# Changelog

All notable changes to `@referalli/cli` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Before 1.0, a minor
bump may include breaking changes; they are called out under **Changed**.

## 0.4.10 - 2026-11-11

### Fixed
- `doctor --program`: when several org-wide billing connections exist (one per product in a shared org), a broken one is ⚠ as long as another works, with the fix to limit it to its programs. It still fails when it's the only connection the program could use.

## 0.4.9 - 2026-11-11

### Changed
- `doctor --program` only fails on the program's own resources. Other programs' problems become one line (`scope.other`), and an org-wide connection the program doesn't use is a warning.
- The `tracking.consent` check uses the program's own `trackingConsent`, and never suggests an org-wide change for a program that overrides it.
- Auth connections show the last refused sign-up call.
- `keys list` shows each key's programs.

## 0.4.8 - 2026-11-11

### Added
- `doctor` runs every `/v1/integration-health` check, plus payouts, email provider, widget setup, unpaid approved commissions and the public join page.
- `doctor` and `plan --prune` stay inside the key's programs; `REFERALLI_PROGRAM_ID` sets the default `--program`.
- Webhooks in the yaml can match by `id`, so a URL change updates the endpoint and keeps its secret. `plan`/`apply --prune` delete what the file no longer lists.
- New yaml sections: `payouts`, `email`, `trackingConsent`, `hostedPages`; program fields `widget`, `refereeReward`, `brand`, `termsUrl`, `faqUrl`, `supportUrl`, `trackingConsent`, `notificationEmails`, `howItWorksMd`; `authConnections[].tokenVerification`.
- `referalli billing owner set <accountRef> <customerRef>`.

### Changed
- Unknown webhook topics are rejected with a suggestion. Endpoints managed by Atlas (`managedBy`) are not compared on topics.
- `doctor --scan` warns only on the old names Referalli itself read; other `REFERALLY_*` names are info.

## 0.4.7 - 2026-11-07

### Added

- `referalli doctor --program <id> --e2e` tests one program from outside: `aff.js` loads, destinations answer, the page includes `aff.js`, a `/go` link redirects with its code, and with a test key a test sign-up and payment are recorded.

## 0.4.6 - 2026-11-05

- `keys create --programs ''` explains itself rather than printing the server's bare 400.

## 0.4.5 - 2026-11-05

- `keys create` takes `--programs ID,…` and `--expires-at ISO`.
- `partners list --program` with an unknown id now fails with a 404 and a non-zero exit, rather than "0 enrolled partner(s)". Needs the API from 2026-11-05.

## 0.4.4 - 2026-11-05

- `doctor --scan <dir> [--strict]`: finds the old names `REFERALLY_*`, `referally-version`, `referally_ctx`, `x-referally-*` and `@referally/*` in a source tree, each with file:line, replacement and removal date (or "no removal date set"). Warnings exit 0; `--strict` exits 1 on any. Needs no key.
- `REFERALLY_API_KEY`, `REFERALLY_API_URL`, `REFERALLY_CONFIG_DIR` and the old tracking token names are read when the new name isn't set, with a one-line notice.
- `plan`/`apply` manage `authConnections`: matched by provider + `instanceId`/`appId` + `program`, none deleted. The new signing secret is printed once and never written to a file. `--check` exits 2 on drift too.
- `doctor` with a program-scoped key: the auth and tracking checks it can't run say so, with the key scope that would run them.
- New `partners list --program <id> [--since 7d|ISO] [--json]`: every approved enrollment with its `externalRef`.

## 0.4.3 - 2026-11-04

- `doctor` fails an auth connection whose last refused call (`lastError`) is newer than its last sign-up, with the error. It also warns when the org's tracking consent mode is `none` (live keys).

## 0.4.2 - 2026-11-03

- Fixed: `plan`/`apply` with a `billingConnections:` list failed with `conns.filter is not a function` (the connections list now arrives in the list envelope).
- Programs take `publicPage` (`pitch`, `autoApprove`) and `riskPolicy` (`holdBotScore`, `holdRiskScore`, `holdHighRiskLevel`, `holdDisposableEmail`, `holdVelocity`, `holdUnverifiedEmail`, `holdSelfReferral`). Only the keys you list are compared; `apply` merges them into the live settings.

## 0.4.1 - 2026-11-03

- New `env pull [--mode live|test]`: prints one mode's tracking token (`REFERALLI_TRACKING_TOKEN`, `NEXT_PUBLIC_REFERALLI_TRACKING_TOKEN`), aff.js URL, link base and, for the key's own mode, the program id as `.env` lines. Keys are never pulled.
- `doctor` checks the Atlas adapter: each auth connection's last sign-up (`lastSignupAt`; warns when none or none in 30 days), `auth.atlas` (warns when no auth connection reports sign-ups), and `tracking.configured` (your `REFERALLI_TRACKING_TOKEN` is the token for the key's mode).

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
