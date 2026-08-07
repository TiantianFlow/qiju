import type { MatchView, ServerEnvelope, SnapshotPayload } from "./types";
import { API_BASE_URL } from "./config";

type Listener = () => void;

const FATAL_CLOSE_CODE_MIN = 4000;
const FATAL_CLOSE_CODE_MAX = 4010;

interface CommandEnvelope {
  protocolVersion: number;
  commandId: string;
  matchId: string;
  expectedRevision: number;
  type: "submit_action";
  payload: Record<string, unknown>;
}

/** Minimal socket surface the connection relies on — structurally satisfied by the DOM WebSocket. */
export interface SocketLike {
  readyState: number;
  onopen: (() => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  send(data: string): void;
  close(): void;
}

export interface MatchConnectionDeps {
  /** Overrides the stream URL (tests); defaults to the API/same-origin stream endpoint. */
  url?: string;
  /** Socket factory (tests); defaults to the global WebSocket constructor. */
  createSocket?: (url: string) => SocketLike;
  /** Reconnect backoff: first delay and cap, doubling in between. */
  reconnectInitialMs?: number;
  reconnectMaxMs?: number;
}

function generateCommandId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "cmd-" + Math.random().toString(36).slice(2, 11) + "-" + Date.now().toString(36);
}

export class MatchConnection {
  private socket: SocketLike | null = null;
  private listeners = new Set<Listener>();
  view: MatchView | null = null;
  deadlineAtMs: number | null = null;
  demo: { paused: boolean; speed: number; presentation?: { seq: number; kind: string } | null } = {
    paused: false,
    speed: 1,
    presentation: null,
  };
  connected = false;
  fatal = false;
  lastRejection: string | null = null;

  // THE-26: unresolved commands are kept as full envelopes so a reconnect can
  // replay them byte-for-byte with their ORIGINAL commandId, payload and
  // expectedRevision — never a fresh ID, never rebased onto a newer revision.
  private pending = new Map<string, CommandEnvelope>();

  private readonly deps: MatchConnectionDeps;
  private epoch = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs: number;
  private closedIntentionally = false;
  // Replay must happen only after the fresh socket's snapshot has been
  // applied (snapshot-before-ready); tracked per socket epoch.
  private replayedForEpoch = 0;

  constructor(public matchId: string, deps: MatchConnectionDeps = {}) {
    this.deps = deps;
    this.backoffMs = deps.reconnectInitialMs ?? 250;
  }

  private streamUrl(): string {
    if (this.deps.url) return this.deps.url;
    let wsProtocol: string;
    let host: string;
    if (API_BASE_URL) {
      const apiUrl = new URL(API_BASE_URL);
      wsProtocol = apiUrl.protocol === "https:" ? "wss" : "ws";
      host = apiUrl.host;
    } else {
      wsProtocol = location.protocol === "https:" ? "wss" : "ws";
      host = location.host;
    }
    return `${wsProtocol}://${host}/api/v1/matches/${this.matchId}/stream`;
  }

  connect(): void {
    this.closedIntentionally = false;
    this.openSocket();
  }

  private openSocket(): void {
    this.epoch += 1;
    const epoch = this.epoch;
    const socket = this.deps.createSocket
      ? this.deps.createSocket(this.streamUrl())
      : (new WebSocket(this.streamUrl()) as SocketLike);
    this.socket = socket;

    socket.onopen = () => {
      if (epoch !== this.epoch) return;
      this.connected = true;
      this.emit();
    };
    socket.onclose = (event) => {
      // Stale-socket guard: a superseded socket's late close (e.g. the server
      // 4009-ing the previous connection once our reconnect lands) must never
      // touch the live state or schedule another reconnect.
      if (epoch !== this.epoch) return;
      this.socket = null;
      this.connected = false;
      if (this.closedIntentionally) {
        this.emit();
        return;
      }
      if (event.code >= FATAL_CLOSE_CODE_MIN && event.code < FATAL_CLOSE_CODE_MAX) {
        // Fatal close (4004 match gone — incl. server restart, rooms are
        // in-memory; 4009 same-principal supersession). No silent retry loop.
        this.fatal = true;
        this.emit();
        return;
      }
      // Recoverable disconnect: back off and reconnect/resync.
      this.emit();
      this.scheduleReconnect();
    };
    socket.onerror = () => {
      if (epoch !== this.epoch) return;
      this.emit();
    };
    socket.onmessage = (event) => {
      if (epoch !== this.epoch) return;
      const envelope = JSON.parse(String(event.data)) as ServerEnvelope;
      this.handle(envelope);
      // The connection proved healthy once a snapshot arrives — reset backoff.
      if (envelope.type === "snapshot") {
        this.backoffMs = this.deps.reconnectInitialMs ?? 250;
        if (this.replayedForEpoch !== epoch) {
          this.replayedForEpoch = epoch;
          this.replayPending();
        }
      }
    };
  }

  private scheduleReconnect(): void {
    // Single scheduling: never stack multiple reconnect timers.
    if (this.reconnectTimer !== null || this.closedIntentionally || this.fatal) return;
    const max = this.deps.reconnectMaxMs ?? 5000;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, max);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closedIntentionally || this.fatal) return;
      this.openSocket();
    }, delay);
  }

  private replayPending(): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    for (const envelope of this.pending.values()) {
      this.socket.send(JSON.stringify(envelope));
    }
  }

  private handle(envelope: ServerEnvelope): void {
    switch (envelope.type) {
      case "snapshot": {
        const payload = envelope.payload as SnapshotPayload;
        this.view = payload.view;
        this.deadlineAtMs = payload.deadlineAtMs;
        if (payload.demo) this.demo = payload.demo;
        break;
      }
      case "command_rejected": {
        const payload = envelope.payload as { code?: string; commandId?: string };
        if (payload.commandId) {
          this.pending.delete(payload.commandId);
        }
        this.lastRejection = payload.code ?? "ACTION_ILLEGAL";
        break;
      }
      case "command_accepted": {
        const payload = envelope.payload as { commandId?: string };
        if (payload.commandId && this.pending.delete(payload.commandId)) {
          this.lastRejection = null;
        }
        break;
      }
      case "match_completed":
        break;
      case "demo_state": {
        const payload = envelope.payload as { paused: boolean; speed: number };
        this.demo = payload;
        break;
      }
      case "fatal_error":
        this.fatal = true;
        break;
    }
    this.emit();
  }

  get revision(): number {
    return this.view?.revision ?? 0;
  }

  sendCommand(payload: Record<string, unknown>): string | null {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return null;
    const envelope: CommandEnvelope = {
      protocolVersion: 1,
      commandId: generateCommandId(),
      matchId: this.matchId,
      expectedRevision: this.revision,
      type: "submit_action",
      payload,
    };
    this.pending.set(envelope.commandId, envelope);
    this.socket.send(JSON.stringify(envelope));
    return envelope.commandId;
  }

  sendDemoControl(type: string, speedMultiplier?: number): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(
      JSON.stringify({
        protocolVersion: 1,
        matchId: this.matchId,
        type,
        ...(speedMultiplier !== undefined ? { speedMultiplier } : {}),
      }),
    );
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  close(): void {
    this.closedIntentionally = true;
    this.epoch += 1;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close();
    this.socket = null;
    this.connected = false;
  }
}
