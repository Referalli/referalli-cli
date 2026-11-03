# Changelog

All notable changes to `@referalli/cli` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Before 1.0, a minor
bump may include breaking changes; they are called out under **Changed**.

## 0.4.0 - 2026-11-03

- `apply` manages `billingConnections`: matched by `name`, with `provider`, `programs` (slugs), `status`, `customerRefMetadataKey`, `filter`, and `stripeKeyEnv` (Stripe one-call connect, create only). Missing connections are created, changed fields PATCHed, none deleted; the new `webhookSecret` goes to `--secret-file` (or is printed once, like other new secrets). `--check` exits 2 on billing connection drift too.
- `doctor [--program <id>] [--json]`: read-only setup checks (API key, commission rules, webhook endpoints, billing and auth connections, tracking token), each `✓`/`⚠`/`✗` with a fix. Exits 1 on any `✗`.

## 0.3.3 - 2026-11-02

- `trigger --billing <event> --connection <id> [--data JSON]`: send a billing event fixture for any provider (the connection's) into a test-mode billing connection (`POST /v1/sandbox/billing-fixtures`). Events are provider-neutral (`payment.paid`, `payment.refunded`, `payment.disputed`, `subscription.created`, `subscription.canceled`) or the provider's own names. `trigger --stripe` keeps working.

## 0.3.2 - 2026-11-02

- `apply` sends `waitForCustomer` under `stripeCredits` (the API replaces all credit settings on save, so leaving it out turns it off; the plan shows it).

## 0.3.1 - 2026-11-02

- Fixed: `apply` accepts `balanceCurrency` and `createCustomerIfMissing` under `stripeCredits`. Before, it refused them, and applying a file to a program that had them set turned them off without showing it in the plan.

## 0.3.0 - 2026-11-02

- `trigger --stripe <event> --connection <id> [--data JSON]`: send a Stripe event fixture into a test-mode billing connection (`POST /v1/sandbox/stripe-fixtures`) and print the commissions it created.
- `plan <file>` and `apply <file> [--plan] [--check] [--secret-file PATH]`: declarative config for programs, commission rules, Stripe credit settings, webhook endpoints and API keys (YAML or JSON). Matched by slug, url and name + owner; creates send an `Idempotency-Key`; `--check` exits 2 on drift (1 is an error); no deletes, rotations or revocations.
- New runtime dependency: `js-yaml`.
- `api --secret-file <path>`: write a returned secret (API key, webhook signing secret) to a new 0600 file instead of printing it.
- API additions from `referalli` 0.3.0: one-call referrers, partner summary, portal links, program-scoped API keys and the Stripe balance credit rail.

## 0.2.0 - 2026-10-24

- API 2026-11-01 additions: 56 new operations (inbound signup connectors, billing product filters, per-org SSO and partner-portal sign-in, support-tool context cards, data-rights executors, account closure, rewards, integration health, plans, the event feed and bulk webhook replay) and 2 webhook topics (`webhook_endpoint.failing`, `webhook_endpoint.recovered`).
- New error code `reauth_required` (401): sign in again before changing payout details.
- `events tail --since` backfills from `/v1/events` before tailing live.

## [Unreleased]

### Added
- First public release: `referalli login`, `whoami`, `keys`, `listen --forward-to`, `trigger`, `events tail`, `logs tail`, `api` and `open`.
- `events tail --since 1h` (or an ISO time) prints the events since then from `GET /v1/events`, then tails live without repeating them.
