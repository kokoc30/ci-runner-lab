import { test, expect } from '@playwright/test';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createReport, htmlReport } from '../src/report.js';
import { analyze } from '../src/analysis.js';
let demo;
test.beforeAll(async()=>{
  await mkdir('.ci-runner-lab/qa',{recursive:true});
  const result=execFileSync(process.execPath,['src/cli.js','demo','--no-open','--json'],{encoding:'utf8'});demo=JSON.parse(result);
  await writeFile('.ci-runner-lab/qa/demo.html',await htmlReport(demo));
});
for(const width of [390,1440])test(`offline report at ${width}px: layout, labels, keyboard and print`,async({page,context})=>{
  const external=[];page.on('request',r=>{if(/^https?:/.test(r.url()))external.push(r.url());});
  await context.setOffline(true);await page.setViewportSize({width,height:950});
  await page.goto(pathToFileURL(path.resolve('.ci-runner-lab/qa/demo.html')).href);
  await expect(page.getByText('SYNTHETIC DEMO',{exact:true})).toBeVisible();
  await expect(page.getByRole('heading',{name:'CI performance',exact:true})).toBeVisible();
  expect(await page.locator('script').count()).toBe(0);expect(external).toEqual([]);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.screenshot({path:`.ci-runner-lab/qa/overview-${width}.png`});
  await page.keyboard.press('Tab');await expect(page.getByRole('link',{name:'Skip to report'})).toBeFocused();
  const details=page.getByText('Evidence and next action',{exact:true}).first();await details.focus();await page.keyboard.press('Enter');await expect(details.locator('..')).toHaveAttribute('open','');
  await page.screenshot({path:`.ci-runner-lab/qa/demo-${width}.png`,fullPage:true});
  await page.emulateMedia({media:'print'});await expect(page.getByRole('navigation')).toBeHidden();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
});
test('malicious metadata stays inert; private partial empty report is readable',async({page})=>{
  const r=analyze(createReport('audit',{kind:'github',label:'<img src="https://evil.test/x" onerror="window.pwned=1">',private:true,revision:null}));
  r.status='partial';r.coverage.excluded=['<script>window.pwned=1</script>'];
  const requests=[];page.on('request',x=>{if(/^https?:/.test(x.url()))requests.push(x.url());});
  await page.setContent(await htmlReport(r));await expect(page.getByText('PRIVATE METADATA',{exact:true})).toBeVisible();
  await expect(page.getByText('PARTIAL',{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>window['pwned'])).toBeUndefined();expect(requests).toEqual([]);expect(await page.locator('img,script').count()).toBe(0);
  await expect(page.getByText('No run timings collected.',{exact:false})).toBeVisible();
});
test('demo files use no external assets or scripts',async()=>{const css=await readFile('src/report.css','utf8');expect(css).not.toMatch(/@import|url\(/);expect(await htmlReport(demo)).toContain('script-src');});
