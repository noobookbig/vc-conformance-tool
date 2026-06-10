import { defineConfig, devices } from '@playwright/test';

const PUPPETEER_CHROME =
  process.env.PLAYWRIGHT_CHROME ??
  '/home/big/.cache/puppeteer/chrome/linux-149.0.7827.22/chrome-linux64/chrome';

export default defineConfig({
  testDir: './test/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:8089',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        channel: undefined,
        viewport: { width: 1440, height: 900 },
        launchOptions: {
          executablePath: PUPPETEER_CHROME,
          args: ['--no-sandbox', '--disable-setuid-sandbox'],
        },
      },
      testMatch: /.*\.spec\.ts/,
    },
  ],
  webServer: {
    // Start the v2 server with the SPA mounted. The server picks up
    // `apps/conformance-v2/web/dist/` by default when present. Use a
    // dedicated port (8089) to avoid colliding with the v0.1.0
    // webapp on 8080. Absolute paths because Playwright runs with cwd
    // set to the web folder.
    command:
      'node --import tsx /home/big/Documents/vc-conformance-test/apps/conformance-v2/src/server.ts --port 8089 --catalog /tmp/v2-e2e-catalog --web-dist /home/big/Documents/vc-conformance-test/apps/conformance-v2/web/dist',
    url: 'http://127.0.0.1:8089/api/health',
    reuseExistingServer: false,
    timeout: 30_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
