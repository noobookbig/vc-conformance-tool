/**
 * MAS-296 screenshot config — runs ONLY the screenshot spec against
 * the externally-managed Vite dev server on :5173. Reuses the puppeteer
 * Chrome at the standard puppeteer cache path so we don't need a
 * Playwright-managed browser install.
 */
import { defineConfig } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PUPPETEER_CHROME =
  process.env.PLAYWRIGHT_CHROME ??
  '/home/big/.cache/puppeteer/chrome/linux-149.0.7827.22/chrome-linux64/chrome';

export default defineConfig({
  testDir: path.resolve(__dirname, 'test/e2e'),
  testMatch: /mas-296-screenshots\.spec\.ts$/,
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'off',
    screenshot: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        viewport: { width: 1440, height: 900 },
        launchOptions: {
          executablePath: PUPPETEER_CHROME,
          args: ['--no-sandbox', '--disable-setuid-sandbox'],
        },
      },
      testMatch: /mas-296-screenshots\.spec\.ts$/,
    },
  ],
});
