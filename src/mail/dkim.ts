// DKIM signing config of the mail seam (TCS-94). The key is the wrangler
// secret DKIM_PRIVATE_KEY; the domain and selector are the settings rows
// mail.dkim_domain and mail.dkim_selector. All three set: the mail is signed.
// Any one missing: the mail goes out unsigned and a warning is written. A
// missing DKIM item never fails a send.

export interface DkimConfig {
  domain: string;
  selector: string;
  privateKey: string;
}

export type DkimState = { state: "signed"; config: DkimConfig } | { state: "off" | "incomplete"; missing: string[] };

// The warning of an unsigned send, on the sources row 'mail' (migration 0030).
export const MAIL_WARNING_SQL = "UPDATE sources SET last_warning = ?, last_run_at = ? WHERE id = 'mail'";

// MailChannels takes the key as base64 DER. A PEM is accepted too: its armor
// lines and all whitespace are removed. An empty result means not set.
export function normalizeDkimKey(raw: string | undefined): string {
  return (raw ?? "")
    .trim()
    .replace(/-----(BEGIN|END)[^-]*-----/g, "")
    .replace(/\s+/g, "");
}

// domain and selector come from getSettingText with the fallback "" (= not set).
// off: no key. incomplete: a key, but a row is blank.
export function resolveDkim(secret: string | undefined, domain: string, selector: string): DkimState {
  const privateKey = normalizeDkimKey(secret);
  if (privateKey === "") return { state: "off", missing: ["DKIM_PRIVATE_KEY"] };
  const missing: string[] = [];
  if (domain.trim() === "") missing.push("mail.dkim_domain");
  if (selector.trim() === "") missing.push("mail.dkim_selector");
  if (missing.length > 0) return { state: "incomplete", missing };
  return { state: "signed", config: { domain: domain.trim(), selector: selector.trim(), privateKey } };
}

// Writes the unsigned-send warning: names only, never a value. Never throws.
export async function noteDkimUnsigned(db: D1Database, missing: string[], nowIso: string): Promise<void> {
  console.warn(JSON.stringify({ lane: "mail", warn: "dkim_unsigned", missing }));
  try {
    await db.prepare(MAIL_WARNING_SQL).bind(`mail sent unsigned (no DKIM): not set: ${missing.join(", ")}`, nowIso).run();
  } catch (err) {
    console.error(JSON.stringify({ lane: "mail", err: err instanceof Error ? `${err.name}: ${err.message}` : String(err) }));
  }
}
