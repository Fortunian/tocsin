// Maven: ComparableVersion order (maven-artifact 3.x). The version splits into
// items on `.`, `-` and digit/letter changes; a `-` or a change opens a
// sublist. Qualifiers: alpha < beta < milestone < rc = cr < snapshot <
// "" = ga = final = release < sp < any other text (lexical). A single a, b or m
// right before a digit means alpha, beta, milestone. Trailing zeros and empty
// qualifiers are dropped, so 1 = 1.0 = 1.0.0 = 1-ga.
import type { Comparator } from "./types";

// A leading digit, then Maven's usual characters. No `v`, no spaces, no ranges.
const MAVEN = /^[0-9][0-9A-Za-z._+-]*$/;

const QUALIFIERS = ["alpha", "beta", "milestone", "rc", "snapshot", "", "sp"];
const ALIASES: Record<string, string> = { ga: "", final: "", release: "", cr: "rc" };
const RELEASE_INDEX = String(QUALIFIERS.indexOf(""));

type Item = { kind: "int"; value: string } | { kind: "string"; value: string } | { kind: "list"; items: Item[] };

const intItem = (digits: string): Item => ({ kind: "int", value: digits.replace(/^0+/, "") });

function stringItem(value: string, followedByDigit: boolean): Item {
  if (followedByDigit && value.length === 1) value = value === "a" ? "alpha" : value === "b" ? "beta" : value === "m" ? "milestone" : value;
  return { kind: "string", value: ALIASES[value] ?? value };
}

function parseItem(isDigit: boolean, buf: string): Item {
  return isDigit ? intItem(buf) : stringItem(buf, false);
}

function isNull(item: Item): boolean {
  if (item.kind === "int") return item.value === "";
  if (item.kind === "string") return item.value === "";
  return item.items.length === 0;
}

// Drops trailing null items; stops at the first non-null item that is not a list.
function normalize(list: Item[]): void {
  for (let i = list.length - 1; i >= 0; i--) {
    if (isNull(list[i])) list.splice(i, 1);
    else if (list[i].kind !== "list") break;
  }
}

export function parseMaven(version: string): Item {
  const v = version.trim().toLowerCase();
  const root: Item[] = [];
  let list = root;
  const stack: Item[][] = [root];
  let isDigit = false;
  let start = 0;
  const openList = () => {
    const next: Item[] = [];
    list.push({ kind: "list", items: next });
    list = next;
    stack.push(next);
  };
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (c === ".") {
      list.push(i === start ? intItem("0") : parseItem(isDigit, v.slice(start, i)));
      start = i + 1;
    } else if (c === "-") {
      list.push(i === start ? intItem("0") : parseItem(isDigit, v.slice(start, i)));
      start = i + 1;
      openList();
    } else if (c >= "0" && c <= "9") {
      if (!isDigit && i > start) {
        list.push(stringItem(v.slice(start, i), true));
        start = i;
        openList();
      }
      isDigit = true;
    } else {
      if (isDigit && i > start) {
        list.push(parseItem(true, v.slice(start, i)));
        start = i;
        openList();
      }
      isDigit = false;
    }
  }
  if (v.length > start) list.push(parseItem(isDigit, v.slice(start)));
  while (stack.length > 0) normalize(stack.pop()!);
  return { kind: "list", items: root };
}

function qualifierKey(q: string): string {
  const i = QUALIFIERS.indexOf(q);
  return i === -1 ? `${QUALIFIERS.length}-${q}` : String(i);
}

const cmp = <T>(a: T, b: T) => (a < b ? -1 : a > b ? 1 : 0);

function cmpInt(a: string, b: string): number {
  return a.length !== b.length ? cmp(a.length, b.length) : cmp(a, b);
}

// `b` undefined is Maven's null item: the shorter side of a list.
function compareItem(a: Item, b: Item | undefined): number {
  switch (a.kind) {
    case "int":
      if (b === undefined) return a.value === "" ? 0 : 1;
      return b.kind === "int" ? cmpInt(a.value, b.value) : 1;
    case "string":
      if (b === undefined) return cmp(qualifierKey(a.value), RELEASE_INDEX);
      if (b.kind === "int" || b.kind === "list") return -1;
      return cmp(qualifierKey(a.value), qualifierKey(b.value));
    case "list": {
      if (b === undefined) return a.items.length === 0 ? 0 : compareItem(a.items[0], undefined);
      if (b.kind === "int") return -1;
      if (b.kind === "string") return 1;
      const n = Math.max(a.items.length, b.items.length);
      for (let i = 0; i < n; i++) {
        const l = a.items[i];
        const r = b.items[i];
        const c = l === undefined ? (r === undefined ? 0 : -compareItem(r, undefined)) : compareItem(l, r);
        if (c !== 0) return c;
      }
      return 0;
    }
  }
}

export function validMaven(v: string): boolean {
  return MAVEN.test(v.trim());
}

export function compareMaven(a: string, b: string): number {
  if (!validMaven(a) || !validMaven(b)) throw new Error(`invalid Maven version: ${validMaven(a) ? b : a}`);
  return compareItem(parseMaven(a), parseMaven(b));
}

export const mavenComparator: Comparator = { valid: validMaven, compare: compareMaven };
