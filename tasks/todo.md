# Tocsin — tasks

Plan: docs/PLAN_2026-10-21.html. Tickets: docs/tickets/*.md.

## Setup (Mac)
- [x] Register tocsin.sh and tocsin.so (Namecheap, 2026-10-21)
- [x] Add both zones to Cloudflare, nameservers aleena + matias .ns.cloudflare.com
- [x] Namecheap nameservers changed (Lior, 2026-10-21)
- [ ] Nameservers live at the registry (re-check with `dig NS tocsin.sh @a0.nic.sh`)
- [ ] Lior approves plan + tickets
- [x] Repo at Fortunian/tocsin (transferred 2026-10-22)
- [ ] Make repo public when launch-check (#14) passes against prod — Lior pre-authorized 2026-10-22: `gh api -X PATCH repos/Fortunian/tocsin -f private=false`
- [ ] Harness load: `bin/load-project.sh Fortunian/tocsin --prefix TCS --prod https://tocsin.sh`
- [ ] GitHub Actions secret CLOUDFLARE_API_TOKEN (Workers + D1 + KV + Queues scopes, liorwn account)
- [ ] Reserve npm `tocsin` with a placeholder 0.0.1 publish

## Build (harness)
- [ ] Wave 0: #1 scaffold
- [ ] Wave 1: #2 OSV, #5 feed API, #6a parsers, #6b matcher
- [ ] Wave 2: #3 node+php runtime, #4 enrichment, #7 watch lists, #6c check endpoint, #11 site
- [ ] Wave 3: #8 webhooks, #9 MCP, #10 CLI (connect, check) + skill, #13 launch gate
- [x] Wave 4: #12 Stripe PARKED (launch is free, 2026-10-22)

## Launch
- [ ] Feed contains the real 2026-10-21 Node and PHP advisories (proved by #3 fixtures against prod)
- [ ] Post: "Your agent's fetch() was exploitable on October 21 and nothing told it."

## Filed 2026-10-22 (Fortunian/tocsin issues, ai-build)
#1 scaffold · #2 OSV ingest · #3 feed API · #4 parsers · #5 matcher · #6 node+php runtime · #7 NVD/KEV/EPSS · #8 watch lists · #9 check endpoint · #10 site · #11 webhooks · #12 MCP · #13 CLI connect/check · #14 launch gate · #15 Stripe
Blocked until the box can read the repo: install the board-harness GitHub Apps on the owner account (or make the repo public and rely on the PAT rung), then re-run load-project.
