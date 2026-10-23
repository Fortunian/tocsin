// Debian: dpkg version order (Debian policy 5.6.12). [epoch:]upstream[-revision];
// the epoch is a number (absent = 0); upstream and revision compare with
// verrevcmp: `~` sorts before everything, even the end of the string, then
// letters, then other characters; digit runs compare as numbers.
import type { Comparator } from "./types";

const UPSTREAM = /^[0-9][A-Za-z0-9.+~:-]*$/;
const REVISION = /^[A-Za-z0-9.+~]+$/;

interface Dpkg {
  epoch: number;
  upstream: string;
  revision: string;
}

export function parseDpkg(v: string): Dpkg | null {
  let s = v.trim();
  if (s === "" || /\s/.test(s)) return null;
  let epoch = 0;
  const e = /^(\d+):/.exec(s);
  if (e) {
    epoch = Number(e[1]);
    s = s.slice(e[0].length);
  } else if (s.includes(":")) return null;
  const dash = s.lastIndexOf("-");
  const upstream = dash === -1 ? s : s.slice(0, dash);
  const revision = dash === -1 ? "" : s.slice(dash + 1);
  if (!UPSTREAM.test(upstream) || (dash !== -1 && !REVISION.test(revision))) return null;
  return { epoch, upstream, revision };
}

function order(c: string | undefined): number {
  if (c === undefined || (c >= "0" && c <= "9")) return 0;
  if (/[A-Za-z]/.test(c)) return c.charCodeAt(0);
  if (c === "~") return -1;
  return c.charCodeAt(0) + 256;
}

const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";

export function verrevcmp(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    while ((i < a.length && !isDigit(a[i])) || (j < b.length && !isDigit(b[j]))) {
      const ac = order(a[i]);
      const bc = order(b[j]);
      if (ac !== bc) return ac - bc;
      i++;
      j++;
    }
    while (a[i] === "0") i++;
    while (b[j] === "0") j++;
    let firstDiff = 0;
    while (isDigit(a[i]) && isDigit(b[j])) {
      if (firstDiff === 0) firstDiff = a.charCodeAt(i) - b.charCodeAt(j);
      i++;
      j++;
    }
    if (isDigit(a[i])) return 1;
    if (isDigit(b[j])) return -1;
    if (firstDiff !== 0) return firstDiff;
  }
  return 0;
}

const sign = (n: number) => (n < 0 ? -1 : n > 0 ? 1 : 0);

export function compareDpkg(a: string, b: string): number {
  const pa = parseDpkg(a);
  const pb = parseDpkg(b);
  if (!pa || !pb) throw new Error(`invalid dpkg version: ${pa ? b : a}`);
  if (pa.epoch !== pb.epoch) return pa.epoch < pb.epoch ? -1 : 1;
  return sign(verrevcmp(pa.upstream, pb.upstream)) || sign(verrevcmp(pa.revision, pb.revision));
}

export const dpkgComparator: Comparator = { valid: (v) => parseDpkg(v) !== null, compare: compareDpkg };
