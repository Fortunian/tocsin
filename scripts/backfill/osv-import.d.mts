// Types of scripts/backfill/osv-import.mjs for the TypeScript tests.
export interface ZipEntryInfo {
  name: string;
  method: number;
  crc: number;
  compressed: number;
  size: number;
  offset: number;
}

export interface ZipReader {
  entries: ZipEntryInfo[];
  read(entry: ZipEntryInfo): Promise<Uint8Array>;
}

export function readZip(bytes: Uint8Array): Promise<ZipReader>;

export interface ImportBody {
  ecosystem: string;
  records: Record<string, unknown>[];
  skipped: number;
  last_id: string;
  final: boolean;
  start?: true;
}

export interface ImportAnswer {
  ecosystem: string;
  imported: number;
  unchanged: number;
  skipped: number;
  inserted: number;
  updated: number;
  errors: string[];
  last_id: string;
  done_at: string | null;
}

export interface BackfillRow {
  last_id: string | null;
  done_at: string | null;
  max_batch?: number;
  max_docs?: number;
  skip_id_prefixes?: string[];
}

export interface BackfillTotals {
  imported: number;
  unchanged: number;
  skipped: number;
  errors: number;
  posts: number;
  // done_at of the final answer; null means the server did not record the end.
  done_at: string | null;
}

export function runBackfill(opts: {
  zip: Uint8Array;
  ecosystem: string;
  // A thrown error with status 413 halves the batch and sends the records again.
  post: (body: ImportBody) => Promise<ImportAnswer>;
  get: () => Promise<BackfillRow>;
  batch?: number;
  log?: (line: string) => void;
}): Promise<BackfillTotals>;
