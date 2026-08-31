-- Склад поставщика раскладывается по товарам: витрина строится как проекция реальных остатков.
ALTER TABLE supplier_stub.keys ADD COLUMN IF NOT EXISTS sku TEXT;

DROP INDEX IF EXISTS supplier_stub.supplier_stub_free_keys_idx;
CREATE INDEX IF NOT EXISTS supplier_stub_free_keys_idx
  ON supplier_stub.keys (supplier, sku, id)
  WHERE taken_by IS NULL;

-- Отказ поставщика действует в пределах одной попытки доставки: на следующей запись
-- переводится в retryable, иначе временная причина стала бы вечной.
ALTER TABLE supplier_requests DROP CONSTRAINT IF EXISTS supplier_requests_state_check;
ALTER TABLE supplier_requests ADD CONSTRAINT supplier_requests_state_check
  CHECK (state IN ('in_flight', 'ok', 'failed', 'unknown', 'retryable'));
