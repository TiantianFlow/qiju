# Qiju

A research-grade sealed-bid auction game inspired by competitive auction
mechanics: four seats race to value an opaque lot of collectibles through a
veil of partial, asymmetric intel, then submit sealed bids across a
multi-round auction with escalating pass-price thresholds.

**🎲 [Play the live demo →](https://qijugame.com)**

Qiju is a from-scratch, deterministic reimplementation — original content,
original economy, original UI — built as a full-stack TypeScript reference
project: a pure functional game-core state machine, a Fastify + WebSocket
authoritative server, a React client, and a CLI arena for offline AI-vs-AI
simulation at scale.

## Architecture

A pnpm workspace monorepo:

```
qiju/
├── apps/
│   ├── web/              React + Vite client (deployable as a static SPA)
│   ├── server/            Fastify HTTP + WebSocket authoritative game server
│   └── arena/              CLI for offline batch simulation & AI benchmarking
├── packages/
│   ├── game-core/          Pure deterministic state machine (no I/O, no clock, no RNG side effects)
│   ├── content-demo/       Item catalog, value bands, locale strings
│   ├── rules-demo/         Rule bundle compilation + conservative valuation engine
│   ├── agents/             Built-in deterministic AI agents (heuristic bidders)
│   ├── session-runtime/    In-memory room executor, clock abstraction, AI orchestration
│   ├── contracts/          Shared wire protocol types (zod schemas)
│   └── test-kit/           Shared test fixtures/helpers
└── scripts/                 Repo guard scripts (e.g. forbidden-content check)
```

Match state lives entirely in server memory — there is no database. A server
restart drops any in-progress matches; this is a deliberate scope decision,
not a limitation to work around.

## Quick start

```bash
pnpm install
pnpm build
node apps/server/dist/main.js
```

Open `http://localhost:3000`.

For local development with hot reload (two terminals):

```bash
pnpm dev:server    # tsx watch, http://localhost:3000
pnpm dev:web       # vite dev, http://localhost:5173, proxies /api to :3000
```

## Environment variables

| Variable | Where | Default | Description |
|---|---|---|---|
| `PORT` | server | `3000` | HTTP/WS listen port |
| `HOST` | server | `0.0.0.0` | Listen address |
| `NODE_ENV` | server | `development` | `production` enables `Secure`/`SameSite=None` guest cookies and requires `COOKIE_SECRET` |
| `COOKIE_SECRET` | server | — | Required in production; signs the guest-session cookie |
| `CORS_ORIGIN` | server | unset (unrestricted) | Comma-separated allowed frontend origin(s) for a cross-origin deploy |
| `COOKIE_DOMAIN` | server | unset (host-only) | Shared parent domain for the guest cookie, if frontend/backend share one |
| `DATA_DIR` | server | `data` | Arena report output directory |
| `LOG_LEVEL` | server | `info` | Fastify/pino log level |
| `ALLOW_FIXED_SEED` | server | `true` | Allow clients to request a reproducible match seed |
| `VITE_API_URL` | web (build-time) | unset (relative paths) | Backend origin, set only for a cross-origin deploy — see [`.env.example`](./.env.example) and [`apps/web/.env.example`](./apps/web/.env.example) |

## Deployment

Designed for a split deploy: a static frontend on an edge CDN, a stateful
Node backend on a real compute host.

**Frontend (`apps/web`) → Cloudflare Pages** (or any static host)
- Build command: `pnpm --filter @qiju/web... run build`
- Output directory: `apps/web/dist`
- Set `VITE_API_URL` to the backend's public URL in the Pages build
  environment.

**Backend (`apps/server`) → Railway** (or any Node-capable host — Fastify +
WebSocket needs a real persistent process; this cannot run on static hosting
or standard edge/Workers runtimes as-is). See
[`apps/server/railway.toml`](./apps/server/railway.toml) for the Railway
service config. Set `NODE_ENV=production`, `COOKIE_SECRET`, and `CORS_ORIGIN`
(the frontend's origin) in the platform's environment settings.

No domain names are hardcoded anywhere in this repo — everything above is
wired through environment variables at build/deploy time.

## Gate commands

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm arena:smoke     # 1,000-match fixed-seed AI smoke run
pnpm build
pnpm test:e2e        # Playwright, requires `pnpm build` first
pnpm guard:content   # forbids private/research identifiers and hardcoded domains in source
```

## Screenshot

_placeholder — add a screenshot or GIF of a match in progress here._

## Project status

Qiju is a personal research and demo project, open-sourced for anyone curious
about deterministic game engines, sealed-bid auction mechanics, or full-stack
TypeScript architecture. It is not a supported product: bug reports and small
fixes are welcome, but large feature requests are likely to go unanswered.

The live demo runs on free/hobby-tier hosting and holds match state in memory
only — expect it to restart occasionally and drop in-progress matches.

## License

MIT — see [LICENSE](./LICENSE). This covers the entire project; all game
content is procedurally generated or written from scratch, with no third-party
art, audio, or font assets.
