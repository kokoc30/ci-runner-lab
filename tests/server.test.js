import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { startServer } from '../src/server.js';
import { createReport } from '../src/report.js';
import { spawn } from 'node:child_process';

async function setup(t, options = {}) {
  await mkdir('.ci-runner-lab', { recursive: true });
  const root = await mkdtemp(path.resolve('.ci-runner-lab/web-test-'));
  const app = await startServer({ outputRoot: path.join(root, 'reports'), ...options });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); });
  const response = await fetch(app.url), html = await response.text();
  const token = html.match(/name="session-token" content="([a-f0-9]{64})"/)[1];
  const request = (route, data = undefined, headers = {}) => fetch(app.url + route, {
    method: data === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, Origin: app.url, 'Content-Type': 'application/json', ...headers },
    body: data === undefined ? undefined : JSON.stringify(data)
  });
  return { root, app, request, response, html, token };
}
async function finished(request) {
  // Device collection permits two 15-second readiness probes, plus process cleanup.
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const state = await (await request('/api/state')).json();
    if (state.job?.status !== 'running') return state;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Task did not finish within 45 seconds.');
}
/** @param {string} root @param {Record<string, string>} [scripts] */
async function fixture(root, scripts = { ok: 'node -e "require(\'fs\').writeFileSync(\'ran\',\'yes\')"' }) {
  const target = path.join(root, 'trusted project'); await mkdir(target);
  await writeFile(path.join(target, 'package.json'), JSON.stringify({ scripts })); return target;
}

test('server binds only IPv4 loopback, serves a tight CSP and controlled assets', async t => {
  const { app, response, request, html } = await setup(t);
  assert.match(app.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
  assert.doesNotMatch(response.headers.get('content-security-policy'), /unsafe-inline/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.doesNotMatch(html, /<script[^>]*>[^<]+<\/script>/);
  for (const asset of ['/app.js', '/app.css', '/report.css']) assert.equal((await request(asset)).status, 200);
  for (const route of ['/src/server.js', '/package.json', '/.env', '/api/state?token=x', '/reports/../../package.json', '/reports/%2e%2e%2fpackage.json']) assert.equal((await request(route)).status, 404, route);
});

test('rejects cross-origin, missing token, wrong token, missing Origin and non-JSON mutations', async t => {
  const { app, request, token } = await setup(t);
  assert.equal((await fetch(app.url + '/api/state')).status, 403);
  for (const headers of [{ Origin: 'https://evil.test' }, { Origin: 'null' }, { Authorization: 'Bearer wrong' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Content-Type': 'text/plain' }]) {
    assert.ok([403, 415].includes((await request('/api/start', { action: 'demo' }, headers)).status));
  }
  assert.equal((await fetch(app.url + '/api/start', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{"action":"demo"}' })).status, 403);
  assert.equal((await request('/api/state')).status, 200);
});

test('rejects DNS rebinding Host even on otherwise valid requests', async t => {
  const { app } = await setup(t);
  for (const host of ['evil.test', 'localhost', '127.0.0.1', '127.0.0.1:1']) {
    const status = await new Promise((resolve, reject) => {
      http.get(app.url, { headers: { Host: host } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject);
    });
    assert.equal(status, 403);
  }
});

test('rejects oversized, malformed, unrecognized and shell-shaped requests without starting work', async t => {
  const { app, request, token } = await setup(t);
  for (const data of [{ action: 'exec', command: 'whoami' }, { action: 'audit', repo: 'a/b;whoami' }, { action: 'audit', repo: 'a/b', runs: 51 }, { action: 'demo', out: '../../outside' }, { action: 'bench', script: 'ok', consent: true }, null]) assert.ok((await request('/api/start', data)).status >= 400);
  assert.equal((await request('/api/start', { action: 'demo', huge: 'x'.repeat(33000) })).status, 413);
  assert.equal((await fetch(app.url + '/api/start', { method: 'POST', headers: { Origin: app.url, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{' })).status, 400);
  assert.equal((await (await request('/api/state')).json()).job, null);
});

test('demo task returns real schema companions; download paths cannot select arbitrary files', async t => {
  const { request } = await setup(t);
  assert.equal((await request('/api/start', { action: 'demo' })).status, 202);
  const state = await finished(request); assert.equal(state.job.status, 'complete');
  const { report, base } = await (await request(`/api/reports/${state.job.reportId}`)).json();
  assert.equal(report.schemaVersion, 1); assert.equal(report.toolVersion, '0.2.0'); assert.equal(report.mode, 'demo');
  const html = await request(base + '.html'); assert.match(await html.text(), /SYNTHETIC DEMO/);
  assert.match(html.headers.get('content-security-policy'), /script-src 'none'/);
  assert.deepEqual(await (await request(base + '.json')).json(), report);
  assert.match(await (await request(base + '.md')).text(), /SYNTHETIC DEMO/);
  assert.equal((await request(base + '.js')).status, 404);
  assert.equal((await request('/reports/00000000-0000-0000-0000-000000000000/report.html')).status, 404);
});

test('local workflow audit is read-only and script discovery does not execute code', async t => {
  const { root, request } = await setup(t); const target = await fixture(root);
  await mkdir(path.join(target, '.github', 'workflows'), { recursive: true });
  await writeFile(path.join(target, '.github', 'workflows', 'ci.yml'), 'name: Local\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps: []\n');
  assert.equal((await request('/api/scripts', { path: target })).status, 200);
  await request('/api/start', { action: 'local', path: target }); const state = await finished(request);
  const result = await (await request(`/api/reports/${state.job.reportId}`)).json();
  assert.equal(result.report.workflows.length, 1); await assert.rejects(access(path.join(target, 'ran')));
});

test('benchmark refuses missing consent, consumes approval once and runs only reviewed script', async t => {
  const { root, request } = await setup(t); const target = await fixture(root);
  const preview = await (await request('/api/prepare', { path: target, script: 'ok', warmups: 0, repetitions: 1 })).json();
  assert.equal(preview.commands[0].name, 'ok');
  assert.equal((await request('/api/start', { action: 'bench', preparation: preview.id, consent: false })).status, 403);
  await assert.rejects(access(path.join(target, 'ran')));
  assert.equal((await request('/api/start', { action: 'bench', preparation: preview.id, consent: true, script: 'unapproved' })).status, 400);
  assert.equal((await request('/api/start', { action: 'bench', preparation: preview.id, consent: true })).status, 202);
  const state = await finished(request); assert.equal(state.job.status, 'complete');
  assert.equal(await readFile(path.join(target, 'ran'), 'utf8'), 'yes');
  assert.equal((await request('/api/start', { action: 'bench', preparation: preview.id, consent: true })).status, 403);
});

test('changed package and explicitly discarded preparation cannot execute', async t => {
  const { root, request } = await setup(t); const target = await fixture(root);
  const preview = await (await request('/api/prepare', { path: target, script: 'ok' })).json();
  await writeFile(path.join(target, 'package.json'), JSON.stringify({ scripts: { ok: 'node -e "process.exit(0)"' } }));
  await request('/api/start', { action: 'bench', preparation: preview.id, consent: true });
  const state = await finished(request); assert.equal(state.job.status, 'error'); assert.match(state.job.message, /changed/);
  await assert.rejects(access(path.join(target, 'ran')));
  const second = await (await request('/api/prepare', { path: target, script: 'ok' })).json();
  await request('/api/discard', {});
  assert.equal((await request('/api/start', { action: 'bench', preparation: second.id, consent: true })).status, 403);
});

test('cancel interrupts a running benchmark and reaps the owned process', async t => {
  const { root, request } = await setup(t); const target = await fixture(root, { wait: 'node wait.cjs' });
  await writeFile(path.join(target, 'wait.cjs'), "require('fs').writeFileSync('pid', String(process.pid));setInterval(()=>{},1000)");
  const preview = await (await request('/api/prepare', { path: target, script: 'wait', warmups: 0, repetitions: 1 })).json();
  const started = await (await request('/api/start', { action: 'bench', preparation: preview.id, consent: true })).json();
  let pid;
  for (let i = 0; i < 150; i++) { try { pid = Number(await readFile(path.join(target, 'pid'), 'utf8')); break; } catch { await new Promise(r => setTimeout(r, 50)); } }
  assert.ok(pid); assert.equal((await request('/api/start', { action: 'demo' })).status, 409);
  assert.equal((await request('/api/cancel', { id: 'wrong' })).status, 409);
  await request('/api/cancel', { id: started.job.id });
  const state = await finished(request); assert.equal(state.job.status, 'interrupted');
  assert.throws(() => process.kill(pid, 0));
});

test('comparison accepts validated uploads, preserves warnings and escapes hostile metadata in report', async t => {
  const { request } = await setup(t); const report = createReport('audit', { kind: 'local', label: '<script>alert(1)</script>', private: true, revision: null });
  assert.equal((await request('/api/import', { schemaVersion: 42 })).status, 400);
  const imported = await (await request('/api/import', report)).json();
  await request('/api/start', { action: 'compare', before: imported.id, after: imported.id });
  const state = await finished(request), result = await (await request(`/api/reports/${state.job.reportId}`)).json();
  assert.ok(result.report.comparison.warnings.length); assert.equal(result.report.source.private, true);
  const html = await (await request(result.base + '.html')).text(); assert.doesNotMatch(html, /<script>/); assert.match(html, /&lt;script&gt;/);
});

test('errors redact credentials and session secret never appears in job status', async t => {
  const { request, token } = await setup(t, { executeTask: async () => { throw new Error('token=secret-value ghp_abcdef123'); } });
  await request('/api/start', { action: 'demo' }); const state = await finished(request);
  assert.equal(state.job.status, 'error'); assert.doesNotMatch(state.job.message, /secret-value|ghp_/);
  assert.ok(!JSON.stringify(state).includes(token));
});

test('explicit CLI ui starts and SIGTERM shuts the server down', { skip: process.platform === 'win32' }, async () => {
  const child = spawn(process.execPath, ['src/cli.js', 'ui', '--no-open'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let output = '';
  const ready = new Promise((resolve, reject) => {
    child.stderr.on('data', bytes => { output += bytes.toString(); if (/http:\/\/127\.0\.0\.1:\d+/.test(output)) resolve(output.match(/http:\/\/127\.0\.0\.1:\d+/)[0]); });
    child.on('error', reject); child.on('exit', code => { if (code) reject(new Error(output)); });
  });
  try { const url = await ready; assert.equal((await fetch(String(url))).status, 200); }
  finally { const closed = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); assert.equal(await closed, 0); }
});

test('benchmark review includes lifecycle hooks and refuses an incomplete command preview', async t => {
  const { root, request } = await setup(t);
  const target = await fixture(root, { preok: 'echo before', ok: 'echo during', postok: 'echo after', long: 'x'.repeat(1001) });
  const preview = await (await request('/api/prepare', { path: target, script: 'ok' })).json();
  assert.deepEqual(preview.commands.map(c => c.name), ['preok', 'ok', 'postok']);
  const refused = await request('/api/prepare', { path: target, script: 'long' });
  assert.equal(refused.status, 400); assert.match((await refused.json()).error, /complete browser preview/);
});

test('published demo is synthetic, script-free and contains no local API or private paths', async () => {
  const html = await readFile('docs/index.html', 'utf8');
  assert.match(html, /SYNTHETIC DEMO/); assert.match(html, /script-src 'none'/);
  assert.doesNotMatch(html, /<script|127\.0\.0\.1|\/api\/|C:\\Users/i);
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  const demo = JSON.parse(await readFile('fixtures/demo.json', 'utf8'));
  assert.equal(createReport('demo').toolVersion, pkg.version); assert.equal(demo.toolVersion, pkg.version);
});
