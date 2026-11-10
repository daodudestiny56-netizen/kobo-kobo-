import { loadConfig } from '../src/config';
import { createPool } from '../src/db/pool';
import { toWatDate } from '../src/time';

/** Runs tonight's sweep through the real HTTP endpoint (early, because the window is still open) and prints what happened to each trader. */
const config = loadConfig();
const base = process.env.CORE_URL ?? `http://localhost:${config.port}`;
const date = toWatDate(new Date());

const res = await fetch(`${base}/api/v1/sweeps/nightly-batch`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(config.serviceToken ? { authorization: `Bearer ${config.serviceToken}` } : {}) },
  body: JSON.stringify({ target_date: date, allow_early: true }),
}).catch((e) => {
  console.error(`Could not reach core at ${base}. Is "npm run dev" running?`, (e as Error).message);
  process.exit(1);
});
const body = await res.json();
if (!res.ok) {
  console.error('Sweep failed:', JSON.stringify(body));
  process.exit(1);
}
console.log(`Nightly batch for ${date}:`);
console.table(body);

const pool = createPool(config.databaseUrl);
try {
  const { rows } = await pool.query(
    `SELECT m.full_name AS trader, s.status, s.total_takings::text AS takings, s.sweep_amount::text AS swept,
            s.emergency_amount::text AS emergency, s.retirement_amount::text AS retirement, s.pension_reference AS pen_reference
       FROM daily_sweeps s JOIN merchants m ON m.id = s.merchant_id WHERE s.sweep_date = $1 ORDER BY m.created_at`,
    [date],
  );
  console.table(rows);
  const held = await pool.query(`SELECT m.full_name, m.phone_number FROM sweep_guard_alerts a JOIN merchants m ON m.id = a.merchant_id JOIN daily_sweeps s ON s.id = a.sweep_id
      WHERE a.status = 'PENDING_REVIEW' AND a.alert_type = 'ANOMALOUS_INFLOW' AND s.status = 'HELD_GUARD'`);
  for (const h of held.rows) console.log(`Held by Sweep Guard: ${h.full_name}. Text OK from ${h.phone_number}:  npm run demo:sms -- ${h.phone_number} OK`);
  console.log('Reconciliation:  curl ' + `${base}/api/v1/reconciliation?date=${date}` + (config.serviceToken ? ' -H "Authorization: Bearer $SERVICE_TOKEN"' : ''));
} finally {
  await pool.end();
}
