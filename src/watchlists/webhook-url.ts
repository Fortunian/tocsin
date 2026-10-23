// SSRF guard for webhook URLs (TCS-11). Run at registration (POST and PATCH)
// and again at send time, before the DNS check in src/queue/resolve.ts.
// Pure functions: no I/O.

export type UrlCheck = { ok: true; url: URL; host: string } | { ok: false; reason: string };

// Host names we never POST to: our own zones and Cloudflare's worker zone
// (a request there would reach a Worker from inside our account), plus names
// that only resolve inside a private network.
const BLOCKED_SUFFIXES: ReadonlyArray<[string, string]> = [
  ["localhost", "localhost"],
  ["tocsin.sh", "a Tocsin host"],
  ["tocsin.so", "a Tocsin host"],
  ["workers.dev", "a workers.dev host"],
  ["internal", "an .internal host"],
];

function onSuffix(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`);
}

// An IPv4 dotted quad, or an IPv6 literal as the URL parser writes it ([...]).
// The WHATWG parser turns 0x7f000001, 2130706433 and 127.1 into 127.0.0.1.
function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[");
}

// Checks one webhook URL. The reason names the rule, for the 400 answer.
export function checkWebhookUrl(raw: string): UrlCheck {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: "webhook_url must be a URL" };
  }
  if (u.protocol !== "https:") return { ok: false, reason: "webhook_url must use https" };
  if (u.username !== "" || u.password !== "") return { ok: false, reason: "webhook_url must not hold a user name or password" };
  const host = u.hostname.toLowerCase().replace(/\.+$/, "");
  if (host === "") return { ok: false, reason: "webhook_url must have a host name" };
  if (isIpLiteral(host)) return { ok: false, reason: "webhook_url must use a host name, not an IP address" };
  for (const [suffix, label] of BLOCKED_SUFFIXES) {
    if (onSuffix(host, suffix)) return { ok: false, reason: `webhook_url must not point to ${label}` };
  }
  return { ok: true, url: u, host };
}

function v4Octets(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const n = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return n.every((x) => x >= 0 && x <= 255) ? n : null;
}

// Private, loopback, link-local (incl. 169.254.169.254 metadata), CGNAT,
// multicast, reserved, unspecified, and the special-purpose ranges.
function blockedV4([a, b]: number[]): boolean {
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

// Expands an IPv6 text form to 8 groups. null when it is not IPv6.
function v6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, "");
  const tail = /(\d{1,3}(\.\d{1,3}){3})$/.exec(s);
  if (tail) {
    const o = v4Octets(tail[1]);
    if (!o) return null;
    s = s.slice(0, -tail[1].length) + `${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  const all = [...head, ...Array(Math.max(fill, 0)).fill("0"), ...rest];
  if (all.length !== 8 || all.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return all.map((g) => parseInt(g, 16));
}

function blockedV6(g: number[]): boolean {
  // ::/96: ::, ::1 and IPv4-compatible ::a.b.c.d (deprecated, RFC 4291 2.5.5.1).
  if (g.slice(0, 6).every((x) => x === 0)) return true;
  // ::ffff:0:0:0/96: IPv4-translated ::ffff:0:a.b.c.d (RFC 2765).
  if (g.slice(0, 4).every((x) => x === 0) && g[4] === 0xffff && g[5] === 0) return true;
  // 2002::/16: 6to4 carries an IPv4 address in groups 1 and 2; blocked whole.
  if (g[0] === 0x2002) return true;
  const embedded = (hi: number, lo: number) => blockedV4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return embedded(g[6], g[7]); // ::ffff:a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b) return embedded(g[6], g[7]); // NAT64
  return (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xff00) === 0xff00 || g[0] === 0x2001 && g[1] === 0x0db8;
}

// True when a resolved address must never receive a webhook. An address we
// cannot parse is blocked too (fail closed).
export function isBlockedAddress(ip: string): boolean {
  const o = v4Octets(ip);
  if (o) return blockedV4(o);
  const g = v6Groups(ip);
  return g === null ? true : blockedV6(g);
}
