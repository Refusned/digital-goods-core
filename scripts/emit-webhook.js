/**
 * Эмулятор платёжной системы.
 *
 *   node scripts/emit-webhook.js <order_id> [--status paid|failed] [--amount 500]
 *                                [--parallel 50] [--same-event] [--event-id evt_x]
 *
 * --parallel N   отправить N вебхуков одновременно (проверка гонок)
 * --same-event   все N уходят с ОДНИМ event_id (проверка идемпотентности повторной доставки)
 */
const args = process.argv.slice(2);
const orderId = args[0];
if (!orderId) {
  process.stderr.write('usage: node scripts/emit-webhook.js <order_id> [--parallel N] [--same-event]\n');
  process.exit(1);
}
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? def : args[i + 1];
};
const has = (name) => args.includes(`--${name}`);

const base = process.env.API_URL || `http://127.0.0.1:${process.env.PORT || 3010}`;
const status = flag('status', 'paid');
const parallel = Number(flag('parallel', 1));
const sameEvent = has('same-event');
const fixedEventId = flag('event-id', null);

const amount = flag('amount', null);
const resolvedAmount = amount !== null ? Number(amount)
  : await fetch(`${base}/orders/${orderId}`).then((r) => r.json()).then((o) => o.amount).catch(() => null);

const sharedId = fixedEventId || `evt_${Math.random().toString(36).slice(2, 10)}`;
const payloads = Array.from({ length: parallel }, (_, i) => ({
  event_id: sameEvent ? sharedId : `${sharedId}_${i}`,
  order_id: orderId,
  status,
  amount: resolvedAmount,
  currency: 'RUB',
  created_at: new Date().toISOString(),
}));

const started = Date.now();
const responses = await Promise.all(
  payloads.map((body) =>
    fetch(`${base}/webhook/payment`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(async (r) => ({ http: r.status, ...(await r.json().catch(() => ({}))) }))
      .catch((e) => ({ http: 0, error: e.message })),
  ),
);

const byOutcome = responses.reduce((acc, r) => {
  const key = `${r.http}:${r.outcome || r.error || 'ok'}`;
  acc[key] = (acc[key] || 0) + 1;
  return acc;
}, {});

process.stdout.write(JSON.stringify({ order_id: orderId, sent: parallel, same_event: sameEvent, took_ms: Date.now() - started, outcomes: byOutcome }, null, 2) + '\n');
