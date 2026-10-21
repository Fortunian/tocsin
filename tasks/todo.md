# Tocsin — tasks

Plan: docs/PLAN_2026-10-21.html. Tickets: docs/tickets/*.md.

## Setup (Mac)
- [x] Register tocsin.sh and tocsin.so (Namecheap, 2026-10-21)
- [x] Add both zones to Cloudflare (liorwn@gmail.com account), nameservers aleena + matias .ns.cloudflare.com
- [x] Namecheap nameservers changed (Lior, 2026-10-21)
- [ ] Nameservers live at the registry (re-check with `dig NS tocsin.sh @a0.nic.sh`)
- [ ] Lior approves plan + tickets
- [ ] Repo liorwn/tocsin pushed; set public on Lior's word
- [ ] Harness load: `bin/load-project.sh liorwn/tocsin --prefix TCS --prod https://tocsin.sh`
- [ ] GitHub Actions secret CLOUDFLARE_API_TOKEN (Workers + D1 + KV + Queues scopes, liorwn account)
- [ ] Reserve npm `tocsin` with a placeholder 0.0.1 publish

## Build (harness)
- [ ] Wave 0: #1 scaffold
- [ ] Wave 1: #2 OSV, #5 feed API, #6a parsers, #6b matcher
- [ ] Wave 2: #3 node+php runtime, #4 enrichment, #7 watch lists, #6c check endpoint, #11 site
- [ ] Wave 3: #8 webhooks, #9 MCP, #10 CLI + skill
- [ ] Wave 4: #12 Stripe

## Launch
- [ ] Feed contains the real 2026-10-21 Node and PHP advisories (proved by #3 fixtures against prod)
- [ ] Post: "Your agent's fetch() was exploitable on October 21 and nothing told it."
