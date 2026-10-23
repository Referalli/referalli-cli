# @referalli/cli

The Referalli command line. Sign in from the terminal, forward webhooks to your laptop, fire test events, and watch events and API requests live.

```sh
npm install -g @referalli/cli     # or: npx @referalli/cli <command>
referalli login
```

Requires Node.js 18.18 or later.

## Sign in

```sh
referalli login                 # opens a browser to approve this device (owner or admin)
referalli login --no-browser    # prints the approval link instead
referalli login --key rk_test_… # paste an API key instead (checked before it is saved)
referalli whoami
referalli logout
```

The key is saved to `~/.config/referalli/cli.json` with mode 600. In CI, set `REFERALLI_API_KEY` instead and nothing is written to disk.

## Forward webhooks to localhost

```sh
referalli listen --forward-to http://localhost:3000/webhooks
referalli listen --events referral.created,commission.earned --forward-to http://localhost:3000/webhooks
```

`listen` prints a signing secret for the session. Each event is delivered to your URL with Standard Webhooks headers (`webhook-id`, `webhook-timestamp`, `webhook-signature`) signed with that secret, so your verification code runs unchanged. Without `--forward-to`, events are printed.

## Fire test events

```sh
referalli trigger                 # lists the topics you can trigger
referalli trigger referral.created
referalli trigger commission.earned --data '{"amountMinor": 2500}'
```

A triggered event is sent to every running `listen` session and to your webhook endpoints.

## Watch what is happening

```sh
referalli events tail                         # every event, one line each
referalli events tail --events payout.sent --json   # full event bodies, for piping into jq
referalli logs tail                           # your API requests: method, path, status, latency
```

## Everything else

```sh
referalli keys create --name "Dana laptop" --owner dana@example.com --mode test
referalli keys list
referalli keys revoke key_…
referalli api GET /v1/partners
referalli api POST /v1/links --data '{"partnerId":"prt_…","programId":"prg_…"}'
referalli open docs      # also: dashboard, keys, webhooks, spec, status
```

## Environment

| Variable | Meaning |
| --- | --- |
| `REFERALLI_API_KEY` | Use this key instead of the saved login |
| `REFERALLI_API_URL` | API base URL (default `https://referalli.com`; `http://localhost:4000` for a local API) |
| `REFERALLI_CONFIG_DIR` | Where the login is saved (default `~/.config/referalli`) |

## Links

- Docs: https://referalli.com/docs
- Issues: https://github.com/Referalli/referalli-cli/issues
- Changelog: [CHANGELOG.md](./CHANGELOG.md)

MIT licensed.
