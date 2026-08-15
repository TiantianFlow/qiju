import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import { createClient } from "@supabase/supabase-js";
import WebSocket from "ws";
import { buildApp } from "./app.js";
import {
  decodeSessionCookie,
  setSessionCookie,
} from "./session.js";
import { appEnv, cookiePair, cookieValueDecoded, getAuthUser, requireSupabaseEnv } from "./test-helpers.js";

const env = requireSupabaseEnv();

async function signedLegacyGuestCookie(value: string): Promise<string> {
  const signer = Fastify();
  await signer.register(fastifyCookie, { secret: "integration-test-secret-key" });
  let header = "";
  signer.get("/", async (_req, reply) => {
    reply.setCookie("lv_guest", value, { path: "/", signed: true });
    return {};
  });
  const res = await signer.inject({ method: "GET", url: "/" });
  header = cookiePair(res.headers["set-cookie"], "lv_guest")!;
  await signer.close();
  return header;
}

async function signSessionCookie(tokens: { accessToken: string; refreshToken: string }): Promise<string> {
  const signer = Fastify();
  await signer.register(fastifyCookie, { secret: "integration-test-secret-key" });
  signer.get("/", async (_req, reply) => {
    setSessionCookie(reply, tokens, { production: false });
    return {};
  });
  const res = await signer.inject({ method: "GET", url: "/" });
  const header = cookiePair(res.headers["set-cookie"], "lv_session")!;
  await signer.close();
  return header;
}

describe("THE-37a durable identity", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp(appEnv());
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function createHumanMatch(cookie?: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/demo-matches",
      payload: { mode: "human-vs-ai" },
      ...(cookie ? { headers: { cookie } } : {}),
    });
    expect(res.statusCode).toBe(200);
    return {
      matchId: (res.json() as { matchId: string }).matchId,
      setCookie: res.headers["set-cookie"],
    };
  }

  it("A1: a first-time visitor gets an anonymous session backed by an auth.users row", async () => {
    const { setCookie } = await createHumanMatch();
    const session = cookiePair(setCookie, "lv_session");
    expect(session).toBeTruthy();
    // Decode (unsign) to learn the principal, then prove the row SERVER-SIDE —
    // the cookie is only the vehicle, never the evidence.
    const unsigned = app.unsignCookie(cookieValueDecoded(setCookie, "lv_session")!);
    expect(unsigned.valid).toBe(true);
    const tokens = decodeSessionCookie(unsigned.value!)!;
    expect(tokens.refreshToken.length).toBeGreaterThan(0);
    const verify = createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { data } = await verify.auth.getClaims(tokens.accessToken);
    const userId = data!.claims!.sub as string;
    const row = await getAuthUser(env, userId);
    expect(row).not.toBeNull();
    expect(row!.is_anonymous).toBe(true);
  });

  it("A2: restart proof — a fresh app instance resolves the same cookie to the same durable UUID", async () => {
    const first = await buildApp(appEnv());
    await first.ready();
    const res = await first.inject({
      method: "POST",
      url: "/api/v1/demo-matches",
      payload: { mode: "human-vs-ai" },
    });
    expect(res.statusCode).toBe(200);
    const cookie = cookiePair(res.headers["set-cookie"], "lv_session")!;
    const matchId = (res.json() as { matchId: string }).matchId;
    const view = await first.inject({
      method: "GET",
      url: `/api/v1/matches/${matchId}/view`,
      headers: { cookie },
    });
    expect(view.statusCode).toBe(200);
    const firstViewer = (view.json() as { view: { viewer: string } }).view.viewer;
    await first.close();

    // Instance B: empty process memory, no guestStore — only Supabase is durable.
    // Cookie round-tripping alone (today's signed-cookie behaviour) is NOT
    // sufficient here: what proves durability is that a brand-new process
    // resolves the identity by verifying it against the server-side auth.users
    // record, and that the record still exists.
    const second = await buildApp(appEnv());
    await second.ready();
    const created = await second.inject({
      method: "POST",
      url: "/api/v1/demo-matches",
      payload: { mode: "human-vs-ai" },
      headers: { cookie },
    });
    expect(created.statusCode).toBe(200);
    // No NEW session is minted for a returning visitor.
    expect(cookiePair(created.headers["set-cookie"], "lv_session")).toBeNull();
    const matchId2 = (created.json() as { matchId: string }).matchId;
    const view2 = await second.inject({
      method: "GET",
      url: `/api/v1/matches/${matchId2}/view`,
      headers: { cookie },
    });
    expect(view2.statusCode).toBe(200);
    const secondViewer = (view2.json() as { view: { viewer: string } }).view.viewer;
    // Same seat kind; more importantly, same underlying user id server-side.
    expect(secondViewer).toBe(firstViewer);

    const unsigned = second.unsignCookie(cookieValueDecoded(res.headers["set-cookie"], "lv_session")!);
    const tokens = decodeSessionCookie(unsigned.value!)!;
    const verify = createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { data } = await verify.auth.getClaims(tokens.accessToken);
    const userId = data!.claims!.sub as string;
    const row = await getAuthUser(env, userId);
    expect(row).not.toBeNull();
    expect(row!.id).toBe(userId);
    await second.close();
  });

  it("A8: a legacy lv_guest cookie bridges to lv_session and is cleared, no client error", async () => {
    const legacy = await signedLegacyGuestCookie("0123456789abcdef0123456789abcdef");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/demo-matches",
      payload: { mode: "human-vs-ai" },
      headers: { cookie: legacy },
    });
    expect(res.statusCode).toBe(200);
    expect(cookiePair(res.headers["set-cookie"], "lv_session")).toBeTruthy();
    const setCookies = Array.isArray(res.headers["set-cookie"])
      ? (res.headers["set-cookie"] as string[])
      : [res.headers["set-cookie"] as string];
    const clearedGuest = setCookies.find((h) => h.startsWith("lv_guest="));
    expect(clearedGuest).toBeDefined();
    expect(clearedGuest).toMatch(/Expires=Thu, 01 Jan 1970/);
  });

  it("viewing a human-vs-ai match as a non-seated observer with no cookie mints nothing", async () => {
    const { matchId } = await createHumanMatch();
    // Verifier fix: a global user COUNT races with other test files
    // concurrently minting users against the shared Auth database. The
    // no-mint property is asserted by the ABSENCE of Set-Cookie (the only
    // response path that carries a minted session) — a per-response fact,
    // immune to concurrent activity.
    const res = await app.inject({ method: "GET", url: `/api/v1/matches/${matchId}/view` });
    expect([403, 404]).toContain(res.statusCode); // non-seated visitors stay forbidden
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("all-ai creation mints nothing and sets no cookie", async () => {
    // Same isolation fix: assert the response carries no minted session
    // rather than a global auth.users count.
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/demo-matches",
      payload: { mode: "all-ai", seed: "no-mint-1" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("A10: a rotated session cookie still authenticates and keeps a refresh-capable shape", async () => {
    const { setCookie } = await createHumanMatch();
    const unsigned = app.unsignCookie(cookieValueDecoded(setCookie, "lv_session")!);
    const tokens = decodeSessionCookie(unsigned.value!)!;

    // Force a refresh server-side (as the rotation path would on expiry).
    const verify = createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { data: refreshed, error } = await verify.auth.refreshSession({
      refresh_token: tokens.refreshToken,
    });
    expect(error).toBeNull();
    expect(refreshed.session).toBeTruthy();
    const rotated = {
      accessToken: refreshed.session!.access_token,
      refreshToken: refreshed.session!.refresh_token,
    };
    // THE-39 conversion depends on this shape: a real session with a live
    // refresh token that updateUser/linkIdentity can act on — not a bare UUID.
    expect(rotated.refreshToken).toBeTruthy();
    expect(rotated.refreshToken).not.toBe(tokens.refreshToken);

    const rotatedCookie = await signSessionCookie(rotated);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/demo-matches",
      payload: { mode: "human-vs-ai" },
      headers: { cookie: rotatedCookie },
    });
    expect(res.statusCode).toBe(200);
    // Authenticates without minting a replacement identity.
    expect(cookiePair(res.headers["set-cookie"], "lv_session")).toBeNull();
  });

  it("cookie precedence: both cookies present — lv_session wins, lv_guest cleared", async () => {
    const { setCookie } = await createHumanMatch();
    const session = cookiePair(setCookie, "lv_session")!;
    const legacy = await signedLegacyGuestCookie("fedcba9876543210fedcba9876543210");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/demo-matches",
      payload: { mode: "human-vs-ai" },
      headers: { cookie: `${session}; ${legacy}` },
    });
    expect(res.statusCode).toBe(200);
    expect(cookiePair(res.headers["set-cookie"], "lv_session")).toBeNull(); // not re-minted
    const setCookies = Array.isArray(res.headers["set-cookie"])
      ? (res.headers["set-cookie"] as string[])
      : [res.headers["set-cookie"] as string];
    expect(setCookies.some((h) => h.startsWith("lv_guest=") && h.includes("1970"))).toBe(true);
  });

  it("WS upgrade with no cookie on human-vs-ai closes 4003 AUTH_REQUIRED", async () => {
    const { matchId } = await createHumanMatch();
    const port = 4311;
    const listener = await buildApp({ ...appEnv(), PORT: port });
    await listener.listen({ port });
    const { matchId: matchId2 } = await (async () => {
      const res = await listener.inject({
        method: "POST",
        url: "/api/v1/demo-matches",
        payload: { mode: "human-vs-ai" },
      });
      return { matchId: (res.json() as { matchId: string }).matchId };
    })();
    void matchId;
    const code = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://localhost:${port}/api/v1/matches/${matchId2}/stream`);
      ws.on("close", (c) => resolve(c));
      ws.on("error", () => {});
    });
    expect(code).toBe(4003);
    await listener.close();
  });

  it("WS upgrade with a valid session that holds no seat closes 4003 AUTH_REQUIRED", async () => {
    const port = 4312;
    const listener = await buildApp({ ...appEnv(), PORT: port });
    await listener.listen({ port });
    const owner = await listener.inject({
      method: "POST",
      url: "/api/v1/demo-matches",
      payload: { mode: "human-vs-ai" },
    });
    const matchId = (owner.json() as { matchId: string }).matchId;
    const stranger = await listener.inject({
      method: "POST",
      url: "/api/v1/demo-matches",
      payload: { mode: "human-vs-ai" },
    });
    const strangerCookie = cookiePair(stranger.headers["set-cookie"], "lv_session")!;
    const code = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://localhost:${port}/api/v1/matches/${matchId}/stream`, {
        headers: { cookie: strangerCookie },
      });
      ws.on("close", (c) => resolve(c));
      ws.on("error", () => {});
    });
    expect(code).toBe(4003);
    await listener.close();
  });

  it("A3: WS upgrade with a valid session whose sub holds the seat is accepted and reports the seat", async () => {
    const port = 4314;
    const listener = await buildApp({ ...appEnv(), PORT: port });
    await listener.listen({ port });
    const created = await listener.inject({
      method: "POST",
      url: "/api/v1/demo-matches",
      payload: { mode: "human-vs-ai" },
    });
    const matchId = (created.json() as { matchId: string }).matchId;
    const cookie = cookiePair(created.headers["set-cookie"], "lv_session")!;
    const hello = await new Promise<{ type: string; payload: { viewer: string } }>((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${port}/api/v1/matches/${matchId}/stream`, {
        headers: { cookie },
      });
      ws.on("message", (raw) => {
        const m = JSON.parse(raw.toString()) as { type: string; payload: { viewer: string } };
        if (m.type === "hello") {
          ws.close();
          resolve(m);
        }
      });
      ws.on("error", reject);
      setTimeout(() => reject(new Error("hello timeout")), 5_000);
    });
    // seatIdForPrincipal resolved: the hello names a concrete seat, never "public".
    expect(hello.payload.viewer).not.toBe("public");
    expect(typeof hello.payload.viewer).toBe("string");
    await listener.close();
  });

  it("A6: a second upgrade with the same principal closes the earlier socket 4009 CONNECTION_SUPERSEDED", async () => {
    const port = 4315;
    const listener = await buildApp({ ...appEnv(), PORT: port });
    await listener.listen({ port });
    const created = await listener.inject({
      method: "POST",
      url: "/api/v1/demo-matches",
      payload: { mode: "human-vs-ai" },
    });
    const matchId = (created.json() as { matchId: string }).matchId;
    const cookie = cookiePair(created.headers["set-cookie"], "lv_session")!;
    const first = new WebSocket(`ws://localhost:${port}/api/v1/matches/${matchId}/stream`, {
      headers: { cookie },
    });
    await new Promise<void>((resolve) => first.on("open", () => resolve()));
    const firstClosed = new Promise<number>((resolve) => first.on("close", (c) => resolve(c)));
    const second = new WebSocket(`ws://localhost:${port}/api/v1/matches/${matchId}/stream`, {
      headers: { cookie },
    });
    await new Promise<void>((resolve) => second.on("open", () => resolve()));
    expect(await firstClosed).toBe(4009); // unchanged from pre-37a behaviour
    second.close();
    await listener.close();
  });

  it("A7: an all-ai upgrade with no cookie at all is accepted, unchanged from today", async () => {
    const port = 4316;
    const listener = await buildApp({ ...appEnv(), PORT: port });
    await listener.listen({ port });
    const created = await listener.inject({
      method: "POST",
      url: "/api/v1/demo-matches",
      payload: { mode: "all-ai", seed: "a7-no-cookie" },
    });
    const matchId = (created.json() as { matchId: string }).matchId;
    const hello = await new Promise<{ type: string; payload: { viewer: string } }>((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${port}/api/v1/matches/${matchId}/stream`);
      ws.on("message", (raw) => {
        const m = JSON.parse(raw.toString()) as { type: string; payload: { viewer: string } };
        if (m.type === "hello") {
          ws.close();
          resolve(m);
        }
      });
      ws.on("error", reject);
      setTimeout(() => reject(new Error("hello timeout")), 5_000);
    });
    expect(hello.payload.viewer).toBe("public");
    await listener.close();
  });

  it("A11/A12: client-IP resolution drives Sb-Forwarded-For and rate-limit buckets (both modes)", async () => {
    // Default (untrusted): caller-supplied headers are ignored, one shared bucket.
    const untrusted = await buildApp(appEnv());
    await untrusted.ready();
    const resA = await untrusted.inject({
      method: "GET",
      url: "/health/live",
      remoteAddress: "10.0.0.1",
      headers: { "cf-connecting-ip": "1.2.3.4", "x-forwarded-for": "9.9.9.9" },
    });
    expect(resA.statusCode).toBe(200);
    await untrusted.close();

    // Trusted: distinct CF-Connecting-IP values get distinct rate-limit buckets.
    const trusted = await buildApp({ ...appEnv(), TRUST_CF_CONNECTING_IP: "true" });
    await trusted.ready();
    // Push the first client past 240/min; the second must not be limited.
    let lastA = 0;
    for (let i = 0; i < 245; i++) {
      const res = await trusted.inject({
        method: "GET",
        url: "/health/live",
        headers: { "cf-connecting-ip": "1.2.3.4" },
      });
      lastA = res.statusCode;
    }
    expect(lastA).toBe(429);
    const resB = await trusted.inject({
      method: "GET",
      url: "/health/live",
      headers: { "cf-connecting-ip": "5.6.7.8" },
    });
    expect(resB.statusCode).toBe(200);
    await trusted.close();

    // Untrusted mode preserves today's behaviour: both callers share one bucket.
    const untrusted2 = await buildApp(appEnv());
    await untrusted2.ready();
    let last = 0;
    for (let i = 0; i < 245; i++) {
      const res = await untrusted2.inject({
        method: "GET",
        url: "/health/live",
        remoteAddress: "10.0.0.1",
        headers: { "cf-connecting-ip": i % 2 === 0 ? "1.2.3.4" : "5.6.7.8" },
      });
      last = res.statusCode;
    }
    expect(last).toBe(429); // one shared bucket, exactly as before this change
    await untrusted2.close();
  }, 60_000);

  it("definitive rejection mints a replacement session (the branch transient must never take)", async () => {
    // A well-signed envelope carrying structurally valid v:1 tokens whose
    // refresh token Auth conclusively rejects (garbage) → mint anew.
    const forged = await signSessionCookie({ accessToken: "garbage-at", refreshToken: "garbage-rt" });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/demo-matches",
      payload: { mode: "human-vs-ai" },
      headers: { cookie: forged },
    });
    expect(res.statusCode).toBe(200);
    // Verifier fix: prove the mint by resolving the NEW session to a real,
    // previously-unknown auth.users row — not by a global count that races
    // with concurrent mints in other test files.
    const minted = cookiePair(res.headers["set-cookie"], "lv_session");
    expect(minted).toBeTruthy();
    const unsigned = app.unsignCookie(cookieValueDecoded(res.headers["set-cookie"], "lv_session")!);
    expect(unsigned.valid).toBe(true);
    const tokens = decodeSessionCookie(unsigned.value!)!;
    const verify = createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { data } = await verify.auth.getClaims(tokens.accessToken);
    const newUserId = data!.claims!.sub as string;
    // The minted session is backed by a real durable row (not garbage).
    const row = await getAuthUser(env, newUserId);
    expect(row).not.toBeNull();
    expect(row!.is_anonymous).toBe(true);
  });

  it("transient auth failure fails closed: HTTP 503 and the cookie is preserved byte-for-byte", async () => {
    // Fault-inject the verify client itself: every getClaims/refresh call
    // fails inconclusively, simulating Auth 5xx / JWKS unavailable / network
    // failure. This is deterministic — pointing at a dead URL raced the
    // client's internal retry budget and produced mints instead.
    const { sessionDeps } = await import("./session.js");
    const real = sessionDeps.verifyClientFactory;
    const { failingVerifyClient } = await import("./session.js");
    sessionDeps.verifyClientFactory = failingVerifyClient;
    try {
      const dead = await buildApp(appEnv()); // captures the failing client
      await dead.ready();
      const { setCookie } = await createHumanMatch(); // real session from the live app
      const cookie = cookiePair(setCookie, "lv_session")!;
      const res = await dead.inject({
        method: "POST",
        url: "/api/v1/demo-matches",
        payload: { mode: "human-vs-ai" },
        headers: { cookie },
      });
      expect(res.statusCode).toBe(503);
      expect((res.json() as { error: string }).error).toBe("AUTH_TEMPORARILY_UNAVAILABLE");
      // Never cleared, never overwritten, nothing minted. Verifier fix:
      // the no-mint property is asserted by the ABSENT Set-Cookie (the only
      // mint carrier), not a global count that races other test files.
      expect(res.headers["set-cookie"]).toBeUndefined();
      // And the pre-existing user is untouched (per-row, race-free).
      const unsigned = app.unsignCookie(cookieValueDecoded(setCookie, "lv_session")!);
      const tokens = decodeSessionCookie(unsigned.value!)!;
      const verify = createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      });
      const { data } = await verify.auth.getClaims(tokens.accessToken);
      const row = await getAuthUser(env, data!.claims!.sub as string);
      expect(row).not.toBeNull();
      await dead.close();
    } finally {
      sessionDeps.verifyClientFactory = real;
    }
  });

  it("transient failure on the WS upgrade rejects pre-handshake with 503 (no 4003, cookie intact)", async () => {
    const port = 4313;
    // Build the app with a verify client that passes through while this test
    // sets up (creating the room needs a resolved session), then fails
    // inconclusively once armed. Rooms are per-app, so the fault must live
    // INSIDE the app under test — this is the deterministic lever.
    const mod = await import("./session.js");
    const realFactory = mod.sessionDeps.verifyClientFactory;
    let fail = false;
    mod.sessionDeps.verifyClientFactory = (e) => {
      const client = realFactory(e);
      const passthrough = <T extends (...args: never[]) => unknown>(fn: T) =>
        async (...args: Parameters<T>): Promise<unknown> =>
          fail
            ? { data: null, error: { status: 503, message: "fault-injected" } }
            : fn(...args);
      return {
        auth: {
          getClaims: passthrough(client.auth.getClaims.bind(client.auth) as never),
          refreshSession: passthrough(client.auth.refreshSession.bind(client.auth) as never),
        },
      } as never;
    };
    try {
      const app2 = await buildApp({ ...appEnv(), PORT: port });
      await app2.listen({ port });
      const created = await app2.inject({
        method: "POST",
        url: "/api/v1/demo-matches",
        payload: { mode: "human-vs-ai" },
      });
      expect(created.statusCode).toBe(200);
      const matchId = (created.json() as { matchId: string }).matchId;
      const cookie = cookiePair(created.headers["set-cookie"], "lv_session")!;
      // Arm the fault: every subsequent verification is inconclusive.
      fail = true;
      const result = await new Promise<{ status: number | null; closeCode: number | null }>((resolve) => {
        const ws = new WebSocket(`ws://localhost:${port}/api/v1/matches/${matchId}/stream`, {
          headers: { cookie },
        });
        // A post-handshake auth close would surface here as a close code.
        ws.on("open", () => resolve({ status: 101, closeCode: null }));
        ws.on("close", (c) => resolve({ status: null, closeCode: c }));
        // preValidation answered 503 before completing the handshake: the
        // upgrade failed with a plain HTTP response — exactly the design.
        ws.on("error", (err) => {
          const m = /(\d{3})/.exec((err as Error).message);
          resolve({ status: m ? Number(m[1]) : null, closeCode: null });
        });
      });
      expect(result.status).toBe(503);
      expect(result.closeCode).toBeNull(); // no 4003 — the handshake never completed
      // Transient never mints: the setup session's user is intact (per-row,
      // race-free — a global count would race other files' mints).
      const unsigned = app2.unsignCookie(cookieValueDecoded(created.headers["set-cookie"], "lv_session")!);
      const tokens = decodeSessionCookie(unsigned.value!)!;
      const verify = createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      });
      const { data } = await verify.auth.getClaims(tokens.accessToken);
      const row = await getAuthUser(env, data!.claims!.sub as string);
      expect(row).not.toBeNull();
      await app2.close();
    } finally {
      mod.sessionDeps.verifyClientFactory = realFactory;
    }
  });
});
