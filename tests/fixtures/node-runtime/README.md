# node-runtime fixtures

Recorded from nodejs.org on 2026-10-22T15:34:43Z (UTC), each answer HTTP 200.
No byte in these files was written by hand.

| File | Source URL | Full-file sha256 of the recording | Rule |
|---|---|---|---|
| `vulnerability.xml` | https://nodejs.org/en/feed/vulnerability.xml | f98fad19b1bea6830bf65be8b87289dcceb943da42154fadf5f7b761591402b2 | whole file |
| `2026-10-21.html` | https://nodejs.org/en/blog/vulnerability/october-2026-security-releases | fc6a0cecdb78d1bd27b758e85eb0dde34f62d572c7b059c9879da2a4844b9f71 | byte slice: the one `<main …>…</main>` element, from `<main` to the end of `</main>` (58,718 of 289,487 bytes) |
| `index.json` | https://nodejs.org/dist/index.json | 6c56f52ff7be0efb8199281e5dcc774709166cf8b55be1b08dc1dba14f1060a0 | the recording has one entry per line; kept the lines whose `date` is `2026-10-01` or later (7 entries), each line unedited, joined back into a JSON array |

The rest of the post page is Next.js script and navigation. The ingester reads
only the headings and lists inside `<main>`.

Sha256 of the files in this directory:

- `vulnerability.xml`: f98fad19b1bea6830bf65be8b87289dcceb943da42154fadf5f7b761591402b2 (same as the recording)
- `2026-10-21.html`: 409fb55ca0113610b865c26783719f4ec8dc1e147af10c1c02d304447fe01895
- `index.json`: 9fb26b98005b84231257d36e79fa02016dced65c1f88956af58808598566dc3b

## TCS-30 fixtures

Recorded on 2026-10-22 (UTC) as below. No byte in these files was written by hand.
The TCS-30 build box had no egress to nodejs.org, so the build cut the slices from
the recordings that the TCS-30 planning session (the July post and the archive
capture) and the TCS-6 build (the dist index) saved on the box.

| File | Source URL | Recorded at | Full-file sha256 of the recording | Rule |
|---|---|---|---|---|
| `2026-07-29.html` | https://nodejs.org/en/blog/vulnerability/july-2026-security-releases | 2026-10-22T23:51:23Z | 3f73fe8618d38fda9e54bb0f2f4d263b2c34635421b7761069aa3cd89837d4d3 | byte slice: the one `<main …>…</main>` element (62,961 of 301,179 bytes) |
| `2026-10-14-pre.html` | https://web.archive.org/web/20261014143758id_/https://nodejs.org/en/blog/vulnerability/october-2026-security-releases (the 2026-10-14 pre-announcement at the release post URL) | 2026-10-22T23:51:44Z | 36e65628940ce61c6560cf807e0d9f772cda2a8949cbae00b80f8050b72137cf (gzip as served); 99a8a9023e8dfa8266be4c5ad3adcd5e98c3b47ead74a8e189fd8311d229c30f (after gunzip) | gunzip, then the same `<main …>…</main>` byte slice (52,182 of 265,486 bytes) |
| `index-since-2026-07.json` | https://nodejs.org/dist/index.json | 2026-10-22T15:34:42Z (the `index.json` recording above) | 6c56f52ff7be0efb8199281e5dcc774709166cf8b55be1b08dc1dba14f1060a0 | the `index.json` rule with the cut at `2026-07-01` (22 entries). The same script with the cut at `2026-10-01` gives `index.json` byte for byte. |

Sha256 of these files in this directory:

- `2026-07-29.html`: 0be1d0cbf3d33dec72b8b0838a6d06e3b2fbe1e42eff3f352772b26e14eca10e
- `2026-10-14-pre.html`: f5fd8163aa95a9298acaebd50280c19db097445954b86908f45456e78c204f9f
- `index-since-2026-07.json`: 9cc67ba5f3d0a37c9756615b359a5a5ab803ce2413081ab3976701f7b78af6e1
