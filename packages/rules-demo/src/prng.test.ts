import { describe, expect, it } from "vitest";
import { Xoshiro128StarStar, deriveStreamSeed, canonicalEncode, canonicalHash } from "@qiju/game-core";

describe("canonical-json.v1", () => {
  it("sorts object keys recursively and preserves array order", () => {
    const out = canonicalEncode({
      b: 1,
      a: { d: [3, 2, 1], c: "x" },
    } as never);
    expect(out).toBe('{"a":{"c":"x","d":[3,2,1]},"b":1}');
  });

  it("golden vector", () => {
    const hash = canonicalHash({ hello: "world", n: 42, list: [true, null, "x"] } as never);
    expect(hash).toBe("d1d98c029e1df49e2e6c2a9878ecef253c4543192b0463c468e022a612424a84");
  });

  it("rejects non-finite numbers", () => {
    expect(() => canonicalEncode(Number.NaN as never)).toThrow();
    expect(() => canonicalEncode(Number.POSITIVE_INFINITY as never)).toThrow();
  });
});

describe("rng.xoshiro128ss.v1", () => {
  it("is deterministic from the same seed", () => {
    const seed = deriveStreamSeed(["s", "h", "p"]);
    const a = new Xoshiro128StarStar(seed);
    const b = new Xoshiro128StarStar(seed);
    for (let i = 0; i < 100; i++) {
      expect(a.nextUint32()).toBe(b.nextUint32());
    }
  });

  it("differs across stream paths", () => {
    const a = new Xoshiro128StarStar(deriveStreamSeed(["s", "h", "lot/profile"]));
    const b = new Xoshiro128StarStar(deriveStreamSeed(["s", "h", "agent/seat1"]));
    expect(a.nextUint32()).not.toBe(b.nextUint32());
  });

  it("nextBelow stays within bound and is unbiased-shape", () => {
    const rng = new Xoshiro128StarStar(deriveStreamSeed(["s", "h", "p"]));
    for (let i = 0; i < 1000; i++) {
      const v = rng.nextBelow(7);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(7);
    }
  });

  it("snapshot and restore reproduce the sequence", () => {
    const seed = deriveStreamSeed(["s", "h", "p"]);
    const a = new Xoshiro128StarStar(seed);
    a.nextUint32();
    a.nextUint32();
    const snap = a.snapshot();
    const b = new Xoshiro128StarStar(seed).restore(snap);
    for (let i = 0; i < 50; i++) {
      expect(a.nextUint32()).toBe(b.nextUint32());
    }
  });

  it("reference vector: known seeds", () => {
    const rng = new Xoshiro128StarStar(new Uint8Array(16));
    const outputs = [rng.nextUint32(), rng.nextUint32(), rng.nextUint32(), rng.nextUint32()];
    expect(outputs).toEqual([0, 0, 0, 0]);
    const rng2 = new Xoshiro128StarStar(new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
    expect([rng2.nextUint32(), rng2.nextUint32(), rng2.nextUint32()]).toEqual([0, 5760, 5760]);
  });
});
