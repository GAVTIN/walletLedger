# Stretch: sharding and consistent hashing

Code: `src/shard/ring.ts`. Tests: `test/shard.test.ts`. This is a **routing library only**. The API still talks to one Postgres; nothing here is wired into the money path. I built the part that is easy to get wrong (the ring) and wrote down the part that is hard (cross-shard transfers) rather than pretending to have built it.

## 1. Why shard at all

One Postgres node eventually runs out of something: disk, memory for the working set, or write throughput on the busiest tables (`ledger_entries` grows by at least two rows per transfer). Read replicas help reads, not writes. Sharding splits the *wallets* across several independent databases.

## 2. Why `account_id % N` is a trap

With N = 4, account 17 lives on shard `17 % 4 = 1`. Add a fifth shard and it maps to `17 % 5 = 2`. A key keeps its shard only if `k % 4 == k % 5`, so roughly **80% of all wallets must move** (the test measures > 70% on 20,000 keys). Moving data between live databases while money is flowing is the riskiest operation you can run, so you want to move as little as possible.

## 3. The ring

* Hash each shard onto a circle of 2^32 positions, **160 times** (virtual nodes: one point per shard would give lumpy, uneven arcs).
* Hash a key onto the same circle; it belongs to the first point clockwise.
* Adding a shard only steals the arcs just before its own points, so keys move **only to the new shard** and about 1/(N+1) of them move. Removing a shard only reassigns that shard's keys to its neighbours.

What `test/shard.test.ts` proves, on 20,000 account ids:

| Property | Check |
|---|---|
| Deterministic, even spread | each of 4 shards within ±25% of ideal |
| Add a 5th shard | 10–30% of keys move (expected about 20%); every moved key went *to* `s5`, none shuffled between old shards; mod-N would move > 70% |
| Remove a shard | only that shard's keys change owner |
| Empty ring | throws instead of guessing |

We shard by **account id**, because the money path locks account rows. A transfer where both accounts hash to the same shard is still one ordinary local transaction, with every guarantee in this repo.

## 4. The hard part: a transfer across two shards

If sender and receiver live on different shards, there is no single transaction. Options:

| Option | How | Cost |
|---|---|---|
| **Two-phase commit** (`PREPARE TRANSACTION`) | Lock + prepare on both shards, then commit both | Prepared transactions hold row locks while the coordinator decides; a coordinator crash leaves them hanging until someone resolves them. Operationally nasty. |
| **Saga with a ledger on each side** (what I would build) | Shard A: debit sender, credit a per-shard *in-transit* system account, commit. Then shard B: debit its in-transit account, credit receiver, commit. A durable "transfer outbox" row drives step 2 with retries. If step 2 can never succeed, a compensating reversal on A returns the money. | Money is briefly "in flight"; reconciliation must check that all in-transit accounts net to zero globally. Every step must be idempotent, and the idempotency-key machinery already built here is exactly that. |
| Avoid it | Co-locate accounts that transact often (e.g. shard by *user*, not account, so a user's own wallets are always together) | Doesn't help peer-to-peer between users. |

Each shard keeps the double-entry invariant locally (debits = credits per shard), and the global invariant becomes "sum over shards of all balances, including in-transit accounts, is zero". The reconciliation job would run per shard plus one cross-shard check.

## 5. Things sharding does not fix

* **Hot accounts.** One merchant receiving thousands of payments per second is one row on one shard. The row lock serializes them (the same effect I measured with the `CASH_IN` system account). Fixes: split a hot account into N sub-accounts and sum them on read, or batch credits.
* **Resharding with live traffic.** The ring tells you *which* keys move; you still need dual-write or a freeze window per moved key. Moving a wallet means: lock it on the old shard, copy balance + entries, flip the routing, unlock.
* **Global queries** (the admin risk queue, nightly reconciliation) become scatter-gather.
* **System accounts** (`CASH_IN` etc.) must exist per shard or you create one global hot spot.
