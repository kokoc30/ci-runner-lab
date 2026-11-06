import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import open from 'open';
import { runTask } from './tasks.js';
import { prepareBenchmark } from './benchmark.js';
import { validateReport } from './report.js';
import { validateRepo } from './github.js';
import { sanitize } from './process.js';

const uiCsp = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const assets = { '/app.js': ['app.js', 'text/javascript'], '/app.css': ['app.css', 'text/css'], '/report.css': ['report.css', 'text/css'] };
const fail = (status, message) => Object.assign(new Error(message), { status });
function fields(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) throw fail(400, 'Unsupported request fields.');
}
function text(value, label, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f]/.test(value)) throw fail(400, `Enter a valid ${label}.`);
  return value.trim();
}
function localPath(value) { return path.resolve(text(value, 'project directory', 4096)); }
async function body(req, limit = 32 * 1024) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) throw fail(415, 'Use application/json.');
  if (Number(req.headers['content-length']) > limit) throw fail(413, 'Request exceeds the size limit.');
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw fail(413, 'Request exceeds the size limit.'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail(400, 'Invalid JSON.'); }
}
async function projectScripts(target) {
  const root = await realpath(target), file = path.join(root, 'package.json');
  if ((await stat(file)).size > 1024 * 1024) throw fail(400, 'package.json exceeds 1 MiB.');
  const pkg = JSON.parse(await readFile(file, 'utf8'));
  const scripts = Object.entries(pkg.scripts ?? {}).filter(([name, command]) => /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,99}$/.test(name) && typeof command === 'string');
  if (!scripts.length) throw fail(400, 'No supported npm scripts in this project.');
  if (scripts.length > 200) throw fail(400, 'Too many npm scripts (maximum 200).');
  return { root, scripts: Object.fromEntries(scripts) };
}

/** The local browser is a privilege boundary: strict authority, origin and a session secret.
 * Only registered assets/reports are served; paths never come from a download request. */
export async function startServer({ outputRoot = path.resolve('.ci-runner-lab/reports'), executeTask = runTask } = {}) {
  const token = randomBytes(32).toString('hex');
  const saved = new Map();
  let origin = '', host = '', job = null, pending = null, active = Promise.resolve(), closing = false;
  let posts = 0;
  const register = (report, output = null) => {
    const id = randomUUID();
    saved.set(id, { report, output });
    if (saved.size > 30) saved.delete(saved.keys().next().value);
    return id;
  };
  const publicJob = () => job ? { id: job.id, action: job.action, status: job.status, message: job.message, reportId: job.reportId ?? null } : null;
  const send = (res, code, value, type = 'application/json') => {
    res.writeHead(code, { 'Content-Type': `${type}; charset=utf-8` });
    res.end(type === 'application/json' ? JSON.stringify(value) : value);
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', uiCsp);
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    let ownsPost = false;
    try {
      if (req.headers.host !== host || (req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site') throw fail(403, 'This app accepts same-origin localhost requests only.');
      const route = req.url;
      if (req.method === 'GET' && route === '/') {
        const html = (await readFile(new URL('./app.html', import.meta.url), 'utf8')).replace('__SESSION_TOKEN__', token);
        return send(res, 200, html, 'text/html');
      }
      if (req.method === 'GET' && Object.hasOwn(assets, route)) {
        const [file, type] = assets[route];
        return send(res, 200, await readFile(new URL(file, import.meta.url), 'utf8'), type);
      }
      const download = /^\/reports\/([0-9a-f-]{36})\/report\.(html|md|json)$/.exec(route);
      if (req.method === 'GET' && download) {
        const entry = saved.get(download[1]);
        if (!entry?.output) throw fail(404, 'Report not found in this session.');
        const file = path.join(path.dirname(entry.output), `report.${download[2]}`);
        // Reject replacement symlinks as well as traversal; serving is limited to our published files.
        if (await realpath(file) !== file) throw fail(403, 'Report path changed.');
        res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'none'; script-src 'none'; frame-ancestors 'none'");
        if (download[2] !== 'html') res.setHeader('Content-Disposition', `attachment; filename="report.${download[2]}"`);
        return send(res, 200, await readFile(file, 'utf8'), download[2] === 'html' ? 'text/html' : 'text/plain');
      }
      if (!route?.startsWith('/api/')) throw fail(404, 'Not found.');
      if (req.headers.authorization !== `Bearer ${token}`) throw fail(403, 'Session expired. Reload this local app.');
      if (req.method === 'GET' && route === '/api/state') return send(res, 200, {
        job: publicJob(), reports: [...saved.entries()].map(([id, { report, output }]) => ({ id, label: report.source.label, mode: report.mode, generatedAt: report.generatedAt, downloadable: Boolean(output) }))
      });
      const result = /^\/api\/reports\/([0-9a-f-]{36})$/.exec(route);
      if (req.method === 'GET' && result) {
        const entry = saved.get(result[1]);
        if (!entry) throw fail(404, 'Report not found in this session.');
        return send(res, 200, { report: entry.report, output: entry.output, base: entry.output ? `/reports/${result[1]}/report` : null });
      }
      if (req.method === 'GET') throw fail(404, 'Not found.');
      if (req.method !== 'POST') throw fail(405, 'Method not allowed.');
      if (req.headers.origin !== origin) throw fail(403, 'A same-origin request is required.');
      if (closing) throw fail(503, 'The app is stopping.');
      if (posts >= 2) throw fail(429, 'Too many requests. Retry shortly.');
      posts++; ownsPost = true;
      const data = await body(req, route === '/api/import' ? 8 * 1024 * 1024 : 32 * 1024);
      if (route === '/api/cancel') {
        fields(data, ['id']);
        if (!job || job.id !== data.id || job.status !== 'running') throw fail(409, 'No matching task is running.');
        job.message = 'Stopping; waiting for owned processes to exit…'; job.controller.abort();
        return send(res, 200, { job: publicJob() });
      }
      if (job?.status === 'running') throw fail(409, 'Finish or stop the current task first.');
      if (route === '/api/import') {
        validateReport(data);
        return send(res, 201, { id: register(data) });
      }
      if (route === '/api/scripts') {
        fields(data, ['path']);
        const project = await projectScripts(localPath(data.path));
        return send(res, 200, { root: project.root, scripts: Object.keys(project.scripts) });
      }
      if (route === '/api/prepare') {
        fields(data, ['path', 'script', 'warmups', 'repetitions', 'timeout']);
        const prepared = await prepareBenchmark(localPath(data.path), text(data.script, 'script name', 100), data);
        const project = await projectScripts(prepared.root);
        const commands = [ `pre${prepared.script}`, prepared.script, `post${prepared.script}` ].filter(k => Object.hasOwn(project.scripts, k)).map(k => {
          if (project.scripts[k].length > 1000) throw fail(400, 'Script or lifecycle hook is too long for a complete browser preview. Review it and use the CLI.');
          return { name: k, command: sanitize(project.scripts[k]) };
        });
        pending = { id: randomUUID(), prepared, expires: Date.now() + 5 * 60 * 1000 };
        return send(res, 200, { id: pending.id, root: prepared.root, script: prepared.script, limits: prepared.limits,
          commands });
      }
      if (route === '/api/discard') { fields(data, []); pending = null; return send(res, 200, { discarded: true }); }
      if (route !== '/api/start') throw fail(404, 'Not found.');
      const action = data.action;
      const options = {}, context = { outputRoot, prepared: undefined, allowExec: false, comparison: undefined };
      let command = action;
      if (action === 'demo' || action === 'doctor') fields(data, ['action']);
      else if (action === 'audit') {
        fields(data, ['action', 'repo', 'runs', 'workflow', 'branch', 'event']);
        options['repo'] = validateRepo(data.repo);
        const runs = data.runs ?? 10;
        if (!Number.isInteger(runs) || runs < 1 || runs > 50) throw fail(400, 'Choose 1–50 runs.');
        options['runs'] = runs;
        for (const k of ['workflow', 'branch', 'event']) if (data[k]) options[k] = text(data[k], k);
      } else if (action === 'local') {
        fields(data, ['action', 'path']); command = 'audit'; options['path'] = localPath(data.path);
      } else if (action === 'bench') {
        fields(data, ['action', 'preparation', 'consent']);
        if (data.consent !== true || !pending || data.preparation !== pending.id || pending.expires < Date.now()) throw fail(403, 'Review this benchmark and explicitly consent to this run.');
        context.prepared = pending.prepared; context.allowExec = true; pending = null;
      } else if (action === 'compare') {
        fields(data, ['action', 'before', 'after']);
        const before = saved.get(data.before), after = saved.get(data.after);
        if (!before || !after) throw fail(400, 'Select two saved reports or import report.json files.');
        context.comparison = [before.report, after.report];
      } else throw fail(400, 'Unknown task.');
      const current = { id: randomUUID(), action, status: 'running', message: 'Starting…', controller: new AbortController(), reportId: null };
      job = current;
      active = (async () => {
        try {
          const result = await executeTask(command, options, { ...context, signal: current.controller.signal,
            onProgress: message => { if (!current.controller.signal.aborted) current.message = message; } });
          current.reportId = register(result.report, result.output);
          current.status = result.report.status;
          current.message = result.report.status === 'complete' ? 'Report ready.' : result.report.status === 'interrupted' ? 'Stopped. Collected evidence is saved.' : 'Report ready; review the limitations.';
        } catch (e) { current.status = 'error'; current.message = sanitize(e.message); }
      })();
      return send(res, 202, { job: publicJob() });
    } catch (e) { if (!res.headersSent) send(res, e.status ?? 400, { error: sanitize(e.message) }); else res.end(); }
    finally { if (ownsPost) posts--; }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(undefined)); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Local server did not bind.');
  host = `127.0.0.1:${address.port}`; origin = `http://${host}`;
  return { url: origin, close: async () => {
    closing = true; job?.controller.abort();
    const closed = new Promise(resolve => server.close(() => resolve(undefined)));
    server.closeAllConnections(); await active; await closed;
  } };
}

export async function launchUi({ openBrowser = true } = {}) {
  const app = await startServer();
  process.stderr.write(`CI Runner Lab: ${app.url}\nLocal only. Press Ctrl+C to stop.\n`);
  if (openBrowser) try { await open(app.url, { wait: false }); } catch { process.stderr.write('Open the local URL above in your browser.\n'); }
  await new Promise(resolve => {
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true; await app.close();
      process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); resolve(undefined);
    };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
  });
}
