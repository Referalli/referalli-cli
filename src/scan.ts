import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { LEGACY_ENV, LEGACY_ENV_REMOVAL } from './config.js';
import { printChecks, type Check } from './doctor.js';

const MAX_BYTES = 1024 * 1024;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next']);
const LOCKFILE = /\.(lock|lockb)$|^(pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json|go\.sum)$/;
const REMOVAL = `removal ${LEGACY_ENV_REMOVAL}`;
const PUBLISHED = new Set(['cli', 'express', 'mcp', 'next', 'react', 'react-native']);

const packageName = (old: string) => {
  const name = old.slice('@referally/'.length);
  if (name === 'sdk-js') return 'referalli';
  return PUBLISHED.has(name) ? `@referalli/${name}` : 'no published replacement';
};

// Dates come from docs: Renamed from Referally (the cookie twin goes first, the rest on one later date).
const RULES: Array<{ re: RegExp; to: (old: string) => string; removal: string }> = [
  { re: /\w*REFERALLY_\w*/g, to: (o) => o.replace('REFERALLY_', 'REFERALLI_'), removal: REMOVAL },
  { re: /referally-version/gi, to: () => 'referalli-version', removal: REMOVAL },
  { re: /referally_ctx/g, to: () => 'referalli_ctx', removal: 'removal 2027-01-31' },
  { re: /x-referally-[\w-]*/gi, to: (o) => o.toLowerCase().replace('referally', 'referalli'), removal: REMOVAL },
  { re: /@referally\/[\w.-]*/g, to: packageName, removal: REMOVAL },
];

/**
 * One line per old name per line. An env name is a warning only when Referalli itself read it;
 * any other REFERALLY_* is the app's own name (info): nothing of ours stops reading it.
 */
function scanFile(path: string, text: string): Check[] {
  if (!/referally/i.test(text)) return [];
  return text.split('\n').flatMap((line, i) =>
    RULES.flatMap(({ re, to, removal }) =>
      [...new Set(line.match(re) ?? [])].map((old): Check => {
        const own = /REFERALLY_/.test(old) && !LEGACY_ENV.includes(old);
        return own
          ? { id: `${path}:${i + 1}`, status: 'info', message: `${old}: your own name (Referalli never read it); rename it to ${to(old)} if you like` }
          : { id: `${path}:${i + 1}`, status: 'warn', message: `${old} → ${to(old)} (${removal})` };
      }),
    ),
  );
}

/** `referalli doctor --scan <dir> [--strict]`: old names in a source tree. Needs no key and calls no API. */
export function runScan(out: (line: string) => void, err: (line: string) => void, dir: string, opts: { strict: boolean; json: boolean }): number {
  const hits: Check[] = [];
  let files = 0;
  let skipped = 0;
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      try {
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) walk(path);
        } else if (entry.isFile() && !LOCKFILE.test(entry.name)) { // symlinks aren't followed: no loops
          if (statSync(path).size > MAX_BYTES) {
            skipped++;
            continue;
          }
          const buf = readFileSync(path);
          if (buf.subarray(0, 8000).includes(0)) {
            skipped++;
            continue;
          }
          files++;
          hits.push(...scanFile(path, buf.toString('utf8')));
        }
      } catch {
        skipped++; // unreadable: counted, the rest of the tree still scans
      }
    }
  };
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`${dir}: not a directory`);
  walk(dir);
  const warnings = hits.filter((h) => h.status === 'warn').length;
  printChecks(out, hits.length ? hits : [{ id: 'names', status: 'ok', message: 'no old Referally names found' }], opts.json);
  err(`Scanned ${files} file(s), ${warnings} old name(s) Referalli reads, ${hits.length - warnings} of your own; skipped ${skipped} (over 1 MB, binary or unreadable).`);
  return opts.strict && warnings ? 1 : 0;
}
