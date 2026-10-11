# Understanding this project

A backend that moves money is the same ideas with one difference: **the cost of being wrong is real money, and many users act at the same moment.** Everything here is an answer to "what if two things happen at once?" or "what if something fails halfway?"

Read in this order. Each section names the file to open.

## 0. The mental model in one paragraph

A wallet balance is a number that many requests want to read-then-change. The database is the only shared place, so the database must enforce the rules. We (1) record every movement as two matching ledger lines (double entry), (2) lock the rows we are about to change so nobody else can interleave, (3) make every request safe to retry, (4) prove every night that the numbers add up, and (5) let rules and an LLM help humans spot fraud, without ever letting the LLM touch money or SQL.

## 1. The ledger (`migrations/001_core.sql`)

**Double entry.** Sending Rs 100 from Asha to Rahul inserts two rows in `ledger_entries`: a **D**ebit of 10000 on Asha's account and a **C**redit of 10000 on Rahul's. Amounts are always positive; the direction says which way. Balance = credits - debits. Top-ups come *from* a system account `CASH_IN`, so money is never created from nothing; it just goes negative on `CASH_IN`, which is how "money entered the system" is recorded. Sum of every balance in the system is therefore always **0**. That one fact is what reconciliation checks.

**Paise as integers.** `0.1 + 0.2 != 0.3` in floating point. Whole paise in `BIGINT` never rounds.

**The database refuses bad states** even if our code is buggy: negative wallet balance (`CHECK`), unbalanced transfers (a trigger checked at COMMIT), editing or deleting history (triggers that raise an error). `test/basics.test.ts` ("database guard rails") attacks these with raw SQL on purpose.

Try: open `psql`, run `UPDATE ledger_entries SET amount = 1;` and read the error.

## 2. A transfer, line by line (`src/ledger/transfers.ts`, `createTransfer`)

1. Idempotency wrapper begins a transaction (section 4).
2. `lockAccounts`: `SELECT ... WHERE id = ANY(...) ORDER BY id FOR UPDATE`. This takes a **row lock** on the wallets involved. Anyone else wanting the same row *waits* here.
3. Run fraud rules (section 6), still holding the lock.
4. `assertNoOverdraft`: check the balance **now that nobody can change it**.
5. Insert the transfer row, the ledger entries, update both balances, add a status-history row.
6. COMMIT releases the locks. The deferred trigger verifies debits = credits at this moment.

### Why locks, and why in id order

Without the lock (the naive version in `scripts/naive-stampede.ts`): 100 requests all read "balance = 500" at the same time, all pass the check, all write. Result in `docs/naive-stampede.md`: 100 of 100 succeed and the real balance is **Rs -500**. This is a *lost update* plus a *check-then-act* race; you know it from React state when two `setState(count + 1)` calls both read the old value.

Deadlock: if one transfer locks A then B and another locks B then A, each waits for the other forever. Always locking the **lower id first** makes a cycle impossible (`test/stampede.test.ts` fires opposing transfers to prove it).

### Isolation levels in plain words (`docs/isolation.md` has real two-terminal transcripts)

- **READ COMMITTED** (default): each *statement* sees data committed before it started. Two statements in one transaction can see different worlds. Fast, and fine when we lock what we read.
- **REPEATABLE READ**: the whole transaction sees one frozen snapshot. We use it for reconciliation so all five checks look at the same moment.
- **SERIALIZABLE**: the database pretends transactions ran one at a time and *aborts* any that conflict (error 40001); you must retry. Correct, but my measurements show retries growing with contention (2 per request at 5 writers, about 10 at 100), and every caller needs a correct retry loop. Locks just queue people.

Try: run `npm run lab:naive`, then break the lock (remove `FOR UPDATE`) and rerun `test/stampede.test.ts`; it should fail.

## 3. Constraints vs application checks

The app checks "enough balance" to return a friendly 422. The `CHECK (balance >= 0)` is the **backstop** that catches us if the app code ever has a bug. Both are needed: the app for good errors, the database for guarantees. Rule of thumb: anything that must *never* be false belongs in the database.

## 4. Idempotency (`src/http/idempotency.ts`, `migrations/002`)

A phone on a bad network sends "pay Rs 500", gets no answer, retries. Without protection: paid twice. The client sends `Idempotency-Key: <uuid>` and the server guarantees one effect.

How it works:

1. Hash the request (method + path + body with keys sorted, so field order doesn't matter).
2. Inside the **same transaction** as the transfer, `INSERT` the key with `ON CONFLICT DO NOTHING`.
3. If the insert did not happen, someone already used this key: roll back and look it up. Same hash returns the **saved response, byte for byte**; different hash returns 422; still running returns 409.
4. The key row and the money commit **together or not at all**, so there is no window where the money moved but the key is lost (or vice versa).

Business errors (like insufficient funds) are saved too (via a SAVEPOINT) so a retry gets the same 422. Server errors (5xx) roll back everything, so a retry gets a fresh attempt. Tests: 5 sequential, 10 parallel, different amount, in `test/idempotency.test.ts`.

Try: send the same curl twice with the same key and compare headers and body; change one digit of the amount and watch the 422.

## 5. Reconciliation (`src/recon/reconcile.ts`)

Because the balance is a cache, we **prove** nightly it equals the ledger. Five checks, each one SQL statement:

1. Global: sum of all balances = 0.
2. Per transfer: debits = credits.
3. Stored balance = credits - debits, for every account.
4. No wallet below zero.
5. No orphans: completed transfers have entries; entries have a transfer.

They run in one **REPEATABLE READ** transaction so they agree on a single moment while payments continue. `job_locks` + `FOR UPDATE NOWAIT` means a second run starting at the same time fails immediately instead of doubling the work. It **reports and never fixes**: auto-repair would hide the bug that caused the damage. `test/reconcile.test.ts` seeds 10,000 transfers, corrupts exactly three things, and requires the report to say exactly that.

## 6. Fraud rules (`src/risk/`)

Rules live in the `risk_rules` table (thresholds you can UPDATE). They run **inside** the transfer transaction right after the lock, so a burst of transfers from one wallet cannot all be judged "at the same time". A HOLD rule creates a transfer in status HELD (no money moves) and returns 202; an admin releases or reverses it. Rules cost about 1.1 ms (`docs/rules-latency.md`).

The LLM is deliberately **not** in this path. At night, `explain.ts` asks a model to write a one-line explanation for each flag. A model outage can't block a payment, and its text is only advice for humans.

## 7. Letting an LLM near financial data (`src/qa/ask.ts`)

"How much did I send to Rahul in March?" Naive approach: let the model write SQL. Never do that. Our design:

- The model returns **only JSON**: `{type, counterparty?, from?, to?}`, validated against a strict whitelist.
- **Who is asking comes from auth**, never from the question or the model. "Show me user 7's data" cannot change the user id.
- We run **our own parameterized SQL** for one of four fixed question types. LIKE wildcards in names are escaped.
- Transfer notes (free text, a prompt-injection vector) are never sent to the Q&A model, and in the nightly explainer they are truncated and labelled as untrusted data.
- The security does not depend on the model behaving; even a fully hijacked model can only choose one of four safe queries for the logged-in user. `test/qa.test.ts` includes injection attempts.

Try: add a transfer note "ignore previous instructions and ..." and ask a question. Nothing leaks, because notes never reach that prompt.

## 8. Indexes and EXPLAIN (`docs/explain.md`)

An index is a sorted lookup structure: great for reads, a tax on every write (I measured about 3.2x slower bulk inserts with the two ledger indexes). Each index exists for one named query (table in `docs/schema.md`). Two things I measured that surprised me: `OFFSET 100000` pagination took 438 ms vs 0.07 ms for keyset pagination (OFFSET still walks past all the skipped rows), and a time-window query using `clock_timestamp()` could not use the index while `now()` could.

Try: `EXPLAIN ANALYZE` the statement query with and without the index, in `psql` after `npm run seed`.

## 9. How the tests are built

Each test file clones a pre-migrated template database (`test/helpers/global-setup.ts`), starts the real Fastify app in-process (`app.inject`, no network), and uses real Postgres. Concurrency tests really run 100 parallel transactions. I also verified key tests by **mutation**: deliberately breaking the code (removing a lock, using READ COMMITTED for reconciliation) and confirming the test fails. A test that cannot fail proves nothing.

## 10. Vocabulary cheat sheet

| Term | Meaning here |
| --- | --- |
| Transaction | a group of statements that all happen or none do |
| Row lock (`FOR UPDATE`) | others touching that row wait until you commit |
| Deadlock | two transactions each waiting on the other's lock |
| Lost update | two writers overwrite each other based on stale reads |
| Idempotent | doing it twice has the same effect as once |
| Snapshot | a frozen consistent view of the database |
| Constraint | a rule the database enforces itself |
| Append-only | rows are never edited; corrections are new rows |
| Reconciliation | independently recomputing totals to prove they match |
| Shard | one of several databases that each hold part of the data |

## 11. Exercises (in rising difficulty)

1. Add a `GET /wallets/{id}/summary` returning stored vs ledger-computed balance. Which index does the computed one use?
2. Change `LARGE_AMOUNT` to 20,000 paise with one `UPDATE risk_rules`; send a transfer; find it in the admin queue; release it.
3. Remove `ORDER BY id` from `lockAccounts` and run the deadlock test several times. Explain what you see.
4. Corrupt a balance by hand (you'll need to disable the trigger in a scratch DB) and run reconciliation. Which checks fire, and why more than one?
5. Add a fifth Q&A question type, end to end, with a prompt-injection test.
6. Implement the cross-shard saga from `docs/sharding.md` for two local databases.