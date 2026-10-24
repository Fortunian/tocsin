# OSV fixtures for TCS-38

api.osv.dev, the OSV bucket and GitHub did not answer from the build box (egress proxy). Only the
npm and PyPI registries did. The recorded records below come from test data inside PyPI sdists,
whole files, not edited. Every other record is hand-built and marked `assumed`.

## Recorded

| File | Package (sdist) | Path in the sdist |
|---|---|---|
| `Maven/GHSA-76mp-659p-rw65.json` | osv 0.1.3, https://files.pythonhosted.org/packages/7c/6a/c7482cd8793dc7ef32f1a4578dbb9b05ecbf150a136ecf47af33d597b3ef/osv-0.1.3.tar.gz sha256 4621ebed9c4c70ab34078ebf13a6473ab2161f0b71f9f7215ebd0002090672c1 | `osv/osv-schema/tools/ghsa/testdata/maven_greater_than.osv.json` |
| `Maven/GHSA-mr95-9rr4-668f.json` | osv 0.1.3 (as above) | `osv/osv-schema/tools/ghsa/testdata/full_ranges.osv.json` |
| `Alpine/CVE-2018-5407.json` | osv 0.1.3 (as above) | `osv/osv-schema/tools/osv-linter/testdata/CVE-2018-5407.json` (one `affected[]` entry has a GIT range and no ecosystem) |
| `Maven/GHSA-2hjr-vmf3-xwvp.json` | vulnerablecode 40.2.0, https://files.pythonhosted.org/packages/3c/da/02785ee14a67288465195c62c9987e93df5c414b99e531ada8dffc7f0a05/vulnerablecode-40.2.0.tar.gz sha256 70de487646ee78c8f349347f0d1df92480f6f7139de55d17cd7f383b10566010 | `vulnerabilities/tests/test_data/osv_test/github/github-1.json` |
| `Maven/GHSA-8hxh-r6f7-jf45.json` | vulnerablecode 40.2.0 (as above) | `vulnerabilities/tests/test_data/osv_test/github/github-3.json` |
| `Maven/GHSA-29qj-rvv6-qrmv.json` | vulnerablecode 40.2.0 (as above) | `vulnerabilities/tests/test_data/github_osv/github_osv_test_3.json` |
| `NuGet/GHSA-h7jm-g87p-5935.json` | vulnerablecode 40.2.0 (as above) | `vulnerabilities/tests/test_data/github_osv/github_osv_test_7.json` |

## Assumed (hand-built)

`maven.assumed.json`, `nuget.assumed.json`, `hex.assumed.json`, `pub.assumed.json`,
`alpine.assumed.json`, `debian.assumed.json`: source: assumed. Records in the OSV shape, written by
the TCS-38 build, not copies of published advisories. Ids `TCS38-<ECOSYSTEM>-<n>` are test ids, not
OSV ids; the package names are real, the ranges are test inputs. `GHSA-jfh8-c2jp-5v3q` (log4j-core,
CVE-2021-44228) keeps its real id because the ticket's prod gate names it; its three ranges
(`2.0-beta9`..`2.3.1`, `2.4`..`2.12.2`, `2.13.0`..`2.15.0`) and its CVSS vector are written from the
public advisory, not recorded. Replace each file with recorded copies from
`https://api.osv.dev/v1/vulns/<id>` when that host is reachable.
