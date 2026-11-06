import { test, expect } from '@playwright/test';
import { mkdir, mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import path from 'node:path';
import { startServer } from '../src/server.js';
import { createReport } from '../src/report.js';
import { analyze } from '../src/analysis.js';

let app, root;
test.beforeEach(async () => {
  await mkdir('.ci-runner-lab/qa', { recursive: true });
  root = await mkdtemp(path.resolve('.ci-runner-lab/browser-test-'));
  app = await startServer({ outputRoot: path.join(root, 'reports') });
});
test.afterEach(async () => { await app.close(); await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); });
async function ready(page) { await expect(page.locator('#result')).toBeVisible({ timeout: 20000 }); }
async function noOverflow(page) { expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true); }

for (const width of [1440, 1024, 390]) for (const colorScheme of /** @type {const} */ (['light', 'dark'])) {
  test(`browser app ${width}px ${colorScheme}: first run, demo, report downloads and keyboard`, async ({ page, context }) => {
    const external = [], errors = [];
    page.on('request', r => { if (!r.url().startsWith(app.url)) external.push(r.url()); });
    page.on('pageerror', e => errors.push(e.message));
    await page.setViewportSize({ width, height: 1000 }); await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    await page.goto(app.url);
    await expect(page.getByRole('heading', { name: 'Understand your CI.' })).toBeVisible();
    await noOverflow(page);
    await page.screenshot({ path: `.ci-runner-lab/qa/app-start-${width}-${colorScheme}.png` });
    await page.keyboard.press('Tab'); await expect(page.getByRole('link', { name: 'Skip to workspace' })).toBeFocused();
    await page.keyboard.press('Enter'); await expect(page.locator('#workspace')).toBeFocused();
    await page.getByRole('button', { name: 'Try demo', exact: true }).click(); await ready(page);
    await expect(page.getByText('Demo · Synthetic data', { exact: true })).toBeVisible();
    await expect(page.locator('.headline-metric strong')).toHaveText('163.00 s');
    await noOverflow(page);
    await page.screenshot({ path: `.ci-runner-lab/qa/app-demo-${width}-${colorScheme}.png` });
    const popup = context.waitForEvent('page'); await page.getByRole('link', { name: 'Open complete report' }).click();
    const report = await popup; await report.waitForLoadState();
    await expect(report.getByText('SYNTHETIC DEMO', { exact: true })).toBeVisible();
    expect(await report.locator('script').count()).toBe(0); await report.close();
    const download = page.waitForEvent('download'); await page.getByRole('link', { name: 'Download JSON' }).click();
    expect((await download).suggestedFilename()).toBe('report.json');
    await page.getByRole('button', { name: 'Compare', exact: true }).click();
    await page.getByRole('button', { name: 'Compare reports', exact: true }).click(); await ready(page);
    await expect(page.getByText('Before and after.', { exact: true })).toBeVisible();
    await expect(page.getByText('Comparison context', { exact: true })).toBeVisible();
    expect(errors).toEqual([]); expect(external).toEqual([]);
  });
}

test('benchmark consent refusal, acceptance and cancellation use real owned scripts', async ({ page }) => {
  const target = path.join(root, 'trusted fixture'); await mkdir(target);
  await writeFile(path.join(target, 'package.json'), JSON.stringify({ scripts: { ok: 'node ok.cjs', wait: 'node wait.cjs' } }));
  await writeFile(path.join(target, 'ok.cjs'), "require('fs').writeFileSync('ran','yes')");
  await writeFile(path.join(target, 'wait.cjs'), "require('fs').writeFileSync('waiting','yes');setInterval(()=>{},1000)");
  await page.goto(app.url); await page.getByRole('button', { name: 'Benchmark', exact: true }).click();
  await page.getByLabel('Trusted project directory', { exact: true }).fill(target);
  await page.getByRole('button', { name: 'Load scripts' }).click(); await page.getByLabel('npm script', { exact: true }).selectOption('ok');
  await page.locator('#bench-form summary').click();
  await page.getByLabel('Warm-ups', { exact: true }).fill('0'); await page.getByLabel('Measured runs', { exact: true }).fill('1');
  await page.getByRole('button', { name: 'Review benchmark' }).click();
  await expect(page.getByRole('dialog')).toContainText('This is not a sandbox.');
  await expect(page.getByRole('button', { name: 'Run benchmark', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Do not run' }).click(); await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.locator('#session-status')).toHaveText('Benchmark declined. Nothing executed.');
  await expect(access(path.join(target, 'ran'))).rejects.toThrow();
  await page.getByRole('button', { name: 'Review benchmark' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByLabel('I trust this project and allow this run.').check();
  await page.getByRole('button', { name: 'Run benchmark', exact: true }).click(); await ready(page);
  expect(await readFile(path.join(target, 'ran'), 'utf8')).toBe('yes');
  await expect(page.locator('.headline-metric strong')).not.toHaveText('Unknown');
  await page.getByRole('button', { name: 'Benchmark', exact: true }).click();
  await page.getByLabel('npm script', { exact: true }).selectOption('wait');
  await page.getByRole('button', { name: 'Review benchmark' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByLabel('I trust this project and allow this run.').check(); await page.getByRole('button', { name: 'Run benchmark', exact: true }).click();
  await expect.poll(async () => { try { await access(path.join(target, 'waiting')); return true; } catch { return false; } }).toBe(true);
  await page.getByRole('button', { name: 'Stop task' }).click(); await ready(page);
  await expect(page.locator('#result')).toContainText('Stopped.');
  await expect(page.locator('.headline-metric strong')).toHaveText('Unknown');
});

test('device and local workflows are real; invalid repo gives an actionable error', async ({ page }) => {
  await page.goto(app.url); await page.getByLabel('GitHub repository').fill('bad;repo'); await page.getByRole('button', { name: 'Analyze', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('owner/repository');
  await page.getByRole('button', { name: 'My computer', exact: true }).click();
  await page.getByRole('button', { name: 'Check my computer' }).click(); await ready(page);
  await expect(page.getByRole('heading', { name: 'Your computer, at a glance.' })).toBeVisible();
  expect(Number(await page.locator('.headline-metric strong').textContent())).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'New analysis' }).click();
  await page.locator('.more summary').click(); await page.getByRole('button', { name: 'Inspect local workflows', exact: true }).click();
  await page.getByLabel('Project directory', { exact: true }).fill(path.resolve('.'));
  await page.getByRole('button', { name: 'Inspect workflows', exact: true }).click(); await ready(page);
  await expect(page.locator('#result')).toContainText('Static inspection does not measure workflow speed.');
});

test('uploaded JSON comparisons escape metadata and reject invalid reports', async ({ page }) => {
  await page.goto(app.url); await page.getByRole('button', { name: 'Compare', exact: true }).click();
  await page.locator('#before-file').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{"schemaVersion":99}') });
  await expect(page.getByRole('alert')).toContainText('unsupported schemaVersion');
  const report = analyze(createReport('audit', { kind: 'local', label: '<img src=x onerror=alert(1)>', private: true, revision: null }));
  for (const id of ['before', 'after']) {
    await page.locator(`#${id}-file`).setInputFiles({ name: `${id}.json`, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(report)) });
    await expect(page.locator(`#${id}`)).not.toHaveValue('');
  }
  await page.getByRole('button', { name: 'Compare reports', exact: true }).click(); await ready(page);
  await expect(page.locator('.result-source')).toContainText('<img src=x');
  expect(await page.locator('#result img, #result script').count()).toBe(0);
  await expect(page.locator('#result')).toContainText('Private repository metadata.');
});

test('partial GitHub authentication state stays truthful and readable', async ({ page }) => {
  await app.close();
  app = await startServer({ outputRoot: path.join(root, 'partial'), executeTask: async () => {
    const report = analyze(createReport('audit')); report.status = 'partial'; report.coverage.excluded.push('GitHub authentication required; run gh auth login.');
    return { report, output: null };
  } });
  await page.goto(app.url); await page.getByLabel('GitHub repository').fill('example/repo');
  await page.getByRole('button', { name: 'Analyze', exact: true }).click(); await ready(page);
  await expect(page.locator('.result-warning')).toContainText('gh auth login');
  await expect(page.locator('.headline-metric strong')).toHaveText('—');
});

test('app respects reduced transparency, reduced motion and 320px reflow', async ({ page, context }) => {
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }, { name: 'prefers-reduced-transparency', value: 'reduce' }] });
  await page.setViewportSize({ width: 320, height: 900 }); await page.goto(app.url); await noOverflow(page);
  await page.locator('.task-switch').evaluate(el => { el.style.letterSpacing = '0.12em'; });
  await noOverflow(page);
  await page.screenshot({ path: '.ci-runner-lab/qa/app-320-reflow.png', fullPage: true });
  expect(await page.locator('.task-switch').evaluate(el => window.getComputedStyle(el).backdropFilter)).toBe('none');
  expect(await page.evaluate(() => window.getComputedStyle(document.body, '::before').animationName)).toBe('none');
  await page.getByRole('button', { name: 'Try demo', exact: true }).click(); await ready(page); await noOverflow(page);
});
