import { createHash } from "node:crypto";

export const UINT32_MAX_PLUS_ONE = 0x100000000;

export class Xoshiro128StarStar {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;
  private drawCount: number;

  constructor(seedBytes: Uint8Array, initialDrawCount = 0) {
    if (seedBytes.length < 16) {
      throw new Error("xoshiro128ss requires at least 16 seed bytes");
    }
    const view = new DataView(seedBytes.buffer, seedBytes.byteOffset, seedBytes.byteLength);
    this.s0 = view.getUint32(0, true);
    this.s1 = view.getUint32(4, true);
    this.s2 = view.getUint32(8, true);
    this.s3 = view.getUint32(12, true);
    this.drawCount = initialDrawCount;
  }

  get draws(): number {
    return this.drawCount;
  }

  restore(snapshot: { state: [number, number, number, number]; draws: number }): this {
    this.s0 = snapshot.state[0] >>> 0;
    this.s1 = snapshot.state[1] >>> 0;
    this.s2 = snapshot.state[2] >>> 0;
    this.s3 = snapshot.state[3] >>> 0;
    this.drawCount = snapshot.draws;
    return this;
  }

  snapshot(): { state: [number, number, number, number]; draws: number } {
    return { state: [this.s0, this.s1, this.s2, this.s3], draws: this.drawCount };
  }

  nextUint32(): number {
    const result = Math.imul(rotl(Math.imul(this.s1, 5), 7), 9) >>> 0;
    const t = (this.s1 << 9) >>> 0;
    this.s2 ^= this.s0;
    this.s3 ^= this.s1;
    this.s1 ^= this.s2;
    this.s0 ^= this.s3;
    this.s2 ^= t;
    this.s3 = rotl(this.s3, 11);
    this.drawCount += 1;
    return result;
  }

  nextBelow(boundExclusive: number): number {
    if (!Number.isSafeInteger(boundExclusive) || boundExclusive <= 0) {
      throw new Error("nextBelow requires a positive safe integer bound");
    }
    if (boundExclusive > UINT32_MAX_PLUS_ONE) {
      throw new Error("bound exceeds uint32 range");
    }
    const bound = boundExclusive >>> 0;
    const threshold = (UINT32_MAX_PLUS_ONE - bound) % bound;
    for (;;) {
      const r = this.nextUint32();
      if (r >= threshold) {
        return r % bound;
      }
    }
  }

  nextFraction(): number {
    return this.nextUint32() / UINT32_MAX_PLUS_ONE;
  }
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

export const RNG_ALGORITHM_ID = "rng.xoshiro128ss.v1" as const;

export function deriveStreamSeed(inputs: string[]): Uint8Array {
  const joined = inputs.join("\0");
  return createHash("sha256").update(joined, "utf8").digest();
}
