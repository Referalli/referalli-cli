import { parseArgs } from 'node:util';
import { ApiError } from './client.js';
import { api, CliError, eventsTail, keys, login, listen, logout, logsTail, open, trigger, whoami, type Flags, type Io } from './commands.js';
import { VERSION } from './version.js';

export { readConfig, writeConfig, configPath, type CliConfig } from './config.js';
export { createClient, ApiError } from './client.js';
export type { Io } from './commands.js';
export { VERSION } from './version.js';

export const HELP = `referalli: the Referalli command line

Usage:
  referalli login [--key rk_…] [--base-url URL] [--no-browser]
  referalli logout
  referalli whoami
  referalli listen [--forward-to URL] [--events topic,topic] [--max-events N]
  referalli trigger <topic> [--data JSON]
  referalli events tail [--events topic,topic] [--since 1h|ISO] [--json] [--max N]
  referalli logs tail [--max N]
  referalli open [docs|dashboard|keys|webhooks|spec|status]
  referalli api <METHOD> <path> [--data JSON]
  referalli keys create --name NAME [--owner WHO] [--mode both|live|test] [--scopes full,…] [--expires-days N]
  referalli keys list [--owner WHO] [--mode live|test]
  referalli keys revoke <key id> [--pair] [--cascade]

Environment:
  REFERALLI_API_KEY   use this key instead of the saved login
  REFERALLI_API_URL   API base URL (default: the hosted API)
  REFERALLI_CONFIG_DIR where the login is saved (default ~/.config/referalli)`;

/** Run one command; returns the process exit code. */
export async function runCli(argv: string[], io: Io): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        key: { type: 'string' },
        'base-url': { type: 'string' },
        'no-browser': { type: 'boolean' },
        'forward-to': { type: 'string' },
        events: { type: 'string' },
        since: { type: 'string' },
        'max-events': { type: 'string' },
        max: { type: 'string' },
        wait: { type: 'string' },
        data: { type: 'string' },
        name: { type: 'string' },
        owner: { type: 'string' },
        mode: { type: 'string' },
        scopes: { type: 'string' },
        'expires-days': { type: 'string' },
        pair: { type: 'boolean' },
        cascade: { type: 'boolean' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (err) {
    io.err((err as Error).message);
    io.err(HELP);
    return 2;
  }
  const flags = parsed.values as Flags;
  const [command, ...rest] = parsed.positionals;
  if (flags.version) {
    io.out(VERSION);
    return 0;
  }
  if (!command || flags.help) {
    io.out(HELP);
    return command || flags.help ? 0 : 2;
  }
  try {
    switch (command) {
      case 'login':
        return await login(io, flags);
      case 'logout':
        return await logout(io);
      case 'whoami':
        return await whoami(io);
      case 'listen':
        return await listen(io, flags);
      case 'trigger':
        return await trigger(io, rest[0], flags);
      case 'logs':
        if (rest[0] !== 'tail') throw new CliError('Usage: referalli logs tail');
        return await logsTail(io, flags);
      case 'events':
        if (rest[0] !== 'tail') throw new CliError('Usage: referalli events tail');
        return await eventsTail(io, flags);
      case 'open':
        return await open(io, rest[0], flags);
      case 'version':
        io.out(VERSION);
        return 0;
      case 'api':
        return await api(io, rest[0], rest[1], flags);
      case 'keys':
        return await keys(io, rest[0], rest[1], flags);
      default:
        io.err(`Unknown command "${command}".`);
        io.err(HELP);
        return 2;
    }
  } catch (err) {
    if (err instanceof CliError) io.err(err.message);
    else if (err instanceof ApiError) io.err(`API error ${err.status}${err.code ? ` (${err.code})` : ''}: ${err.message}`);
    else io.err(`Error: ${(err as Error).message}`);
    return 1;
  }
}
