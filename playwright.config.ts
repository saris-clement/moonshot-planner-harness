import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  use: {
    channel: 'chrome',
    headless: true,
    viewport: { width: 1440, height: 1000 },
  },
});
