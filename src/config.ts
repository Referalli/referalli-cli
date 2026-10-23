import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** What `referalli login` saves. The key is a secret: the file is mode 600. */
export interface CliConfig {
  baseUrl: string;
  key: string;
  orgId?: string;
  orgName?: string;
}

export const DEFAULT_BASE_URL = 'https://referalli.com';

export const configDir = (env: NodeJS.ProcessEnv = process.env) =>
  env.REFERALLI_CONFIG_DIR ?? join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'referalli');

export const configPath = (env: NodeJS.ProcessEnv = process.env) => join(configDir(env), 'cli.json');

export function readConfig(env: NodeJS.ProcessEnv = process.env): CliConfig | null {
  // Env wins, so CI can run the CLI without a saved login.
  if (env.REFERALLI_API_KEY) {
    return { baseUrl: env.REFERALLI_API_URL ?? DEFAULT_BASE_URL, key: env.REFERALLI_API_KEY };
  }
  const path = configPath(env);
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as CliConfig;
  return { ...parsed, baseUrl: env.REFERALLI_API_URL ?? parsed.baseUrl };
}

export function writeConfig(config: CliConfig, env: NodeJS.ProcessEnv = process.env): string {
  const dir = configDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = configPath(env);
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600); // an existing file keeps its old mode on write
  return path;
}

export function removeConfig(env: NodeJS.ProcessEnv = process.env): boolean {
  const path = configPath(env);
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}
