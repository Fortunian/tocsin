# NVD fixtures

Shape: NVD CVE API 2.0 (`GET https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=<id>`),
as documented at https://nvd.nist.gov/developers/vulnerabilities.

These files are NOT recorded responses. `services.nvd.nist.gov` was refused by the build
box egress proxy on 2026-10-22 (13:57Z, CONNECT 403), so the files were written by hand in
the 2.0 response shape. The CVE ids `CVE-2026-9000x` are fixture ids, not real CVEs.

- `cve-score-9.2.json`: one result with a CVSS v4.0 Secondary entry (8.4), a CVSS v3.1
  Secondary entry (7.8), a v3.1 Primary entry (9.2) and a v2 entry (6.8). The 9.2 vector
  `CVSS:3.1/AV:L/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:L` computes to 9.2 with `cvss3BaseScore`.
- `cve-no-metrics.json`: one result in "Awaiting Analysis" with empty `metrics`.
- `no-results.json`: `totalResults: 0` (the answer NVD gives for an unknown CVE id).
