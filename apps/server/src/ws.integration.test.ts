import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { buildApp } from "./app.js";

interface Envelope {
  type: string;
  revision: number;
  payload: Record<string, unknown>;
}

class WsClient {
  private ws: WebSocket;
  readonly messages: Envelope[] = [];
  view: Record<string, unknown> | null = null;
  deadlineAtMs: number | null = null;
  demo: Record<string, unknown> | null = null;

  constructor(url: string, cookie: string) {
    this.ws = new WebSocket(url, { headers: { cookie } });
    this.ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString()) as Envelope & { payload: never };
      this.messages.push(m);
      if (m.type === "snapshot") {
        const p = m.payload as { view: Record<string, unknown>; deadlineAtMs: number | null; demo: Record<string, unknown> };
        this.view = p.view;
        this.deadlineAtMs = p.deadlineAtMs;
        this.demo = p.demo;
      }
    });
  }

  async open(): Promise<void> {
    await new Promise<void>((resolve) => this.ws.on("open", () => resolve()));
    await this.waitFor((m) => m.type === "snapshot");
  }

  send(obj: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(obj));
  }

  async waitFor(pred: (m: Envelope) => boolean, timeoutMs = 10_000): Promise<Envelope> {
    const start = Date.now();
    for (;;) {
      const found = this.messages.find(pred);
      if (found) return found;
      if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  close(): void {
    this.ws.close();
  }
}

describe("server integration (real WebSocket)", () => {
  let app: FastifyInstance;
  const port = 4199;

  beforeAll(async () => {
    app = await buildApp({
      PORT: port,
      LOG_LEVEL: "silent",
      ALLOW_FIXED_SEED: "true",
      COOKIE_SECRET: "integration-test-secret-key",
    });
    await app.listen({ port });
  });

  afterAll(async () => {
    await app.close();
  });

  async function createMatch(mode: "all-ai" | "human-vs-ai", seed?: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/demo-matches",
      payload: { mode, ...(seed ? { seed } : {}) },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { matchId: string };
    const cookie = (res.headers["set-cookie"] as string).split(";")[0]!;
    return { matchId: body.matchId, cookie };
  }

  it("all-AI demo starts paused at auction-ready with deadlineAtMs null and steps advance presentation", async () => {
    const { matchId, cookie } = await createMatch("all-ai", "it-demo-1");
    const client = new WsClient(`ws://localhost:${port}/api/v1/matches/${matchId}/stream`, cookie);
    await client.open();

    expect(client.deadlineAtMs).toBeNull();
    const demo = client.demo as { paused: boolean; presentation: { kind: string; seq: number } };
    expect(demo.paused).toBe(true);
    expect(demo.presentation.kind).toBe("auction-ready");
    expect((client.view as { round: number }).round).toBe(1);

    const seqBefore = demo.presentation.seq;
    client.send({ protocolVersion: 1, matchId, type: "demo_step" });
    const state = await client.waitFor((m) => m.type === "demo_state");
    const presentation = (state.payload as { presentation: { kind: string; seq: number } }).presentation;
    expect(presentation.seq).toBe(seqBefore + 1);
    expect(presentation.kind).not.toBe("auction-ready");
    client.close();
  });

  it("demo_state and snapshot project consistent presentation and deadline", async () => {
    const { matchId, cookie } = await createMatch("all-ai", "it-demo-2");
    const client = new WsClient(`ws://localhost:${port}/api/v1/matches/${matchId}/stream`, cookie);
    await client.open();
    client.send({ protocolVersion: 1, matchId, type: "demo_step" });
    const demoState = await client.waitFor((m) => m.type === "demo_state");
    const statePresentation = (demoState.payload as { presentation: { seq: number } }).presentation;
    const laterSnapshots = client.messages.filter(
      (m) => m.type === "snapshot" && client.messages.indexOf(m) > client.messages.indexOf(demoState),
    );
    const snapshot = laterSnapshots.length > 0
      ? laterSnapshots[laterSnapshots.length - 1]!
      : [...client.messages].reverse().find((m) => m.type === "snapshot")!;
    const snapDemo = (snapshot.payload as { demo: { presentation: { seq: number } } }).demo;
    expect(snapDemo.presentation.seq).toBe(statePresentation.seq);
    const snapDeadline = (snapshot.payload as { deadlineAtMs: number | null }).deadlineAtMs;
    expect(snapDeadline).toBeNull();
    client.close();
  });

  it("full view DTO over the wire contains no hidden slot enumeration or S0x tokens", async () => {
    const { matchId, cookie } = await createMatch("all-ai", "it-secret-1");
    const client = new WsClient(`ws://localhost:${port}/api/v1/matches/${matchId}/stream`, cookie);
    await client.open();
    const raw = JSON.stringify(client.view);
    expect(raw).not.toMatch(/"slotId"/);
    expect(raw).not.toMatch(/S0\d/);
    expect((client.view as { slots: unknown[] }).slots).toHaveLength(0);
    expect((client.view as { contentBundleId: string }).contentBundleId).toBe("content.synthetic.v2");
    client.close();
  });

  it("human match serves 120s deadline, reconnect keeps the same authoritative deadline", async () => {
    const { matchId, cookie } = await createMatch("human-vs-ai");
    const client = new WsClient(`ws://localhost:${port}/api/v1/matches/${matchId}/stream`, cookie);
    await client.open();
    const seatId = (client.view as { viewer: string }).viewer;

    client.send({
      protocolVersion: 1,
      commandId: "it-select-1",
      matchId,
      expectedRevision: (client.view as { revision: number }).revision,
      type: "submit_action",
      payload: { type: "select_loadout", analystId: "analyst.appraiser", toolPackageId: "kit.appraisal" },
    });
    await client.waitFor((m) => m.type === "snapshot" && (client.view as { mySeat?: { analystId?: string } }).mySeat?.analystId !== undefined);
    client.send({
      protocolVersion: 1,
      commandId: "it-lock-001",
      matchId,
      expectedRevision: (client.view as { revision: number }).revision,
      type: "submit_action",
      payload: { type: "lock_setup" },
    });
    await client.waitFor(() => client.deadlineAtMs !== null, 15_000);
    const deadline = client.deadlineAtMs!;
    expect(deadline - Date.now()).toBeGreaterThan(100_000);
    expect(deadline - Date.now()).toBeLessThanOrEqual(121_000);
    void seatId;

    client.close();
    await new Promise((r) => setTimeout(r, 300));
    const client2 = new WsClient(`ws://localhost:${port}/api/v1/matches/${matchId}/stream`, cookie);
    await client2.open();
    expect(client2.deadlineAtMs).toBe(deadline);
    client2.close();
  });

  it("a stranger principal cannot read another guest's seat view", async () => {
    const { matchId } = await createMatch("human-vs-ai");
    const res = await app.inject({ method: "GET", url: `/api/v1/matches/${matchId}/view` });
    expect([403, 404]).toContain(res.statusCode);
  });

  it("completed demo projection enumerates the full lot over the wire", async () => {
    const { matchId, cookie } = await createMatch("all-ai", "it-complete-1");
    const client = new WsClient(`ws://localhost:${port}/api/v1/matches/${matchId}/stream`, cookie);
    await client.open();
    for (let i = 0; i < 40; i++) {
      if ((client.view as { phase: string }).phase === "completed") break;
      client.send({ protocolVersion: 1, matchId, type: "demo_step" });
      await client.waitFor((m) => m.type === "demo_state", 15_000);
      await new Promise((r) => setTimeout(r, 100));
    }
    expect((client.view as { phase: string }).phase).toBe("completed");
    const board = (client.view as { board: { revealedObjects: Array<{ identity?: string; exactValue?: number }> } }).board;
    expect(board.revealedObjects.length).toBeGreaterThanOrEqual(8);
    for (const obj of board.revealedObjects) {
      expect(obj.identity).toBeDefined();
      expect(obj.exactValue).toBeDefined();
    }
    client.close();
  }, 60_000);
});
