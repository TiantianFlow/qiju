import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyCors from "@fastify/cors";
import fastifyWebsocket from "@fastify/websocket";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import type { WebSocket } from "ws";
import { z } from "zod";
import {
  BRAND,
  PROTOCOL_VERSION,
  commandEnvelopeSchema,
  createMatchRequestSchema,
  demoControlSchema,
  type CapabilitiesResponse,
  type ClientCommand,
  type ServerEnvelope,
} from "@qiju/contracts";
import type { GameCommand, SeatId } from "@qiju/game-core";
import { compileDemoV2 } from "@qiju/rules-demo";
import { agentById, BUILTIN_AGENTS, type Agent } from "@qiju/agents";
import {
  RoomManager,
  SystemClock,
  type RoomEvents,
  type ViewUpdate,
} from "@qiju/session-runtime";
import {
  clearLegacyGuestCookie,
  createVerifyClient,
  decodeSessionCookie,
  getClientIp,
  sessionDeps,
  setSessionCookie,
  verifyTokens,
  type SessionEnv,
} from "./session.js";

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default("0.0.0.0"),
  COOKIE_SECRET: z.string().min(16).optional(),
  LOG_LEVEL: z.string().default("info"),
  // THE-37a: Supabase is the identity store. The secret key is server-only —
  // it must never reach the browser, a client bundle, a log line, or a
  // committed file.
  SUPABASE_URL: z.string().url(),
  SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  SUPABASE_SECRET_KEY: z.string().min(1),
  // THE-37a: trust boundary for client-IP resolution. DEFAULT UNTRUSTED —
  // without this switch the socket peer is used and caller-supplied
  // forwarding headers are ignored. Enabling this safely in production is an
  // unresolved infra decision (needs Cloudflare-proxied backend ingress AND
  // direct origin ingress blocked/validated).
  TRUST_CF_CONNECTING_IP: z
    .string()
    .default("false")
    .transform((v) => v === "true"),
  ALLOW_FIXED_SEED: z
    .string()
    .default("true")
    .transform((v) => v === "true"),
  NODE_ENV: z.string().default("development"),
  // Comma-separated list of allowed frontend origins for cross-origin deploys
  // (e.g. Cloudflare Pages -> Railway). Unset means unrestricted (dev mode).
  CORS_ORIGIN: z.string().optional(),
  // Cookie domain shared between frontend/backend subdomains of the same
  // parent domain (e.g. ".example.com"). Unset means host-only cookie.
  COOKIE_DOMAIN: z.string().optional(),
  // THE-26: app-level WebSocket heartbeat interval. 30s default safely
  // undercuts Cloudflare's 100s idle-connection timeout (bid window is 120s).
  WS_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(50).default(30_000),
});

export type AppEnv = z.infer<typeof envSchema>;

interface ConnectionContext {
  matchId: string;
  principalId: string | null;
  isObserver: boolean;
  serverSequence: number;
}

function toGameCommand(payload: ClientCommand, seatId: SeatId): GameCommand {
  switch (payload.type) {
    case "select_loadout":
      return {
        kind: "select_loadout",
        seatId,
        analystId: payload.analystId as never,
        toolPackageId: payload.toolPackageId as never,
      };
    case "lock_setup":
      return { kind: "lock_setup", seatId };
    case "use_tool":
      return {
        kind: "use_tool",
        seatId,
        toolId: payload.toolId,
        actionWindowId: payload.actionWindowId,
      };
    case "submit_bid":
      return {
        kind: "submit_bid",
        seatId,
        amount: payload.amount,
        actionWindowId: payload.actionWindowId,
      };
    case "lock_bid":
      return { kind: "lock_bid", seatId, actionWindowId: payload.actionWindowId };
  }
}

export async function buildApp(envOverrides?: Record<string, string | number | boolean>): Promise<FastifyInstance> {
  const merged: Record<string, unknown> = { ...process.env, ...envOverrides };
  const env = envSchema.parse(merged);
  if (env.NODE_ENV === "production" && !env.COOKIE_SECRET) {
    throw new Error("COOKIE_SECRET is required in production");
  }
  const cookieSecret = env.COOKIE_SECRET ?? "dev-only-insecure-secret-change-me";

  const runtime = compileDemoV2();
  const clock = new SystemClock();
  const connections = new Map<
    string,
    Set<{ socket: WebSocket; ctx: ConnectionContext; isAlive: boolean; terminatedByHeartbeat: boolean }>
  >();

  const manager = new RoomManager({
    runtime,
    clock,
    agentPool: {
      humanVsAiAgents: (): Agent[] => [
        BUILTIN_AGENTS[2]!,
        BUILTIN_AGENTS[2]!,
        BUILTIN_AGENTS[2]!,
        BUILTIN_AGENTS[2]!,
      ],
      allAiAgents: (): Agent[] => [
        agentById("cautious-appraiser")!,
        agentById("balanced-calculator")!,
        agentById("aggressive-challenger")!,
        agentById("balanced-calculator")!,
      ],
    },
    // THE-24: an evicted room's matchId must behave exactly like one that
    // never existed - close any sockets still pointed at it (same code a
    // truly-missing match gets on connect) and drop the connections entry
    // so it doesn't linger as a dead Set nobody ever prunes.
    onEvict(matchId) {
      const set = connections.get(matchId);
      if (!set) return;
      for (const conn of set) {
        try {
          conn.socket.close(4004, "MATCH_NOT_FOUND_OR_FORBIDDEN");
        } catch {
          /* already closed */
        }
      }
      connections.delete(matchId);
    },
  });

  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      serializers: {
        req(request) {
          return { method: request.method, url: request.url };
        },
      },
    },
    disableRequestLogging: true,
  });

  const corsOrigins = env.CORS_ORIGIN
    ? env.CORS_ORIGIN.split(",")
        .map((o) => o.trim())
        .filter(Boolean)
    : null;

  await app.register(fastifyCookie, { secret: cookieSecret });
  await app.register(fastifyCors, {
    // No CORS_ORIGIN configured -> unrestricted (local dev / same-origin deploy).
    // Configured -> only the listed frontend origin(s); credentialed requests
    // still need an explicit (non-wildcard) origin, which @fastify/cors handles
    // by reflecting the request origin when it matches the allowlist.
    origin: corsOrigins ?? true,
    credentials: true,
  });
  await app.register(fastifyWebsocket, { options: { maxPayload: 64 * 1024 } });
  await app.register(fastifyRateLimit, {
    max: 240,
    timeWindow: "1 minute",
    // THE-37a: bucket by the same client-IP resolver used for Sb-Forwarded-For.
    // Default-untrusted means every request buckets on the socket peer —
    // exactly today's behaviour — until the trust switch is deliberately set.
    keyGenerator: (request) => getClientIp(request, env.TRUST_CF_CONNECTING_IP),
    // errorResponseBuilder's return value is THROWN by the plugin (v10):
    // returning a plain object lands in the error handler as a 500. Throw a
    // status-coded error so clients get the 429 the limiter intends.
    errorResponseBuilder: (_request, context) => {
      const err = new Error("RATE_LIMITED") as Error & { statusCode: number };
      err.statusCode = context.statusCode;
      return err;
    },
  });

  // THE-26: one heartbeat timer per app (not per socket). Each tick terminates
  // sockets that failed to pong the previous ping, then marks the rest dead
  // and pings them; a `pong` flips `isAlive` back (registered at connect).
  // Protocol-level ping/pong only: no JSON envelope, no serverSequence bump,
  // no revision/deadline change, and deliberately no manager.touch() so the
  // THE-24 idle-eviction clock is never reset by heartbeats alone.
  const heartbeatTimer = setInterval(() => {
    for (const set of connections.values()) {
      for (const conn of set) {
        if (!conn.isAlive) {
          // Flag before terminating so the close handler can tell this
          // heartbeat-initiated teardown apart from a genuine user/network
          // close and skip its manager.touch() — a dead socket must not
          // reset the THE-24 idle-eviction clock.
          conn.terminatedByHeartbeat = true;
          try {
            conn.socket.terminate();
          } catch {
            /* already closed */
          }
          continue;
        }
        conn.isAlive = false;
        try {
          conn.socket.ping();
        } catch {
          /* already closed */
        }
      }
    }
  }, env.WS_HEARTBEAT_INTERVAL_MS);
  app.addHook("onClose", async () => {
    clearInterval(heartbeatTimer);
  });

  // THE-37a: durable identity lives in Supabase auth.users; the browser holds
  // a server-minted anonymous session in the signed httpOnly lv_session
  // cookie. The publishable-key client is stateless (tokens passed per call);
  // the secret key is used for signInAnonymously only, per request.
  const sessionEnv: SessionEnv = {
    SUPABASE_URL: env.SUPABASE_URL,
    SUPABASE_PUBLISHABLE_KEY: env.SUPABASE_PUBLISHABLE_KEY,
    SUPABASE_SECRET_KEY: env.SUPABASE_SECRET_KEY,
  };
  const verifyClient = createVerifyClient(sessionEnv);
  const cookieOpts = {
    production: env.NODE_ENV === "production",
    ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
  };
  const transientUnavailable = (reply: FastifyReply) =>
    reply.code(503).send({ error: "AUTH_TEMPORARILY_UNAVAILABLE" });

  type PrincipalOutcome =
    | { kind: "ok"; principalId: string | null }
    | { kind: "transient" };

  /**
   * Verify a presented session and return its principal. NEVER mints.
   * Cookie precedence: valid lv_session wins; legacy lv_guest is cleared and
   * (when mint=true) bridged into a fresh anonymous session; definitive
   * invalidity behaves like absence; transient failure preserves lv_session
   * byte-for-byte and fails closed.
   */
  async function resolveSession(
    request: FastifyRequest,
    reply: FastifyReply,
    mint: boolean,
  ): Promise<PrincipalOutcome> {
    const raw = request.cookies.lv_session;
    if (raw) {
      const unsigned = request.unsignCookie(raw);
      if (unsigned.valid && unsigned.value) {
        const tokens = decodeSessionCookie(unsigned.value);
        if (tokens) {
          const result = await verifyTokens(verifyClient, tokens);
          if (result.kind === "transient") return { kind: "transient" };
          if (result.kind === "ok") {
            if (result.rotated) setSessionCookie(reply, result.rotated, cookieOpts);
            if (request.cookies.lv_guest) clearLegacyGuestCookie(reply, cookieOpts);
            return { kind: "ok", principalId: result.principalId };
          }
          // definitive invalid: fall through and behave as absent
        }
        // unknown envelope version / malformed: definitive, behave as absent
      }
      // bad signature: definitive, behave as absent
    }

    const hadLegacyGuest = Boolean(request.cookies.lv_guest);
    if (!mint) {
      if (hadLegacyGuest) clearLegacyGuestCookie(reply, cookieOpts);
      return { kind: "ok", principalId: null };
    }

    const minted = await sessionDeps.mint(sessionEnv, getClientIp(request, env.TRUST_CF_CONNECTING_IP));
    if (minted.kind !== "ok") return { kind: "transient" };
    setSessionCookie(reply, minted.tokens, cookieOpts);
    if (hadLegacyGuest) clearLegacyGuestCookie(reply, cookieOpts);
    const verified = await verifyTokens(verifyClient, minted.tokens);
    if (verified.kind !== "ok") return { kind: "transient" };
    return { kind: "ok", principalId: verified.principalId };
  }

  /** Read paths: resolve only, never mint. Null principal = anonymous observer. */
  function resolveExistingPrincipal(request: FastifyRequest, reply: FastifyReply) {
    return resolveSession(request, reply, false);
  }

  /** Write paths that require a durable identity: resolve, minting if absent. */
  async function requirePrincipal(request: FastifyRequest, reply: FastifyReply) {
    const outcome = await resolveSession(request, reply, true);
    if (outcome.kind === "ok" && outcome.principalId === null) {
      // Unreachable: mint=true always yields a principal on success.
      throw new Error("requirePrincipal resolved without a principal");
    }
    return outcome as { kind: "ok"; principalId: string } | { kind: "transient" };
  }

  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async () => ({
    status: "ok",
    ruleBundle: runtime.manifest.ruleBundleId,
    ruleManifestHash: runtime.manifestHash,
  }));

  app.get("/api/v1/capabilities", async (): Promise<CapabilitiesResponse> => {
    return {
      protocolVersion: PROTOCOL_VERSION,
      locales: ["zh-CN", "en"],
      defaultLocale: "zh-CN",
      ruleBundles: [
        { id: runtime.manifest.ruleBundleId, version: runtime.manifest.semanticVersion, hash: runtime.manifestHash },
      ],
      contentBundleId: runtime.manifest.contentBundleId,
      modes: ["human-vs-ai", "all-ai"],
      productName: BRAND.productName,
      allowFixedSeed: env.ALLOW_FIXED_SEED,
      persistence: "in-memory",
    };
  });

  app.get("/api/v1/content/:bundle/:locale", async (request, reply) => {
    const params = request.params as { bundle: string; locale: string };
    if (params.bundle !== runtime.manifest.contentBundleId) {
      return reply.code(404).send({ error: "MATCH_NOT_FOUND_OR_FORBIDDEN" });
    }
    const locale = params.locale === "en" ? "en" : "zh-CN";
    const catalog = runtime.catalogSorted.map((item) => ({
      id: item.id,
      tier: item.tier,
      category: item.category,
      value: item.value,
      footprint: item.footprint ?? { width: 1, height: 1 },
      shapeId: item.shapeId,
      ...(item.colorTier ? { colorTier: item.colorTier } : {}),
    }));
    return { locale, strings: runtime.locale[locale], contentHash: runtime.contentHash, catalog };
  });

  app.post("/api/v1/demo-matches", async (request, reply) => {
    const parsed = createMatchRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "COMMAND_SCHEMA_INVALID" });
    }
    const seed =
      parsed.data.seed && env.ALLOW_FIXED_SEED ? parsed.data.seed : randomBytes(12).toString("hex");
    // Fixed seeds derive a stable matchId so agent RNG (which mixes matchId) is reproducible.
    const matchId =
      parsed.data.seed && env.ALLOW_FIXED_SEED
        ? `seed-${createHash("sha256").update(`${parsed.data.mode}:${parsed.data.seed}`).digest("hex").slice(0, 32)}`
        : randomUUID();
    if (manager.get(matchId)) {
      manager.delete(matchId);
    }

    const roomEvents: RoomEvents = {
      onViewUpdate(update: ViewUpdate, revision: number) {
        pushView(matchId, update, revision);
      },
      onMatchCompleted(result: unknown) {
        pushToMatch(matchId, (ctx, seq) => ({
          protocolVersion: PROTOCOL_VERSION,
          serverSequence: seq,
          matchId,
          revision: -1,
          type: "match_completed",
          payload: result,
        }));
      },
      onEvents() {},
    };

    if (parsed.data.mode === "human-vs-ai") {
      // THE-37a: the only path that mints a durable identity. all-ai matches
      // and read endpoints never consume the anonymous-signup bucket.
      const principal = await requirePrincipal(request, reply);
      if (principal.kind === "transient") return transientUnavailable(reply);
      manager.createHumanVsAi({ matchId, seed, humanPrincipalId: principal.principalId, events: roomEvents });
    } else {
      manager.createAllAi({ matchId, seed, events: roomEvents });
    }
    request.log.info({ matchId, mode: parsed.data.mode }, "match created");
    return { matchId, mode: parsed.data.mode, seed };
  });

  app.get("/api/v1/matches/:id/view", async (request, reply) => {
    const matchId = (request.params as { id: string }).id;
    const room = manager.get(matchId);
    if (!room) {
      return reply.code(404).send({ error: "MATCH_NOT_FOUND_OR_FORBIDDEN" });
    }
    const principal = await resolveExistingPrincipal(request, reply);
    if (principal.kind === "transient") return transientUnavailable(reply);
    const view = room.viewForPrincipal(principal.principalId ?? "observer");
    if (!view) {
      return reply.code(403).send({ error: "MATCH_NOT_FOUND_OR_FORBIDDEN" });
    }
    return { view, demo: room.demoState, deadlineAtMs: room.activeDeadlineAtMs };
  });

  function pushToMatch(
    matchId: string,
    build: (ctx: ConnectionContext, seq: number) => ServerEnvelope,
  ): void {
    const set = connections.get(matchId);
    if (!set || set.size === 0) return;
    manager.touch(matchId);
    for (const conn of set) {
      conn.ctx.serverSequence += 1;
      const envelope = build(conn.ctx, conn.ctx.serverSequence);
      try {
        conn.socket.send(JSON.stringify(envelope));
      } catch {
        /* closed */
      }
    }
  }

  function pushView(matchId: string, update: ViewUpdate, revision: number): void {
    const set = connections.get(matchId);
    if (!set || set.size === 0) return;
    manager.touch(matchId);
    for (const conn of set) {
      let view: unknown = null;
      if (update.kind === "public" && conn.ctx.isObserver) {
        view = update.view;
      } else if (update.kind === "seat" && !conn.ctx.isObserver) {
        const room = manager.get(matchId);
        if (room && conn.ctx.principalId) {
          view = room.viewForPrincipal(conn.ctx.principalId);
        }
      }
      if (!view) continue;
      conn.ctx.serverSequence += 1;
      const envelope: ServerEnvelope = {
        protocolVersion: PROTOCOL_VERSION,
        serverSequence: conn.ctx.serverSequence,
        matchId,
        revision,
        type: "snapshot",
        payload: { view, deadlineAtMs: manager.get(matchId)?.activeDeadlineAtMs ?? null, demo: manager.get(matchId)?.demoState },
      };
      try {
        conn.socket.send(JSON.stringify(envelope));
      } catch {
        /* closed */
      }
    }
  }

  app.get(
    "/api/v1/matches/:id/stream",
    {
      websocket: true,
      // THE-37a: authenticate BEFORE the upgrade completes. A transient
      // identity failure rejects the handshake with 503 (the existing client
      // treats a failed upgrade as recoverable and retries with backoff);
      // definitive absence proceeds to the handler, which closes with the
      // established 4003/4004 codes. The session cookie is never cleared on
      // a transient failure.
      preValidation: async (request, reply) => {
        const matchId = (request.params as { id: string }).id;
        const room = manager.get(matchId);
        if (!room || room.mode !== "human-vs-ai") return;
        const principal = await resolveExistingPrincipal(request, reply);
        if (principal.kind === "transient") {
          await transientUnavailable(reply);
          return reply;
        }
        (request as FastifyRequest & { wsPrincipalId: string | null }).wsPrincipalId =
          principal.principalId;
      },
    },
    (socket, request) => {
    const matchId = (request.params as { id: string }).id;
    const room = manager.get(matchId);
    if (!room) {
      socket.close(4004, "MATCH_NOT_FOUND_OR_FORBIDDEN");
      return;
    }
    let principalId: string | null = null;
    if (room.mode === "human-vs-ai") {
      principalId =
        (request as FastifyRequest & { wsPrincipalId?: string | null }).wsPrincipalId ?? null;
      if (!principalId || !room.seatIdForPrincipal(principalId)) {
        socket.close(4003, "AUTH_REQUIRED");
        return;
      }
    }

    const origin = request.headers.origin;
    if (origin) {
      try {
        const originHost = new URL(origin).host;
        const allowedHosts = new Set([request.headers.host]);
        for (const allowed of corsOrigins ?? []) {
          try {
            allowedHosts.add(new URL(allowed).host);
          } catch {
            /* skip malformed CORS_ORIGIN entries */
          }
        }
        if (!allowedHosts.has(originHost)) {
          socket.close(4001, "ORIGIN_FORBIDDEN");
          return;
        }
      } catch {
        socket.close(4001, "ORIGIN_FORBIDDEN");
        return;
      }
    }

    const ctx: ConnectionContext = {
      matchId,
      principalId,
      isObserver: room.mode === "all-ai",
      serverSequence: 0,
    };
    const conn = { socket, ctx, isAlive: true, terminatedByHeartbeat: false };
    socket.on("pong", () => {
      conn.isAlive = true;
    });
    let set = connections.get(matchId);
    if (!set) {
      set = new Set();
      connections.set(matchId, set);
    }
    if (principalId) {
      for (const other of set) {
        if (other.ctx.principalId === principalId) {
          try {
            other.socket.close(4009, "CONNECTION_SUPERSEDED");
          } catch {
            /* closed */
          }
          set.delete(other);
        }
      }
    }
    set.add(conn);

    const send = (envelope: ServerEnvelope): void => {
      ctx.serverSequence = envelope.serverSequence;
      socket.send(JSON.stringify(envelope));
    };
    void send;

    ctx.serverSequence += 1;
    socket.send(
      JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        serverSequence: ctx.serverSequence,
        matchId,
        revision: room.revision,
        type: "hello",
        payload: { viewer: ctx.isObserver ? "public" : room.seatIdForPrincipal(principalId!) },
      } satisfies ServerEnvelope),
    );
    ctx.serverSequence += 1;
    socket.send(
      JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        serverSequence: ctx.serverSequence,
        matchId,
        revision: room.revision,
        type: "snapshot",
        payload: {
          view: room.viewForPrincipal(principalId ?? "observer"),
          deadlineAtMs: room.activeDeadlineAtMs,
          demo: room.demoState,
        },
      } satisfies ServerEnvelope),
    );

    socket.on("message", (raw: Buffer) => {
      void (async () => {
        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(raw.toString());
        } catch {
          return;
        }
        // THE-24: this handler reuses the `room` reference captured once at
        // connect time rather than calling manager.get() per message, so a
        // long-lived, actively-used connection needs an explicit touch here
        // to keep resetting the idle-eviction clock.
        manager.touch(matchId);
        const obj = parsedJson as { protocolVersion?: number };
        if (obj.protocolVersion !== PROTOCOL_VERSION) {
          ctx.serverSequence += 1;
          socket.send(
            JSON.stringify({
              protocolVersion: PROTOCOL_VERSION,
              serverSequence: ctx.serverSequence,
              matchId,
              revision: room.revision,
              type: "fatal_error",
              payload: { code: "PROTOCOL_VERSION_UNSUPPORTED" },
            } satisfies ServerEnvelope),
          );
          socket.close(4000, "PROTOCOL_VERSION_UNSUPPORTED");
          return;
        }

        const demoControl = demoControlSchema.safeParse(parsedJson);
        if (demoControl.success && room.mode === "all-ai") {
          const dc = demoControl.data;
          if (dc.type === "demo_pause") room.setDemoPaused(true);
          if (dc.type === "demo_resume") room.setDemoPaused(false);
          if (dc.type === "demo_step") await room.demoStep();
          if (dc.type === "demo_set_speed" && dc.speedMultiplier) room.setDemoSpeed(dc.speedMultiplier);
          ctx.serverSequence += 1;
          socket.send(
            JSON.stringify({
              protocolVersion: PROTOCOL_VERSION,
              serverSequence: ctx.serverSequence,
              matchId,
              revision: room.revision,
              type: "demo_state",
              payload: room.demoState,
            } satisfies ServerEnvelope),
          );
          // demo_step already published exactly one presentation snapshot from the room.
          // Other demo controls still need a snapshot so clients refresh demo flags.
          if (dc.type !== "demo_step") {
            ctx.serverSequence += 1;
            socket.send(
              JSON.stringify({
                protocolVersion: PROTOCOL_VERSION,
                serverSequence: ctx.serverSequence,
                matchId,
                revision: room.revision,
                type: "snapshot",
                payload: {
                  view: room.viewForPrincipal(principalId ?? "observer"),
                  deadlineAtMs: room.activeDeadlineAtMs,
                  demo: room.demoState,
                },
              } satisfies ServerEnvelope),
            );
          }
          return;
        }

        const envelope = commandEnvelopeSchema.safeParse(parsedJson);
        if (!envelope.success) {
          ctx.serverSequence += 1;
          socket.send(
            JSON.stringify({
              protocolVersion: PROTOCOL_VERSION,
              serverSequence: ctx.serverSequence,
              matchId,
              revision: room.revision,
              type: "command_rejected",
              payload: { code: "COMMAND_SCHEMA_INVALID" },
            } satisfies ServerEnvelope),
          );
          return;
        }
        const env2 = envelope.data;
        if (env2.matchId !== matchId) {
          return;
        }
        if (!principalId) {
          return;
        }
        const seatId = room.seatIdForPrincipal(principalId);
        if (!seatId) {
          return;
        }
        const command = toGameCommand(env2.payload, seatId);
        request.log.info(
          { matchId, commandId: env2.commandId, commandType: env2.payload.type, seatId },
          "command received",
        );
        const result = await room.submitCommand({
          commandId: env2.commandId,
          expectedRevision: env2.expectedRevision,
          seatId,
          command,
          source: "human",
        });
        ctx.serverSequence += 1;
        socket.send(
          JSON.stringify({
            protocolVersion: PROTOCOL_VERSION,
            serverSequence: ctx.serverSequence,
            matchId,
            revision: room.revision,
            type: result.accepted ? "command_accepted" : "command_rejected",
            payload: {
              commandId: env2.commandId,
              revision: result.revision,
              ...(result.rejectionCode ? { code: result.rejectionCode } : {}),
              ...(result.duplicate ? { duplicate: true } : {}),
            },
          } satisfies ServerEnvelope),
        );
      })();
    });

    socket.on("close", () => {
      const set = connections.get(matchId);
      set?.delete(conn);
      // Prune the now-empty Set rather than leaving a dead entry behind, and
      // touch the room so a genuine reconnect gets the full idle window
      // measured from "last actually connected", not from whenever some
      // earlier, unrelated message happened to arrive. Exception: a socket
      // the THE-26 heartbeat itself terminated was already unresponsive —
      // its teardown is not activity and must not reset the THE-24
      // idle-eviction clock.
      if (set && set.size === 0) connections.delete(matchId);
      if (!conn.terminatedByHeartbeat) manager.touch(matchId);
    });
    },
  );

  app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    // Status-coded errors (e.g. the 429 raised by @fastify/rate-limit) keep
    // their status; only genuinely unexpected errors collapse to 500.
    if (typeof error.statusCode === "number" && error.statusCode < 500) {
      void reply.code(error.statusCode).send({ error: error.message });
      return;
    }
    request.log.error({ err: error.message }, "unhandled error");
    void reply.code(500).send({ error: "TEMPORARY_STORAGE_FAILURE" });
  });

  const here = dirname(fileURLToPath(import.meta.url));
  const webDist = join(here, "..", "..", "web", "dist");
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, {
      root: webDist,
      index: ["index.html"],
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/") || request.url.startsWith("/health/")) {
        void reply.code(404).send({ error: "MATCH_NOT_FOUND_OR_FORBIDDEN" });
        return;
      }
      void reply.sendFile("index.html");
    });
  }

  return app;
}
