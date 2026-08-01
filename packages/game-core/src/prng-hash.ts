import { createHash } from "node:crypto";
import { canonicalEncode } from "./canonical.js";

export function sha256HexUtf8(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function canonicalHash(value: unknown): string {
  return sha256HexUtf8(canonicalEncode(value as never));
}
