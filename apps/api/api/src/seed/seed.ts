/**
 * Deterministic local demo data.
 *
 * Every id and every date is FIXED, so two runs on two machines produce byte-identical
 * rows and a screenshot or a failing assertion means the same thing everywhere.
 * Re-running is a no-op (`ON CONFLICT DO NOTHING` on the fixed primary keys).
 *
 * This is development data, not a fixture factory for production: it refuses to run
 * under NODE_ENV=production.
 */
import { planEndDateExclusive } from '@hi/contracts';
import { loadConfig } from '../config.js';
import { Database } from '../db/pool.js';
import type { Tx } from '../db/pool.js';
import { hashPassword } from '../auth/password.js';

const config = loadConfig({
  ...process.env,
  SESSION_SECRET: process.env.SESSION_SECRET ?? 'local-seed-placeholder-secret-value-32b',
});

if (config.nodeEnv === 'production') {
  process.stderr.write('[seed] refusing to run against a production environment\n');
  process.exit(1);
}

/**
 * Resolved at run time rather than hard-coded: the demo account is created
 * through app_register_password_user, exactly like a real sign-up, so the seed
 * needs no privilege the running API does not already have. (The API role is
 * deliberately unable to write a password hash directly.)
 */
let USER_ID = '';
const PLAN_ID = '22222222-2222-4222-8222-222222222222';
const REVISION_ID = '33333333-3333-4333-8333-333333333333';
const GYM_COMMITMENT_ID = '44444444-4444-4444-8444-444444444444';
const TRAINER_COMMITMENT_ID = '44444444-4444-4444-8444-444444444445';

const START_DATE = '2026-09-01';
const END_DATE = planEndDateExclusive(START_DATE);
const TIMEZONE = 'Asia/Kolkata';
const DEMO_EMAIL = 'demo@fitfolio.test';
/** Local demo only. Meets the real policy so it exercises the same code path. */
const DEMO_PASSWORD = 'demo-fitfolio-2026';

const EXPENSES = [
  { id: '55555555-5555-4555-8555-000000000001', category: 'gym', paid_on: '2026-09-02', amount: '400000', attributable: '400000', commitment: GYM_COMMITMENT_ID },
  { id: '55555555-5555-4555-8555-000000000002', category: 'trainer', paid_on: '2026-09-05', amount: '900000', attributable: '900000', commitment: TRAINER_COMMITMENT_ID },
  { id: '55555555-5555-4555-8555-000000000003', category: 'groceries', paid_on: '2026-09-09', amount: '500000', attributable: '200000', commitment: null },
] as const;

const WEIGHTS = [
  { id: '66666666-6666-4666-8666-000000000001', at: '2026-09-01T07:00:00+05:30', date: '2026-09-01', kg: '90.000' },
  { id: '66666666-6666-4666-8666-000000000002', at: '2026-09-01T21:00:00+05:30', date: '2026-09-01', kg: '90.400' },
  { id: '66666666-6666-4666-8666-000000000003', at: '2026-09-05T07:00:00+05:30', date: '2026-09-05', kg: '89.500' },
  { id: '66666666-6666-4666-8666-000000000004', at: '2026-09-09T07:00:00+05:30', date: '2026-09-09', kg: '88.800' },
  { id: '66666666-6666-4666-8666-000000000005', at: '2026-09-12T07:00:00+05:30', date: '2026-09-12', kg: '88.200' },
] as const;

const ACTIVITIES = [
  { id: '77777777-7777-4777-8777-000000000001', at: '2026-09-02T18:00:00+05:30', date: '2026-09-02', kind: 'gym', status: 'completed', minutes: 60, commitment: GYM_COMMITMENT_ID },
  { id: '77777777-7777-4777-8777-000000000002', at: '2026-09-04T18:00:00+05:30', date: '2026-09-04', kind: 'trainer', status: 'completed', minutes: 45, commitment: TRAINER_COMMITMENT_ID },
  { id: '77777777-7777-4777-8777-000000000003', at: '2026-09-06T18:00:00+05:30', date: '2026-09-06', kind: 'gym', status: 'missed', minutes: null, commitment: GYM_COMMITMENT_ID },
  { id: '77777777-7777-4777-8777-000000000004', at: '2026-09-11T18:00:00+05:30', date: '2026-09-11', kind: 'gym', status: 'completed', minutes: 55, commitment: GYM_COMMITMENT_ID },
] as const;

const NUTRITION = [
  { date: '2026-09-02', calories: 2100, protein: '120.00' },
  { date: '2026-09-03', calories: 0, protein: null },     // an explicit zero, NOT unknown
  { date: '2026-09-04', calories: null, protein: '95.50' }, // unknown calories, known protein
] as const;

async function categoryIds(tx: Tx): Promise<Map<string, number>> {
  const { rows } = await tx.query<{ id: number; code: string }>('SELECT id, code FROM categories');
  return new Map(rows.map((r) => [r.code, r.id]));
}

const db = new Database(config);

try {
  // Create (or find) the demo account first — this happens outside any user
  // transaction, because there is no user context until an account exists.
  const registered = await db.registerPasswordUser(DEMO_EMAIL, await hashPassword(DEMO_PASSWORD), TIMEZONE);
  if (registered !== null) {
    USER_ID = registered;
  } else {
    const existing = await db.passwordCredential(DEMO_EMAIL);
    if (existing === null) throw new Error(`could not create or find ${DEMO_EMAIL}`);
    USER_ID = existing.userId;
    // Re-running the seed resets the demo password to the documented one.
    await db.setPassword(USER_ID, await hashPassword(DEMO_PASSWORD));
  }

  await db.withUserTransaction(USER_ID, async (tx) => {
    const categories = await categoryIds(tx);
    const cat = (code: string): number => {
      const id = categories.get(code);
      if (id === undefined) throw new Error(`missing category ${code}`);
      return id;
    };

    // The account row already exists (registration created it). Set the
    // display preferences the demo screenshots expect.
    await tx.query(
      `UPDATE users SET display_name = 'Demo user', weight_unit = 'kg',
              notification_opt_in = true, timezone = $2
        WHERE id = $1`,
      [USER_ID, TIMEZONE],
    );

    await tx.query(
      `INSERT INTO plans (id, user_id, name, status, start_date, end_date, timezone, currency_code,
                          budget_scope, baseline_weight_kg, target_weight_kg,
                          daily_calorie_target, daily_protein_target_g, activated_at)
       VALUES ($1,$2,'Six-month reset','active',$3,$4,$5,'INR','total','90.000','84.000',2100,120,
               '2026-09-01T00:30:00+05:30')
       ON CONFLICT (id) DO NOTHING`,
      [PLAN_ID, USER_ID, START_DATE, END_DATE, TIMEZONE],
    );

    await tx.query(
      `INSERT INTO budget_revisions (id, user_id, plan_id, revision, total_minor, effective_on, reason)
       VALUES ($1,$2,$3,1,'6000000',$4,'Initial budget')
       ON CONFLICT (id) DO NOTHING`,
      [REVISION_ID, USER_ID, PLAN_ID, START_DATE],
    );
    for (const [code, allocated] of [['gym', '1200000'], ['trainer', '2400000'], ['groceries', '1800000']] as const) {
      await tx.query(
        `INSERT INTO budget_lines (user_id, plan_id, revision_id, category_id, allocated_minor)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [USER_ID, PLAN_ID, REVISION_ID, cat(code), allocated],
      );
    }

    for (const commitment of [
      { id: GYM_COMMITMENT_ID, code: 'gym', label: 'Gym membership', due: '2026-09-01', expected: '400000', attributable: '400000', model: 'unlimited', sessions: null },
      { id: TRAINER_COMMITMENT_ID, code: 'trainer', label: 'Trainer pack', due: '2026-09-05', expected: '900000', attributable: '900000', model: 'sessions', sessions: 12 },
    ] as const) {
      await tx.query(
        `INSERT INTO commitments (id, user_id, plan_id, category_id, label, due_on, expected_minor,
                                  attributable_minor, session_model, expected_sessions, generation_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (id) DO NOTHING`,
        [
          commitment.id, USER_ID, PLAN_ID, cat(commitment.code), commitment.label, commitment.due,
          commitment.expected, commitment.attributable, commitment.model, commitment.sessions,
          `seed:${commitment.code}`,
        ],
      );
    }

    for (const expense of EXPENSES) {
      await tx.query(
        `INSERT INTO expenses (id, user_id, plan_id, category_id, commitment_id, paid_on, kind,
                               amount_minor, attributable_minor, description)
         VALUES ($1,$2,$3,$4,$5,$6,'payment',$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
        [
          expense.id, USER_ID, PLAN_ID, cat(expense.category), expense.commitment, expense.paid_on,
          expense.amount, expense.attributable, 'seed entry',
        ],
      );
    }

    for (const weight of WEIGHTS) {
      await tx.query(
        `INSERT INTO weight_entries (id, user_id, plan_id, measured_at, local_date, weight_kg)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING`,
        [weight.id, USER_ID, PLAN_ID, weight.at, weight.date, weight.kg],
      );
    }

    for (const activity of ACTIVITIES) {
      await tx.query(
        `INSERT INTO activity_entries (id, user_id, plan_id, commitment_id, occurred_at, local_date,
                                       kind, status, duration_minutes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
        [
          activity.id, USER_ID, PLAN_ID, activity.commitment, activity.at, activity.date,
          activity.kind, activity.status, activity.minutes,
        ],
      );
    }

    for (const day of NUTRITION) {
      await tx.query(
        `INSERT INTO nutrition_days (user_id, plan_id, local_date, calories, protein_g)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (user_id, plan_id, local_date) DO NOTHING`,
        [USER_ID, PLAN_ID, day.date, day.calories, day.protein],
      );
    }
  });

  process.stdout.write(
    `[seed] demo account ready\n` +
    `[seed]   sign in with  ${DEMO_EMAIL}  /  ${DEMO_PASSWORD}\n` +
    `[seed]   user ${USER_ID}, plan ${PLAN_ID}\n` +
    `[seed] local demo credentials only — the seed refuses to run in production\n`);
} finally {
  await db.close();
}
