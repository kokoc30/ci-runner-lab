import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests', testMatch: 'ui.spec.js', workers: 1,
  outputDir: '.ci-runner-lab/ui-results', reporter: 'list',
  use: { browserName: 'chromium', headless: true }, timeout: 30000
});
