# PARKED (2026-10-22): Tocsin launches free. Do not build.

# Billing: Stripe checkout for the pro plan (after launch)

Blocked-by: #7 (hard)

## Scope
- `POST /v1/billing/checkout` with a bearer key creates a Stripe Checkout session for the `pro` price (price id from the `plans` row `stripe_price_id`, migration `0005_plans_stripe.sql` adds the column). Success URL `tocsin.sh/upgraded`.
- `POST /webhooks/stripe` verifies the signature, and on `checkout.session.completed` sets the key's plan to `pro`; on `customer.subscription.deleted` sets it back to `free`. Idempotent on Stripe event id (table `stripe_events(id PK, received_at)`).
- `GET /v1/me` returns plan and limits.

## Acceptance tests
- `tests/routes/billing.test.ts`: with Stripe mocked behind one seam (`src/billing/stripe.ts`), checkout returns a URL; the completed webhook flips the plan; the same event id twice flips once; a bad signature returns 400.

## Out of scope
Invoices UI, seats, annual pricing.
