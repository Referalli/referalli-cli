#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { runCli } from '../src/index.js';

const controller = new AbortController();
// The first Ctrl-C stops a running command cleanly (listeners are closed); a second one exits at once.
process.on('SIGINT', () => {
  if (controller.signal.aborted) process.exit(130);
  controller.abort();
});

const openBrowser = (url: string): boolean => {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
    return true;
  } catch {
    return false;
  }
};

const code = await runCli(process.argv.slice(2), {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  env: process.env,
  sleep: (ms) =>
    new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      controller.signal.addEventListener('abort', () => {
        clearTimeout(t);
        resolve();
      });
    }),
  openBrowser,
  signal: controller.signal,
});
process.exit(code);
