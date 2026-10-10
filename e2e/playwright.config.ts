import { defineConfig, devices } from '@playwright/test';

// See scripts/pw-env.sh: in the cloud container we must use the preinstalled Chromium.
const executablePath = process.env.BUTTPAD_CHROMIUM || undefined;

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  outputDir: '../test-results',
  timeout: 30_000,
  fullyParallel: true,
  reporter: [['list']],
  use: {
    launchOptions: { executablePath },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'phone', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium', launchOptions: { executablePath } } },
    { name: 'desktop', use: { ...devices['Desktop Chrome'], launchOptions: { executablePath } } },
  ],
});
