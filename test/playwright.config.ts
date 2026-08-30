import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  outputDir: '../build/test-results',
  reporter: [['html', { outputFolder: '../build/playwright-report' }]],
  timeout: 60000,
  use: {
    trace: 'on-first-retry',
  },
  // No webServer needed - e2e tests use production build with file:// URLs
});
