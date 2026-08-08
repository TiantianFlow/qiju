import { describe, expect, it } from "vitest";
import { computeVersionString } from "./version";

const ts = (iso: string) => Math.floor(Date.parse(iso) / 1000);

describe("computeVersionString", () => {
  it("uses .1 when the built commit is the only commit on its UTC date", () => {
    // newest first, as `git log` emits them
    expect(
      computeVersionString([ts("2026-08-08T10:00:00Z"), ts("2026-08-07T09:00:00Z"), ts("2026-08-07T08:00:00Z")]),
    ).toBe("2026-08-08.1");
  });

  it("counts same-day commits up to and including the built commit", () => {
    expect(
      computeVersionString([
        ts("2026-08-08T18:00:00Z"),
        ts("2026-08-08T10:00:00Z"),
        ts("2026-08-08T02:00:00Z"),
        ts("2026-08-07T23:59:59Z"),
      ]),
    ).toBe("2026-08-08.3");
  });

  it("splits days on the UTC boundary", () => {
    expect(computeVersionString([ts("2026-08-09T00:00:01Z"), ts("2026-08-08T23:59:59Z")])).toBe("2026-08-09.1");
    expect(computeVersionString([ts("2026-08-08T23:59:59Z"), ts("2026-08-08T00:00:01Z")])).toBe("2026-08-08.2");
  });

  it("falls back to dev when there is no commit history", () => {
    expect(computeVersionString([])).toBe("dev");
  });
});
