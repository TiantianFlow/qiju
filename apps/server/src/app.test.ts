import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ LOG_LEVEL: "silent" });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("server integration", () => {
  it("health and capabilities are available", async () => {
    const live = await app.inject({ method: "GET", url: "/health/live" });
    expect(live.statusCode).toBe(200);
    const ready = await app.inject({ method: "GET", url: "/health/ready" });
    expect(ready.statusCode).toBe(200);
    const cap = await app.inject({ method: "GET", url: "/api/v1/capabilities" });
    expect(cap.statusCode).toBe(200);
    const body = cap.json() as { locales: string[]; defaultLocale: string };
    expect(body.locales).toEqual(["zh-CN", "en"]);
    expect(body.defaultLocale).toBe("zh-CN");
  });

  it("creates a human-vs-ai match and issues a guest cookie", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/demo-matches",
      payload: { mode: "human-vs-ai", seed: "itest" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["set-cookie"]).toBeDefined();
    const body = res.json() as { matchId: string };
    expect(body.matchId).toBeTruthy();
  });

  it("rejects schema-invalid create", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/demo-matches",
      payload: { mode: "nonsense" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("unknown match view is 404", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/matches/nope/view" });
    expect(res.statusCode).toBe(404);
  });

  it("content endpoint serves both locales with identical key sets", async () => {
    const zh = await app.inject({ method: "GET", url: "/api/v1/content/content.synthetic.v2/zh-CN" });
    const en = await app.inject({ method: "GET", url: "/api/v1/content/content.synthetic.v2/en" });
    expect(zh.statusCode).toBe(200);
    expect(en.statusCode).toBe(200);
    const zhKeys = Object.keys((zh.json() as { strings: Record<string, string> }).strings).sort();
    const enKeys = Object.keys((en.json() as { strings: Record<string, string> }).strings).sort();
    expect(zhKeys).toEqual(enKeys);
  });
});
