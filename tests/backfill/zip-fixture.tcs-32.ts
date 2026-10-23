// Test helper (TCS-32): builds an OSV-style all.zip in memory. One entry per
// record, named `<id>.json`, the layout of
// https://osv-vulnerabilities.storage.googleapis.com/<eco>/all.zip. Entries are
// deflate-raw (method 8) or stored (method 0); `zip64: true` writes the ZIP64
// end records that a real npm all.zip needs (more than 65,535 entries).
// No network: the records are built by `osvRecord` below.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function deflateRaw(b: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([b]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
  stored?: boolean;
}

export async function buildZip(entries: ZipEntry[], opts: { zip64?: boolean } = {}): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const body = e.stored ? e.data : await deflateRaw(e.data);
    const crc = crc32(e.data);
    const method = e.stored ? 0 : 8;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(8, method, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, e.data.length, true);
    local.setUint16(26, name.length, true);
    chunks.push(new Uint8Array(local.buffer), name, body);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(10, method, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, body.length, true);
    cd.setUint32(24, e.data.length, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.length + body.length;
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const cdOffset = offset;
  const tail: Uint8Array[] = [];
  if (opts.zip64) {
    const rec = new DataView(new ArrayBuffer(56));
    rec.setUint32(0, 0x06064b50, true);
    rec.setBigUint64(4, 44n, true);
    rec.setUint16(12, 45, true);
    rec.setUint16(14, 45, true);
    rec.setBigUint64(24, BigInt(entries.length), true);
    rec.setBigUint64(32, BigInt(entries.length), true);
    rec.setBigUint64(40, BigInt(cdSize), true);
    rec.setBigUint64(48, BigInt(cdOffset), true);
    const loc = new DataView(new ArrayBuffer(20));
    loc.setUint32(0, 0x07064b50, true);
    loc.setBigUint64(8, BigInt(cdOffset + cdSize), true);
    loc.setUint32(16, 1, true);
    tail.push(new Uint8Array(rec.buffer), new Uint8Array(loc.buffer));
  }
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, opts.zip64 ? 0xffff : entries.length, true);
  eocd.setUint16(10, opts.zip64 ? 0xffff : entries.length, true);
  eocd.setUint32(12, opts.zip64 ? 0xffffffff : cdSize, true);
  eocd.setUint32(16, opts.zip64 ? 0xffffffff : cdOffset, true);
  tail.push(new Uint8Array(eocd.buffer));
  const all = [...chunks, ...central, ...tail];
  const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
  let p = 0;
  for (const c of all) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

// One OSV record in the shape of the OSV schema (the fields normalizeOsv reads).
export function osvRecord(id: string, ecosystem: string, name: string, opts: { withdrawn?: boolean; published?: string; fixed?: string; modified?: string } = {}): Record<string, unknown> {
  return {
    id,
    modified: opts.modified ?? "2026-10-01T00:00:00Z",
    published: opts.published ?? "2020-01-01T00:00:00Z",
    ...(opts.withdrawn ? { withdrawn: "2026-09-01T00:00:00Z" } : {}),
    summary: `Fixture advisory ${id}`,
    affected: [{ package: { ecosystem, name }, ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "0" }, { fixed: opts.fixed ?? "1.0.1" }] }] }],
    references: [{ type: "WEB", url: `https://example.com/fixture/${id}` }],
  };
}

export function jsonEntry(rec: Record<string, unknown>, stored = false): ZipEntry {
  return { name: `${String(rec.id)}.json`, data: new TextEncoder().encode(JSON.stringify(rec)), stored };
}
