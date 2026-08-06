<div align="center">

# 奇局 Qiju

English | [简体中文](./README.zh-CN.md)

**Four bidders. One crate of curiosities. Nobody knows what's inside.**

### 🎲 [Play now →](https://qijugame.com)

No sign-up. Runs in the browser. One match takes about five minutes.

![A Qiju match in progress: a partially revealed lot board, running estimated-value HUD, auction event log, and the sealed-bid dock](./docs/screenshot.png)

</div>

---

## The game

A sealed crate goes up for auction. Inside is a jumble of collectibles — a
golden koi statue, a broken sword hilt, a novelty air freshener, something
nobody has identified yet. Some are worth a fortune. Most are worth very
little.

You get **fragments**. Your analyst reveals a few shapes, or a category, or one
exact price tag. Your tools can probe for more. Everyone at the table sees a
*different* slice of the truth, and every scan you run is announced publicly —
so what your rivals choose to look at tells you something too.

Then you write a number on a slip of paper and hope.

## How to play

You're bidding for **the whole crate**, not individual items. You start with a
budget of **2,000,000**.

**Five rounds of sealed bids.** Everyone bids at once, in secret.

To win in an early round you must *dramatically* outbid everyone else — the
crate only changes hands early if someone is willing to badly overpay:

| Round | You win if your bid is over… |
|:---:|---|
| 1 | **2×** the second-highest bid |
| 2 | **1.6×** |
| 3 | **1.3×** |
| 4 | **1.1×** |
| 5 | simply the **highest** — final round |

Tie on the last round and it goes to a tiebreaker; tie again and the crate goes
unsold. Everyone walks away with nothing.

Between rounds, new intel arrives. Bid too early and you're guessing. Wait too
long and someone snatches it. **Win the crate for less than it turns out to be
worth** — that's the whole game.

## Your analyst

Pick one before the auction. Each sees the crate differently.

| Analyst | What they reveal |
|---|---|
| **Surveyor** | Shapes of 4 random unknown slots |
| **Cataloger** | 3 slot categories; identifies 1 item in round 3 |
| **Statistician** | Exact counts of 2 rarity tiers; a category's mean value in round 4 |
| **Appraiser** | 1 exact value up front; 2 new tiers in rounds 2 and 4 |

## Your tools

Pick one kit. Two uses, spend them when they matter — every use is public.

| Kit | Tools |
|---|---|
| **Survey Kit** | Shape Scan, Category Scan |
| **Catalog Kit** | Tier Scan, Identify |
| **Appraisal Kit** | Value Probe, Category Mean |

## Play against the AI

Four built-in bots play a full table. They're deterministic — feed a match the
same seed and it replays move for move, which makes bad beats reproducible and
arguments settleable.

You can also just **watch** a table of four AIs play each other, step by step or
at 8× speed.

---

<details>
<summary><b>Self-hosting and development</b></summary>

### Quick start

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

### Architecture

A pnpm workspace monorepo:

```
qiju/
├── apps/
│   ├── web/                React + Vite client (deployable as a static SPA)
│   ├── server/             Fastify HTTP + WebSocket authoritative game server
│   └── arena/              CLI for offline batch simulation & AI benchmarking
└── packages/
    ├── game-core/          Pure deterministic state machine (no I/O, no clock, no RNG side effects)
    ├── content-demo/       Item catalog, value bands, locale strings
    ├── rules-demo/         Rule bundle compilation + valuation engine
    ├── agents/             Built-in deterministic AI agents
    ├── session-runtime/    In-memory room executor, clock abstraction, AI orchestration
    ├── contracts/          Shared wire protocol types (zod schemas)
    └── test-kit/           Shared test fixtures/helpers
```

The server is authoritative and never sends a client information that seat
shouldn't have — hidden item values are stripped from the wire payload, not
merely hidden in the UI.

Match state lives entirely in server memory. There is no database. A restart
drops in-progress matches; that's a deliberate scope decision.

### Environment variables

| Variable | Where | Default | Description |
|---|---|---|---|
| `PORT` | server | `3000` | HTTP/WS listen port |
| `HOST` | server | `0.0.0.0` | Listen address |
| `NODE_ENV` | server | `development` | `production` enables `Secure`/`SameSite=None` guest cookies and requires `COOKIE_SECRET` |
| `COOKIE_SECRET` | server | — | Required in production; signs the guest-session cookie |
| `CORS_ORIGIN` | server | unset (unrestricted) | Comma-separated allowed frontend origin(s) for a cross-origin deploy |
| `COOKIE_DOMAIN` | server | unset (host-only) | Shared parent domain for the guest cookie |
| `DATA_DIR` | server | `data` | Arena report output directory |
| `LOG_LEVEL` | server | `info` | Fastify/pino log level |
| `ALLOW_FIXED_SEED` | server | `true` | Allow clients to request a reproducible match seed |
| `VITE_API_URL` | web (build-time) | unset (relative paths) | Backend origin, for a cross-origin deploy |

### Deployment

Designed for a split deploy: a static frontend on an edge CDN, a stateful Node
backend on a real compute host.

**Frontend (`apps/web`) → Cloudflare Pages** (or any static host)
- Build command: `pnpm --filter @qiju/web... run build`
- Output directory: `apps/web/dist`
- Set `VITE_API_URL` to the backend's public URL.

**Backend (`apps/server`) → Railway** (or any Node-capable host — Fastify +
WebSocket needs a real persistent process; it cannot run on static hosting or
standard edge/Workers runtimes as-is). See
[`apps/server/railway.toml`](./apps/server/railway.toml).

No domain names are hardcoded anywhere — everything is wired through
environment variables at build/deploy time.

### Tests

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm arena:smoke     # 1,000-match fixed-seed AI smoke run
pnpm build
pnpm test:e2e        # Playwright, requires `pnpm build` first
```

</details>

## About this project

Qiju is a fan-made, non-commercial hobby project — a take on the sealed-bid
auction format, written from scratch. The engine, rules, economy, interface
and code are entirely original, and most of the collectibles are generated
procedurally; a handful of named items are affectionate nods to the genre that
inspired it. Nothing here is copied from anyone else's assets, and the project
isn't affiliated with or endorsed by anyone.

It's a personal project rather than a supported product: bug reports and small
fixes are welcome, large feature requests probably won't get picked up. The
demo runs on hobby-tier hosting and keeps match state in memory, so expect the
occasional restart.

## License

MIT — see [LICENSE](./LICENSE). Covers the entire project; there are no
third-party art, audio, or font assets.
