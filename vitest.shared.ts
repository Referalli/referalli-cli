import { defineConfig, mergeConfig, type ViteUserConfig } from 'vitest/config';

/**
 * What every package's tests run with. The Mac they run on is shared by ~25
 * agents, so the cheap path is the default: two forked workers, each capped at
 * 1.5 GB of heap. CI (its own runner) may raise the worker count with
 * VITEST_MAX_FORKS.
 */
export const light = defineConfig({
  test: {
    pool: 'forks',
    poolOptions: {
      forks: { maxForks: Number(process.env.VITEST_MAX_FORKS ?? 2), minForks: 1, execArgv: ['--max-old-space-size=1536'] },
    },
  },
});

/** Suites that each clone a Postgres database (`createTestDb`): setup can wait on the template build. */
export const dbSuites = mergeConfig(light, defineConfig({ test: { hookTimeout: 60_000, testTimeout: 30_000 } }));

export const withLight = (config: ViteUserConfig) => mergeConfig(light, config);
export const withDb = (config: ViteUserConfig) => mergeConfig(dbSuites, config);
