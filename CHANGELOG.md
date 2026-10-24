# Changelog

All notable changes to `@referalli/cli` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Before 1.0, a minor
bump may include breaking changes; they are called out under **Changed**.

## 0.2.0 - 2026-10-24

- API 2026-11-01 additions: 56 new operations (inbound signup connectors, billing product filters, per-org SSO and partner-portal sign-in, support-tool context cards, data-rights executors, account closure, rewards, integration health, plans, the event feed and bulk webhook replay) and 2 webhook topics (`webhook_endpoint.failing`, `webhook_endpoint.recovered`).
- New error code `reauth_required` (401): sign in again before changing payout details.
- `events tail --since` backfills from `/v1/events` before tailing live.

## [Unreleased]

### Added
- First public release: `referalli login`, `whoami`, `keys`, `listen --forward-to`, `trigger`, `events tail`, `logs tail`, `api` and `open`.
- `events tail --since 1h` (or an ISO time) prints the events since then from `GET /v1/events`, then tails live without repeating them.
