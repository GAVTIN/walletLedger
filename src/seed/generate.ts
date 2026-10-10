import type { Pool } from '../db';

/**
 * Bulk data generator (used by `npm run seed`, the reconciliation acceptance test
 * and the EXPLAIN benchmarks).
 *
 * It does NOT call the HTTP API - 100k round trips would take forever. Instead it
 * SIMULATES balances in memory so every generated transfer is valid (no wallet ever
 * goes negative), then bulk-inserts transfers + balanced ledger entries + status
 * history with unnest(). All the database triggers/constraints still run, so a bug
 * here would be rejected by the schema, not silently stored. Seeded transfers skip
 * the fraud rules (they are historical data).
 */

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ['Rahul', 'Asha', 'Priya', 'Amit', 'Neha', 'Vikram', 'Sneha', 'Rohan', 'Anjali', 'Karan', 'Pooja', 'Arjun', 'Divya', 'Sanjay', 'Meera', 'Ishaan'];
const LAST = ['Sharma', 'Verma', 'Patel', 'Iyer', 'Nair', 'Singh', 'Gupta', 'Kulkarni', 'Mehta', 'Reddy', 'Joshi', 'Desai'];
const NOTES = ['rent', 'dinner split', 'groceries', 'gift', 'movie tickets', 'thanks!', 'cab share', null, null, null, null, null];

export type SeedOptions = {
  users: number;
  transfers: number;
  days?: number; // spread history over this many days ending now (default 90)
  seed?: number;
  batch?: number;
  log?: (m: string) => void;
};
export type SeedResult = { users: number; wallets: number; transfers: number; entries: number; walletIds: number[] };

type T = {
  type: 'TOPUP' | 'PEER_TRANSFER' | 'WITHDRAWAL';
  amount: number;
  source: number;
  dest: number;
  userId: number;
  note: string | null;
  at: number; // epoch ms
};

export async function seedData(pool: Pool, o: SeedOptions): Promise<SeedResult> {
  const log = o.log ?? (() => {});
  const rnd = mulberry32(o.seed ?? 42);
  const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
  const batch = o.batch ?? 5000;
  const days = o.days ?? 90;

  const sys = Object.fromEntries(
    (await pool.query<{ id: number; system_code: string }>('SELECT id, system_code FROM accounts WHERE system_code IS NOT NULL')).rows.map((r) => [r.system_code, r.id]),
  ) as Record<'CASH_IN' | 'CASH_OUT' | 'FEE_REVENUE', number>;

  // ---- users + wallets --------------------------------------------------------
  const tag = `${o.seed ?? 42}-${Date.now().toString(36)}`;
  const names: string[] = [];
  const emails: string[] = [];
  const phones: string[] = [];
  for (let i = 0; i < o.users; i++) {
    names.push(`${FIRST[i % FIRST.length]} ${LAST[Math.floor(i / FIRST.length) % LAST.length]}`);
    emails.push(`seed-${tag}-${String(i).padStart(6, '0')}@example.com`);
    phones.push('');
  }
  // Phones must be unique across repeated seeds: derive them from the current max user id.
  const base = Number((await pool.query<{ n: number }>('SELECT COALESCE(MAX(id), 0) AS n FROM users')).rows[0].n);
  for (let i = 0; i < o.users; i++) phones[i] = `+9170${String(base * 100000 + i).padStart(10, '0')}`;

  const userRows = (
    await pool.query<{ id: number; email: string }>(
      `INSERT INTO users (name, email, phone, kyc_status)
       SELECT n, e, p, 'VERIFIED' FROM unnest($1::text[], $2::text[], $3::text[]) AS u(n, e, p)
       RETURNING id, email`,
      [names, emails, phones],
    )
  ).rows;
  userRows.sort((a, b) => a.email.localeCompare(b.email));
  const userIds = userRows.map((r) => r.id);

  const wUser: number[] = [];
  const wName: string[] = [];
  for (const id of userIds) {
    wUser.push(id, id);
    wName.push('main', 'savings');
  }
  const wallets = (
    await pool.query<{ id: number; user_id: number }>(
      `INSERT INTO accounts (kind, user_id, name)
       SELECT 'USER_WALLET', u, n FROM unnest($1::bigint[], $2::text[]) AS w(u, n)
       RETURNING id, user_id`,
      [wUser, wName],
    )
  ).rows;
  const walletIds = wallets.map((w) => w.id);
  const ownerOf = new Map(wallets.map((w) => [w.id, w.user_id]));
  const bal = new Map<number, number>(walletIds.map((id) => [id, 0]));
  log(`users=${userIds.length} wallets=${walletIds.length}`);

  // ---- simulate transfers in time order ---------------------------------------
  const end = Date.now();
  const start = end - days * 86_400_000;
  const total = Math.max(o.transfers, walletIds.length);
  const plan: T[] = [];
  let cashInTotal = 0;
  let cashOutTotal = 0;
  for (let i = 0; i < total; i++) {
    const at = start + Math.floor(((i + 1) / total) * (end - start - 1000));
    const pickWallet = () => walletIds[int(0, walletIds.length - 1)];
    let t: T | null = null;

    if (i < walletIds.length) {
      const w = walletIds[i];
      t = { type: 'TOPUP', amount: int(500, 20000) * 100, source: sys.CASH_IN, dest: w, userId: ownerOf.get(w)!, note: 'opening top-up', at };
    } else {
      const r = rnd();
      if (r >= 0.13) {
        for (let tries = 0; tries < 6 && !t; tries++) {
          const from = pickWallet();
          const b = bal.get(from)!;
          if (b < 1000) continue; // < Rs 10
          let to = pickWallet();
          if (to === from) continue;
          if (rnd() < 0.3) {
            // own-wallet move (main <-> savings)
            const sib = wallets.find((x) => x.id !== from && x.user_id === ownerOf.get(from));
            if (sib) to = sib.id;
          }
          const amount = Math.min(b, int(10, 3000) * 100);
          t = { type: 'PEER_TRANSFER', amount, source: from, dest: to, userId: ownerOf.get(from)!, note: NOTES[int(0, NOTES.length - 1)], at };
        }
      } else if (r >= 0.08) {
        const from = pickWallet();
        const b = bal.get(from)!;
        if (b >= 10000) {
          t = { type: 'WITHDRAWAL', amount: Math.min(b, int(100, 2000) * 100), source: from, dest: sys.CASH_OUT, userId: ownerOf.get(from)!, note: null, at };
        }
      }
      if (!t) {
        const w = pickWallet();
        t = { type: 'TOPUP', amount: int(100, 10000) * 100, source: sys.CASH_IN, dest: w, userId: ownerOf.get(w)!, note: null, at };
      }
    }

    if (t.type === 'TOPUP') {
      bal.set(t.dest, bal.get(t.dest)! + t.amount);
      cashInTotal += t.amount;
    } else {
      bal.set(t.source, bal.get(t.source)! - t.amount);
      if (t.type === 'PEER_TRANSFER') bal.set(t.dest, bal.get(t.dest)! + t.amount);
      else cashOutTotal += t.amount;
    }
    plan.push(t);
  }
  log(`simulated ${plan.length} transfers`);

  // ---- bulk insert, one transaction per batch ---------------------------------
  let entries = 0;
  for (let i = 0; i < plan.length; i += batch) {
    const part = plan.slice(i, i + batch);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const ids = (
        await client.query<{ id: number }>(
          `SELECT nextval(pg_get_serial_sequence('transfers', 'id')) AS id FROM generate_series(1, $1::int)`,
          [part.length],
        )
      ).rows.map((r) => r.id);
      const at = part.map((t) => new Date(t.at).toISOString());

      await client.query(
        `INSERT INTO transfers (id, type, status, amount, source_account_id, destination_account_id, initiated_by_user_id, note, created_at)
         OVERRIDING SYSTEM VALUE
         SELECT * FROM unnest($1::bigint[], $2::text[], $3::text[], $4::bigint[], $5::bigint[], $6::bigint[], $7::bigint[], $8::text[], $9::timestamptz[])`,
        [ids, part.map((t) => t.type), part.map(() => 'COMPLETED'), part.map((t) => t.amount), part.map((t) => t.source), part.map((t) => t.dest), part.map((t) => t.userId), part.map((t) => t.note), at],
      );
      await client.query(
        `INSERT INTO ledger_entries (transfer_id, account_id, direction, amount, created_at)
         SELECT * FROM unnest($1::bigint[], $2::bigint[], $3::text[], $4::bigint[], $5::timestamptz[])`,
        [
          [...ids, ...ids],
          [...part.map((t) => t.source), ...part.map((t) => t.dest)],
          [...part.map(() => 'D'), ...part.map(() => 'C')],
          [...part.map((t) => t.amount), ...part.map((t) => t.amount)],
          [...at, ...at],
        ],
      );
      await client.query(
        `INSERT INTO transfer_status_history (transfer_id, from_status, to_status, changed_by, changed_at)
         SELECT t, NULL, 'COMPLETED', 'user:' || u, a
           FROM unnest($1::bigint[], $2::bigint[], $3::timestamptz[]) AS h(t, u, a)`,
        [ids, part.map((t) => t.userId), at],
      );
      await client.query('COMMIT');
      entries += part.length * 2;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    if ((i / batch) % 5 === 0) log(`inserted ${Math.min(i + batch, plan.length)}/${plan.length}`);
  }

  // ---- stored balances ---------------------------------------------------------
  const ids = [...bal.keys(), sys.CASH_IN, sys.CASH_OUT];
  const vals = [...bal.values(), -cashInTotal, cashOutTotal];
  await pool.query(
    `UPDATE accounts a SET balance = a.balance + v.b
       FROM unnest($1::bigint[], $2::bigint[]) AS v(id, b) WHERE a.id = v.id`,
    [ids, vals],
  );
  log('balances written');

  return { users: userIds.length, wallets: walletIds.length, transfers: plan.length, entries, walletIds };
}
