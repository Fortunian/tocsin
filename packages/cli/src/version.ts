import { readFileSync } from "node:fs";

/** The package root: `src/` and `dist/` both sit one level below it. */
export const PKG_ROOT = new URL("..", import.meta.url);

export const VERSION: string = (JSON.parse(readFileSync(new URL("package.json", PKG_ROOT), "utf8")) as { version: string }).version;
