import { useEffect, useState } from "react";
import type { MatchConnection } from "./connection";

export function useConnection(connection: MatchConnection | null): number {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!connection) return;
    return connection.subscribe(() => setTick((n) => n + 1));
  }, [connection]);
  return connection?.revision ?? 0;
}

export function useCountdown(deadlineAtMs: number | null): number | null {
  const [remaining, setRemaining] = useState<number | null>(null);
  useEffect(() => {
    if (deadlineAtMs === null) {
      setRemaining(null);
      return;
    }
    const update = () => setRemaining(Math.max(0, Math.ceil((deadlineAtMs - Date.now()) / 1000)));
    update();
    const interval = setInterval(update, 250);
    return () => clearInterval(interval);
  }, [deadlineAtMs]);
  return remaining;
}
