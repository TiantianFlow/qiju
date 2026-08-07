import { describe, expect, it } from "vitest";
import { normalizeBidInput } from "./bid";

const BUDGET = 2_000_000;

describe("normalizeBidInput", () => {
  it("passes in-range values through unchanged", () => {
    expect(normalizeBidInput("2000000", 0, BUDGET)).toEqual({ amount: 2_000_000, wasCapped: false });
    expect(normalizeBidInput("1500000", 0, BUDGET)).toEqual({ amount: 1_500_000, wasCapped: false });
    expect(normalizeBidInput("1", 0, BUDGET)).toEqual({ amount: 1, wasCapped: false });
    expect(normalizeBidInput("0", 0, BUDGET)).toEqual({ amount: 0, wasCapped: false });
  });

  it("caps above-budget values to the max and reports the cap", () => {
    expect(normalizeBidInput("10000000", 0, BUDGET)).toEqual({ amount: 2_000_000, wasCapped: true });
    expect(normalizeBidInput("2000001", 0, BUDGET)).toEqual({ amount: 2_000_000, wasCapped: true });
  });

  it("clamps below-min values to the min, preserving the previous clamp behavior", () => {
    expect(normalizeBidInput("-5", 0, BUDGET)).toEqual({ amount: 0, wasCapped: false });
    expect(normalizeBidInput("3", 10, BUDGET)).toEqual({ amount: 10, wasCapped: false });
  });

  it("treats blank and unparseable input as 0, like the previous inline clamp", () => {
    expect(normalizeBidInput("", 0, BUDGET)).toEqual({ amount: 0, wasCapped: false });
    expect(normalizeBidInput("abc", 0, BUDGET)).toEqual({ amount: 0, wasCapped: false });
  });

  it("handles boundary values exactly at min and max", () => {
    expect(normalizeBidInput("0", 0, BUDGET)).toEqual({ amount: 0, wasCapped: false });
    expect(normalizeBidInput(String(BUDGET), 0, BUDGET)).toEqual({ amount: BUDGET, wasCapped: false });
  });
});
