import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { RoomManager } from "@qiju/session-runtime";
import { buildApp } from "./app.js";
import { appEnv, cookiePair } from "./test-helpers.js";

const HEARTBEAT_MS = 150;

interface Envelope {
  type: string;
  revision: number;
  payload: Record<string, unknown>;
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("websocket heartbeat (short interval)", () => {
  let app: FastifyInstance;
  const port = 4201;
  let heartbeatHandle: ReturnType<typeof setInterval> | undefined;

  beforeAll(async () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    app = await buildApp({
      ...appEnv(),
      PORT: port,
      WS_HEARTBEAT_INTERVAL_MS: HEARTBEAT_MS,
    });
    heartbeatHandle = setIntervalSpy.mock.results.find(
      (r, i) => setIntervalSpy.mock.calls[i]?.[1] === HEARTBEAT_MS,
    )?.value as ReturnType<typeof setInterval> | undefined;
    setIntervalSpy.mockRestore();
    expect(heartbeatHandle).toBeDefined();
    await app.listen({ port });
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function createMatch(mode: "all-ai" | "human-vs-ai", seed?: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/demo-matches",
      payload: { mode, ...(seed ? { seed } : {}) },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { matchId: string };
    // all-ai matches mint no session (THE-37a); only human-vs-ai sets one.
    const cookie = cookiePair(res.headers["set-cookie"], "lv_session") ?? "";
    return { matchId: body.matchId, cookie };
  }

  function connect(matchId: string, cookie: string, opts?: { autoPong?: boolean }) {
    const messages: Envelope[] = [];
    const ws = new WebSocket(`ws://localhost:${port}/api/v1/matches/${matchId}/stream`, {
      headers: { cookie },
      ...(opts?.autoPong === false ? { autoPong: false } : {}),
    });
    ws.on("message", (raw) => messages.push(JSON.parse(raw.toString()) as Envelope));
    return { ws, messages };
  }

  async function waitOpen(ws: WebSocket): Promise<void> {
    if (ws.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("close", () => reject(new Error("socket closed before open")));
    });
  }

  it("keeps an auto-pong client connected and emits no JSON envelopes", async () => {
    const { matchId, cookie } = await createMatch("all-ai", "hb-alive-1");
    const { ws, messages } = connect(matchId, cookie);
    await waitOpen(ws);
    await wait(HEARTBEAT_MS * 3 + 100);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    // hello + initial snapshot only — heartbeats travel as protocol ping/pong
    // frames and must never surface as JSON envelopes.
    expect(messages.map((m) => m.type)).toEqual(["hello", "snapshot"]);
    ws.close();
  });

  it("terminates a client that never pongs", async () => {
    const { matchId, cookie } = await createMatch("all-ai", "hb-dead-1");
    const { ws } = connect(matchId, cookie, { autoPong: false });
    await waitOpen(ws);
    const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
    const code = await closed;
    expect(code).toBe(1006);
  });

  it("heartbeat termination of an unresponsive socket does not touch the room (THE-24 idle clock)", async () => {
    const { matchId, cookie } = await createMatch("all-ai", "hb-no-touch-1");
    const { ws } = connect(matchId, cookie, { autoPong: false });
    await waitOpen(ws);
    // Let connect-time activity settle, then watch for any touch of THIS room.
    const touchSpy = vi.spyOn(RoomManager.prototype, "touch");
    await wait(50);
    touchSpy.mockClear();

    const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
    const code = await closed;
    expect(code).toBe(1006);
    // Give any post-teardown touch a window to land before asserting.
    await wait(HEARTBEAT_MS * 2);
    expect(touchSpy.mock.calls.some(([id]) => id === matchId)).toBe(false);
  });

  it("serves the current snapshot to a reconnecting client", async () => {
    const { matchId, cookie } = await createMatch("all-ai", "hb-rejoin-1");
    const first = connect(matchId, cookie);
    await waitOpen(first.ws);
    await wait(50);
    const snapshot = first.messages.find((m) => m.type === "snapshot")!;
    expect(snapshot).toBeDefined();
    first.ws.close();
    await wait(100);

    const second = connect(matchId, cookie);
    await waitOpen(second.ws);
    await wait(50);
    const rejoin = second.messages.find((m) => m.type === "snapshot")!;
    expect(rejoin).toBeDefined();
    expect(rejoin.revision).toBe(snapshot.revision);
    second.ws.close();
  });

  it("clears the heartbeat timer on shutdown", async () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const standalone = await buildApp({
      ...appEnv(),
      PORT: 4202,
      WS_HEARTBEAT_INTERVAL_MS: HEARTBEAT_MS,
    });
    const handle = setIntervalSpy.mock.results.find(
      (r, i) => setIntervalSpy.mock.calls[i]?.[1] === HEARTBEAT_MS,
    )?.value as ReturnType<typeof setInterval> | undefined;
    setIntervalSpy.mockRestore();
    expect(handle).toBeDefined();

    await standalone.listen({ port: 4202 });
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    await standalone.close();
    expect(clearIntervalSpy.mock.calls.some(([cleared]) => cleared === handle)).toBe(true);
    clearIntervalSpy.mockRestore();
  });
});
