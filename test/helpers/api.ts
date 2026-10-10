import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { config } from '../../src/config';
import type { Pool } from '../../src/db';
import { buildApp } from '../../src/http/app';
import type { LlmClient } from '../../src/llm/client';
import { MockLlm } from '../../src/llm/mock';

export type Res = { status: number; body: any; headers: Record<string, unknown>; raw: string };

export async function makeApi(pool: Pool, llm: LlmClient = new MockLlm(() => '{"type":0}'), cfg = config) {
  const app: FastifyInstance = await buildApp({ pool, llm, config: cfg });

  async function call(method: 'GET' | 'POST', url: string, opts: { user?: number; admin?: boolean; key?: string | null; body?: unknown } = {}): Promise<Res> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (opts.user !== undefined) headers['x-user-id'] = String(opts.user);
    if (opts.admin) headers['x-admin-token'] = cfg.adminToken;
    if (method === 'POST' && opts.key !== null) headers['idempotency-key'] = opts.key ?? randomUUID();
    const res = await app.inject({ method, url, headers, payload: method === 'POST' ? JSON.stringify(opts.body ?? {}) : undefined });
    return { status: res.statusCode, raw: res.body, body: res.body ? JSON.parse(res.body) : null, headers: res.headers };
  }
  const post = (url: string, body: unknown, o: { user?: number; admin?: boolean; key?: string | null } = {}) => call('POST', url, { ...o, body });
  const get = (url: string, o: { user?: number; admin?: boolean } = {}) => call('GET', url, o);

  let n = 0;
  async function createUser(name = 'Test User') {
    n++;
    const r = await post('/users', { name, email: `u${n}-${randomUUID().slice(0, 8)}@example.com`, phone: `+9199${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}${n % 10}` });
    if (r.status !== 201) throw new Error(`createUser failed ${r.status} ${r.raw}`);
    return r.body.id as number;
  }
  async function openWallet(userId: number, name = 'main') {
    const r = await post(`/users/${userId}/wallets`, { name }, { user: userId });
    if (r.status !== 201) throw new Error(`openWallet failed ${r.status} ${r.raw}`);
    return r.body.id as number;
  }
  async function topup(userId: number, walletId: number, amount: number) {
    const r = await post('/transfers/topup', { wallet_id: walletId, amount }, { user: userId });
    if (r.status !== 201) throw new Error(`topup failed ${r.status} ${r.raw}`);
    return r.body;
  }
  /** user + funded wallet in one go */
  async function fundedUser(name: string, amount: number) {
    const userId = await createUser(name);
    const walletId = await openWallet(userId);
    if (amount > 0) await topup(userId, walletId, amount);
    return { userId, walletId };
  }
  return { app, call, post, get, createUser, openWallet, topup, fundedUser };
}
export type Api = Awaited<ReturnType<typeof makeApi>>;

export async function balanceOf(pool: Pool, walletId: number): Promise<number> {
  return (await pool.query<{ balance: number }>('SELECT balance FROM accounts WHERE id = $1', [walletId])).rows[0].balance;
}

export async function ledgerTotals(pool: Pool) {
  const r = await pool.query<{ d: number; c: number }>(
    `SELECT COALESCE(SUM(amount) FILTER (WHERE direction='D'),0) AS d, COALESCE(SUM(amount) FILTER (WHERE direction='C'),0) AS c FROM ledger_entries`,
  );
  return r.rows[0];
}
