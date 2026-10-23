# TCS-69 fixture

No byte in this file was written by hand.

| File | Source URL | Recorded at | Full-file sha256 of the recording | Rule |
|---|---|---|---|---|
| `2019-09-12-no-updates.html` | https://nodejs.org/en/blog/vulnerability/september-2019-openssl-no-updates | 2026-10-23T05:05:47Z | 018c21ebc64101c221404610b9363a9c0d4671c4ccdfaa4c8c0020a894705b97 | byte slice: the one `<main …>…</main>` element, from `<main` to the end of `</main>` (52,921 of 268,280 bytes) |

The TCS-69 planning session recorded the page (HTTP 200) on the build box. The
build session had no egress to nodejs.org, so it cut the slice from that saved
recording with the rule of `README.md`.

The post is the feed item "OpenSSL security releases do not require Node.js
security releases" (pubDate Thu, 12 Sep 2019 17:00:15 GMT). Its `<h1>`/`<h2>`
headings are the title, "Summary", "Analysis", "Acknowledgements" and "Contact
and future updates": no CVE heading (the CVE ids are in the body text) and no
pre-announcement wording.

Sha256 of the file in this directory:

- `2019-09-12-no-updates.html`: efa7d6d524f76a7c3a3b8f475b13b43ab399fce6e927f85962deb8be591580fe

## TCS-69 round 2 fixtures (the walk test)

Recorded from nodejs.org on 2026-10-23T13:05:33Z (UTC), each answer HTTP 200,
by the round-2 build session. No byte in these files was written by hand. Each
file is the byte slice of the one `<main …>…</main>` element of the recording
(rule of `README.md`).

| File | Source URL | Full-file sha256 of the recording | Slice |
|---|---|---|---|
| `2019-12-18-pre.html` | https://nodejs.org/en/blog/vulnerability/december-2019-security-releases | b650e9e315ebaa330e1f0418c06fdc88dab7eda17e5b65a1caa00850be53bd49 | 57,236 of 280,252 bytes |
| `2026-01-13-incomplete.html` | https://nodejs.org/en/blog/vulnerability/december-2025-security-releases | 8207c4fec84a6b223031889e208354f2f04bcfc2d2fbbeb552b7594be800aa3f | 67,292 of 318,397 bytes |
| `2026-10-21.tcs-69.html` | https://nodejs.org/en/blog/vulnerability/october-2026-security-releases | eddae2052356d959ad7e8b755a96aaa3de908ee260e1bcb0f9791696ac76aafc | 58,751 of 289,403 bytes |

The same session recorded
https://nodejs.org/en/blog/vulnerability/september-2019-openssl-no-updates again
(recording sha256 3591613a678e7428c0e65966becc4e7c02c4fd70ab9023727199aab1202efc9d):
its slice is byte for byte `2019-09-12-no-updates.html`.

What the parser reads in each post:

- `2019-12-18-pre.html` (feed item "December 2019 Security Releases", pubDate
  Wed, 18 Dec 2019 00:23:00 GMT): no CVE heading, pre-announcement wording.
- `2026-01-13-incomplete.html` (feed pubDate Tue, 13 Jan 2026 00:00:00 GMT):
  8 rated CVE headings on 20.x, 22.x, 24.x and 25.x. The "Downloads and
  release details" heading is the last element of `<main>` and has no release
  under it, so the post names no fixed version for any line.
- `2026-10-21.tcs-69.html`: 10 rated CVE headings on 22.x, 24.x and 26.x, fixed
  in 22.23.4, 24.22.1 and 26.12.1. The page changed since the 2026-10-22
  recording `2026-10-21.html` (58,718 bytes), so it is a new file.

Sha256 of the files in this directory:

- `2019-12-18-pre.html`: 19808347f9617900211d4670d1bef29e839e1b0c0652cd9be48911140c4c1e7b
- `2026-01-13-incomplete.html`: 84a8fae3c6a7b30bc9bcb5d55452166968893e3cbf6c7ffc58112cb8eeb18ac0
- `2026-10-21.tcs-69.html`: ed6b95c72989b3fd0dad631bc4aaa88736e8084f02bcc230780ddb43fb5a1723
