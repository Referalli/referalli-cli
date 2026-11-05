import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { printChecks, type Check } from './doctor.js';

const MAX_BYTES = 1024 * 1024;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next']);
const LOCKFILE = /\.(lock|lockb)$|^(pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json|go\.sum)$/;
const NO_DATE = 'no removal date set';
const PUBLISHED = new Set(['cli', 'express', 'mcp', 'next', 'react', 'react-native']);

const packageName = (old: string) => {
  const name = old.slice('@referally/'.length);
  if (name === 'sdk-js') return 'referalli';
  return PUBLISHED.has(name) ? `@referalli/${name}` : 'no published replacement';
};

// Dates come from docs: Renamed from Referally. Only the cookie twin has one; the rest are "until further notice".
const RULES: Array<{ re: RegExp; to: (old: string) => string; removal: string }> = [
  { re: /\w*REFERALLY_\w*/g, to: (o) => o.replace('REFERALLY_', 'REFERALLI_'), removal: NO_DATE },
  { re: /referally-version/gi, to: () => 'referalli-version', removal: NO_DATE },
  { re: /referally_ctx/g, to: () => 'referalli_ctx', removal: 'removal 2027-01-31' },
  { re: /x-referally-[\w-]*/gi, to: (o) => o.toLowerCase().replace('referally', 'referalli'), removal: NO_DATE },
  { re: /@referally\/[\w.-]*/g, to: packageName, removal: NO_DATE },
];

/** One warning per old name per line. Only the name is reported, never the line: it may be a .env value. */
function scanFile(path: string, text: string): Check[] {
  if (!/referally/i.test(text)) return [];
  return text.split('\n').flatMap((line, i) =>
    RULES.flatMap(({ re, to, removal }) =>
      [...new Set(line.match(re) ?? [])].map((old): Check => ({
        id: `${path}:${i + 1}`,
        status: 'warn',
        message: `${old} → ${to(old)} (${removal})`,
      })),
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
  printChecks(out, hits.length ? hits : [{ id: 'names', status: 'ok', message: 'no old Referally names found' }], opts.json);
  err(`Scanned ${files} file(s), ${hits.length} old name(s); skipped ${skipped} (over 1 MB, binary or unreadable).`);
  return opts.strict && hits.length ? 1 : 0;
}
