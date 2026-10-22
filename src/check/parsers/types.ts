export interface Dependency {
  ecosystem: string;
  name: string;
  version: string;
}

export interface Skipped {
  line?: number;
  raw: string;
  reason: string;
}

export interface ParseResult {
  dependencies: Dependency[];
  skipped: Skipped[];
}

export type ParserId =
  | "package-lock"
  | "pnpm-lock"
  | "yarn-lock"
  | "requirements"
  | "go-sum"
  | "composer-lock"
  | "cargo-lock"
  | "gemfile-lock";

/** The file could not be read as its format. Distinct from a file with no dependencies. */
export class LockfileParseError extends Error {
  constructor(
    readonly parser: ParserId,
    reason: string,
  ) {
    super(`${parser}: ${reason}`);
    this.name = "LockfileParseError";
  }
}

/** Collects dependencies deduplicated on (ecosystem, name, version), in first-seen order. */
export class ResultBuilder {
  private readonly seen = new Set<string>();
  private readonly result: ParseResult = { dependencies: [], skipped: [] };

  add(ecosystem: string, name: string, version: string): void {
    const key = `${ecosystem}\u0000${name}\u0000${version}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.result.dependencies.push({ ecosystem, name, version });
  }

  skip(raw: string, reason: string, line?: number): void {
    this.result.skipped.push(line === undefined ? { raw, reason } : { line, raw, reason });
  }

  build(): ParseResult {
    return this.result;
  }
}
