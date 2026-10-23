import { LockfileParseError, ResultBuilder, type ParseResult } from "./types";

export const OS_NAMES = ["alpine", "debian"] as const;
export type OsName = (typeof OS_NAMES)[number];

/** The OSV ecosystem string of a release: Alpine 3.18 / v3.18 / 3.18.4 -> Alpine:v3.18; Debian 12 / 12.5 -> Debian:12. Else null. */
export function osEcosystem(os: OsName, release: string): string | null {
  const r = release.trim();
  if (os === "alpine") {
    const m = /^v?(\d+)\.(\d+)(?:\.\d+)?$/.exec(r);
    return m ? `Alpine:v${m[1]}.${m[2]}` : null;
  }
  const m = /^(\d+)(?:\.\d+)?$/.exec(r);
  return m ? `Debian:${m[1]}` : null;
}

// apk list --installed: <pkg>-<ver>-r<N> <arch> {<origin>} (<license>) [installed]
const APK_LINE = /^(\S+)-(\d[^\s-]*-r\d+)\s+\S+\s+\{([^}]+)\}/;
// dpkg -l: a 2-3 letter state (desired, status, error), then name, version, arch.
const DPKG_L_LINE = /^([uihrp][ncHUFWti]R?)\s+(\S+)\s+(\S+)\s+\S+/;
// dpkg-query -W -f='${source:Package} ${Version}\n': two columns.
const DPKG_QUERY_LINE = /^([a-z0-9][a-z0-9+.-]*)\s+(\S+)$/;

/**
 * An OS package list: `apk list --installed` text for Alpine (the name is the
 * origin, the aports source package OSV names), `dpkg -l` text or
 * `dpkg-query -W` two-column text for Debian. Dependencies carry the release
 * in their ecosystem (Alpine:v3.18, Debian:12).
 */
export function parseOsPackages(os: OsName, release: string, text: string): ParseResult {
  const ecosystem = osEcosystem(os, release);
  if (ecosystem === null) throw new LockfileParseError("os-packages", `${os}: unknown release ${JSON.stringify(release)}`);
  const out = new ResultBuilder();
  let packages = 0;
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (line === "") return;
    if (os === "alpine") {
      const m = APK_LINE.exec(line);
      if (!m) {
        out.skip(line.slice(0, 200), "not a package line", i + 1);
        return;
      }
      packages++;
      out.add(ecosystem, m[3], m[2]);
      return;
    }
    if (/^(Desired=|\||\+\+\+-)/.test(line)) return;
    const l = DPKG_L_LINE.exec(line);
    if (l) {
      packages++;
      if (l[1][1] !== "i") out.skip(line.slice(0, 200), "not installed", i + 1);
      else out.add(ecosystem, l[2].replace(/:[a-z0-9-]+$/, ""), l[3]);
      return;
    }
    const q = DPKG_QUERY_LINE.exec(line);
    if (q) {
      packages++;
      out.add(ecosystem, q[1], q[2]);
      return;
    }
    out.skip(line.slice(0, 200), "not a package line", i + 1);
  });
  if (packages === 0) throw new LockfileParseError("os-packages", `${os}: no package line in os_packages`);
  return out.build();
}
