// Readers for one key of a sources.config_json object (repo iron rule 5).
// An absent key returns the code fallback; a present but bad value throws.

export function posIntConfig(raw: Record<string, unknown>, source: string, key: string, fallback: number): number {
  const v = raw[key];
  if (v === undefined) return fallback;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) throw new Error(`${source} config: ${key} must be a positive integer`);
  return v;
}

export function urlConfig(raw: Record<string, unknown>, source: string, key: string, fallback: string): string {
  const v = raw[key];
  if (v === undefined) return fallback;
  if (typeof v !== "string" || !/^https?:\/\/[^/]/.test(v)) throw new Error(`${source} config: ${key} must be an http(s) URL`);
  return v;
}
