# Digital wallet backend

A small but real money-moving backend: double-entry ledger, race-free transfers, idempotent retries, nightly reconciliation, fraud rules with LLM-written explanations, and a safe natural-language statement Q&A.

Stack: **Node 22 + TypeScript + Fastify + PostgreSQL 16, raw SQL via `pg`** (no ORM, so every lock and every money statement is visible in `src/ledger/transfers.ts`).

> New to backend? Read **[docs/UNDERSTANDING.md](docs/UNDERSTANDING.md)** first. It walks through the code in the order the money flows.

## Quick start

```bash
docker compose up            # Postgres + API (http://localhost:3000) + nightly worker
# or, without Docker (needs a local Postgres):
cp .env.example .env && npm ci && npm run migrate && npm run api
npm run seed                 # 1,000 users, 2,000 wallets, 100,000 transfers (~15 s)
bash scripts/demo.sh         # the 5-minute demo as a script, against a running API
npm test                     # 96 tests; needs Postgres reachable at TEST_ADMIN_URL
```

With no `ANTHROPIC_API_KEY` the LLM features use a built-in **mock model** (deterministic, offline). Set the key to use the real API (`LLM_MODEL` defaults to `claude-sonnet-5-5`).

## API

Auth is a stand-in (see Assumptions): users send `X-User-Id`, admins send `X-Admin-Token`. Every POST needs `Idempotency-Key: <uuid>`. Errors are always `{code, message, request_id}`. Money is always **integer paise**.

| Method + path | Who | Result |
|---|---|---|
| `POST /users` | anyone | 201 |
| `POST /users/{id}/wallets` | that user | 201 |
| `GET /wallets/{id}/balance` | owner | stored balance |
| `GET /wallets/{id}/statement?limit&offset` or `?cursor=` | owner | newest first; keyset cursor for deep pages |
| `POST /transfers/topup` | owner | 201 / 422 |
| `POST /transfers` (wallet to wallet) | owner of source | 201, **202 if held by a rule**, 422 insufficient funds |
| `POST /transfers/withdraw` | owner | 201 / 202 / 422 |
| `POST /transfers/{id}/reverse` | the user who initiated it (admins via the risk decision endpoint) | 201, a NEW transfer pointing at the original; 409 if already reversed (unique index) |
| `GET /transfers/{id}` | a party to it | transfer, entries, status history |
| `POST /users/{id}/statement/ask` | that user | `{question}` becomes a numeric answer (4 question types) |
| `POST /admin/reconciliation/run`, `GET /admin/reconciliation/runs/{id}` | admin | 202 `{started:true, run_id}` or 202 `{started:false}` if one is already running; then the report |
| `GET /admin/risk/queue`, `POST /admin/risk/{transfer_id}/decision` | admin | held transfers; `release` or `reverse` (on a HELD transfer, reverse = reject) |
| `GET /health` | anyone | |

## Layout

```
migrations/    001 core ledger, 002 idempotency, 003 reconciliation, 004 risk rules
src/ledger/    transfers.ts: THE money path (locks, overdraft check, entries)
src/http/      routes, auth, validation, idempotency wrapper
src/recon/     the 5 reconciliation checks (+ snapshot + job lock)
src/risk/      rules.ts (inline, in the transfer txn), explain.ts (nightly LLM)
src/qa/        statement Q&A: LLM returns JSON only, we run parameterized SQL
src/llm/       client interface, Anthropic client, mock
src/jobs/      nightly job + scheduler    src/shard/  consistent-hash ring (stretch)
scripts/       seed, labs that generate docs/*.md, demo.sh
test/          7 files, real Postgres, a fresh cloned database per file
docs/          schema, isolation lab, naive vs locked, explain plans, sharding, understanding
```

## Answers to the design questions

**1. Store the balance, or compute it from the ledger?** Both. `accounts.balance` is a *cache* updated in the same transaction as the ledger entries; the ledger is the truth. Computing every time is always right but costs a sum over the wallet's whole history on every balance read and on every overdraft check (and you would still need a lock to make "check then spend" safe). Storing is O(1) and gives us a row to lock, but it can drift from the ledger through a bug. So drift is made *detectable*: the nightly reconciliation recomputes balances from entries and reports any difference (`STORED_BALANCE`). `docs/naive-stampede.md` shows the cache lying (Rs 480 stored vs Rs -500 real) and reconciliation catching it.

**2. Why do wallets and system accounts share one table?** In double entry, cash-in, cash-out and fee revenue are just the other side of a transaction. If they were a different table, every ledger entry would need "which table does `account_id` point to?" and the "debits equal credits" invariant would need two code paths. One `accounts` table with `kind` keeps one foreign key and one path. The differences are constraints: system accounts have no owner and *may* go negative (`CASH_IN` goes negative as money enters the wallet world; that is correct).

**3. Why aren't email or phone primary keys?** They change, they are personal data (they would be copied into every foreign key, log line and URL), and a key must never be reused. Ids are `BIGINT` identities; email (case-insensitive) and phone are `UNIQUE` columns, so they are still protected from duplicates.

**4. Which isolation level, and why?** `READ COMMITTED` plus `SELECT ... FOR UPDATE` on both account rows, **always in ascending id order**. Ordered locking makes deadlock impossible between transfers (A to B and B to A both lock the lower id first; tested with 100 opposing transfers). Measured alternatives (`docs/naive-stampede.md`):
- No locks (naive): 100/100 "succeed", ledger says wallet is at Rs -500.
- `SERIALIZABLE` with a retry loop: correct, but it needed 2.0 aborted attempts per request at 5 writers and about 10 at 100, and every caller must write the retry loop right. Locking: zero aborts, requests just queue.
- The sender's row lock is also what makes the fraud rules race-free (a burst cannot be evaluated "at the same time").
The step-by-step two-session transcripts are in `docs/isolation.md`.

## Assumptions and honest disclosures

Read these. Some of them are things I could not know.

1. **The brief's rules table and idempotency-response table were blank** in the file I received (lost in conversion). I invented the four fraud rules (large amount, daily volume, velocity, new recipient; all thresholds are rows in `risk_rules`, so you can change them with an `UPDATE`) and inferred the idempotency semantics: same key + same request returns the saved response byte for byte; same key + different body returns 422; same key while the first is still running returns 409. Check these against your original.
2. **Auth is a stand-in**: `X-User-Id` / `X-Admin-Token`. Anyone could forge it. Real auth (JWT or sessions) replaces `authenticate()` in `src/http/context.ts` and nothing else.
3. **Held transfers do not reserve funds.** A held transfer writes no ledger entries; the money stays spendable until an admin releases it, and funds are re-checked at release (it can fail then). Reserving would need a holds account; I chose the simpler model and tested it.
4. Only KYC `REJECTED` blocks a transfer; `PENDING` can transact. A real product would decide this with compliance.
5. Date questions in Q&A use **IST (Asia/Kolkata)** month/day boundaries.
6. Q&A semantics: "sent to / received from" counts peer transfers between different users; "how many / largest" counts COMPLETED non-reversal transfers. Answers carry a `unit` (`paise` or `count`).
7. The withdrawal fee is optional (`WITHDRAWAL_FEE_PAISE`, default 0). When non-zero it is a third ledger entry to `FEE_REVENUE`.
8. **Seeded data bypasses the fraud rules** (bulk `unnest` insert, but every trigger and constraint still runs). The reconciliation after seeding is clean.
9. Reconciliation counts **issue rows, not root causes**: the 3 deliberate corruptions in the test produce 6 rows (1 global, 2 per-transfer, 3 stored-balance) because one broken entry shows up in several checks. That is expected and asserted.
10. **`CASH_IN` is a hot row.** Every top-up locks it, so top-ups serialize system-wide. Fine here; at scale you would split it into N cash-in accounts (see `docs/sharding.md` section 5).
11. **Docker/compose was not run**: the sandbox I built this in has no Docker daemon. The Dockerfile and compose file are straightforward and the same commands (`npm run migrate`, `tsx src/server.ts`) are what the tests and demo exercised, but treat `docker compose up` as untested until you run it once.
12. **There is no demo video.** I cannot record one. `scripts/demo.sh` performs the same five-minute story (transfer, retry, held transfer, reconciliation, Q&A) against a live API, and I ran it successfully.
13. The mock LLM understands the 10 sample questions in `test/fixtures/qa-samples.json` plus variations; it is not a language model. Behaviour with a real key was not tested (no key here). The safety design does not depend on the model behaving: its output is validated and the caller id comes from auth.

## What the measurements say

| Question | Answer | Where |
|---|---|---|
| Stampede: Rs 500, 100 x Rs 10, run 20 times | exactly 50 succeed, balance Rs 0, every time | `test/stampede.test.ts` |
| Naive version | 100/100 succeed, real balance Rs -500 | `docs/naive-stampede.md` |
| Cost of the fraud rules | +1.1 ms per transfer (16%) | `docs/rules-latency.md` |
| Reconciliation on 1.5M entries | all 7 queries about 3.6 s total | `docs/explain.md` |
| Statement page 100,000 deep | OFFSET 438 ms vs keyset 0.07 ms | `docs/explain.md` |
| Cost of the two ledger indexes | bulk insert about 3.2x slower | `docs/explain.md` |
| `transfer_id` index on ledger | helps only the per-transfer check (about 2x); the orphan checks scan anyway | `docs/explain.md` |

## Trade-offs I made

* **Stored balance** (fast, lockable) over computed-only, paid for with a nightly proof.
* **Locks** over SERIALIZABLE: simpler for callers, no aborts, but a hot wallet queues.
* **Rules run inline** in the transfer transaction (consistent, race-free) at about 1 ms; the LLM does *not*: it runs nightly, outside any transaction, so a slow or failing model can never block or break a payment.
* **Reconciliation reports, never fixes.** Auto-fixing a ledger hides the bug that caused it.
* **Append-only enforced in the database** (triggers), so even a buggy deploy cannot rewrite history; corrections are new reversing entries.

## What I would do next

1. Real authentication and authorization; rate limiting.
2. Funds reservation for held transfers.
3. Wire the shard router in, and build the cross-shard saga from `docs/sharding.md`.
4. Split `CASH_IN` into several accounts; partition `ledger_entries` by month once it passes a few hundred million rows.
5. Reconciliation on a replica with a long-running snapshot, plus alerting on non-empty reports.
6. Run the Q&A and explain prompts against a real model with an adversarial test set and log every question.
