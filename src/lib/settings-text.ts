// Reads one text setting from the settings table. Same contract as
// getSettingInt: the fallback is the documented code default; a missing row,
// a blank value or a failed read returns the fallback.
export async function getSettingText(db: D1Database, key: string, fallback: string): Promise<string> {
  let row: { value: string } | null;
  try {
    row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  } catch (err) {
    console.error(JSON.stringify({ lane: "settings", key, err: err instanceof Error ? `${err.name}: ${err.message}` : String(err) }));
    return fallback;
  }
  const value = row?.value.trim() ?? "";
  return value === "" ? fallback : value;
}
