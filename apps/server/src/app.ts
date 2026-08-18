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
  type CookieOptions,
  type SessionEnv,
  type SessionTokens,
} from "./session.js";
import {
  buildPersistedMatch,
  persistenceDeps,
  persistMatchCompletionFailOpen,
  type MatchPersistenceStore,
} from "./persistence.js";
import {
  clearOAuthCookie,
  isTransactionExpired,
  oauthCallback,
  oauthStart,
  playerLabel,
  readOAuthTransactions,
  RETURN_TO_ALLOWLIST,
  setOAuthCookie,
  transactionCorrelationHash,
  upsertTransaction,
  type AccountsEnv,
  type OAuthTransaction,
} from "./oauth.js";
import type { MatchResult } from "@qiju/game-core";

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
  // THE-39: accounts/OAuth/leaderboard ship DARK. Default off; every
  // user-visible surface for the feature is gated on this flag.
  FEATURE_ACCOUNTS: z
    .string()
    .default("false")
    .transform((v) => v === "true"),
  // Server's own externally reachable origin, used to build the OAuth
  // callback URL. Never derived from request Host/Origin headers.
  PUBLIC_API_ORIGIN: z.string().url().optional(),
  // Frontend origin the OAuth callback 303s to. Never request-derived.
  WEB_ORIGIN: z.string().url().optional(),
  // Domain-separated HMAC secret for pseudonymous leaderboard labels.
  PLAYER_LABEL_SECRET: z.string().min(16).optional(),
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
  // THE-44: production cookies are SameSite=None; Secure, so the CORS
  // allowlist is the ONLY control stopping an arbitrary origin from making
  // credentialed reads (e.g. /api/v1/me/career). Falling back to
  // `origin: true` with `credentials: true` reflects every origin — a
  // footgun the moment CORS_ORIGIN is unset. Fail startup instead.
  if (env.NODE_ENV === "production" && !(env.CORS_ORIGIN && env.CORS_ORIGIN.trim().length > 0)) {
    throw new Error("CORS_ORIGIN is required in production (credentialed SameSite=None cookies have no safe default)");
  }
  // THE-39: the OAuth feature needs fixed origins — the callback URL and
  // the final 303 are built only from these, never from request headers.
  if (env.FEATURE_ACCOUNTS) {
    if (!env.PUBLIC_API_ORIGIN || !env.WEB_ORIGIN) {
      throw new Error("FEATURE_ACCOUNTS requires PUBLIC_API_ORIGIN and WEB_ORIGIN");
    }
  }
  const cookieSecret = env.COOKIE_SECRET ?? "dev-only-insecure-secret-change-me";
  // THE-37b: resolve the persistence store at BUILD time, per app instance
  // (same discipline as sessionDeps.verifyClientFactory): a fault-injected
  // store must not leak between app instances in one process.
  const resolvedMatchStore: MatchPersistenceStore = persistenceDeps.storeFactory({
    SUPABASE_URL: String(merged.SUPABASE_URL),
    SUPABASE_SECRET_KEY: String(merged.SUPABASE_SECRET_KEY),
  });

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

  // THE-37b: match persistence store, resolved at build time (above) so a
  // fault-injected factory affects exactly one app instance. The default is
  // the real secret-key Supabase store; never the publishable key — RLS
  // denies it.
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
      persistence: "durable",
    };
  });

  /**
   * THE-37b: the caller's own career aggregates, computed in SQL over
   * persisted rows. Self-only (no :userId — no enumeration surface),
   * NEVER mints (the 30/hour anonymous-signup cap is real), and a
   * principal with no history gets zeroed aggregates, not 404.
   */
  app.get("/api/v1/me/career", async (request, reply) => {
    const principal = await resolveExistingPrincipal(request, reply);
    if (principal.kind === "transient") return transientUnavailable(reply);
    if (principal.principalId === null) {
      return reply.code(401).send({ error: "AUTH_REQUIRED" });
    }
    try {
      return await resolvedMatchStore.careerForUser(principal.principalId);
    } catch (err) {
      request.log.error({ err: err instanceof Error ? err.message : String(err) }, "career query failed");
      return reply.code(503).send({ error: "TEMPORARY_STORAGE_FAILURE" });
    }
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

    // THE-37b: resolve identity BEFORE defining the completion handler so
    // the handler can capture seat metadata without touching session-runtime
    // internals. human-vs-ai: seat1 is the human seat (RoomManager
    // construction), attributed to the resolved principal; all-ai: every
    // seat is an agent with a null user reference.
    let humanPrincipalId: string | null = null;
    if (parsed.data.mode === "human-vs-ai") {
      // THE-37a: the only path that mints a durable identity. all-ai matches
      // and read endpoints never consume the anonymous-signup bucket.
      const principal = await requirePrincipal(request, reply);
      if (principal.kind === "transient") return transientUnavailable(reply);
      humanPrincipalId = principal.principalId;
    }
    const seatContext: {
      mode: "human-vs-ai" | "all-ai";
      seats: Array<{ seatId: string; kind: "human" | "agent"; principalId?: string }>;
    } = {
      mode: parsed.data.mode,
      seats: ["seat1", "seat2", "seat3", "seat4"].map((seatId) =>
        seatId === "seat1" && parsed.data.mode === "human-vs-ai"
          ? { seatId, kind: "human" as const, principalId: humanPrincipalId! }
          : { seatId, kind: "agent" as const },
      ),
    };

    const roomEvents: RoomEvents = {
      onViewUpdate(update: ViewUpdate, revision: number) {
        pushView(matchId, update, revision);
      },
      onMatchCompleted(result: unknown, finalStateHash: string) {
        pushToMatch(matchId, (ctx, seq) => ({
          protocolVersion: PROTOCOL_VERSION,
          serverSequence: seq,
          matchId,
          revision: -1,
          type: "match_completed",
          payload: result,
        }));
        // THE-37b: durable record. Fire-and-forget AFTER the push is queued;
        // the store call is fail-open (logged + swallowed) so a database
        // problem can never block, delay, or fail the completion. Seat
        // metadata comes from the creation context (seat1 is the human seat
        // in human-vs-ai by RoomManager construction); agent seats carry a
        // null user reference, which is what keeps all-ai economics out of
        // every career aggregate in SQL.
        const persisted = buildPersistedMatch({
          matchId,
          mode: seatContext.mode,
          seed,
          ruleBundleId: runtime.manifest.ruleBundleId,
          ruleManifestHash: runtime.manifestHash,
          contentHash: runtime.contentHash,
          finalStateHash,
          result: result as MatchResult,
          seats: seatContext.seats,
        });
        persistMatchCompletionFailOpen(resolvedMatchStore, persisted, (message) =>
          app.log.error({ matchId, err: message }, "match persistence failed (fail-open)"),
        );
      },
      onEvents() {},
    };

    if (parsed.data.mode === "human-vs-ai") {
      manager.createHumanVsAi({ matchId, seed, humanPrincipalId: humanPrincipalId!, events: roomEvents });
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

  // ---------------------------------------------------------------------
  // THE-39 increment 2 — accounts: OAuth start/callback, /me, leaderboard.
  // Everything in this block is DARK behind FEATURE_ACCOUNTS (default off).
  // The browser never receives a Supabase token; conflicts fail safe and
  // preserve lv_session byte-for-byte on every error path.
  // ---------------------------------------------------------------------
  const accountsEnv: AccountsEnv = {
    ...sessionEnv,
    FEATURE_ACCOUNTS: env.FEATURE_ACCOUNTS,
    PUBLIC_API_ORIGIN: env.PUBLIC_API_ORIGIN,
    WEB_ORIGIN: env.WEB_ORIGIN,
    PLAYER_LABEL_SECRET: env.PLAYER_LABEL_SECRET,
  };

  if (env.FEATURE_ACCOUNTS) {
    const labelSecret = env.PLAYER_LABEL_SECRET ?? cookieSecret;
    const oauthCookieOpts: CookieOptions = {
      production: env.NODE_ENV === "production",
      ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
    };
    const callbackBase = `${env.PUBLIC_API_ORIGIN}/api/v1/auth/oauth/callback`;

    // Narrow start limiter IN ADDITION to the global one (per design):
    // 10/min/IP plus a tighter 3/min per presented principal for the
    // convert path, so provider-roundtrip abuse can't hammer Auth.
    const oauthLimiter = new Map<string, { count: number; resetAt: number }>();
    const OAUTH_WINDOW_MS = 60_000;
    function bucketLimited(key: string, limit: number): boolean {
      const now = Date.now();
      const entry = oauthLimiter.get(key);
      if (!entry || entry.resetAt <= now) {
        oauthLimiter.set(key, { count: 1, resetAt: now + OAUTH_WINDOW_MS });
        return false;
      }
      entry.count += 1;
      return entry.count > limit;
    }
    function oauthRateLimited(request: FastifyRequest, principalKey: string | null): boolean {
      if (bucketLimited(`ip:${getClientIp(request, env.TRUST_CF_CONNECTING_IP)}`, 10)) return true;
      if (principalKey && bucketLimited(`principal:${principalKey}`, 3)) return true;
      return false;
    }
    app.addHook("onClose", async () => oauthLimiter.clear());

    /** Read lv_session WITHOUT verifying against Auth (start re-verifies). */
    function presentedSession(request: FastifyRequest): {
      tokens: SessionTokens | null;
      malformed: boolean;
    } {
      const raw = request.cookies.lv_session;
      if (!raw) return { tokens: null, malformed: false };
      const unsigned = request.unsignCookie(raw);
      if (!unsigned.valid || !unsigned.value) return { tokens: null, malformed: true };
      const tokens = decodeSessionCookie(unsigned.value);
      return { tokens, malformed: tokens === null };
    }

    const startBodySchema = z.object({
      provider: z.enum(["google"]),
      returnTo: z.string().optional(),
    });

    /**
     * POST /api/v1/auth/oauth/start — begins a PKCE flow. Returns the
     * provider URL as JSON (a fetch cannot turn a 302 into top-level
     * cross-origin navigation). POST-only, JSON-only, custom header
     * required (forces a cross-origin preflight).
     */
    app.post("/api/v1/auth/oauth/start", async (request, reply) => {
      if (request.headers["x-lotveil-request"] !== "oauth") {
        return reply.code(400).send({ error: "INVALID_REQUEST" });
      }
      const presentedEarly = presentedSession(request);
      if (oauthRateLimited(request, presentedEarly.tokens?.refreshToken.slice(-12) ?? null)) {
        return reply.code(429).send({ error: "RATE_LIMITED" });
      }
      const parsed = startBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: "INVALID_REQUEST" });
      }
      const returnTo = parsed.data.returnTo ?? "/account";
      if (!(RETURN_TO_ALLOWLIST as readonly string[]).includes(returnTo)) {
        return reply.code(400).send({ error: "INVALID_REQUEST" });
      }

      const presented = presentedEarly;
      const outcome = await oauthStart(accountsEnv, {
        provider: parsed.data.provider,
        returnTo,
        sessionTokens: presented.tokens,
        presentedMalformedCookie: presented.malformed,
        callbackUrl: callbackBase,
        now: Date.now(),
      });

      if (outcome.kind === "fail") {
        // Verifier fix (HIGH): if the session rotated before the failure,
        // the rotated tokens MUST be written even now. Keeping the
        // pre-rotation cookie would leave the browser holding a refresh
        // token the Auth server may already have invalidated — the THE-42
        // career-detach class through another door. When rotated is null
        // the cookie is genuinely untouched.
        if (outcome.rotated) setSessionCookie(reply, outcome.rotated, cookieOpts);
        const txHash = presented.tokens
          ? transactionCorrelationHash(presented.tokens.accessToken.slice(-16))
          : "no-session";
        request.log.warn(
          { phase: "oauth_start", code: outcome.code, provider: parsed.data.provider, tx: txHash },
          "oauth start failed",
        );
        return reply.code(outcome.http).send({ error: outcome.code });
      }

      // Persist the transaction (cap 2, newest wins) and any rotation.
      const existing = readOAuthTransactions(request);
      const transactions = upsertTransaction(existing, outcome.transaction, Date.now());
      setOAuthCookie(reply, transactions, oauthCookieOpts);
      if (outcome.rotated) setSessionCookie(reply, outcome.rotated, cookieOpts);
      return reply.send({ redirectUrl: outcome.redirectUrl });
    });

    /**
     * GET /api/v1/auth/oauth/callback — Supabase redirects here with code+
     * state or provider error fields. Validates the transaction, exchanges,
     * rotates lv_session on success, consumes the transaction, and 303s to
     * the configured frontend. Host/Origin are NEVER used to build URLs.
     */
    app.get("/api/v1/auth/oauth/callback", async (request, reply) => {
      reply.header("cache-control", "no-store");
      reply.header("referrer-policy", "no-referrer");
      const query = request.query as Record<string, string | undefined>;
      const transactions = readOAuthTransactions(request);
      const webOrigin = env.WEB_ORIGIN!;
      const redirectWith = (returnTo: string, params: Record<string, string>) => {
        const url = new URL(returnTo, webOrigin);
        for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
        return reply.code(303).redirect(url.toString());
      };
      const consume = (tx: OAuthTransaction | null) => {
        const remaining = (transactions ?? []).filter(
          (t) =>
            !(tx && t.state === tx.state) &&
            !isTransactionExpired(t, Date.now()),
        );
        if (remaining.length > 0) setOAuthCookie(reply, remaining, oauthCookieOpts);
        else clearOAuthCookie(reply, oauthCookieOpts);
      };
      // Find the matching transaction first so error paths can consume it.
      const matched =
        query.state && transactions
          ? transactions.find(
              (t) => !isTransactionExpired(t, Date.now()) && t.state === query.state,
            )
          : null;

      // Consume the state on every exchange attempt (one-time).
      const result = await oauthCallback(accountsEnv, {
        code: query.code ?? null,
        state: query.state ?? null,
        providerError: query.error ?? null,
        providerErrorCode: query.error_code ?? null,
        transactions,
        now: Date.now(),
        snapshotExists: (userId) => resolvedMatchStore.snapshotExists(userId),
      });
      consume(matched ?? null);

      const txLog = matched ? transactionCorrelationHash(matched.state) : "unknown";
      switch (result.kind) {
        case "success": {
          // Only now is lv_session overwritten — all conversion invariants
          // (expected principal, permanent status, snapshot exists) held.
          setSessionCookie(reply, result.tokens, cookieOpts);
          request.log.info(
            { phase: "oauth_callback", outcome: "success", tx: txLog },
            "oauth callback completed",
          );
          return redirectWith(result.transaction.returnTo, { auth: "ok" });
        }
        case "cancelled":
          request.log.info({ phase: "oauth_callback", outcome: "cancelled", tx: txLog }, "oauth cancelled");
          return redirectWith(matched?.returnTo ?? "/account", { auth: "cancelled" });
        case "conflict":
          // Fail safe: lv_session untouched, no fallback sign-in, no merge.
          request.log.warn({ phase: "oauth_callback", outcome: "conflict", code: result.code, tx: txLog }, "oauth conflict");
          return redirectWith(matched?.returnTo ?? "/account", { auth: "conflict" });
        case "expired":
          return redirectWith("/account", { auth: "expired" });
        case "restart":
          request.log.warn({ phase: "oauth_callback", outcome: "restart", code: result.code, tx: txLog }, "oauth exchange failed");
          return redirectWith(matched?.returnTo ?? "/account", { auth: "restart" });
        case "failed":
          request.log.error({ phase: "oauth_callback", outcome: "failed", code: result.code, tx: txLog }, "oauth invariant failure");
          return redirectWith(matched?.returnTo ?? "/account", { auth: "failed" });
        case "transient":
          // Verifier fix (MEDIUM): consuming the transaction IS correct per
          // design (Auth JS removed the verifier; the code's outcome is
          // uncertain). The defect was the raw 503 JSON body — a user
          // mid-flow must land on the frontend restart page like every
          // other terminal callback state.
          request.log.warn({ phase: "oauth_callback", outcome: "transient", tx: txLog }, "oauth exchange transient failure");
          return redirectWith(matched?.returnTo ?? "/account", { auth: "restart" });
      }
    });

    /**
     * GET /api/v1/me — session status + authoritative conversion recovery.
     * NEVER mints. A stale anonymous-era JWT whose database user is already
     * permanent is recovered by rotating to a fresh session.
     */
    app.get("/api/v1/me", async (request, reply) => {
      const principal = await resolveExistingPrincipal(request, reply);
      if (principal.kind === "transient") return transientUnavailable(reply);
      if (principal.principalId === null) {
        return reply.send({ principal: "none", playerLabel: null });
      }
      // Authoritative status (the JWT's is_anonymous may be stale if the
      // browser closed between identity linking and callback completion).
      const presented = presentedSession(request);
      if (presented.tokens) {
        const { data, error } = await verifyClient.auth.getUser(presented.tokens.accessToken);
        if (!error && data.user) {
          if (data.user.is_anonymous === false) {
            return reply.send({
              principal: "account",
              playerLabel: playerLabel(data.user.id, labelSecret),
            });
          }
          return reply.send({
            principal: "guest",
            playerLabel: playerLabel(data.user.id, labelSecret),
          });
        }
      }
      // getUser unavailable but the session resolved: report guest without
      // a recovery claim rather than failing the read.
      return reply.send({
        principal: "guest",
        playerLabel: playerLabel(principal.principalId, labelSecret),
      });
    });

    /**
     * GET /api/v1/leaderboard — public, never mints, resolves an existing
     * principal only to mark isSelf. Sort and exclusion live in the RPC.
     * Pocket balance / win-loss-push come from leaderboard_page_v2.
     */
    app.get("/api/v1/leaderboard", async (request, reply) => {
      const query = request.query as Record<string, string | undefined>;
      const parsedOffset = Number(query.offset ?? "0");
      const parsedLimit = Number(query.limit ?? "50");
      if (
        !Number.isSafeInteger(parsedOffset) ||
        !Number.isSafeInteger(parsedLimit) ||
        parsedOffset < 0 ||
        parsedOffset > 100_000 ||
        parsedLimit < 1 ||
        parsedLimit > 100
      ) {
        return reply.code(400).send({ error: "INVALID_PAGINATION" });
      }
      const principal = await resolveExistingPrincipal(request, reply);
      if (principal.kind === "transient") return transientUnavailable(reply);
      try {
        const page = await resolvedMatchStore.leaderboardPage(parsedOffset, parsedLimit);
        const entries = page.rows.map((row) => ({
          rank: row.rank,
          playerLabel: playerLabel(row.userId, labelSecret),
          isSelf: principal.principalId !== null && row.userId === principal.principalId,
          pocketBalance: row.pocketBalance,
          wins: row.wins,
          losses: row.losses,
          pushes: row.pushes,
          matchesPlayed: row.matchesPlayed,
        }));
        const nextOffset =
          parsedOffset + parsedLimit < page.total ? parsedOffset + parsedLimit : null;
        return reply.send({ entries, total: page.total, nextOffset });
      } catch (err) {
        request.log.error({ err: err instanceof Error ? err.message : String(err) }, "leaderboard query failed");
        return reply.code(503).send({ error: "TEMPORARY_STORAGE_FAILURE" });
      }
    });
  } else {
    // Flag off: the surface is entirely absent, not merely disabled.
    app.all("/api/v1/auth/oauth/start", async (_request, reply) =>
      reply.code(404).send({ error: "MATCH_NOT_FOUND_OR_FORBIDDEN" }),
    );
    app.all("/api/v1/auth/oauth/callback", async (_request, reply) =>
      reply.code(404).send({ error: "MATCH_NOT_FOUND_OR_FORBIDDEN" }),
    );
    app.get("/api/v1/me", async (_request, reply) =>
      reply.code(404).send({ error: "MATCH_NOT_FOUND_OR_FORBIDDEN" }),
    );
    app.get("/api/v1/leaderboard", async (_request, reply) =>
      reply.code(404).send({ error: "MATCH_NOT_FOUND_OR_FORBIDDEN" }),
    );
  }

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
