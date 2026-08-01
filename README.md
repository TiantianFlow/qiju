# Qiju（奇局）MVP

原创、自托管的四席密封竞价游戏。当前为本地工作名，公开发布前名称与许可仍待法律门禁。

## 运行（Linux x64 / macOS）

```bash
pnpm install
pnpm build
node apps/server/dist/main.js
```

默认监听 `0.0.0.0:3000`，浏览器打开 `http://localhost:3000`。

环境变量：`PORT`、`HOST`、`DATA_DIR`、`COOKIE_SECRET`（生产必需）、`LOG_LEVEL`、`ALLOW_FIXED_SEED`、`NODE_ENV`。

## 开发

```bash
pnpm dev:server    # tsx watch, 端口 3000
pnpm dev:web       # vite dev, 端口 5173, 代理 /api
```

## 门禁命令

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm arena:smoke     # 固定 1,000 场 smoke
pnpm build
pnpm test:e2e        # Playwright（先 pnpm build）
pnpm guard:content   # 禁止私人研究数据／标识进入源码
```

## 范围说明

- 活动比赛只保存在服务器内存；进程重启会中止活动比赛，页面提示可恢复到首页。
- 同一进程内支持浏览器断线重连、commandId 幂等、绝对截止、stale revision 拒绝、最多结算一次。
- Arena 制品写入显式数据目录（`data/`）。
- 不实现 SQLite、迁移、备份、进程重启恢复。

## 结构

- `packages/game-core`：纯确定性状态机（无网络／时钟／随机外部源）。
- `packages/rules-demo` + `packages/content-demo`：冻结的 `demo.v0` 与 `content.synthetic.v0`。
- `packages/agents`：4 个内置确定性 Agent 与降级。
- `packages/replay`：无头比赛驱动、规范重放验证。
- `packages/session-runtime`：内存房间执行器、Clock、AI 协调。
- `apps/server`：Fastify HTTP + WebSocket 权威服务器。
- `apps/web`：可替换的 React 演示 UI。
- `apps/arena`：离线批量模拟与报告 CLI。
