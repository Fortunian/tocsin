// The core of the OSV backfill (TCS-32): read an OSV <eco>/all.zip, sort the
// records by id, skip the ids up to the resume watermark, skip MAL- and
// withdrawn records, and post the rest in batches to POST /v1/internal/import.
// The server normalizes and upserts each record with the cron's code. This
// file has no Node-only import, so the same code runs in Node 22 (the
// workflow) and in workerd (tests/backfill/import.tcs-32.test.ts).

const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(b) {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function inflateRaw(b) {
  const stream = new Blob([b]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// A central-directory zip reader: stored (0) and deflate (8) entries, ZIP64
// end records and ZIP64 size/offset fields. Each entry is inflated on read,
// so only the zip bytes stay in memory.
export async function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (p) => view.getUint16(p, true);
  const u32 = (p) => view.getUint32(p, true);
  const u64 = (p) => Number(view.getBigUint64(p, true));
  let eocd = -1;
  // The EOCD record is in the last 22 + 65535 (comment) bytes.
  for (let p = bytes.length - 22; p >= Math.max(0, bytes.length - 22 - 65535); p--) {
    if (u32(p) === EOCD) {
      eocd = p;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip file: no end of central directory record");
  let count = u16(eocd + 10);
  let cdOffset = u32(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) {
    const loc = eocd - 20;
    if (loc < 0 || u32(loc) !== ZIP64_LOCATOR) throw new Error("zip: ZIP64 end locator missing");
    const rec = u64(loc + 8);
    if (u32(rec) !== ZIP64_EOCD) throw new Error("zip: ZIP64 end record missing");
    count = u64(rec + 32);
    cdOffset = u64(rec + 48);
  }
  const dec = new TextDecoder();
  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (u32(p) !== CENTRAL) throw new Error(`zip: bad central directory entry ${i}`);
    const method = u16(p + 10);
    const crc = u32(p + 16);
    let compressed = u32(p + 20);
    let size = u32(p + 24);
    const nameLen = u16(p + 28);
    const extraLen = u16(p + 30);
    const commentLen = u16(p + 32);
    let offset = u32(p + 42);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    // ZIP64 extended information (header 0x0001): the 0xffffffff fields, in order.
    for (let e = p + 46 + nameLen; e < p + 46 + nameLen + extraLen; ) {
      const id = u16(e);
      const len = u16(e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        if (size === 0xffffffff) (size = u64(q)), (q += 8);
        if (compressed === 0xffffffff) (compressed = u64(q)), (q += 8);
        if (offset === 0xffffffff) offset = u64(q);
      }
      e += 4 + len;
    }
    entries.push({ name, method, crc, compressed, size, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return {
    entries,
    async read(entry) {
      const h = entry.offset;
      if (u32(h) !== LOCAL) throw new Error(`zip: bad local header for ${entry.name}`);
      const start = h + 30 + u16(h + 26) + u16(h + 28);
      const raw = bytes.subarray(start, start + entry.compressed);
      let out;
      if (entry.method === 0) out = raw;
      else if (entry.method === 8) out = await inflateRaw(raw);
      else throw new Error(`zip: ${entry.name} uses compression method ${entry.method}; only stored and deflate are read`);
      if (out.length !== entry.size || crc32(out) !== entry.crc) throw new Error(`zip: ${entry.name} fails its size or CRC check`);
      return out;
    },
  };
}

const idOf = (name) => name.replace(/^.*\//, "").replace(/\.json$/, "");

// get(): the backfill row of the ecosystem (GET /v1/internal/import/<eco>).
// post(body): one POST /v1/internal/import; it throws when the request fails.
// A row with last_id and no done_at resumes after last_id. Any other row
// starts a new run (start: true), which resets the counters on the server.
export async function runBackfill({ zip, ecosystem, post, get, batch = 100, log = () => {} }) {
  const z = await readZip(zip);
  const row = await get();
  const resume = row.last_id !== null && row.done_at === null ? row.last_id : null;
  let size = Math.max(1, Math.min(batch, row.max_batch ?? batch));
  const skipPrefixes = row.skip_id_prefixes ?? ["MAL-"];
  const files = z.entries.filter((e) => e.name.endsWith(".json")).sort((a, b) => (idOf(a.name) < idOf(b.name) ? -1 : idOf(a.name) > idOf(b.name) ? 1 : 0));
  const dec = new TextDecoder();
  const totals = { imported: 0, unchanged: 0, skipped: 0, errors: 0, posts: 0, done_at: null };
  let records = [];
  let skipped = 0;
  let lastId = resume;
  let start = resume === null;

  // One POST. A 413 (the server's import.max_docs or body cap) refuses the
  // whole batch before any write, so the script halves the batch size and
  // sends the same records again in two parts. The first part's last_id is its
  // own last record, so the watermark never passes a record not yet written;
  // the skipped count and final flag go with the last part. One record over
  // the cap fails the run.
  const postPart = async (recs, skip, last, final) => {
    const body = { ecosystem, records: recs, skipped: skip, last_id: last, final, ...(start ? { start: true } : {}) };
    let a;
    try {
      a = await post(body);
    } catch (err) {
      if (err?.status !== 413 || recs.length <= 1) throw err;
      const half = Math.ceil(recs.length / 2);
      size = Math.min(size, half);
      log(`${ecosystem}: ${recs.length} records refused (413): batch size now ${size}`);
      await postPart(recs.slice(0, half), 0, recs[half - 1].id, false);
      await postPart(recs.slice(half), skip, last, final);
      return;
    }
    totals.imported += a.imported;
    totals.unchanged += a.unchanged;
    totals.skipped += a.skipped;
    totals.errors += a.errors.length;
    totals.posts += 1;
    if (final) totals.done_at = a.done_at;
    log(`${ecosystem}: batch ${totals.posts}: ${recs.length} records, ${a.imported} imported, ${a.unchanged} unchanged, ${a.skipped} skipped, ${a.errors.length} errors, last_id ${a.last_id}${final ? ", done" : ""}`);
    start = false;
  };

  const send = async (final) => {
    await postPart(records, skipped, lastId ?? "", final);
    records = [];
    skipped = 0;
  };

  for (const entry of files) {
    const id = idOf(entry.name);
    if (resume !== null && id <= resume) continue;
    lastId = id;
    if (skipPrefixes.some((p) => id.startsWith(p))) {
      skipped += 1;
      continue;
    }
    const rec = JSON.parse(dec.decode(await z.read(entry)));
    if (typeof rec.withdrawn === "string" && rec.withdrawn !== "") {
      skipped += 1;
      continue;
    }
    records.push(rec);
    if (records.length >= size) await send(false);
  }
  if (lastId === null) throw new Error(`${ecosystem}: the zip has no record`);
  await send(true);
  return totals;
}
