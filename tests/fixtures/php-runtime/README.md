# php-runtime fixtures

Recorded on 2026-10-22T15:34:43Z (UTC), each answer HTTP 200. Every file is
the whole recorded answer, byte for byte. No byte was written by hand.

| File | Source URL | sha256 |
|---|---|---|
| `2026-10-21.html` | https://www.php.net/index.php | f35d9a82e413c9816cfaef91f105f8e4ec27f6b7694ddc592eb99575123871e8 |
| `releases.xml` | https://www.php.net/releases/feed.php | 5745cf67c9dd25f706daf8d3c3f403dd703fe8ddf86802fa1b91c859e0a1c89a |
| `GHSA-w8hw-w9fx-j79w.json` | https://api.github.com/repos/php/php-src/security-advisories/GHSA-w8hw-w9fx-j79w | e94e2dd08e0acca7ffd55b5fa54089d63ad535ff7c11499cf71d4d78ded1e756 |
| `GHSA-6wmf-4rv5-p3rp.json` | https://api.github.com/repos/php/php-src/security-advisories/GHSA-6wmf-4rv5-p3rp | 61c9b7cc2ceadc8d9884754a1994968da8906da0c3370e7840c716528a187b42 |

`2026-10-21.html` is the php.net front page on that day. Its first news entry
is the 2026-10-21 "Security advisory: Critical remote code execution
vulnerabilities, update now" post. The GitHub answers were read without a token.

## `security-advisories.page1.json` (TCS-29): ASSEMBLED, not recorded

| File | Stands in for | sha256 |
|---|---|---|
| `security-advisories.page1.json` | https://api.github.com/repos/php/php-src/security-advisories?state=published&sort=published&direction=desc&per_page=3 | 30d4775b1df519170550d59656eeb3f280f117471a26af7386c53bd7e9f07199 |

The TCS-29 build (2026-10-23T01:36:38Z) had no egress to api.github.com: the
build proxy answered 403 to `CONNECT api.github.com:443`, so the list page
could not be recorded. A script assembled the file on 2026-10-23 as a JSON
array of three items, newest first:

1. `GHSA-w8hw-w9fx-j79w.json`, byte for byte (recorded, see above).
2. `GHSA-6wmf-4rv5-p3rp.json`, byte for byte (recorded, see above).
3. SYNTHETIC: a copy of item 2 with `ghsa_id` GHSA-2222-2222-2222,
   `cve_id` CVE-2099-10001, its `url`, `html_url` and `identifiers` to match,
   `summary` and `description` marked SYNTHETIC, and `published_at` /
   `updated_at` 2026-09-15T00:00:00Z. It is the advisory older than the
   test cursor. It is not a real advisory.

The list endpoint returns the same repository advisory object as the single
GHSA endpoint, so items 1 and 2 have the list item shape. Re-record this file
from the URL above when a session has GitHub access, and replace this section.
