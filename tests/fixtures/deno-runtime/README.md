# deno-runtime fixtures

SYNTHETIC. Every file in this directory was written by hand on 2026-10-23.
No file is a recording, and no GHSA id or CVE id in it is a real advisory.

Why: the TCS-41 build ran with no egress to api.github.com (the build proxy
answered 403 to `CONNECT api.github.com:443`), so the real page could not be
recorded. Re-record these files from the URLs below when a session has
GitHub access, and replace this README with the recorded form of
`tests/fixtures/python-runtime/README.md` (UTC time, status, ETag, sha256).

What is real: the `package`, `vulnerable_version_range` and
`patched_versions` strings. Each one is a value that
`GET https://api.github.com/repos/denoland/deno/security-advisories?state=published&per_page=100&sort=published&direction=desc`
returned on 2026-10-23 to the TCS-41 plan session (the plan's "Live facts").
The rest of each entry (ids, CVE ids, summaries, dates, CVSS) is invented,
in the shape of the GitHub repository security advisory schema.

The CVE ids use the year 2099, so they can never collide with a real CVE.
The GHSA ids use repeated groups (`GHSA-2222-2222-2222`), so they read as fake.

| Entry | Real strings it carries | Source of the strings |
|---|---|---|
| GHSA-2222-2222-2222 | `deno/""`, `<= 2.7.4`, `2.7.5` | GHSA-x2qc |
| GHSA-3333-3333-3333 | `rust/deno`, `< v2.7.10`, `v2.7.10` | GHSA-7xh3 |
| GHSA-4444-4444-4444 | `""/Deno`, `>=2.0.0`, `2.2.15, 2.5.2` | GHSA-m2gf (patched), live range list |
| GHSA-5555-5555-5555 | `<=2.1.12, <=2.2.12`, `2.1.13, 2.2.13, >=2.3.3` | GHSA-xqxc (patched), live range list |
| GHSA-6666-6666-6666 | `rust/denoland/deno`, `> 1.46.0 <= 2.1.6`, `2.1.7` | GHSA-2x3r-hwv5-p32x |
| GHSA-7777-7777-7777 | `rust/deno_fetch`, `<1.46.4, <2.1.2`, `2.1.2` | GHSA-f27p |
| GHSA-8888-8888-8888 | `>= 1.36.2, < 1.40.3`, `""` | GHSA-3j27-563v-28wf |
| GHSA-9999-9999-9999 | `rust/deno_runtime`, `=1.34.0` | GHSA-vc52 |
| GHSA-2222-3333-4444 | `composer/""`, `1.5.0 - 1.10.1` | GHSA-m3c4, live range list |
| GHSA-3333-4444-5555 | `deno/node:crypto`, `>= 1.9`, `>= 2.2.5` | GHSA-5379, live lists |
| GHSA-4444-5555-6666 | `rust/serde_v8`, `rust/deno_doc` | live package list |
| GHSA-5555-6666-7777 | none (a withdrawn entry) | invented |

`releases.json`: hand-written in the shape of
`GET https://api.github.com/repos/denoland/deno/releases?per_page=100`,
with only `tag_name`, `draft`, `prerelease` and `published_at` per entry.
It holds one prerelease, one draft and one tag that is not a `v` tag.

Sha256 of the files in this directory:

- `advisories.json`: 7debd9198702ba7034a46e125fc00f90970d4bc775dfe75d3c7461138b175f63
- `releases.json`: 0f3d2fe2ae5249971cd1606e7eeea4b86a61d0173d3b631c02dd309c1979d514
