# KEV fixtures

Shape: the CISA Known Exploited Vulnerabilities JSON feed
(`https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json`).

Not a recorded download. `www.cisa.gov` was refused by the build box egress proxy on
2026-10-22 (13:57Z, CONNECT 403), so `feed.json` was written by hand in the feed shape.
The `CVE-2021-44228` entry follows the public catalog entry for Log4Shell. The
`CVE-2026-9001x` entries are fixture ids, not real CVEs; `cve-2026-90012` is lowercase on
purpose (the ingester must ignore it).
