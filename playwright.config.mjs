import { defineConfig } from '@playwright/test';

const browserChannel = process.env.PLAYWRIGHT_CHANNEL
  || (process.platform === 'win32' ? 'msedge' : '');

export default defineConfig({
  testDir: './test/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [['line']],
  use: {
    headless: true,
    ...(browserChannel ? { channel: browserChannel } : {}),
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'off',
  },
});
