import { z } from "zod";

export const PROTOCOL_VERSION = 1 as const;

export const seatIdSchema = z.enum(["seat1", "seat2", "seat3", "seat4"]);

export const createMatchRequestSchema = z.object({
  mode: z.enum(["human-vs-ai", "all-ai"]),
  seed: z.string().min(1).max(128).optional(),
  agents: z.array(z.string()).length(4).optional(),
});
export type CreateMatchRequest = z.infer<typeof createMatchRequestSchema>;

export const clientCommandSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("select_loadout"),
    analystId: z.string(),
    toolPackageId: z.string(),
  }),
  z.object({ type: z.literal("lock_setup") }),
  z.object({
    type: z.literal("use_tool"),
    toolId: z.string(),
    actionWindowId: z.string(),
  }),
  z.object({
    type: z.literal("submit_bid"),
    amount: z.number().int().min(0),
    actionWindowId: z.string(),
  }),
  z.object({
    type: z.literal("lock_bid"),
    actionWindowId: z.string(),
  }),
]);
export type ClientCommand = z.infer<typeof clientCommandSchema>;

export const commandEnvelopeSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  commandId: z.string().min(8).max(64),
  matchId: z.string().min(1).max(64),
  expectedRevision: z.number().int().min(0),
  type: z.literal("submit_action"),
  payload: clientCommandSchema,
});
export type CommandEnvelope = z.infer<typeof commandEnvelopeSchema>;

export const demoControlSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  matchId: z.string(),
  type: z.enum(["demo_pause", "demo_resume", "demo_step", "demo_set_speed"]),
  speedMultiplier: z.number().optional(),
});
export type DemoControl = z.infer<typeof demoControlSchema>;

export interface ServerEnvelope {
  protocolVersion: typeof PROTOCOL_VERSION;
  serverSequence: number;
  matchId: string;
  revision: number;
  type:
    | "hello"
    | "snapshot"
    | "command_accepted"
    | "command_rejected"
    | "view_changed"
    | "connection_state"
    | "match_completed"
    | "demo_state"
    | "fatal_error";
  payload: unknown;
}

export interface CapabilitiesResponse {
  protocolVersion: number;
  locales: string[];
  defaultLocale: string;
  ruleBundles: Array<{ id: string; version: string; hash: string }>;
  contentBundleId?: string;
  modes: string[];
  productName: { "zh-CN": string; en: string };
  allowFixedSeed: boolean;
  persistence: "in-memory";
}

export const BRAND = {
  productName: { "zh-CN": "奇局", en: "Qiju" },
} as const;
