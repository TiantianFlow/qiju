import { describe, expect, it } from "vitest";
import { consumeAuthOutcome, fetchLeaderboard, fetchMe, startOAuthSignIn } from "./auth";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("consumeAuthOutcome", () => {
  it("returns null and leaves the URL untouched when auth= is absent", () => {
    const { outcome, cleanUrl } = consumeAuthOutcome("?offset=50", "/leaderboard");
    expect(outcome).toBeNull();
    expect(cleanUrl).toBe("/leaderboard?offset=50");
  });

  it.each(["ok", "cancelled", "conflict", "expired", "restart", "failed"] as const)(
    "recognizes auth=%s and strips it from the URL",
    (expected) => {
      const { outcome, cleanUrl } = consumeAuthOutcome(`?auth=${expected}`, "/account");
      expect(outcome).toBe(expected);
      expect(cleanUrl).toBe("/account");
    },
  );

  it("strips auth= while preserving other query params", () => {
    const { outcome, cleanUrl } = consumeAuthOutcome("?auth=ok&x=1", "/account");
    expect(outcome).toBe("ok");
    expect(cleanUrl).toBe("/account?x=1");
  });

  it("maps an unknown auth= value to null but still strips it", () => {
    const { outcome, cleanUrl } = consumeAuthOutcome("?auth=bogus", "/account");
    expect(outcome).toBeNull();
    expect(cleanUrl).toBe("/account");
  });
});

describe("fetchMe", () => {
  it("returns the principal payload on 200", async () => {
    const me = await fetchMe(async () =>
      jsonResponse(200, { principal: "account", playerLabel: "Player-ABCDEF" }),
    );
    expect(me).toEqual({ principal: "account", playerLabel: "Player-ABCDEF" });
  });

  it("returns null on 404 (feature flag off) — quietly, no throw", async () => {
    const me = await fetchMe(async () => jsonResponse(404, { error: "MATCH_NOT_FOUND_OR_FORBIDDEN" }));
    expect(me).toBeNull();
  });

  it("returns null on other non-OK statuses and network failure", async () => {
    expect(await fetchMe(async () => jsonResponse(503, { error: "x" }))).toBeNull();
    expect(
      await fetchMe(async () => {
        throw new Error("network down");
      }),
    ).toBeNull();
  });

  it("returns null on a malformed body", async () => {
    expect(await fetchMe(async () => jsonResponse(200, { principal: "wizard" }))).toBeNull();
  });
});

describe("fetchLeaderboard", () => {
  const entry = {
    rank: 1,
    playerLabel: "Player-123ABC",
    isSelf: false,
    pocketBalance: 2021000,
    wins: 12,
    losses: 8,
    pushes: 1,
    matchesPlayed: 21,
  };

  it("requests the given page and returns entries/total/nextOffset", async () => {
    const calls: string[] = [];
    const page = await fetchLeaderboard(50, 25, async (input) => {
      calls.push(String(input));
      return jsonResponse(200, { entries: [entry], total: 60, nextOffset: 55 });
    });
    expect(calls[0]).toContain("/api/v1/leaderboard?offset=50&limit=25");
    expect(page).toEqual({ entries: [entry], total: 60, nextOffset: 55 });
  });

  it("maps a non-numeric nextOffset to null", async () => {
    const page = await fetchLeaderboard(0, 50, async () =>
      jsonResponse(200, { entries: [entry], total: 1, nextOffset: null }),
    );
    expect(page?.nextOffset).toBeNull();
  });

  it("returns null on 404 (flag off), 503, network failure, and malformed bodies", async () => {
    expect(await fetchLeaderboard(0, 50, async () => jsonResponse(404, {}))).toBeNull();
    expect(await fetchLeaderboard(0, 50, async () => jsonResponse(503, {}))).toBeNull();
    expect(
      await fetchLeaderboard(0, 50, async () => {
        throw new Error("boom");
      }),
    ).toBeNull();
    expect(
      await fetchLeaderboard(0, 50, async () => jsonResponse(200, { entries: "nope" })),
    ).toBeNull();
  });
});

describe("startOAuthSignIn", () => {
  it("POSTs JSON with the custom header and navigates top-level to redirectUrl", async () => {
    let captured: { url: string; init: RequestInit | undefined } | null = null;
    const assigned: string[] = [];
    const ok = await startOAuthSignIn(
      "/account",
      async (input, init) => {
        captured = { url: String(input), init };
        return jsonResponse(200, { redirectUrl: "https://provider.example/auth?x=1" });
      },
      "http://api.test",
      (url) => assigned.push(url),
    );
    expect(ok).toBe(true);
    expect(captured!.url).toBe("http://api.test/api/v1/auth/oauth/start");
    expect(captured!.init?.method).toBe("POST");
    const headers = new Headers(captured!.init?.headers);
    expect(headers.get("X-Lotveil-Request")).toBe("oauth");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String(captured!.init?.body))).toEqual({
      provider: "google",
      returnTo: "/account",
    });
    expect(assigned).toEqual(["https://provider.example/auth?x=1"]);
  });

  it("returns false without navigating on 404/4xx, malformed bodies, or network failure", async () => {
    const assigned: string[] = [];
    const navigate = (url: string) => assigned.push(url);
    const fail404 = await startOAuthSignIn(
      "/account",
      async () => jsonResponse(404, { error: "off" }),
      "http://api.test",
      navigate,
    );
    const fail401 = await startOAuthSignIn(
      "/account",
      async () => jsonResponse(401, { error: "x" }),
      "http://api.test",
      navigate,
    );
    const malformed = await startOAuthSignIn(
      "/account",
      async () => jsonResponse(200, {}),
      "http://api.test",
      navigate,
    );
    const down = await startOAuthSignIn(
      "/account",
      async () => {
        throw new Error("down");
      },
      "http://api.test",
      navigate,
    );
    expect([fail404, fail401, malformed, down]).toEqual([false, false, false, false]);
    expect(assigned).toEqual([]);
  });
});
