import { defineConfig, devices } from '@playwright/test';

// See scripts/pw-env.sh: in the cloud container we must use the preinstalled Chromium.
const executablePath = process.env.BUTTPAD_CHROMIUM || undefined;
/**
 * The web app served alone (demo backend); host specs start their own hosts on free ports.
 * BUTTPAD_WEB_PORT / BUTTPAD_PW_OUT let two runs on one machine stay out of each other's way.
 */
const WEB_PORT = Number(process.env.BUTTPAD_WEB_PORT) || 19310;

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  outputDir: process.env.BUTTPAD_PW_OUT || '../test-results',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  reporter: [['list']],
  webServer: {
    command: `bun serve-web.ts ${WEB_PORT}`,
    url: `http://127.0.0.1:${WEB_PORT}/api/health`,
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore',
    stderr: 'pipe',
  },
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    launchOptions: { executablePath },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'phone', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium', launchOptions: { executablePath } } },
    { name: 'desktop', use: { ...devices['Desktop Chrome'], launchOptions: { executablePath } } },
  ],
});
