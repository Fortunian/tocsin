import { env, exports } from "cloudflare:workers";
import type { Advisory, SeverityLabel } from "../../src/schema/advisory";
import { validateAdvisory } from "../../src/schema/advisory";
import fixture from "../fixtures/advisory/valid.json";

// Each test passes its own prefix (Crockford base32 letters/digits only), so
// ids never collide across tests: tcs_ + prefix + zero-padded index = 26 chars.
export function idFor(prefix: string, i: number): string {
  return "tcs_" + prefix + String(i).padStart(26 - prefix.length, "0");
}

export interface SeedRow {
  id: string;
  cursor: number;
  ecosystem?: string;
  component?: string;
  label?: SeverityLabel;
  exploited?: boolean;
  cve?: string;
}

export function docFor(r: SeedRow): Advisory {
  const doc = structuredClone(fixture) as Advisory;
  doc.id = r.id;
  doc.ecosystem = r.ecosystem ?? "node";
  doc.component = r.component ?? "node";
  doc.severity = { score: 5, label: r.label ?? "high" };
  doc.exploited = r.exploited ?? false;
  doc.cve_ids = r.cve ? [r.cve] : [];
  const v = validateAdvisory(doc);
  if (!v.ok) throw new Error(`seed doc invalid: ${v.errors.join("; ")}`);
  return doc;
}

export async function seed(rows: SeedRow[]): Promise<Advisory[]> {
  const insert = env.DB.prepare(
    `INSERT INTO advisories (id, cve_primary, ecosystem, component, severity_label, exploited, published_at, modified_at, doc_json, cursor)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const docs = rows.map(docFor);
  const stmts = rows.map((r, i) => {
    const d = docs[i];
    return insert.bind(
      d.id,
      r.cve ?? null,
      d.ecosystem,
      d.component,
      d.severity.label,
      d.exploited ? 1 : 0,
      d.published_at,
      d.modified_at,
      JSON.stringify(d),
      r.cursor,
    );
  });
  for (let i = 0; i < stmts.length; i += 500) await env.DB.batch(stmts.slice(i, i + 500));
  return docs;
}

export function get(path: string, ip: string, headers: Record<string, string> = {}): Promise<Response> {
  return exports.default.fetch(`https://tocsin.test${path}`, { headers: { "CF-Connecting-IP": ip, ...headers } });
}
