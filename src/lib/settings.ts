// Reads one integer setting from the settings table. The fallback is the
// documented code default; the live value is the DB row (CLAUDE.md rule 5).
// A missing row, a non-integer value or a failed read returns the fallback.
export async function getSettingInt(db: D1Database, key: string, fallback: number): Promise<number> {
  let row: { value: string } | null;
  try {
    row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  } catch (err) {
    console.error(JSON.stringify({ lane: "settings", key, err: err instanceof Error ? `${err.name}: ${err.message}` : String(err) }));
    return fallback;
  }
  if (!row || !/^\d+$/.test(row.value.trim())) return fallback;
  return Number(row.value.trim());
}

// Reads a comma-separated list of non-negative integers ("60,300,1800").
// A missing row, an empty list, any non-integer item or a failed read returns
// the fallback and logs why, so a mistyped row never yields a partial list.
export async function getSettingIntList(db: D1Database, key: string, fallback: number[]): Promise<number[]> {
  let row: { value: string } | null;
  try {
    row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  } catch (err) {
    console.error(JSON.stringify({ lane: "settings", key, err: err instanceof Error ? `${err.name}: ${err.message}` : String(err) }));
    return fallback;
  }
  if (!row) return fallback;
  const items = row.value.split(",").map((s) => s.trim());
  if (items.length === 0 || items.some((s) => !/^\d+$/.test(s))) {
    console.error(JSON.stringify({ lane: "settings", key, err: "malformed integer list, using the code fallback", fallback }));
    return fallback;
  }
  return items.map(Number);
}
