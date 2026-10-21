# Tocsin

Security advisories, built for agents.

One normalized feed of runtime and package security advisories. An agent subscribes in one call, asks "am I affected?" with its lockfile, and gets a one-line action with the fixed version.

```
curl "https://tocsin.sh/v1/events?since=0&ecosystem=node,npm&min_severity=high"
curl "https://tocsin.sh/v1/check?node=24.22.0&php=8.4.26"
npx tocsin check
```

Status: planning. See `docs/PLAN_2026-10-21.html` and `docs/tickets/`.

Apache-2.0. The hosted service runs at https://tocsin.sh.
