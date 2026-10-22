// The one seam between the CLI and the outside world: the network, child
// processes, the clock and the terminal. nodeIo() in cli.ts builds the real
// one; tests build a fake that answers from seeded data.

export interface ExecResult {
  /** The exit code. -1 when the command is absent (ENOENT), timed out or was killed. */
  code: number;
  stdout: string;
  stderr: string;
}

export interface Io {
  /** The arguments after `tocsin`. */
  argv: string[];
  env: Record<string, string | undefined>;
  cwd: string;
  platform: string;
  out(line: string): void;
  err(line: string): void;
  fetch(url: string, init: RequestInit): Promise<Response>;
  exec(command: string, args: string[], timeoutMs: number): Promise<ExecResult>;
  sleep(ms: number): Promise<void>;
  /** Test-only stop for `watch`. Unset in production: watch runs until Ctrl-C. */
  maxPolls?: number;
}
