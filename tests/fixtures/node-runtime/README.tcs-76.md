# TCS-76 fixtures

Recorded from nodejs.org on 2026-10-23T13:36:36Z (UTC), each answer HTTP 200,
by the TCS-76 planning session. The build session cut the slices from those
saved recordings with the rules of `README.md`. No byte in these files was
written by hand.

| File | Source URL | Full-file sha256 of the recording | Rule |
|---|---|---|---|
| `2026-03-24.html` | https://nodejs.org/en/blog/vulnerability/march-2026-security-releases | bedfe70aaddd2c099daaf45f3946bb6bfa70e5e8022091b20a63bbf4e7018b91 | byte slice: the one `<main …>…</main>` element, from `<main` to the end of `</main>` (63,675 of 301,104 bytes) |
| `index-2025-12-to-2026-06.json` | https://nodejs.org/dist/index.json | 6c56f52ff7be0efb8199281e5dcc774709166cf8b55be1b08dc1dba14f1060a0 | the `index.json` rule of `README.md` with the cut at `date` 2025-12-01 through 2026-06-30 (34 entries), each line unedited, joined back into a JSON array |

The feed item of the March post is "Tuesday, March 24, 2026 Security Releases"
(pubDate Tue, 24 Mar 2026 03:00:00 GMT). It has 9 rated CVE headings, fixed in
20.20.2, 22.22.2, 24.14.1 and 25.8.2.

The dist index recording has the same sha256 as the 2026-10-22 recording that
`README.md` names. The same cut script, with the cut at 2026-07-01, gives
`index-since-2026-07.json` byte for byte. The slice has every fixed version the
three posts name: v20.20.0, v22.22.0, v24.12.0, v24.13.0 and v25.3.0
(December 2025 post); v20.20.2, v22.22.2, v24.14.1 and v25.8.2 (March 2026
post); v22.23.0, v24.17.0 and v26.3.1 (June 2026 post).

The same session recorded the December 2025 and June 2026 posts again:

- https://nodejs.org/en/blog/vulnerability/december-2025-security-releases:
  sha256 8207c4fec84a6b223031889e208354f2f04bcfc2d2fbbeb552b7594be800aa3f,
  byte-identical to the TCS-69 recording. Its slice is byte for byte
  `2026-01-13-incomplete.html`.
- https://nodejs.org/en/blog/vulnerability/june-2026-security-releases:
  sha256 4a9c6443f5247638c2da0f64fadf2b8b17aadfc0abb065dcc83baee1ca44da88,
  byte-identical to the TCS-69 round 4 recording. Its slice is byte for byte
  `2026-06-18.html`.

Correction to `README.tcs-69.md`: the "Downloads and release details" heading
of `2026-01-13-incomplete.html` does have a release list under it. The list
names "Node.js 20.20.0", "Node.js 22.22.0", "Node.js 24.13.0" and
"Node.js 25.3.0" with no "v", which the parser before TCS-76 did not read.

Sha256 of the files in this directory:

- `2026-03-24.html`: 0c67c0684b63d562b444985a20b65ceed67630498a27478a951f5573c69f5990
- `index-2025-12-to-2026-06.json`: 5a04b4a59bf3821d8c1be03cdc8b00a8296221311de4a7526f2155e297279708
