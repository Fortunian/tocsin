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
