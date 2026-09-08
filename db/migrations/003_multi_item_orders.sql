-- Второй этап: заказ из нескольких товаров, недобросовестный поставщик, лимит запросов,
-- восстановление картины на любой момент.
--
-- Миграция эволюционная: первый этап не переписывается. Одно-товарный заказ становится
-- частным случаем заказа из одной позиции, существующие заказы и выдачи переносятся
-- на новую модель без потери данных.

-- ---------------------------------------------------------------------------
-- Позиции заказа
-- ---------------------------------------------------------------------------

-- Единица товара = одна позиция. Количество разворачивается в отдельные позиции:
-- каждая единица получает свой код от своего поставщика и живёт своей судьбой,
-- поэтому "частично выдан" описывается состояниями позиций, а не одним полем заказа.
CREATE TABLE IF NOT EXISTS order_items (
  id              TEXT PRIMARY KEY,
  order_id        TEXT    NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  position        INTEGER NOT NULL,
  sku             TEXT    NOT NULL REFERENCES products(sku),
  amount_minor    BIGINT  NOT NULL CHECK (amount_minor > 0),
  currency        TEXT    NOT NULL,
  status          TEXT    NOT NULL CHECK (status IN (
                    'pending',        -- ждёт оплаты или очереди
                    'delivering',     -- запрос у поставщика
                    'delivered',      -- код у покупателя
                    'unfulfillable',  -- выдать не удалось, деньги подлежат возврату
                    'refunded')),     -- деньги вернули
  -- Приоритет обслуживания под лимитом поставщика: 0 у оплаченных, 100 у резерва до оплаты.
  priority        SMALLINT NOT NULL DEFAULT 0,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ,
  -- После дедлайна позиция объявляется невыдаваемой и деньги за неё возвращаются:
  -- бесконечное ожидание кода это тоже способ потерять деньги покупателя.
  deadline_at     TIMESTAMPTZ,
  last_error      TEXT,
  queued_at       TIMESTAMPTZ,       -- когда позиция встала в очередь к поставщику
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS order_items_order_position_uidx ON order_items (order_id, position);
CREATE INDEX IF NOT EXISTS order_items_order_idx ON order_items (order_id);

-- Очередь диспетчера: только незавершённые позиции.
-- Порядок обслуживания зашит в индекс, чтобы выборка под всплеском не сортировала таблицу.
CREATE INDEX IF NOT EXISTS order_items_queue_idx
  ON order_items (priority, next_attempt_at, created_at)
  WHERE status IN ('pending', 'delivering');

CREATE INDEX IF NOT EXISTS order_items_refundable_idx
  ON order_items (updated_at)
  WHERE status = 'unfulfillable';

-- Аренда позиции на время выдачи.
--
-- Первый этап разводил параллельные попытки сессионным advisory lock, и это держало
-- отдельное соединение всё время сетевых вызовов. Под всплеском в сотни позиций такой лок
-- выедает пул соединений до нуля и система встаёт целиком. Аренда со сроком свободна
-- от этого: она не занимает соединение и сама протухает, если процесс умер.
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;

-- Заказ из нескольких товаров: sku на уровне заказа больше не обязателен.
-- Для заказа из одной позиции он по-прежнему заполняется, чтобы контракт первого этапа не менялся.
ALTER TABLE orders ALTER COLUMN sku DROP NOT NULL;

-- Итоговые состояния мульти-заказа. Старые статусы остаются: заказ из одной позиции
-- проходит ровно тот же путь, что и в первом этапе.
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check CHECK (status IN (
  'created', 'paid', 'delivering', 'delivered',
  'payment_failed', 'out_of_stock', 'delivery_failed',
  'partially_delivered',   -- часть позиций выдана, за остальные деньги возвращены
  'refunded'));            -- не выдано ничего, деньги возвращены полностью

-- Перенос существующих заказов: у каждого появляется ровно одна позиция.
INSERT INTO order_items (id, order_id, position, sku, amount_minor, currency, status, attempts, created_at, updated_at)
SELECT 'itm_' || o.id || '_1', o.id, 1, o.sku, o.amount_minor, o.currency,
       CASE WHEN o.status = 'delivered' THEN 'delivered' ELSE 'pending' END,
       o.attempts, o.created_at, o.updated_at
  FROM orders o
 WHERE o.sku IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = o.id);

-- ---------------------------------------------------------------------------
-- Выдача переезжает с заказа на позицию
-- ---------------------------------------------------------------------------

ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS order_item_id TEXT REFERENCES order_items(id) ON DELETE CASCADE;
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS sku TEXT;

UPDATE deliveries d
   SET order_item_id = i.id,
       sku = COALESCE(d.sku, i.sku)
  FROM order_items i
 WHERE i.order_id = d.order_id
   AND d.order_item_id IS NULL;

-- Первичный ключ по позиции: две выдачи по одной позиции физически невозможны.
-- Уникальность deliveries.code остаётся: один код не уходит в два заказа.
ALTER TABLE deliveries DROP CONSTRAINT IF EXISTS deliveries_pkey;
ALTER TABLE deliveries ALTER COLUMN order_item_id SET NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'deliveries_item_pkey') THEN
    ALTER TABLE deliveries ADD CONSTRAINT deliveries_item_pkey PRIMARY KEY (order_item_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS deliveries_order_idx ON deliveries (order_id);

-- ---------------------------------------------------------------------------
-- Запросы к поставщику: адресуются позиции, у каждого запроса есть эпоха
-- ---------------------------------------------------------------------------
--
-- Эпоха нужна ровно для недобросовестного поставщика. Внутри эпохи request_id неизменен,
-- поэтому повтор после таймаута обязан вернуть тот же код (защита первого этапа).
-- Эпоха растёт только когда поставщик прислал НЕГОДНЫЙ код (дубль или чужой):
-- тогда мы осознанно просим другой код другим запросом, а негодный возвращаем поставщику.

ALTER TABLE supplier_requests ADD COLUMN IF NOT EXISTS order_item_id TEXT REFERENCES order_items(id) ON DELETE CASCADE;
ALTER TABLE supplier_requests ADD COLUMN IF NOT EXISTS epoch INTEGER NOT NULL DEFAULT 0;

UPDATE supplier_requests sr
   SET order_item_id = i.id
  FROM order_items i
 WHERE i.order_id = sr.order_id
   AND sr.order_item_id IS NULL;

DROP INDEX IF EXISTS supplier_requests_order_supplier_uidx;
CREATE UNIQUE INDEX IF NOT EXISTS supplier_requests_item_supplier_epoch_uidx
  ON supplier_requests (order_item_id, supplier, epoch);
CREATE INDEX IF NOT EXISTS supplier_requests_item_idx ON supplier_requests (order_item_id);

-- Код, который поставщик выдал, а мы отбраковали: он должен вернуться на склад поставщика,
-- иначе товар исчезает из мира. Пока не вернули, запись висит здесь.
ALTER TABLE supplier_requests ADD COLUMN IF NOT EXISTS rejected_code TEXT;
ALTER TABLE supplier_requests ADD COLUMN IF NOT EXISTS released_at TIMESTAMPTZ;

-- rejected: поставщик ответил кодом, но код оказался негодным (дубль или чужой товар).
-- Такой запрос закрыт навсегда, замена просится НОВЫМ request_id со следующей эпохой.
ALTER TABLE supplier_requests DROP CONSTRAINT IF EXISTS supplier_requests_state_check;
ALTER TABLE supplier_requests ADD CONSTRAINT supplier_requests_state_check
  CHECK (state IN ('in_flight', 'ok', 'failed', 'unknown', 'retryable', 'rejected'));

-- ---------------------------------------------------------------------------
-- Возвраты
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS refunds (
  id             TEXT PRIMARY KEY,             -- rfnd_<order_item_id>: детерминирован, повтор невозможен
  order_id       TEXT   NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  order_item_id  TEXT   NOT NULL UNIQUE REFERENCES order_items(id) ON DELETE CASCADE,
  amount_minor   BIGINT NOT NULL CHECK (amount_minor > 0),
  currency       TEXT   NOT NULL,
  reason         TEXT   NOT NULL,
  status         TEXT   NOT NULL CHECK (status IN ('pending', 'settled', 'failed')),
  attempts       INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ,
  last_error     TEXT,
  provider_ref   TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS refunds_pending_idx ON refunds (next_attempt_at) WHERE status <> 'settled';
CREATE INDEX IF NOT EXISTS refunds_order_idx ON refunds (order_id);

-- Возврат это движение денег, поэтому в журнале появляется обязательство перед покупателем.
ALTER TABLE ledger_entries DROP CONSTRAINT IF EXISTS ledger_entries_account_check;
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_account_check
  CHECK (account IN ('cash', 'deferred_revenue', 'revenue', 'cogs', 'inventory', 'refunds_payable'));

-- ---------------------------------------------------------------------------
-- Расхождения с поставщиком
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS supplier_discrepancies (
  id            BIGSERIAL PRIMARY KEY,
  supplier      TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN (
                  'duplicate_code',   -- прислал код, который уже принадлежит другой выдаче
                  'foreign_code',     -- прислал код от другого товара
                  'silent_issue',     -- ответил ошибкой или молчанием, но код выдал
                  'orphan_issue',     -- считает выданным то, чего мы не просили или уже не ждём
                  'lost_code')),      -- код числится за нами, но выдачи нет
  request_id    TEXT,
  order_item_id TEXT,
  code          TEXT,
  detail        JSONB NOT NULL DEFAULT '{}'::jsonb,
  resolution    TEXT,
  detected_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at   TIMESTAMPTZ
);

-- Один и тот же инцидент не плодится при каждом проходе сверки.
CREATE UNIQUE INDEX IF NOT EXISTS supplier_discrepancies_uidx
  ON supplier_discrepancies (supplier, kind, COALESCE(request_id, ''), COALESCE(code, ''));

CREATE INDEX IF NOT EXISTS supplier_discrepancies_open_idx
  ON supplier_discrepancies (detected_at) WHERE resolved_at IS NULL;

-- Курсор фоновой сверки по журналу выдач поставщика.
CREATE TABLE IF NOT EXISTS supplier_sync_state (
  supplier   TEXT PRIMARY KEY,
  cursor_id  BIGINT NOT NULL DEFAULT 0,
  synced_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Лимит запросов к поставщику: общий на все экземпляры сервиса, поэтому живёт в БД
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS supplier_rate_limits (
  supplier     TEXT PRIMARY KEY,
  capacity     INTEGER NOT NULL CHECK (capacity > 0),   -- сколько запросов помещается в окно
  window_ms    INTEGER NOT NULL CHECK (window_ms > 0),
  granted      BIGINT NOT NULL DEFAULT 0,               -- счётчик выданных разрешений, для наблюдаемости
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Журнал выданных разрешений: по нему считается ровно то же скользящее окно,
-- по которому лимит считает сам поставщик. Приблизительное ведро токенов здесь не подходит:
-- накопленный за простой запас плюс текущее пополнение дают в окне больше договорного лимита.
CREATE TABLE IF NOT EXISTS supplier_rate_events (
  id         BIGSERIAL PRIMARY KEY,
  supplier   TEXT NOT NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS supplier_rate_events_idx ON supplier_rate_events (supplier, granted_at);

-- ---------------------------------------------------------------------------
-- Журнал событий: только дополняется, задним числом не переписывается
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS order_events (
  seq           BIGSERIAL PRIMARY KEY,
  order_id      TEXT NOT NULL,
  order_item_id TEXT,
  type          TEXT NOT NULL,
  amount_minor  BIGINT,
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS order_events_order_idx ON order_events (order_id, seq);
CREATE INDEX IF NOT EXISTS order_events_time_idx ON order_events (occurred_at, seq);

-- Append-only держится базой, а не обещанием кода: правка и удаление истории запрещены физически.
CREATE OR REPLACE FUNCTION deny_history_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'append_only: таблица % не допускает % ', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS order_events_append_only ON order_events;
CREATE TRIGGER order_events_append_only
  BEFORE UPDATE OR DELETE ON order_events
  FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();

DROP TRIGGER IF EXISTS ledger_entries_append_only ON ledger_entries;
CREATE TRIGGER ledger_entries_append_only
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();

-- ---------------------------------------------------------------------------
-- Заглушка поставщика: журнал выдач с курсором и возврат отбракованного кода
-- ---------------------------------------------------------------------------

ALTER TABLE supplier_stub.issued ADD COLUMN IF NOT EXISTS seq BIGSERIAL;
ALTER TABLE supplier_stub.issued ADD COLUMN IF NOT EXISTS released_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS supplier_stub_issued_seq_idx ON supplier_stub.issued (supplier, seq);
CREATE INDEX IF NOT EXISTS supplier_stub_issued_code_idx ON supplier_stub.issued (supplier, code);

-- У недобросовестного поставщика нет защиты от повторной выдачи одного кода:
-- именно это поведение второй этап и требует воспроизвести. Уникальность кода
-- остаётся на НАШЕЙ стороне (deliveries.code), где ей и место.
DROP INDEX IF EXISTS supplier_stub.supplier_stub_issued_code_uidx;

-- Заглушка платёжного шлюза: возвраты идемпотентны по refund_id.
CREATE SCHEMA IF NOT EXISTS payment_stub;

CREATE TABLE IF NOT EXISTS payment_stub.refunds (
  refund_id    TEXT PRIMARY KEY,
  order_id     TEXT   NOT NULL,
  amount_minor BIGINT NOT NULL,
  currency     TEXT   NOT NULL,
  provider_ref TEXT   NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
