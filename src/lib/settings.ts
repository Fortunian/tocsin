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
