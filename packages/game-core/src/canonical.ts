export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export function canonicalEncode(value: JsonValue): string {
  return encode(value);
}

function encode(value: JsonValue): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("canonical-json.v1: non-finite number");
    }
    return Object.is(value, -0) ? "0" : String(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map((item) => encode(item)).join(",") + "]";
  }
  const keys = Object.keys(value).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const v = value[key];
    if (v === undefined) continue;
    parts.push(JSON.stringify(key) + ":" + encode(v));
  }
  return "{" + parts.join(",") + "}";
}
