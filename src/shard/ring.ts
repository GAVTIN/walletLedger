import { createHash } from 'node:crypto';

/**
 * Consistent-hash ring (stretch milestone: sharding).
 *
 * Problem: one Postgres can't hold every wallet forever. We split wallets across N
 * databases ("shards"). The simplest rule `shard = account_id % N` has a fatal flaw: change
 * N from 4 to 5 and ~80% of wallets map to a different shard, so you would have to move
 * almost all your data. A consistent-hash ring moves only ~1/(N+1) of the keys.
 *
 * How it works: each shard is hashed onto a circle MANY times ("virtual nodes", so load
 * evens out). A key is hashed onto the same circle and belongs to the first virtual node
 * clockwise from it.
 */
export class HashRing {
  private points: { hash: number; shard: string }[] = [];

  constructor(shards: string[] = [], private readonly vnodes = 160) {
    for (const s of shards) this.add(s);
  }

  /** 32-bit position on the circle. */
  static hash(s: string): number {
    return createHash('md5').update(s).digest().readUInt32BE(0);
  }

  add(shard: string): void {
    for (let i = 0; i < this.vnodes; i++) this.points.push({ hash: HashRing.hash(`${shard}#${i}`), shard });
    this.points.sort((a, b) => a.hash - b.hash);
  }

  remove(shard: string): void {
    this.points = this.points.filter((p) => p.shard !== shard);
  }

  shardsList(): string[] {
    return [...new Set(this.points.map((p) => p.shard))];
  }

  /** The shard that owns this key (binary search for the first point >= hash(key), wrapping around). */
  locate(key: string | number): string {
    if (this.points.length === 0) throw new Error('ring is empty');
    const h = HashRing.hash(String(key));
    let lo = 0;
    let hi = this.points.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.points[mid].hash < h) lo = mid + 1;
      else hi = mid;
    }
    return this.points[lo === this.points.length ? 0 : lo].shard;
  }
}

/**
 * Which shard owns an ACCOUNT. We shard by account id (the wallet), because the money path
 * locks account rows: a transfer whose two accounts live on the SAME shard is still one
 * ordinary local transaction. A transfer across shards is not (see docs/sharding.md).
 */
export const shardForAccount = (ring: HashRing, accountId: number) => ring.locate(`account:${accountId}`);
