import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import WebSocket from "ws";
import { buildApp } from "./app.js";
import { decodeSessionCookie } from "./session.js";
import { persistenceDeps } from "./persistence.js";
import { appEnv, cookiePair, cookieValueDecoded, requireSupabaseEnv } from "./test-helpers.js";

const env = requireSupabaseEnv();

function adminClient(): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

function publishableClient(): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

async function principalFromCookie(app: FastifyInstance, setCookie: string | string[] | undefined): Promise<string> {
  const unsigned = app.unsignCookie(cookieValueDecoded(setCookie, "lv_session")!);
  const tokens = decodeSessionCookie(unsigned.value!)!;
  const { data } = await publishableClient().auth.getClaims(tokens.accessToken);
  return data!.claims!.sub as string;
}

async function matchRows(matchId: string) {
  const { data, error } = await adminClient().from("matches").select("*").eq("match_id", matchId);
  if (error) throw error;
  return data!;
}

async function seatRows(matchId: string) {
  const { data, error } = await adminClient().from("match_seats").select("*").eq("match_id", matchId);
  if (error) throw error;
  return data!;
}

async function waitForRow<T>(fetcher: () => Promise<T[]>, timeoutMs = 10_000): Promise<T[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await fetcher();
    if (rows.length > 0) return rows;
    if (Date.now() > deadline) throw new Error("timed out waiting for persisted row");
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

/**
 * Drive the match's WebSocket until the server pushes match_completed.
 *
 * The driver is a SERIAL command executor: at most one command is ever in
 * flight, and its response is processed before the next command is chosen.
 * That avoids the entire class of races where a snapshot-initiated command
 * and an agent transition interleave — a rejected STALE_REVISION is simply
 * retried against the freshest snapshot. Human seat: pick a loadout, lock
 * setup, then submit+lock a bid whenever a window opens. All-ai observer:
 * speed 8, resume, watch. The 120s human action windows close by
 * server-side deadline as a last resort.
 */
function playUntilCompleted(
  port: number,
  matchId: string,
  cookie: string | null,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `ws://localhost:${port}/api/v1/matches/${matchId}/stream`,
      cookie ? { headers: { cookie } } : undefined,
    );
    interface SeatView {
      viewer: string;
      phase?: string;
      window?: { actionWindowId: string } | null;
      mySeat?: { currentBid?: number; currentBidLocked?: boolean };
    }
    let latestView: SeatView | null = null;
    let revision = 0;
    let inFlight: { kind: string } | null = null;
    let loadoutSelected = false;
    let setupLocked = false;
    let spedUp = false;
    let seq = 0;
    const timeout = setTimeout(
      () =>
        reject(
          new Error(
            `match never completed; driver state=${JSON.stringify({ revision, loadoutSelected, setupLocked, inFlight: inFlight?.kind ?? null, window: latestView?.window?.actionWindowId ?? null })}`,
          ),
        ),
      240_000,
    );

    function sendCommand(payload: Record<string, unknown>, kind: string): void {
      seq += 1;
      inFlight = { kind };
      ws.send(
        JSON.stringify({
          protocolVersion: 1,
          commandId: `cmd-${seq}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          matchId,
          expectedRevision: revision,
          type: "submit_action",
          payload,
        }),
      );
    }

    /** Choose and send the next command from the freshest view, if idle. */
    function maybeAct(): void {
      if (inFlight || !latestView || latestView.viewer === "public") return;
      const view = latestView;
      if (view.phase === "setup") {
        if (!loadoutSelected) {
          sendCommand(
            { type: "select_loadout", analystId: "analyst.surveyor", toolPackageId: "kit.survey" },
            "select_loadout",
          );
        } else if (!setupLocked) {
          sendCommand({ type: "lock_setup" }, "lock_setup");
        }
        return;
      }
      if (!view.window) return;
      const mine = view.mySeat ?? {};
      if (mine.currentBid === undefined) {
        sendCommand({ type: "submit_bid", amount: 3000, actionWindowId: view.window.actionWindowId }, "submit_bid");
      } else if (!mine.currentBidLocked) {
        sendCommand({ type: "lock_bid", actionWindowId: view.window.actionWindowId }, "lock_bid");
      }
    }

    ws.on("message", (raw: Buffer) => {
      const m = JSON.parse(raw.toString()) as {
        type: string;
        revision: number;
        payload: { code?: string; view?: SeatView };
      };
      if (m.type === "match_completed") {
        clearTimeout(timeout);
        ws.close();
        resolve(m.payload);
        return;
      }
      if (m.type === "snapshot" && m.payload.view) {
        revision = m.revision;
        latestView = m.payload.view;
        if (latestView.viewer === "public") {
          // Observer on an all-ai demo: max out the speed and resume once
          // (creation leaves the demo paused), then watch it run.
          if (!spedUp) {
            spedUp = true;
            ws.send(
              JSON.stringify({
                protocolVersion: 1,
                matchId,
                type: "demo_set_speed",
                speedMultiplier: 8,
              }),
            );
            ws.send(JSON.stringify({ protocolVersion: 1, matchId, type: "demo_resume" }));
          }
          return;
        }
        maybeAct();
        return;
      }
      if (m.type === "command_accepted") {
        const kind = inFlight?.kind;
        inFlight = null;
        if (kind === "select_loadout") loadoutSelected = true;
        if (kind === "lock_setup") setupLocked = true;
        maybeAct();
        return;
      }
      if (m.type === "command_rejected") {
        // Whatever the reason (stale revision, window closed mid-flight),
        // re-evaluate against the freshest view and retry if still legal.
        inFlight = null;
        maybeAct();
        return;
      }
    });
    ws.on("error", reject);
  });
}

describe("THE-37b match persistence and career", () => {
  let app: FastifyInstance;
  const PORT = 4391;
  const CLEANUP_MATCH_IDS: string[] = [];

  beforeAll(async () => {
    app = await buildApp({ ...appEnv(), PORT });
    await app.listen({ port: PORT });
  });

  afterAll(async () => {
    await app.close();
    // Test-created rows only: delete the matches this suite persisted.
    for (const id of CLEANUP_MATCH_IDS) {
      await adminClient().from("match_seats").delete().eq("match_id", id);
      await adminClient().from("matches").delete().eq("match_id", id);
    }
  });

  it("B1: a completed human-vs-ai match writes one matches row and one seat row per seat with raw fields", async () => {
    const seed = `b1-${Date.now()}`;
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/demo-matches",
      payload: { mode: "human-vs-ai", seed },
    });
    expect(created.statusCode).toBe(200);
    const { matchId } = created.json() as { matchId: string };
    CLEANUP_MATCH_IDS.push(matchId);
    const cookie = cookiePair(created.headers["set-cookie"], "lv_session")!;
    const principalId = await principalFromCookie(app, created.headers["set-cookie"]);

    await playUntilCompleted(PORT, matchId, cookie);
    const matches = await waitForRow(() => matchRows(matchId));
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ match_id: matchId, mode: "human-vs-ai", seed });
    expect(typeof matches[0]!.final_state_hash).toBe("string");
    expect(matches[0]!.rule_bundle_id.length).toBeGreaterThan(0);

    const seats = await seatRows(matchId);
    expect(seats).toHaveLength(4);
    const human = seats.find((s) => s.seat_id === "seat1")!;
    expect(human.controller_kind).toBe("human");
    expect(human.user_id).toBe(principalId);
    for (const s of seats) {
      expect(typeof Number(s.final_wealth)).toBe("number");
      expect(typeof Number(s.realized_profit)).toBe("number");
      expect(typeof Number(s.bonus_reward)).toBe("number");
      expect(typeof s.dense_economic_rank).toBe("number");
      expect(typeof Number(s.utility_numerator)).toBe("number");
      expect(typeof Number(s.utility_denominator)).toBe("number");
    }
    for (const s of seats.filter((x) => x.seat_id !== "seat1")) {
      expect(s.controller_kind).toBe("agent");
      expect(s.user_id).toBeNull();
    }
  }, 300_000);

  it("B2: completing the same fixed-seed match twice yields one row and unchanged career aggregates", async () => {
    const seed = `b2-${Date.now()}`;
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/demo-matches",
      payload: { mode: "human-vs-ai", seed },
    });
    const { matchId } = first.json() as { matchId: string };
    CLEANUP_MATCH_IDS.push(matchId);
    const cookie = cookiePair(first.headers["set-cookie"], "lv_session")!;
    await playUntilCompleted(PORT, matchId, cookie);
    await waitForRow(() => matchRows(matchId));

    const careerBefore = await app.inject({ method: "GET", url: "/api/v1/me/career", headers: { cookie } });
    expect(careerBefore.statusCode).toBe(200);
    const before = careerBefore.json() as { matchesPlayed: number; totalFinalWealth: number };

    // Replay: creation deletes and recreates the room with the SAME matchId.
    const replay = await app.inject({
      method: "POST",
      url: "/api/v1/demo-matches",
      payload: { mode: "human-vs-ai", seed },
      headers: { cookie },
    });
    expect(replay.statusCode).toBe(200);
    expect((replay.json() as { matchId: string }).matchId).toBe(matchId);
    await playUntilCompleted(PORT, matchId, cookie);
    // Give the second fire-and-forget write a chance to land (it must be a no-op).
    await new Promise((resolve) => setTimeout(resolve, 1_000));

    expect(await matchRows(matchId)).toHaveLength(1);
    expect(await seatRows(matchId)).toHaveLength(4);
    const careerAfter = await app.inject({ method: "GET", url: "/api/v1/me/career", headers: { cookie } });
    expect(careerAfter.json()).toEqual(before);
    expect(before.matchesPlayed).toBeGreaterThanOrEqual(1);
    expect(before.totalFinalWealth).not.toBe(0);
  }, 420_000);

  it("B3: a store failure at the completion boundary does not block the match_completed push or fail the match", async () => {
    // Fault is injected at BUILD time so it lives inside exactly one app
    // instance — no cross-test leakage, no restoration race.
    const real = persistenceDeps.storeFactory;
    persistenceDeps.storeFactory = () => ({
      insertMatch: async () => {
        throw new Error("fault-injected: database down");
      },
      careerForUser: async () => {
        throw new Error("fault-injected: database down");
      },
      leaderboardPage: async () => {
        throw new Error("fault-injected: database down");
      },
      snapshotExists: async () => {
        throw new Error("fault-injected: database down");
      },
    });
    const PORT3 = 4392;
    let faulted: FastifyInstance;
    try {
      faulted = await buildApp({ ...appEnv(), PORT: PORT3 });
    } finally {
      persistenceDeps.storeFactory = real;
    }
    await faulted.listen({ port: PORT3 });
    try {
      const seed = `b3-${Date.now()}`;
      const created = await faulted.inject({
        method: "POST",
        url: "/api/v1/demo-matches",
        payload: { mode: "human-vs-ai", seed },
      });
      expect(created.statusCode).toBe(200);
      const { matchId } = created.json() as { matchId: string };
      CLEANUP_MATCH_IDS.push(matchId);
      const cookie = cookiePair(created.headers["set-cookie"], "lv_session")!;
      // The completion push must arrive normally despite the failing store.
      const result = (await playUntilCompleted(PORT3, matchId, cookie)) as { economic: unknown[] };
      expect(result.economic).toHaveLength(4);
      // Nothing was persisted — the failure was swallowed.
      expect(await matchRows(matchId)).toHaveLength(0);
    } finally {
      await faulted.close();
    }
  }, 300_000);

  it("B4: an all-ai match is persisted but attributes no economics to any user and never moves career", async () => {
    // Career baseline for a fresh human principal.
    const human = await app.inject({
      method: "POST",
      url: "/api/v1/demo-matches",
      payload: { mode: "human-vs-ai" },
    });
    const humanCookie = cookiePair(human.headers["set-cookie"], "lv_session")!;
    const { matchId: humanMatchId } = human.json() as { matchId: string };
    CLEANUP_MATCH_IDS.push(humanMatchId);
    const careerBefore = (
      await app.inject({ method: "GET", url: "/api/v1/me/career", headers: { cookie: humanCookie } })
    ).json();

    const seed = `b4-${Date.now()}`;
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/demo-matches",
      payload: { mode: "all-ai", seed },
    });
    expect(created.statusCode).toBe(200);
    const { matchId } = created.json() as { matchId: string };
    CLEANUP_MATCH_IDS.push(matchId);

    // Observer socket: watch the demo until completion.
    await playUntilCompleted(PORT, matchId, null);
    const matches = await waitForRow(() => matchRows(matchId));
    expect(matches[0]!.mode).toBe("all-ai");
    const seats = await seatRows(matchId);
    expect(seats).toHaveLength(4);
    // No seat row carries a user reference — career exclusion is by SQL construction.
    expect(seats.every((s) => s.user_id === null)).toBe(true);
    expect(seats.every((s) => s.controller_kind === "agent")).toBe(true);

    const careerAfter = (
      await app.inject({ method: "GET", url: "/api/v1/me/career", headers: { cookie: humanCookie } })
    ).json();
    expect(careerAfter).toEqual(careerBefore);
  }, 420_000);

  it("B5: career endpoint is self-only, zeroed for a new principal, 401 without a session, and mints nothing", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/me/career" });
    expect(res.statusCode).toBe(401);
    expect((res.json() as { error: string }).error).toBe("AUTH_REQUIRED");
    expect(res.headers["set-cookie"]).toBeUndefined();

    // A brand-new principal (minted by a match creation, the only mint path)
    // with no completed matches sees zeroed aggregates, not 404.
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/demo-matches",
      payload: { mode: "human-vs-ai" },
    });
    const { matchId } = created.json() as { matchId: string };
    CLEANUP_MATCH_IDS.push(matchId);
    const cookie = cookiePair(created.headers["set-cookie"], "lv_session")!;
    const career = await app.inject({ method: "GET", url: "/api/v1/me/career", headers: { cookie } });
    expect(career.statusCode).toBe(200);
    expect(career.json()).toEqual({
      matchesPlayed: 0,
      totalFinalWealth: 0,
      totalRealizedProfit: 0,
      totalBonusReward: 0,
      bestDenseEconomicRank: null,
      averageFinalWealth: 0,
    });
    // The career call itself sets no cookie (no mint, no rotation here).
    expect(career.headers["set-cookie"]).toBeUndefined();

    // No :userId enumeration surface exists.
    const other = await app.inject({ method: "GET", url: "/api/v1/me/career/anything" });
    expect([404]).toContain(other.statusCode);
  });

  it("B6: the publishable key can neither read nor write the new tables (RLS deny-by-default)", async () => {
    const pub = publishableClient();
    const readMatches = await pub.from("matches").select("*").limit(1);
    expect(readMatches.error).not.toBeNull();
    const readSeats = await pub.from("match_seats").select("*").limit(1);
    expect(readSeats.error).not.toBeNull();
    const writeMatch = await pub.from("matches").insert({
      match_id: "rls-probe",
      mode: "all-ai",
      seed: "s",
      rule_bundle_id: "b",
      rule_manifest_hash: "h",
      content_hash: "h",
      final_state_hash: "h",
    });
    expect(writeMatch.error).not.toBeNull();
    const writeSeat = await pub.from("match_seats").insert({
      match_id: "rls-probe",
      seat_id: "seat1",
      controller_kind: "agent",
      user_id: null,
      final_wealth: 1,
      realized_profit: 1,
      bonus_reward: 0,
      dense_economic_rank: 1,
      utility_numerator: 0,
      utility_denominator: 1,
    });
    expect(writeSeat.error).not.toBeNull();
  });
});
