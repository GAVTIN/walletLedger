import { describe, expect, it } from 'vitest';
import { HashRing, shardForAccount } from '../src/shard/ring';

const keys = Array.from({ length: 20_000 }, (_, i) => i + 1);

describe('consistent hash ring', () => {
  it('is deterministic and spreads load roughly evenly', () => {
    const ring = new HashRing(['s1', 's2', 's3', 's4']);
    const count: Record<string, number> = {};
    for (const k of keys) {
      expect(shardForAccount(ring, k)).toBe(shardForAccount(ring, k));
      const s = shardForAccount(ring, k);
      count[s] = (count[s] ?? 0) + 1;
    }
    expect(Object.keys(count)).toHaveLength(4);
    for (const s of Object.keys(count)) {
      expect(count[s]).toBeGreaterThan((20_000 / 4) * 0.75); // within 25% of perfectly even
      expect(count[s]).toBeLessThan((20_000 / 4) * 1.25);
    }
  });

  it('adding a 5th shard moves only ~1/5 of the keys (modulo hashing would move ~80%)', () => {
    const ring = new HashRing(['s1', 's2', 's3', 's4']);
    const before = keys.map((k) => shardForAccount(ring, k));
    ring.add('s5');
    const after = keys.map((k) => shardForAccount(ring, k));
    const moved = keys.filter((_, i) => before[i] !== after[i]).length / keys.length;
    expect(moved).toBeGreaterThan(0.1);
    expect(moved).toBeLessThan(0.3);
    // every key that moved went TO the new shard; nothing reshuffled between the old shards
    keys.forEach((_, i) => {
      if (before[i] !== after[i]) expect(after[i]).toBe('s5');
    });
    const modMoved = keys.filter((k) => k % 4 !== k % 5).length / keys.length;
    expect(modMoved).toBeGreaterThan(0.7);
  });

  it("removing a shard only reassigns that shard's keys", () => {
    const ring = new HashRing(['s1', 's2', 's3', 's4']);
    const before = keys.map((k) => shardForAccount(ring, k));
    ring.remove('s2');
    keys.forEach((k, i) => {
      const now = shardForAccount(ring, k);
      if (before[i] !== 's2') expect(now).toBe(before[i]);
      else expect(now).not.toBe('s2');
    });
  });

  it('an empty ring refuses to guess', () => {
    expect(() => new HashRing().locate('x')).toThrow(/empty/);
  });
});
