# bun-runtime fixtures

`advisories-empty.json` is the answer that
`GET https://api.github.com/repos/oven-sh/bun/security-advisories?state=published&per_page=100&sort=published&direction=desc`
returned on 2026-10-23 to the TCS-41 plan session: HTTP 200, `[]`. Bun had 0
published repository security advisories that day. The file was written by
hand from that answer, because the TCS-41 build had no egress to
api.github.com (the build proxy answered 403). The ETag was not kept.

`advisories-synthetic.json` is SYNTHETIC. It is ONE hand-written entry in the
shape of the GitHub repository security advisory schema. Bun has no published
advisory to record, so this file proves only the code path, never a published
fact. Its GHSA id (`GHSA-6666-7777-8888`) and CVE id (`CVE-2099-41101`) are
not real.

`releases.json` is SYNTHETIC, in the shape of
`GET https://api.github.com/repos/oven-sh/bun/releases?per_page=100`, with only
`tag_name`, `draft`, `prerelease` and `published_at` per entry. Bun tags its
releases `bun-v<version>` (seen live by the plan session, for example
`bun-v1.4.4`). It holds one prerelease, one draft and one tag without the
`bun-v` prefix.

Re-record all three from the URLs above when a session has GitHub access.

Sha256 of the files in this directory:

- `advisories-empty.json`: 37517e5f3dc66819f61f5a7bb8ace1921282415f10551d2defa5c3eb0985b570
- `advisories-synthetic.json`: ec3146847fe607b9e4f5c460dc8c33abeeabd19260e413955bb16b1c8c5e30a2
- `releases.json`: cf0659c9a7cedb147142f51b7b9020cd4949371c0d4359d9c3975f3bd738f9b3
