# node-eol fixtures

No byte in these files was written by hand.

| File | Source | sha256 | Rule |
|---|---|---|---|
| `schedule.json` | The nodejs/Release `schedule.json`, as copied in the npm package `node-releases@2.0.60` (`data/release-schedule/release-schedule.json`, package tarball sha256 cd379c1964be98e9f08d406ff2127de9107e000c0dd18295acc74896b26636a8). The TCS-32 build box had no egress to raw.githubusercontent.com, only to the npm registry. | 26c8e4743fc3a76d686a038c2df40426bc3bdc7a018cb83f3b88bbf89f45436f | whole file |
| `index.json` | https://nodejs.org/dist/index.json, the recording of 2026-10-22T15:34:43Z that `tests/fixtures/node-runtime/README.md` names (full-file sha256 6c56f52ff7be0efb8199281e5dcc774709166cf8b55be1b08dc1dba14f1060a0). | b6e4444f43f5b6e7b50c99ee3dbeaaa30252763724ec41045f5f077f11e19fea | the recording has one entry per line, newest first; kept the first line of each release line (major, or `0.<minor>`), 35 entries, each line unedited, joined back into a JSON array |
