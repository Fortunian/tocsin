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
