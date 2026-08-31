# Ядро магазина цифровых товаров

Тестовое задание «Бэкенд разработчик»: заказы, вебхуки оплаты, автоматическая выдача кода
с гарантией однократной выдачи под гонками, устойчивые интеграции с двумя поставщиками,
сверка и восстановление, витрина остатков на тысячах SKU.

Стек: Node.js 20+ (ESM), Express, PostgreSQL 16. Из зависимостей только `express` и `pg`,
тесты на встроенном `node:test`.

## Запуск

```bash
docker compose up -d          # PostgreSQL на localhost:5442
cp .env.example .env
npm install
npm run migrate
npm run seed                  # каталог из задания + пул ключей, поделённый между поставщиками
npm start                     # API :3010, поставщик A :3121, поставщик B :3122
```

Порты меняются в `.env`. Postgres можно взять и свой, достаточно поправить `DATABASE_URL`.

## Проверка

```bash
npm test                      # 24 теста: ядро, гонки, таймауты, восстановление, витрина
npm run race                  # сценарии гонок против ЗАПУЩЕННОГО сервера (npm start в соседнем окне)
npm run bench:catalog         # витрина на 20 000 SKU: план запроса и время
```

`npm test` поднимает API и обе заглушки поставщиков внутри процесса на случайных портах,
поэтому запущенный сервер для тестов не нужен. Тесты чистят рабочие таблицы, отдельная база не требуется.

### Как воспроизвести проверку гонок

50 параллельных вебхуков «оплачено» по одному заказу:

```bash
curl -s -XPOST localhost:3010/orders -H 'content-type: application/json' -d '{"sku":"KEY-CS2-PRIME"}'
node scripts/emit-webhook.js <order_id> --parallel 50
curl -s localhost:3010/orders/<order_id>
```

Ожидаемо: заказ `delivered`, ровно одна строка в `deliveries`, у поставщика израсходован один ключ.

Повторная доставка одного и того же события:

```bash
node scripts/emit-webhook.js <order_id> --parallel 20 --same-event
```

Все ответы приходят с `outcome: "duplicate"`, состояние заказа не меняется.

### Как воспроизвести отказ и фолбэк поставщика

Заглушки принимают сценарий поведения на следующие вызовы:

```bash
# A выдаёт код и зависает: ответ не дойдёт (ловушка таймаута)
curl -XPOST localhost:3121/_chaos -H 'content-type: application/json' \
     -d '{"script":["timeout_issue"],"hangMs":3000}'

# A отвечает явным отказом три раза подряд -> заказ уходит на резервного B
curl -XPOST localhost:3121/_chaos -H 'content-type: application/json' -d '{"script":["error","error","error"]}'

# случайные сбои: 30% ошибок и 20% таймаутов
curl -XPOST localhost:3121/_chaos -H 'content-type: application/json' -d '{"errorRate":0.3,"timeoutRate":0.2}'

curl localhost:3121/_stats        # сколько ключей осталось и сколько выдано
```

## API

| Метод | Путь | Назначение |
|---|---|---|
| `POST` | `/orders` | создать заказ по SKU. Тело: `{ "sku", "order_id"?, "buyer_contact"? }`, заголовок `Idempotency-Key` опционален |
| `GET` | `/orders/:id` | заказ со статусом и выданным кодом |
| `POST` | `/webhook/payment` | вебхук платёжной системы по контракту из задания |
| `GET` | `/catalog?type=&limit=` | витрина остатков |
| `GET` | `/catalog/:sku` | карточка товара |
| `GET` | `/admin/reconciliation` | отчёт сверки и баланс журнала денег |
| `POST` | `/admin/orders/:id/deliver` | безопасная ручная доводка заказа (идемпотентна) |
| `POST` | `/admin/stock/:sku/restock` | пополнить остаток на витрине |
| `GET` | `/health` | проверка живости |

`order_id` в `POST /orders` необязателен: он нужен, когда платёжная система узнаёт идентификатор
заказа раньше нас и может прислать вебхук до того, как заказ будет создан.

## Статусы заказа

`created → paid → delivering → delivered`

Ветки: `created → payment_failed`; `paid → delivering → out_of_stock → delivered` (после завоза);
`paid → delivering → delivery_failed → delivered` (после повторной выдачи).
`out_of_stock` и `delivery_failed` восстановимые: заказ забирает фоновый воркер, повторы идемпотентны.

## Как закрыты критерии приёмки

| Критерий | Где проверяется |
|---|---|
| 50 параллельных вебхуков → одна выдача, без потерь | `test/02-exactly-once.test.js`, `npm run race` |
| Повторный вебхук с тем же `event_id` ничего не меняет | `test/02`, `emit-webhook.js --same-event` |
| Вебхук вне порядка или раньше заказа | `test/02` (два отдельных теста) |
| Таймаут поставщика, который выдал код → нет второй выдачи | `test/03-suppliers.test.js` |
| Поставщик A недоступен → фолбэк на B, выдача одна | `test/03` (явный отказ и недоступность, два теста) |
| Пустой остаток → восстановимое состояние, без падения | `test/04-recovery.test.js` |
| Витрина остаётся быстрой на тысячах SKU | `test/05-catalog.test.js`, `npm run bench:catalog` |

## Что где лежит

```
src/services/payments.js    приём вебхука, применение событий, порядок и идемпотентность
src/services/delivery.js    выдача: блокировка заказа, поставщики, финализация
src/services/reconcile.js   сверка
src/services/ledger.js      журнал денежных движений (двойная запись)
src/suppliers/client.js     клиент поставщика: ok / failed / unknown
src/suppliers/stub.js       заглушки A и B со сбоями, таймаутами и своим пулом ключей
src/worker.js               фоновое восстановление
db/migrations/001_init.sql  схема со всеми ограничениями
```

Ключевые решения и мысли про нагрузку смотри в [NOTES.md](NOTES.md).
