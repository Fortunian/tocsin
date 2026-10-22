# EPSS fixtures

Shape: the FIRST EPSS daily CSV (`https://epss.empiricalsecurity.com/epss_scores-current.csv.gz`,
gunzipped): a `#model_version:...,score_date:...` line, the `cve,epss,percentile` header, then
one row per CVE.

Not a recorded download. The EPSS host was refused by the build box egress proxy on
2026-10-22 (13:57Z, CONNECT 403), so `scores.csv` was written by hand in that shape. The
`CVE-2026-9002x` rows are fixture ids. `CVE-2026-90023` has epss 1.7 on purpose (out of
range, the ingester must skip it). The tests gzip this text with `CompressionStream`.
