export interface Clock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): ClockTimerHandle;
}

export interface ClockTimerHandle {
  cancel(): void;
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
  setTimeout(callback: () => void, delayMs: number): ClockTimerHandle {
    const handle = setTimeout(callback, delayMs);
    return { cancel: () => clearTimeout(handle) };
  }
}

export class FakeClock implements Clock {
  private currentTime: number;
  private timers: Array<{ id: number; at: number; callback: () => void; cancelled: boolean }> = [];
  private nextId = 1;

  constructor(startMs = 0) {
    this.currentTime = startMs;
  }

  now(): number {
    return this.currentTime;
  }

  setTimeout(callback: () => void, delayMs: number): ClockTimerHandle {
    const id = this.nextId++;
    const entry = { id, at: this.currentTime + delayMs, callback, cancelled: false };
    this.timers.push(entry);
    return {
      cancel: () => {
        entry.cancelled = true;
      },
    };
  }

  advanceBy(ms: number): void {
    const target = this.currentTime + ms;
    for (;;) {
      const due = this.timers
        .filter((t) => !t.cancelled && t.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.currentTime = due.at;
      due.cancelled = true;
      due.callback();
    }
    this.currentTime = target;
  }
}
