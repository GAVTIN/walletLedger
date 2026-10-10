import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../src/errors';
import { runIdempotent } from '../src/http/idempotency';
import { createTransfer } from '../src/ledger/transfers';
import { balanceOf, makeApi, type Api } from './helpers/api';
import { createTestDb, type TestDb } from './helpers/db';

let db: TestDb;
let api: Api;
beforeAll(async () => {
  db = await createTestDb(20);
  api = await makeApi(db.pool);
});
afterAll(async () => db.drop());

const transferCount = async () => (await db.pool.query('SELECT count(*)::int AS n FROM transfers')).rows[0].n as number;

describe('Milestone 3 acceptance tests', () => {
  it('the same request sent 5 times in a row creates 1 transfer and returns 5 identical responses', async () => {
    const a = await api.fundedUser('IdemA', 100_000);
    const b = await api.fundedUser('IdemB', 0);
    const before = await transferCount();
    const key = randomUUID();
    const body = { from_wallet_id: a.walletId, to_wallet_id: b.walletId, amount: 25_000 };

    const rs = [];
    for (let i = 0; i < 5; i++) rs.push(await api.post('/transfers', body, { user: a.userId, key }));

    expect(await transferCount()).toBe(before + 1);
    expect(await balanceOf(db.pool, a.walletId)).toBe(75_000);
    expect(new Set(rs.map((r) => r.status))).toEqual(new Set([201]));
    expect(new Set(rs.map((r) => r.raw)).size, 'byte-identical bodies').toBe(1);
    expect(rs.map((r) => r.headers['idempotent-replay'])).toEqual(['false', 'true', 'true', 'true', 'true']);
  });

  it('the same key sent 10 times IN PARALLEL still creates exactly 1 transfer', async () => {
    const a = await api.fundedUser('ParA', 100_000);
    const b = await api.fundedUser('ParB', 0);
    const before = await transferCount();
    const key = randomUUID();
    const body = { from_wallet_id: a.walletId, to_wallet_id: b.walletId, amount: 10_000 };

    const rs = await Promise.all(Array.from({ length: 10 }, () => api.post('/transfers', body, { user: a.userId, key })));

    expect(await transferCount()).toBe(before + 1);
    expect(await balanceOf(db.pool, a.walletId)).toBe(90_000);
    expect(new Set(rs.map((r) => r.status))).toEqual(new Set([201]));
    expect(new Set(rs.map((r) => r.raw)).size).toBe(1);
    expect(rs.filter((r) => r.headers['idempotent-replay'] === 'false')).toHaveLength(1);
  });

  it('the same key with a different amount returns 422 and no money moves', async () => {
    const a = await api.fundedUser('DiffA', 100_000);
    const b = await api.fundedUser('DiffB', 0);
    const key = randomUUID();
    const first = await api.post('/transfers', { from_wallet_id: a.walletId, to_wallet_id: b.walletId, amount: 1_000 }, { user: a.userId, key });
    expect(first.status).toBe(201);
    const before = await transferCount();

    const second = await api.post('/transfers', { from_wallet_id: a.walletId, to_wallet_id: b.walletId, amount: 2_000 }, { user: a.userId, key });
    expect(second.status).toBe(422);
    expect(second.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await transferCount()).toBe(before);
    expect(await balanceOf(db.pool, a.walletId)).toBe(99_000);
  });
});

describe('idempotency edge cases', () => {
  it('missing or malformed Idempotency-Key header is 400 on every POST', async () => {
    const u = await api.createUser('NoKey');
    const w = await api.openWallet(u);
    for (const [url, body] of [
      ['/users', { name: 'x', email: 'x@y.co', phone: '+911234567890' }],
      [`/users/${u}/wallets`, {}],
      ['/transfers/topup', { wallet_id: w, amount: 1 }],
      ['/transfers', { from_wallet_id: w, to_wallet_id: w + 1, amount: 1 }],
      ['/transfers/withdraw', { wallet_id: w, amount: 1 }],
      ['/transfers/1/reverse', {}],
      [`/users/${u}/statement/ask`, { question: 'hi' }],
    ] as const) {
      const none = await api.post(url, body, { user: u, key: null });
      expect(none.status, url).toBe(400);
      expect(none.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
      const bad = await api.post(url, body, { user: u, key: 'not-a-uuid' });
      expect(bad.status, url).toBe(400);
    }
  });

  it('keys are unique PER USER: two users may use the same key independently', async () => {
    const a = await api.fundedUser('KA', 10_000);
    const b = await api.fundedUser('KB', 10_000);
    const key = randomUUID();
    const r1 = await api.post('/transfers', { from_wallet_id: a.walletId, to_wallet_id: b.walletId, amount: 100 }, { user: a.userId, key });
    const r2 = await api.post('/transfers', { from_wallet_id: b.walletId, to_wallet_id: a.walletId, amount: 100 }, { user: b.userId, key });
    expect([r1.status, r2.status]).toEqual([201, 201]);
    expect(r1.body.id).not.toBe(r2.body.id);
  });

  it('a business failure (insufficient funds) is saved too: replay returns the same 422, same request_id', async () => {
    const a = await api.fundedUser('FailA', 500);
    const b = await api.fundedUser('FailB', 0);
    const key = randomUUID();
    const body = { from_wallet_id: a.walletId, to_wallet_id: b.walletId, amount: 9_999 };
    const r1 = await api.post('/transfers', body, { user: a.userId, key });
    const r2 = await api.post('/transfers', body, { user: a.userId, key });
    expect(r1.status).toBe(422);
    expect(r2.raw).toBe(r1.raw);
    expect(r2.headers['idempotent-replay']).toBe('true');
  });

  it('a key reused on a DIFFERENT endpoint is rejected (the hash covers method + path)', async () => {
    const a = await api.fundedUser('PathA', 10_000);
    const key = randomUUID();
    expect((await api.post('/transfers/topup', { wallet_id: a.walletId, amount: 100 }, { user: a.userId, key })).status).toBe(201);
    const r = await api.post('/transfers/withdraw', { wallet_id: a.walletId, amount: 100 }, { user: a.userId, key });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('JSON key order and whitespace do not change the request hash', async () => {
    const a = await api.fundedUser('OrderA', 10_000);
    const key = randomUUID();
    const r1 = await api.post('/transfers/topup', { wallet_id: a.walletId, amount: 700 }, { user: a.userId, key });
    const r2 = await api.post('/transfers/topup', { amount: 700, wallet_id: a.walletId }, { user: a.userId, key });
    expect(r2.raw).toBe(r1.raw);
  });

  it('key and money commit TOGETHER: a crash after the transfer leaves neither, and the retry then works', async () => {
    const a = await api.fundedUser('CrashA', 10_000);
    const b = await api.fundedUser('CrashB', 0);
    const key = randomUUID();
    const base = { actor: { kind: 'user' as const, id: a.userId }, key, method: 'POST', path: '/transfers', body: { x: 1 }, requestId: 'r' };
    const mk = (crash: boolean) =>
      runIdempotent(db.pool, {
        ...base,
        handler: async (client) => {
          const o = await createTransfer(client, { type: 'PEER_TRANSFER', userId: a.userId, fromWalletId: a.walletId, toWalletId: b.walletId, amount: 1_000 });
          if (crash) throw new Error('process died after writing the transfer');
          return { status: 201, body: { id: o.transfer.id } };
        },
      });

    await expect(mk(true)).rejects.toThrow(/process died/);
    expect(await balanceOf(db.pool, a.walletId)).toBe(10_000); // money did not move
    expect((await db.pool.query('SELECT 1 FROM idempotency_keys WHERE key = $1', [key])).rowCount).toBe(0); // key not stored

    const retry = await mk(false); // client retries with the SAME key: now it really runs
    expect(retry.status).toBe(201);
    expect(await balanceOf(db.pool, a.walletId)).toBe(9_000);
    const replay = await mk(false);
    expect(replay.replay).toBe(true);
    expect(await balanceOf(db.pool, a.walletId)).toBe(9_000);
  });

  it('a held (202) response is replayed as 202 and still moves no money', async () => {
    const a = await api.fundedUser('HeldA', 9_000_000); // Rs 90,000
    const b = await api.fundedUser('HeldB', 0);
    const key = randomUUID();
    const body = { from_wallet_id: a.walletId, to_wallet_id: b.walletId, amount: 6_000_000 }; // > Rs 50,000 => LARGE_AMOUNT holds
    const r1 = await api.post('/transfers', body, { user: a.userId, key });
    const r2 = await api.post('/transfers', body, { user: a.userId, key });
    expect(r1.status).toBe(202);
    expect(r2.status).toBe(202);
    expect(r2.raw).toBe(r1.raw);
    expect(await balanceOf(db.pool, a.walletId)).toBe(9_000_000);
  });

  it('AppError thrown with 5xx status is NOT saved (retryable)', async () => {
    const key = randomUUID();
    const base = { actor: { kind: 'anonymous' as const }, key, method: 'POST', path: '/x', body: {}, requestId: 'r' };
    await expect(runIdempotent(db.pool, { ...base, handler: async () => { throw new AppError(503, 'UNAVAILABLE', 'try later'); } })).rejects.toThrow();
    const ok = await runIdempotent(db.pool, { ...base, handler: async () => ({ status: 200, body: { fine: true } }) });
    expect(ok.status).toBe(200);
    expect(ok.replay).toBe(false);
  });
});
