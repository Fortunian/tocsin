# python-runtime fixtures

Recorded on 2026-10-22 between 21:18:46Z and 21:21:08Z (UTC), each answer
HTTP 200, read without a token. No byte in a record file was written by hand.

Source change: `https://api.github.com/repos/python/cpython/security-advisories?state=published&per_page=5`
answered `[]` (with and without a token) on 2026-10-22. CPython publishes its
advisories in the PSF advisory database instead (`psf/advisory-database`,
`advisories/python/PSF-YYYY-N.json`, OSV format). Those records carry only
GIT commit ranges, so the fixed version per release line comes from the PSF
CVE record on cveawg.mitre.org.

| File | Source URL | sha256 of the recording | Rule |
|---|---|---|---|
| `listing.json` | https://api.github.com/repos/psf/advisory-database/contents/advisories/python | daf74029ecf3acb485ce6103e8ecfe1b290884ef1505697bc1abc83b454f7c06 | the recording is a JSON array of 195 entries; kept the 5 entries named PSF-2025-16, PSF-2026-41, PSF-2026-42, PSF-2026-43 and PSF-2026-44, each entry unedited, written back with `json.dump(indent=2)`. Recorded ETag: `"39fd4cc08d4e9fccc7b7b084cfe4080373d7c4fb"` |
| `PSF-2026-41.json` | https://raw.githubusercontent.com/psf/advisory-database/main/advisories/python/PSF-2026-41.json | 5bd4f05e0e63df65077ae0591e7c2842e1c1b3432324bfea3a74f90a250bedb7 | whole file |
| `PSF-2026-42.json` | https://raw.githubusercontent.com/psf/advisory-database/main/advisories/python/PSF-2026-42.json | 9d9cb59b75dd7715e1e1f5cd5f895e5b61407f4e2445a67219ad0c9d19574df0 | whole file |
| `PSF-2026-43.json` | https://raw.githubusercontent.com/psf/advisory-database/main/advisories/python/PSF-2026-43.json | e70e78b8610993597514281df096ef497a07067ad9ac4a1bf63ad4e82219a4d1 | whole file |
| `PSF-2026-44.json` | https://raw.githubusercontent.com/psf/advisory-database/main/advisories/python/PSF-2026-44.json | d7d6e8233c260fcb2abe4ba2cc7458f76c62887faf4b5a5e1ce875cf5248e1ac | whole file |
| `CVE-2026-82049.json` | https://cveawg.mitre.org/api/cve/CVE-2026-82049 | a20a5496e8473853d3669cc23316d36fa896abaab2cc185aa6bb1e89a251d832 | whole file |
| `CVE-2026-12345.json` | https://cveawg.mitre.org/api/cve/CVE-2026-12345 | 4601ce072b7701b92b994989d4ff39e4ef68e9a32a8d4983e824b87dc4ad5695 | whole file |
| `CVE-2026-19445.json` | https://cveawg.mitre.org/api/cve/CVE-2026-19445 | 1bc5b392a41030993c6b2602c9f170fb5c415a2ad4ecba64c68af97a689c879b | whole file |
| `CVE-2026-19553.json` | https://cveawg.mitre.org/api/cve/CVE-2026-19553 | 174d3ddc942e1033b259f1146120305182759e0291d4c25c366f946641c30a87 | whole file |
| `releases.json` | https://www.python.org/api/v2/downloads/release/?is_published=true | b9961a8c741553ac658017bb32fafe65a182281fec8991f1ff368ac919807eb9 | the recording is a JSON array of 499 releases; kept the 28 entries with `release_date` on or after `2026-06-01T00:00:00Z`, each entry unedited, written back with `json.dump(indent=2)` |

Sha256 of the trimmed files in this directory:

- `listing.json`: fe2f22221ef7ff5b446ad2d4d0f9160c37520b335708de5db3297d334a6991ee
- `releases.json`: e725440020d12df00a90d125ac57044d1f267f61ac70335d64f309278dc8b001
