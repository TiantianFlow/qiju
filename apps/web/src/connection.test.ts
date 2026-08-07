import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MatchConnection, type SocketLike } from "./connection";

const OPEN = 1;
const CLOSED = 3;

class FakeSocket implements SocketLike {
  static instances: FakeSocket[] = [];

  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  readonly sent: string[] = [];

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = CLOSED;
  }

  serverOpen(): void {
    this.readyState = OPEN;
    this.onopen?.();
  }

  serverClose(code: number): void {
    this.readyState = CLOSED;
    this.onclose?.({ code });
  }

  serverMessage(envelope: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(envelope) });
  }

  serverSnapshot(revision: number): void {
    this.serverMessage({
      type: "snapshot",
      payload: { view: { revision }, deadlineAtMs: null },
    });
  }
}

function lastSocket(): FakeSocket {
  return FakeSocket.instances[FakeSocket.instances.length - 1]!;
}

function makeConnection() {
  const conn = new MatchConnection("match-1", {
    url: "ws://test/stream",
    createSocket: (url) => new FakeSocket(url),
    reconnectInitialMs: 100,
    reconnectMaxMs: 400,
  });
  conn.connect();
  return conn;
}

function openWithSnapshot(socket: FakeSocket, revision: number): void {
  socket.serverOpen();
  socket.serverSnapshot(revision);
}

describe("MatchConnection reconnect", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.instances = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reconnects with exponential backoff and only one pending timer", () => {
    const conn = makeConnection();
    openWithSnapshot(lastSocket(), 1);

    lastSocket().serverClose(1006);
    expect(FakeSocket.instances).toHaveLength(1);
    // onerror racing the close must not stack a second reconnect timer.
    lastSocket().onerror?.();

    vi.advanceTimersByTime(99);
    expect(FakeSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances).toHaveLength(2);

    lastSocket().serverOpen();
    lastSocket().serverClose(1006);
    vi.advanceTimersByTime(199);
    expect(FakeSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances).toHaveLength(3);

    // Backoff keeps doubling to the 400ms cap.
    lastSocket().serverOpen();
    lastSocket().serverClose(1006);
    vi.advanceTimersByTime(400);
    expect(FakeSocket.instances).toHaveLength(4);
    lastSocket().serverOpen();
    lastSocket().serverClose(1006);
    vi.advanceTimersByTime(399);
    expect(FakeSocket.instances).toHaveLength(4);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances).toHaveLength(5);
    conn.close();
  });

  it("resets backoff once a reconnect proves healthy", () => {
    const conn = makeConnection();
    openWithSnapshot(lastSocket(), 1);
    lastSocket().serverClose(1006);
    vi.advanceTimersByTime(100); // attempt 2 at 100ms
    openWithSnapshot(lastSocket(), 2);
    lastSocket().serverClose(1006);
    vi.advanceTimersByTime(100); // healthy snapshot reset -> 100ms again, not 200
    expect(FakeSocket.instances).toHaveLength(3);
    conn.close();
  });

  it("ignores events from a stale socket after reconnect (generation guard)", () => {
    const conn = makeConnection();
    const first = lastSocket();
    openWithSnapshot(first, 1);
    first.serverClose(1006);
    vi.advanceTimersByTime(100);
    const second = lastSocket();
    openWithSnapshot(second, 5);
    expect(conn.view?.revision).toBe(5);

    // Late events from the dead socket must not corrupt live state.
    first.serverMessage({ type: "snapshot", payload: { view: { revision: 99 }, deadlineAtMs: null } });
    expect(conn.view?.revision).toBe(5);
    first.serverClose(4004);
    expect(conn.fatal).toBe(false);
    conn.close();
  });

  it.each([4004, 4009])("treats close code %i as fatal and never retries", (code) => {
    const conn = makeConnection();
    openWithSnapshot(lastSocket(), 1);
    lastSocket().serverClose(code);
    expect(conn.fatal).toBe(true);
    expect(conn.connected).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
    conn.close();
  });

  it("does not reconnect after an explicit close", () => {
    const conn = makeConnection();
    openWithSnapshot(lastSocket(), 1);
    conn.close();
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(conn.connected).toBe(false);
  });

  it("replays an unresolved command with its original id, payload and expectedRevision", () => {
    const conn = makeConnection();
    const first = lastSocket();
    openWithSnapshot(first, 5);
    const commandId = conn.sendCommand({ type: "submit_bid", amount: 1000, actionWindowId: "w1" });
    expect(commandId).toBeTruthy();
    expect(first.sent).toHaveLength(1);
    const original = JSON.parse(first.sent[0]!) as Record<string, unknown>;

    // Socket dies before the acknowledgement arrives.
    first.serverClose(1006);
    vi.advanceTimersByTime(100);
    const second = lastSocket();
    second.serverOpen();
    // Snapshot-before-ready: nothing replayed until the fresh snapshot lands.
    expect(second.sent).toHaveLength(0);
    second.serverSnapshot(9);
    expect(second.sent).toHaveLength(1);
    const replayed = JSON.parse(second.sent[0]!) as Record<string, unknown>;
    expect(replayed.commandId).toBe(original.commandId);
    expect(replayed.expectedRevision).toBe(original.expectedRevision);
    expect(replayed.payload).toEqual(original.payload);

    // The (duplicate) acknowledgement retires the command; a further reconnect
    // must not replay it again.
    second.serverMessage({ type: "command_accepted", payload: { commandId, duplicate: true } });
    second.serverClose(1006);
    vi.advanceTimersByTime(100);
    const third = lastSocket();
    openWithSnapshot(third, 10);
    expect(third.sent).toHaveLength(0);
    conn.close();
  });

  it("retires a rejected command instead of replaying it", () => {
    const conn = makeConnection();
    const first = lastSocket();
    openWithSnapshot(first, 5);
    const commandId = conn.sendCommand({ type: "lock_setup" });
    first.serverMessage({ type: "command_rejected", payload: { commandId, code: "ACTION_ILLEGAL" } });
    expect(conn.lastRejection).toBe("ACTION_ILLEGAL");

    first.serverClose(1006);
    vi.advanceTimersByTime(100);
    const second = lastSocket();
    openWithSnapshot(second, 6);
    expect(second.sent).toHaveLength(0);
    conn.close();
  });

  it("drops commands typed while offline instead of queuing them silently", () => {
    const conn = makeConnection();
    openWithSnapshot(lastSocket(), 5);
    lastSocket().serverClose(1006);
    expect(conn.sendCommand({ type: "submit_bid", amount: 1, actionWindowId: "w1" })).toBeNull();
    vi.advanceTimersByTime(100);
    const second = lastSocket();
    openWithSnapshot(second, 6);
    expect(second.sent).toHaveLength(0);
    conn.close();
  });
});
