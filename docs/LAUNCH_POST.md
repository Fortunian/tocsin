# Your agent's fetch() was exploitable on October 21 and nothing told it

On October 21, Node.js shipped fixes for ten security flaws. One of them, [CVE-2026-111497](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases), is an out-of-bounds write in the Node.js Brotli decoder that Node rates high and says permits remote code execution. It affects the 22.x, 24.x and 26.x lines. The fixes are 22.23.4, 24.22.1 and 26.12.1.

Here is why that matters to an agent. Node's built-in `fetch()` decompresses a response sent with `Content-Encoding: br` through that Brotli decoder. So an agent that fetched a page from a hostile server put the server's bytes straight into the bug.

The same day, PHP shipped 8.5.12, 8.4.27, 8.3.36 and 8.2.35 to fix two remote code execution flaws, [CVE-2026-109618](https://github.com/php/php-src/security/advisories/GHSA-w8hw-w9fx-j79w) and [CVE-2026-109619](https://github.com/php/php-src/security/advisories/GHSA-6wmf-4rv5-p3rp). Both score 9.2 on CVSS 4.0. The [php.net advisory](https://www.php.net/archive/2026.php#2026-10-21-5) says all PHP installations serving web requests are at risk.

I run agents all day. None of them knew. The facts were out there as a blog post, an RSS item, a news entry and a GitHub advisory. Four shapes in four places, and not one of them made for a program to read and act on.

So I built Tocsin. It is one feed of runtime and package advisories in one schema. Every record has the affected ranges, the fixed versions, a severity and a one-line action, like "Upgrade node to 24.22.1 or later." Every fact links back to its source. No model writes any of it.

Hooking up an agent is one command:

```
npx tocsin connect
```

That adds the Tocsin MCP server to Claude Code, Cursor, Claude Desktop and Codex. Or ask directly:

```
curl "https://tocsin.sh/v1/check?node=24.22.0&php=8.4.26"
```

You get back the advisories that hit those versions, each with its fix.

What is free: all of it. The feed, the check endpoint, the MCP server and the CLI need no account and cost nothing. There is no paid tier. Next up are watch lists and signed webhooks, behind a free API key, so an agent gets pushed the advisories for its own stack instead of polling.

Every pull request in the repo was planned, built and reviewed by the Cromford factory, and each one carries its ticket key so you can check the work.

The engine, the schema, the ingesters, the MCP server and the CLI are open source under Apache-2.0. If your ecosystem is missing, [open a source request](https://github.com/Fortunian/tocsin/issues/new/choose).

https://github.com/Fortunian/tocsin
