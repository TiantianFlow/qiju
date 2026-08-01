import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compileDemoV0 } from "@qiju/rules-demo";
import {
  createMatch,
  hashState,
  SEAT_IDS,
  type CompiledRuleRuntime,
  type GameCommand,
  type LegalActionSet,
  type MatchState,
  type SeatId,
} from "@qiju/game-core";
import { agentById, deterministicFallback, BUILTIN_AGENTS } from "@qiju/agents";
import { runAgentMatch, verifyReplay, type MatchRunOutcome, type ReplayFile } from "@qiju/replay";

interface CliArgs {
  command: string;
  options: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): CliArgs {
  const [command = "help", ...rest] = argv;
  const options: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = rest[i + 1];
      if (next === undefined || next.startsWith("--")) {
        options[key] = true;
      } else {
        options[key] = next;
        i++;
      }
    }
  }
  return { command, options };
}

function printHelp(): void {
  process.stdout.write(`qiju-arena - offline simulation and evaluation

Usage:
  arena run      Run a batch of matches
    --matches N          number of matches (default 100)
    --seed-prefix S      seed prefix (default "arena")
    --agents a,b,c,d     agent ids per seat (default: four balanced-calculator)
    --out DIR            output directory (default data/arena-run)
    --trajectories       write trajectories.jsonl
    --smoke              smoke mode: verifies hash determinism

  arena verify   Verify a replay file
    --replay PATH        replay JSON file

  arena compare  Compare two agents pairwise over N matches
    --matches N          matches per pairing (default 100)
    --a ID               candidate agent (default balanced-calculator)
    --b ID               baseline agent (default cautious-appraiser)
    --out DIR            output directory

  arena scenario Run a single scripted match and print round summary
    --seed S             seed (default "scenario")

  arena agents   List built-in agents
`);
}

function fallbackCommand(input: {
  legalActions: LegalActionSet;
  seatId: SeatId;
  actionWindowId?: string;
}): GameCommand {
  return deterministicFallback({
    observation: undefined as never,
    legalActions: input.legalActions,
    context: {
      matchId: "fallback",
      revision: 0,
      seatId: input.seatId,
      ...(input.actionWindowId ? { actionWindowId: input.actionWindowId } : {}),
      ruleBundleId: "demo.v0",
      agentSeed: "fallback",
      softTimeBudgetMs: 0,
    },
  }).action;
}

async function commandRun(options: Record<string, string | boolean>): Promise<number> {
  const runtime = compileDemoV0();
  const matches = Number(options.matches ?? 100);
  const seedPrefix = String(options["seed-prefix"] ?? "arena");
  const outDir = String(options.out ?? "data/arena-run");
  const collectTrajectories = Boolean(options.trajectories);
  const smoke = Boolean(options.smoke);
  const agentIds = String(options.agents ?? "balanced-calculator,balanced-calculator,balanced-calculator,balanced-calculator").split(",");
  const agents = agentIds.map((id) => {
    const agent = agentById(id.trim());
    if (!agent) throw new Error(`unknown agent: ${id}`);
    return agent;
  });
  if (agents.length !== 4) throw new Error("exactly 4 agents required");

  mkdirSync(outDir, { recursive: true });
  const startedAt = new Date().toISOString();
  const outcomes: MatchRunOutcome[] = [];
  const matchesLines: string[] = [];
  const trajectoryLines: string[] = [];
  let totalFallback = 0;
  let totalIllegal = 0;

  for (let i = 0; i < matches; i++) {
    const seed = `${seedPrefix}-${i}`;
    const matchId = `match-${seedPrefix}-${i}`;
    const outcome = await runAgentMatch(
      runtime,
      {
        matchId,
        seed,
        seats: SEAT_IDS.map((seatId, idx) => ({ seatId, agent: agents[idx]! })),
        agentSeedBase: "arena",
      },
      { collectTrajectories, fallback: (fi) => fallbackCommand(fi) },
    );
    outcomes.push(outcome);
    totalFallback += outcome.fallbackCount;
    totalIllegal += outcome.illegalAttempts;
    matchesLines.push(
      JSON.stringify({
        matchId: outcome.matchId,
        seed: outcome.seed,
        finalStateHash: outcome.finalStateHash,
        acquisition: outcome.result.acquisition,
        economic: outcome.result.economic,
      }),
    );
    for (const t of outcome.trajectories) {
      trajectoryLines.push(JSON.stringify(t));
    }
    if (smoke && i < 2) {
      const again = await runAgentMatch(
        runtime,
        {
          matchId,
          seed,
          seats: SEAT_IDS.map((seatId, idx) => ({ seatId, agent: agents[idx]! })),
          agentSeedBase: "arena",
        },
        { collectTrajectories: false, fallback: (fi) => fallbackCommand(fi) },
      );
      if (again.finalStateHash !== outcome.finalStateHash) {
        process.stderr.write(`hash drift on ${matchId}\n`);
        return 1;
      }
    }
  }

  const summary = buildSummary(runtime, outcomes, agentIds, totalFallback, totalIllegal);
  const manifest = {
    schemaVersion: 1,
    createdAt: startedAt,
    coreProtocol: runtime.manifest.coreProtocol,
    ruleBundleId: runtime.manifest.ruleBundleId,
    ruleManifestHash: runtime.manifestHash,
    contentBundleId: runtime.manifest.contentBundleId,
    contentHash: runtime.contentHash,
    rngAlgorithm: runtime.manifest.rngAlgorithm,
    agentIds: agentIds,
    matches,
    seedPrefix,
    rewardDefinition: "relative-final-wealth/4B",
  };

  writeFileSync(join(outDir, "run-manifest.json"), JSON.stringify(manifest, null, 2));
  writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  writeFileSync(join(outDir, "matches.jsonl"), matchesLines.join("\n") + "\n");
  if (collectTrajectories) {
    writeFileSync(join(outDir, "trajectories.jsonl"), trajectoryLines.join("\n") + "\n");
  }
  writeFileSync(join(outDir, "report.md"), buildReport(summary, manifest));
  process.stdout.write(`arena run complete: ${matches} matches -> ${outDir}\n`);
  process.stdout.write(
    `acquisition-rate=${(summary.acquisitionRate * 100).toFixed(1)}% no-sale=${summary.noSaleCount} fallbacks=${totalFallback} illegal=${totalIllegal}\n`,
  );
  return 0;
}

interface Summary {
  matchCount: number;
  acquisitionRate: number;
  noSaleCount: number;
  averageSettlementRound: number;
  averageWinningBid: number;
  averageActualValueProxy: number;
  overbidRate: number;
  perSeat: Record<string, { acquisitions: number; economicFirst: number; meanUtility: number; meanProfit: number }>;
  perAgent: Record<string, { acquisitions: number; meanProfit: number }>;
  fallbackCount: number;
  illegalAttempts: number;
  zeroBidRate: number;
}

function buildSummary(
  runtime: CompiledRuleRuntime,
  outcomes: MatchRunOutcome[],
  agentIds: string[],
  fallbackCount: number,
  illegalAttempts: number,
): Summary {
  void runtime;
  const perSeat: Summary["perSeat"] = {};
  const perAgent: Summary["perAgent"] = {};
  for (const seatId of SEAT_IDS) {
    perSeat[seatId] = { acquisitions: 0, economicFirst: 0, meanUtility: 0, meanProfit: 0 };
  }
  for (const id of new Set(agentIds)) {
    perAgent[id] = { acquisitions: 0, meanProfit: 0 };
  }
  let sold = 0;
  let noSale = 0;
  let roundSum = 0;
  let bidSum = 0;
  let overbid = 0;
  let zeroBidReveals = 0;
  let totalReveals = 0;

  for (const outcome of outcomes) {
    const acq = outcome.result.acquisition;
    if (acq.buyerSeatId !== undefined) {
      sold++;
      roundSum += acq.settlementRound ?? 0;
      bidSum += acq.winningBid ?? 0;
      const buyerEcon = outcome.result.economic.find((e) => e.seatId === acq.buyerSeatId)!;
      if (buyerEcon.realizedProfit < 0) overbid++;
    } else {
      noSale++;
    }
    for (const entry of outcome.result.economic) {
      const seatStats = perSeat[entry.seatId]!;
      if (acq.buyerSeatId === entry.seatId) seatStats.acquisitions++;
      if (entry.denseEconomicRank === 1) seatStats.economicFirst++;
      seatStats.meanProfit += entry.realizedProfit / outcomes.length;
      const agentId = agentIds[SEAT_IDS.indexOf(entry.seatId)]!;
      const agentStats = perAgent[agentId]!;
      if (acq.buyerSeatId === entry.seatId) agentStats.acquisitions++;
      agentStats.meanProfit += entry.realizedProfit / outcomes.length;
    }
    for (const t of outcome.result.training) {
      perSeat[t.seatId]!.meanUtility += t.utilityNumerator / t.utilityDenominator / outcomes.length;
    }
    for (const reveal of outcome.events.filter((e) => e.type === "bids.revealed")) {
      totalReveals++;
      const bids = reveal.payload.bids as Record<string, number>;
      if (Object.values(bids).every((v) => v === 0)) zeroBidReveals++;
    }
  }

  return {
    matchCount: outcomes.length,
    acquisitionRate: outcomes.length ? sold / outcomes.length : 0,
    noSaleCount: noSale,
    averageSettlementRound: sold ? roundSum / sold : 0,
    averageWinningBid: sold ? bidSum / sold : 0,
    averageActualValueProxy: 0,
    overbidRate: sold ? overbid / sold : 0,
    perSeat,
    perAgent,
    fallbackCount,
    illegalAttempts,
    zeroBidRate: totalReveals ? zeroBidReveals / totalReveals : 0,
  };
}

function buildReport(
  summary: Summary,
  manifest: Record<string, unknown>,
): string {
  const lines: string[] = [
    "# Qiju Arena Report",
    "",
    `- Rule bundle: \`${manifest.ruleBundleId}\` (\`${String(manifest.ruleManifestHash).slice(0, 12)}…\`)`,
    `- Content: \`${manifest.contentBundleId}\` (\`${String(manifest.contentHash).slice(0, 12)}…\`)`,
    `- Agents: ${(manifest.agentIds as string[]).join(", ")}`,
    `- Matches: ${summary.matchCount}`,
    "",
    "## Outcomes",
    "",
    `- Acquisition rate: ${(summary.acquisitionRate * 100).toFixed(1)}%`,
    `- No-sale matches: ${summary.noSaleCount}`,
    `- Average settlement round: ${summary.averageSettlementRound.toFixed(2)}`,
    `- Average winning bid: ${summary.averageWinningBid.toFixed(0)}`,
    `- Overbid (buyer loss) rate: ${(summary.overbidRate * 100).toFixed(1)}%`,
    `- All-zero reveal rate: ${(summary.zeroBidRate * 100).toFixed(1)}%`,
    `- Fallbacks: ${summary.fallbackCount}; illegal attempts: ${summary.illegalAttempts}`,
    "",
    "## Per seat",
    "",
    "| Seat | Acquisitions | Economic first | Mean profit | Mean utility |",
    "|---|---|---:|---:|---:|",
  ];
  for (const [seatId, s] of Object.entries(summary.perSeat)) {
    lines.push(
      `| ${seatId} | ${s.acquisitions} | ${s.economicFirst} | ${s.meanProfit.toFixed(0)} | ${s.meanUtility.toFixed(4)} |`,
    );
  }
  lines.push("", "## Per agent", "", "| Agent | Acquisitions | Mean profit |", "|---|---|---:|");
  for (const [agentId, s] of Object.entries(summary.perAgent)) {
    lines.push(`| ${agentId} | ${s.acquisitions} | ${s.meanProfit.toFixed(0)} |`);
  }
  lines.push("");
  return lines.join("\n");
}

async function commandVerify(options: Record<string, string | boolean>): Promise<number> {
  const path = options.replay;
  if (typeof path !== "string") {
    process.stderr.write("arena verify requires --replay PATH\n");
    return 1;
  }
  const { readFileSync } = await import("node:fs");
  const replay = JSON.parse(readFileSync(path, "utf8")) as ReplayFile;
  const runtime = compileDemoV0();
  const initial: MatchState = createMatch({ matchId: replay.matchId, seed: replay.seed, runtime });
  const result = verifyReplay(runtime, initial, replay);
  if (result.ok) {
    process.stdout.write("replay verified: final hash matches\n");
    return 0;
  }
  process.stderr.write(
    `replay mismatch at revision ${result.mismatchAtRevision}: expected ${result.expectedHash} got ${result.actualHash}\n`,
  );
  return 1;
}

async function commandCompare(options: Record<string, string | boolean>): Promise<number> {
  const matches = Number(options.matches ?? 100);
  const aId = String(options.a ?? "balanced-calculator");
  const bId = String(options.b ?? "cautious-appraiser");
  const outDir = String(options.out ?? "data/arena-compare");
  const a = agentById(aId);
  const b = agentById(bId);
  if (!a || !b) throw new Error("unknown agent id");
  const runtime = compileDemoV0();
  mkdirSync(outDir, { recursive: true });

  const statsA = { profit: 0, acquisitions: 0, economicFirst: 0 };
  const statsB = { profit: 0, acquisitions: 0, economicFirst: 0 };

  for (let i = 0; i < matches; i++) {
    const seed = `compare-${i}`;
    const rotate = i % 2 === 0;
    const agents = rotate ? [a, b, a, b] : [b, a, b, a];
    const outcome = await runAgentMatch(
      runtime,
      {
        matchId: `cmp-${i}`,
        seed,
        seats: SEAT_IDS.map((seatId, idx) => ({ seatId, agent: agents[idx]! })),
        agentSeedBase: "arena-compare",
      },
      { collectTrajectories: false, fallback: (fi) => fallbackCommand(fi) },
    );
    for (const entry of outcome.result.economic) {
      const idx = SEAT_IDS.indexOf(entry.seatId);
      const isA = agents[idx] === a;
      const stats = isA ? statsA : statsB;
      stats.profit += entry.realizedProfit;
      if (outcome.result.acquisition.buyerSeatId === entry.seatId) stats.acquisitions++;
      if (entry.denseEconomicRank === 1) stats.economicFirst++;
    }
  }

  const seatsPerAgent = matches * 2;
  const report = {
    a: aId,
    b: bId,
    matches,
    aResults: {
      meanProfit: statsA.profit / seatsPerAgent,
      acquisitions: statsA.acquisitions,
      economicFirst: statsA.economicFirst,
    },
    bResults: {
      meanProfit: statsB.profit / seatsPerAgent,
      acquisitions: statsB.acquisitions,
      economicFirst: statsB.economicFirst,
    },
  };
  writeFileSync(join(outDir, "compare.json"), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  return 0;
}

async function commandScenario(options: Record<string, string | boolean>): Promise<number> {
  const seed = String(options.seed ?? "scenario");
  const runtime = compileDemoV0();
  const outcome = await runAgentMatch(
    runtime,
    {
      matchId: "scenario-1",
      seed,
      seats: SEAT_IDS.map((seatId) => ({ seatId, agent: BUILTIN_AGENTS[2]! })),
      agentSeedBase: "arena-scenario",
    },
    { collectTrajectories: false, fallback: (fi) => fallbackCommand(fi) },
  );
  process.stdout.write(`seed=${seed} finalHash=${outcome.finalStateHash}\n`);
  for (const event of outcome.events) {
    if (event.type === "bids.revealed" || event.type === "match.completed" || event.type === "lot.created") {
      process.stdout.write(`${event.type}: ${JSON.stringify(event.payload)}\n`);
    }
  }
  return 0;
}

async function main(): Promise<number> {
  const { command, options } = parseArgs(process.argv.slice(2));
  switch (command) {
    case "run":
      return commandRun(options);
    case "verify":
      return commandVerify(options);
    case "compare":
      return commandCompare(options);
    case "scenario":
      return commandScenario(options);
    case "agents":
      for (const agent of BUILTIN_AGENTS) {
        process.stdout.write(`${agent.agentId}@${agent.agentVersion}\n`);
      }
      return 0;
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return 0;
    default:
      process.stderr.write(`unknown command: ${command}\n`);
      printHelp();
      return 1;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`arena error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });

export { hashState };
