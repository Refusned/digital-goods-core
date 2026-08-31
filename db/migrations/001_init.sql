-- Схема ядра магазина цифровых товаров.
-- Все инварианты однократной выдачи держатся ограничениями БД, а не только кодом:
-- уникальность deliveries.order_id, уникальность deliveries.code, PK у payment_events и supplier_requests.

CREATE TABLE IF NOT EXISTS products (
  sku          TEXT PRIMARY KEY,
  name         TEXT   NOT NULL,
  type         TEXT   NOT NULL CHECK (type IN ('topup', 'key', 'subscription', 'giftcard')),
  price_minor  BIGINT NOT NULL CHECK (price_minor > 0),   -- деньги целым числом, в минимальной единице валюты
  currency     TEXT   NOT NULL DEFAULT 'RUB',
  image        TEXT,
  popularity   INTEGER NOT NULL DEFAULT 0,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  in_stock     BOOLEAN NOT NULL DEFAULT TRUE,             -- денормализация под горячий запрос витрины
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Проекция остатков. Держится отдельно от products, чтобы запись остатка
-- не блокировала строку товара, которую читает витрина.
CREATE TABLE IF NOT EXISTS product_stock (
  sku        TEXT PRIMARY KEY REFERENCES products(sku) ON DELETE CASCADE,
  available  INTEGER NOT NULL DEFAULT 0 CHECK (available >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Витрина: "активные товары нужного типа, которые есть в наличии, по популярности".
-- Частичный составной индекс закрывает WHERE + ORDER BY + LIMIT без сортировки.
CREATE INDEX IF NOT EXISTS products_showcase_idx
  ON products (type, popularity DESC, sku)
  WHERE is_active AND in_stock;

CREATE INDEX IF NOT EXISTS products_showcase_all_idx
  ON products (popularity DESC, sku)
  WHERE is_active AND in_stock;

CREATE TABLE IF NOT EXISTS orders (
  id              TEXT PRIMARY KEY,
  sku             TEXT   NOT NULL REFERENCES products(sku),
  amount_minor    BIGINT NOT NULL CHECK (amount_minor > 0),
  currency        TEXT   NOT NULL,
  status          TEXT   NOT NULL CHECK (status IN (
                    'created', 'paid', 'delivering', 'delivered',
                    'payment_failed', 'out_of_stock', 'delivery_failed')),
  buyer_contact   TEXT,
  idempotency_key TEXT UNIQUE,          -- защита от двойного клика "Купить"
  paid_at         TIMESTAMPTZ,
  last_payment_event_at TIMESTAMPTZ,   -- время последнего ПРИМЕНЁННОГО события оплаты (защита от вебхуков не по порядку)
  delivered_at    TIMESTAMPTZ,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ,
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Очередь восстановления для фонового воркера: только незавершённые заказы.
CREATE INDEX IF NOT EXISTS orders_recovery_idx
  ON orders (next_attempt_at)
  WHERE status IN ('paid', 'delivering', 'out_of_stock', 'delivery_failed');

CREATE INDEX IF NOT EXISTS orders_status_idx ON orders (status);

-- События платёжной системы.
-- order_id НАМЕРЕННО без внешнего ключа: вебхук может прийти раньше, чем создан заказ.
-- PK по event_id -> повторная доставка того же события физически не может примениться дважды.
CREATE TABLE IF NOT EXISTS payment_events (
  event_id     TEXT PRIMARY KEY,
  order_id     TEXT   NOT NULL,
  status       TEXT   NOT NULL CHECK (status IN ('paid', 'failed')),
  amount_minor BIGINT,
  currency     TEXT,
  occurred_at  TIMESTAMPTZ NOT NULL,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  outcome      TEXT
);

-- Непринятые события (заказа ещё не было) забирает тот же воркер восстановления.
CREATE INDEX IF NOT EXISTS payment_events_pending_idx
  ON payment_events (order_id)
  WHERE processed_at IS NULL;

-- Факт выдачи. order_id = PRIMARY KEY, поэтому "две выдачи по одному заказу" невозможны
-- физически, даже если весь прикладной код ошибётся.
CREATE TABLE IF NOT EXISTS deliveries (
  order_id   TEXT PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  code       TEXT NOT NULL,
  supplier   TEXT NOT NULL,
  request_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Один код не может уйти в два заказа.
CREATE UNIQUE INDEX IF NOT EXISTS deliveries_code_uidx ON deliveries (code);

-- Журнал обращений к поставщикам.
-- state = 'unknown' означает таймаут: ответа нет, но поставщик МОГ выдать код.
-- Пока по заказу есть 'unknown', уход на резервного поставщика запрещён.
-- state = 'failed' относится только к текущей попытке доставки: на следующей попытке
-- запись переводится в 'retryable', иначе временный отказ (нет остатка) стал бы вечным.
CREATE TABLE IF NOT EXISTS supplier_requests (
  request_id TEXT PRIMARY KEY,
  order_id   TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  supplier   TEXT NOT NULL,
  state      TEXT NOT NULL CHECK (state IN ('in_flight', 'ok', 'failed', 'unknown', 'retryable')),
  code       TEXT,
  reason     TEXT,
  attempts   INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS supplier_requests_order_supplier_uidx
  ON supplier_requests (order_id, supplier);

CREATE INDEX IF NOT EXISTS supplier_requests_order_idx ON supplier_requests (order_id);

-- Журнал денежных движений, двойная запись.
-- Каждая проводка = две строки с одним txn_id. Сумма debit минус сумма credit по системе всегда 0.
CREATE TABLE IF NOT EXISTS ledger_entries (
  id           BIGSERIAL PRIMARY KEY,
  txn_id       TEXT   NOT NULL,
  order_id     TEXT   NOT NULL,
  account      TEXT   NOT NULL CHECK (account IN ('cash', 'deferred_revenue', 'revenue', 'cogs', 'inventory')),
  direction    TEXT   NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Проводка не может задвоиться: повтор вставки той же пары падает на конфликте.
CREATE UNIQUE INDEX IF NOT EXISTS ledger_txn_account_uidx ON ledger_entries (txn_id, account, direction);
CREATE INDEX IF NOT EXISTS ledger_order_idx ON ledger_entries (order_id);

-- Синхронизация признака наличия для витрины.
CREATE OR REPLACE FUNCTION sync_product_in_stock() RETURNS TRIGGER AS $$
BEGIN
  UPDATE products
     SET in_stock = (NEW.available > 0)
   WHERE sku = NEW.sku
     AND in_stock IS DISTINCT FROM (NEW.available > 0);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS product_stock_sync ON product_stock;
CREATE TRIGGER product_stock_sync
  AFTER INSERT OR UPDATE OF available ON product_stock
  FOR EACH ROW EXECUTE FUNCTION sync_product_in_stock();

-- ---------------------------------------------------------------------------
-- Заглушки поставщиков живут в отдельной схеме: это ВНЕШНЯЯ система,
-- ядро в неё ходит только по HTTP и ничего не знает про её таблицы.
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS supplier_stub;

CREATE TABLE IF NOT EXISTS supplier_stub.keys (
  id       BIGSERIAL PRIMARY KEY,
  supplier TEXT NOT NULL,
  code     TEXT NOT NULL,
  taken_by TEXT,
  UNIQUE (supplier, code)
);

CREATE INDEX IF NOT EXISTS supplier_stub_free_keys_idx
  ON supplier_stub.keys (supplier, id)
  WHERE taken_by IS NULL;

-- Ключевое требование контракта: повтор с тем же request_id обязан вернуть тот же код.
CREATE TABLE IF NOT EXISTS supplier_stub.issued (
  request_id TEXT PRIMARY KEY,
  supplier   TEXT NOT NULL,
  order_id   TEXT,
  sku        TEXT,
  code       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS supplier_stub_issued_code_uidx
  ON supplier_stub.issued (supplier, code);
