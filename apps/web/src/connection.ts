import type { MatchView, ServerEnvelope, SnapshotPayload } from "./types";

type Listener = () => void;

export class MatchConnection {
  private socket: WebSocket | null = null;
  private listeners = new Set<Listener>();
  view: MatchView | null = null;
  deadlineAtMs: number | null = null;
  demo = { paused: false, speed: 1 };
  connected = false;
  fatal = false;
  lastRejection: string | null = null;
  private pendingCommandId: string | null = null;

  constructor(public matchId: string) {}

  connect(): void {
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    this.socket = new WebSocket(`${protocol}://${location.host}/api/v1/matches/${this.matchId}/stream`);
    this.socket.onopen = () => {
      this.connected = true;
      this.emit();
    };
    this.socket.onclose = (event) => {
      this.connected = false;
      if (event.code >= 4000 && event.code < 4010) {
        this.fatal = true;
      }
      this.emit();
    };
    this.socket.onerror = () => {
      this.connected = false;
      this.emit();
    };
    this.socket.onmessage = (event) => {
      const envelope = JSON.parse(String(event.data)) as ServerEnvelope;
      this.handle(envelope);
    };
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
        if (payload.commandId && payload.commandId === this.pendingCommandId) {
          this.pendingCommandId = null;
        }
        this.lastRejection = payload.code ?? "ACTION_ILLEGAL";
        break;
      }
      case "command_accepted": {
        const payload = envelope.payload as { commandId?: string };
        if (payload.commandId && payload.commandId === this.pendingCommandId) {
          this.pendingCommandId = null;
          this.lastRejection = null;
        }
        break;
      }
      case "match_completed":
        break;
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
    const commandId = crypto.randomUUID();
    this.pendingCommandId = commandId;
    this.socket.send(
      JSON.stringify({
        protocolVersion: 1,
        commandId,
        matchId: this.matchId,
        expectedRevision: this.revision,
        type: "submit_action",
        payload,
      }),
    );
    return commandId;
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
    this.socket?.close();
    this.socket = null;
  }
}
