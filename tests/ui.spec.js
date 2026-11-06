import { test, expect } from '@playwright/test';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createReport, htmlReport, writeReport } from '../src/report.js';
import { analyze } from '../src/analysis.js';

let demo;
const reports = {};
function generate(name, args, expectedExit = 0) {
  const result = spawnSync(process.execPath, ['src/cli.js', ...args, '--no-open', '--json'], { encoding: 'utf8', timeout: 30000 });
  expect(result.status, result.stderr).toBe(expectedExit);
  const file = result.stderr.match(/Report: (.+)/)[1].trim();
  reports[name] = pathToFileURL(file).href;
  return { data: JSON.parse(result.stdout), file };
}
async function noOverflow(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

test.beforeAll(async () => {
  await mkdir('.ci-runner-lab/qa/benchmark-fixture', { recursive: true });
  const generated = generate('demo', ['demo']);
  demo = generated.data;
  const json = path.join(path.dirname(generated.file), 'report.json');
  generate('compare', ['compare', json, json]);
  generate('doctor', ['doctor']);
  // Only execute these test-owned, explicitly consented scripts, never repository scripts.
  await writeFile('.ci-runner-lab/qa/benchmark-fixture/package.json', JSON.stringify({
    scripts: { ok: 'node -e "process.exit(0)"', fail: 'node -e "console.error(\'test fixture failure\');process.exit(1)"' }
  }));
  for (const [script, status] of [['ok', 0], ['fail', 1]]) {
    const benchmark = generate(script, ['bench', '--path', '.ci-runner-lab/qa/benchmark-fixture', '--script', String(script), '--allow-exec', '--warmups', '0', '--repetitions', '1'], Number(status));
    if (script === 'ok') {
      const saved = path.join(path.dirname(benchmark.file), 'report.json');
      generate('compare-benchmark', ['compare', saved, saved]);
    }
  }
});

for (const width of [390, 1024, 1440]) {
  for (const colorScheme of /** @type {const} */ (['light', 'dark'])) {
    test(`offline report at ${width}px ${colorScheme}: layout, navigation, keyboard, print`, async ({ page, context }) => {
      const external = [], errors = [];
      page.on('request', r => { if (/^https?:/.test(r.url())) external.push(r.url()); });
      page.on('pageerror', e => errors.push(e.message));
      await context.setOffline(true);
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(reports.demo);
      await expect(page.getByText('SYNTHETIC DEMO', { exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'CI performance', exact: true })).toBeVisible();
      expect(await page.locator('script').count()).toBe(0);
      expect(external).toEqual([]);
      expect(errors).toEqual([]);
      await noOverflow(page);
      await page.screenshot({ path: `.ci-runner-lab/qa/overview-${width}-${colorScheme}.png` });
      await page.keyboard.press('Tab');
      await expect(page.getByRole('link', { name: 'Skip to report' })).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(page.locator('#overview')).toBeFocused();
      for (const name of ['Workflows', 'Benchmarks', 'Compare', 'Overview']) {
        const link = page.getByRole('navigation').getByRole('link', { name, exact: true });
        await link.click();
        await expect(page).toHaveURL(new RegExp(`#${name.toLowerCase()}$`));
        const target = page.locator(`#${name.toLowerCase()}`);
        expect((await target.boundingBox()).y).toBeGreaterThanOrEqual(90);
      }
      const summary = page.locator('#computer > summary');
      await summary.focus(); await page.keyboard.press('Enter');
      await expect(page.locator('#computer')).toHaveAttribute('open', '');
      await expect(page.getByText('Usable parallelism', { exact: true })).toBeVisible();
      await page.keyboard.press('Enter');
      await expect(page.locator('#computer')).not.toHaveAttribute('open', '');
      const details = page.getByText('Evidence and next action', { exact: true }).first();
      await details.focus(); await page.keyboard.press('Enter');
      await expect(details.locator('..')).toHaveAttribute('open', '');
      await page.screenshot({ path: `.ci-runner-lab/qa/workflows-${width}-${colorScheme}.png` });
      await page.screenshot({ path: `.ci-runner-lab/qa/full-${width}-${colorScheme}.png`, fullPage: true });
      await page.emulateMedia({ media: 'print' });
      await expect(page.getByRole('navigation')).toBeHidden();
      await noOverflow(page);
      // Chromium must print the content of closed native disclosures too.
      const inventory = page.getByText('Static workflow inventory (1)', { exact: true }).locator('..');
      expect(await inventory.evaluate(el => window.getComputedStyle(el, '::details-content').contentVisibility)).toBe('visible');
    });
  }
}

test('malicious metadata stays inert; private partial empty report is readable', async ({ page }) => {
  const r = analyze(createReport('audit', { kind: 'github', label: '<img src="https://evil.test/x" onerror="window.pwned=1">', private: true, revision: null }));
  r.status = 'partial'; r.coverage.excluded = ['<script>window.pwned=1</script>'];
  const file = await writeReport(r, '.ci-runner-lab/qa');
  const requests = []; page.on('request', x => { if (/^https?:/.test(x.url())) requests.push(x.url()); });
  await page.setViewportSize({ width: 390, height: 1000 });
  await page.goto(pathToFileURL(file).href);
  await expect(page.getByText('PRIVATE METADATA', { exact: true })).toBeVisible();
  await expect(page.getByText('PARTIAL', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window['pwned'])).toBeUndefined();
  expect(requests).toEqual([]); expect(await page.locator('img,script').count()).toBe(0);
  await expect(page.getByText('No run timings collected.', { exact: false })).toBeVisible();
  await expect(page.locator('#evidence > details')).toHaveAttribute('open', '');
  await noOverflow(page);
  await page.screenshot({ path: '.ci-runner-lab/qa/partial-mobile.png' });
});

test('generated benchmark, failed benchmark, device and comparison reports keep real evidence', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 1000 });
  for (const name of ['ok', 'fail', 'doctor', 'compare', 'compare-benchmark']) {
    await page.goto(reports[name]);
    await noOverflow(page);
    await page.screenshot({ path: `.ci-runner-lab/qa/${name}-mobile.png` });
    if (name === 'fail') {
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Measurement failed. Review the details.');
      await expect(page.locator('.headline-metric strong')).toHaveText('Unknown');
      await expect(page.getByText('test fixture failure', { exact: true })).toBeVisible();
      await expect(page.getByText('measured 1 · unsuccessful', { exact: true })).toBeVisible();
    } else if (name === 'ok') {
      await expect(page.locator('.headline-metric strong')).not.toHaveText('Unknown');
      await expect(page.getByText('Trusted npm benchmark · passed', { exact: true })).toBeVisible();
    } else if (name.startsWith('compare')) {
      await expect(page.getByText('After samples', { exact: true })).toBeVisible();
      await expect(page.locator('#compare')).toContainText('overlap');
      if (name === 'compare-benchmark') await expect(page.locator('.headline-metric strong')).not.toHaveText('Unknown');
    } else {
      await page.locator('#computer > summary').click();
      await expect(page.getByText('Usable parallelism', { exact: true })).toBeVisible();
    }
  }
});

test('reduced preferences, theme contrast, hover, and narrow reflow', async ({ page, context }) => {
  const cdp = await context.newCDPSession(page);
  for (const theme of ['light', 'dark']) {
    await cdp.send('Emulation.setEmulatedMedia', { features: [
      { name: 'prefers-color-scheme', value: theme },
      { name: 'prefers-reduced-motion', value: 'reduce' },
      { name: 'prefers-reduced-transparency', value: 'reduce' }
    ] });
    await page.goto(reports.demo);
    const styles = await page.evaluate(() => {
      const root = window.getComputedStyle(document.documentElement);
      return {
        animation: window.getComputedStyle(document.body, '::before').animationName,
        blur: window.getComputedStyle(document.querySelector('nav')).backdropFilter,
        colors: ['--ink', '--muted', '--paper', '--surface'].map(k => root.getPropertyValue(k).trim())
      };
    });
    expect(styles.animation).toBe('none'); expect(styles.blur).toBe('none');
    const luminance = hex => {
      const rgb = hex.replace('#', '').match(/../g).map(c => parseInt(c, 16) / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4);
      return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
    };
    for (const foreground of styles.colors.slice(0, 2)) for (const background of styles.colors.slice(2)) {
      const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
      expect((values[0] + .05) / (values[1] + .05)).toBeGreaterThanOrEqual(4.5);
    }
    const link = page.getByRole('navigation').getByRole('link', { name: 'Compare' });
    const before = await link.evaluate(el => window.getComputedStyle(el).backgroundColor);
    await link.hover();
    expect(await link.evaluate(el => window.getComputedStyle(el).backgroundColor)).not.toBe(before);
    await link.focus();
    expect(await link.evaluate(el => window.getComputedStyle(el).outlineStyle)).not.toBe('none');
  }
  await page.setViewportSize({ width: 320, height: 900 });
  await noOverflow(page);
  // A long untrusted repository label must wrap, including at narrow widths.
  const long = structuredClone(demo); long.source.label = 'repository-'.repeat(40);
  await page.setContent(await htmlReport(long));
  await noOverflow(page);
});

test('zero and missing durations remain distinct and finite', async ({ page }) => {
  const r = structuredClone(demo);
  r.metrics.groups.forEach(g => { g.span = { n: 1, minMs: 0, maxMs: 0, medianMs: 0 }; });
  await page.setContent(await htmlReport(r));
  await expect(page.locator('.headline-metric strong')).toHaveText('0.00 s');
  expect(await page.locator('style').textContent()).not.toMatch(/NaN|Infinity/);
  for (const el of await page.locator('[style]').all()) expect(await el.getAttribute('style')).not.toMatch(/NaN|Infinity/);
  r.metrics.groups.forEach(g => { g.span = { n: 0, minMs: null, maxMs: null, medianMs: null }; });
  await page.setContent(await htmlReport(r));
  await expect(page.locator('.headline-metric strong')).toHaveText('—');
});

test('ambient illumination finishes without continuous animation', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto(reports.demo);
  const duration = await page.evaluate(async () => {
    const animation = document.getAnimations().find(a => a['animationName'] === 'light-settle');
    const duration = animation?.effect?.getTiming().duration;
    await animation?.finished;
    return { duration, running: document.getAnimations().filter(a => a.playState === 'running').length };
  });
  expect(duration).toEqual({ duration: 4000, running: 0 });
});

test('demo uses no external assets or scripts and keeps the restrictive CSP', async () => {
  const css = await readFile('src/report.css', 'utf8');
  expect(css).not.toMatch(/@import|url\(/);
  const html = await htmlReport(demo);
  expect(html).toContain("default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'none'; script-src 'none'");
  expect(Buffer.byteLength(html)).toBeLessThan(100 * 1024);
});
