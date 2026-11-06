#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, appendFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import open from 'open';
import { validateRepo } from './github.js';
import { scenarioInputs } from './analysis.js';
import { prepareBenchmark, benchmarkLimits } from './benchmark.js';
import { runTask } from './tasks.js';
import { sanitize } from './process.js';

export const HELP = `CI Runner Lab — Understand your CI. Measure before changing it.

  npm start                                    Local browser app (terminal only)
  npm start -- ui --no-open                     Explicit local server
  npm run cli                                  Guided terminal menu
  npm start -- demo                             Offline synthetic demo
  npm start -- doctor                           Inspect this computer
  npm start -- audit --path "my-project"         Read local workflow YAML
  npm start -- audit --repo owner/repository --runs 10
  npm start -- audit --repo owner/repository --workflow ci.yml --runs 10
  npm start -- bench --path "my-project" --script test:ci --allow-exec
  npm start -- compare "before.json" "after.json"

Common: --out <directory>  --open / --no-open  --json  --help
Audit: --runs <1–50> (10)  --workflow <file>  --branch <name>  --event <event>
Bench: --warmups <0–2> (1)  --repetitions <1–10> (3)  --timeout <1–600 seconds> (120)
Costs: --monthly-runs <positive integer>  --power-watts <average watts>  --kwh-price <USD/kWh>

Audits are read-only. Benchmarks run trusted local scripts and lifecycle hooks.
Reports: .ci-runner-lab/reports/<unique run>/report.{html,md,json}
Exit: 0 success, 1 operational/partial failure, 2 invalid input, 130 interrupted.
`;

class InputError extends Error {}
export function argumentsFor(argv) {
  const opts = {};
  for (const key of ['out', 'path', 'repo', 'runs', 'workflow', 'branch', 'event', 'script', 'warmups', 'repetitions', 'timeout', 'monthly-runs', 'power-watts', 'kwh-price']) opts[key] = { type: 'string' };
  for (const key of ['open', 'no-open', 'json', 'help', 'allow-exec']) opts[key] = { type: 'boolean' };
  let parsed;
  try { parsed = parseArgs({ args: argv, options: opts, allowPositionals: true, strict: true }); } catch (e) { throw new InputError(e.message); }
  const { values: v, positionals: p } = parsed;
  const command = p[0];
  if (v.open && v['no-open']) throw new InputError('Choose --open or --no-open.');
  if (v.help) return { command: 'help', options: v, files: [] };
  if (command && !['demo', 'doctor', 'audit', 'bench', 'compare', 'ui', 'cli'].includes(command)) throw new InputError(`Unknown command: ${command}. Use --help.`);
  if (command === 'compare' ? p.length !== 3 : p.length > 1) throw new InputError('Compare needs two report.json paths; other commands take named options.');
  if (command === 'audit' && Boolean(v.path) === Boolean(v.repo)) throw new InputError('Audit needs exactly one of --path or --repo.');
  if (command === 'bench' && (!v.path || !v.script)) throw new InputError('Benchmark needs --path and --script.');
  try {
    if (v.repo) validateRepo(v.repo);
    if (v.runs !== undefined && (!Number.isInteger(Number(v.runs)) || Number(v.runs) < 1 || Number(v.runs) > 50)) throw new Error('--runs must be an integer from 1 to 50.');
    if (command === 'bench') benchmarkLimits(v);
    scenarioInputs({ monthlyRuns: v['monthly-runs'], powerWatts: v['power-watts'], kwhPrice: v['kwh-price'] });
  } catch (e) { throw new InputError(e.message); }
  return { command, options: v, files: p.slice(1) };
}

export const MENU = `\nCI Runner Lab
Understand your CI. Measure before changing it.

1. Try the demo — no GitHub login needed
2. Check this computer
3. Analyze a GitHub repository
4. Inspect local workflow files
5. Benchmark a trusted npm script — runs local code
6. Compare two saved reports
0. Exit
`;

/** Injectable prompt supports terminal EOF and deterministic guided-flow tests. */
export async function wizard(ask, show) {
  const cancelled = v => v === null || /^(back|cancel|q)$/i.test(v.trim()) || v.trim() === '';
  while (true) {
    show(MENU);
    const choice = await ask('Choose an option [1] (0 exits): ');
    if (choice === null || /^(0|q|cancel)$/i.test(choice.trim())) return null;
    const c = choice.trim() || '1';
    if (c === '1' || c === '2') return { command: c === '1' ? 'demo' : 'doctor', options: {}, files: [] };
    if (!['3', '4', '5', '6'].includes(c)) { show('Choose 0–6.'); continue; }
    const target = await ask(c === '3' ? 'GitHub owner/repository (back cancels): ' : c === '6' ? 'Before report.json path (back cancels): ' : 'Project directory (back cancels): ');
    if (target === null) return null;
    if (cancelled(target)) continue;
    if (c === '3') return argumentsFor(['audit', '--repo', target.trim()]);
    if (c === '4') return argumentsFor(['audit', '--path', target.trim()]);
    const second = await ask(c === '5' ? 'Trusted npm script [test] (back cancels): ' : 'After report.json path (back cancels): ');
    if (second === null) return null;
    if (/^(back|cancel|q)$/i.test(second.trim())) continue;
    return c === '5' ? argumentsFor(['bench', '--path', target.trim(), '--script', second.trim() || 'test']) : argumentsFor(['compare', target.trim(), second.trim()]);
  }
}

async function promptSession(callback) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  let closed = false; rl.on('close', () => { closed = true; });
  try { return await callback(async text => { if (closed) return null; try { return await rl.question(text); } catch { return null; } }); }
  finally { rl.close(); }
}

/** Real command path; stdout contains only normalized JSON with --json. */
export async function main(argv = process.argv.slice(2)) {
  const show = message => process.stderr.write(message + '\n');
  try {
    let parsed = argumentsFor(argv);
    const interactive = Boolean(process.stdin.isTTY && process.stderr.isTTY && !process.env.CI);
    if (!parsed.command) {
      if (!interactive) throw new InputError('Choose a command in noninteractive mode: npm start -- demo --no-open, or npm start -- ui --no-open for the local server.');
      parsed = { command: 'ui', options: parsed.options, files: [] };
    }
    if (parsed.command === 'cli') {
      if (!interactive) throw new InputError('The guided menu needs an interactive terminal; use an explicit command in noninteractive mode.');
      parsed = await promptSession(ask => wizard(ask, show));
      if (!parsed) return 0;
    }
    const { command, options: o, files } = parsed;
    if (command === 'ui') {
      if (Object.keys(o).some(k => !['open', 'no-open'].includes(k))) throw new InputError('The UI accepts only --open or --no-open.');
      const { launchUi } = await import('./server.js');
      await launchUi({ openBrowser: Boolean(o.open || (interactive && !o['no-open'])) });
      return 0;
    }
    const json = Boolean(o.json);
    if (command === 'help') { process.stdout.write(HELP); return 0; }
    const outputRoot = path.resolve(o.out ?? '.ci-runner-lab/reports');
    let prepared;
    if (command === 'bench') {
      try { prepared = await prepareBenchmark(o.path, o.script, o); } catch (e) { throw new InputError(e.message); }
      show(`\nBenchmark directory: ${prepared.root}\nCommand: npm run ${prepared.script}\nWarm-ups: ${prepared.limits.warmups}; measured runs: ${prepared.limits.repetitions}; timeout: ${prepared.limits.timeout}s each\nMaximum execution budget: ${prepared.limits.maximumSeconds}s (a limit, not a prediction).\nWARNING: npm scripts and lifecycle hooks can change files and access the network. No resource sandbox.`);
      let allowed = Boolean(o['allow-exec']);
      if (!allowed && interactive) allowed = await promptSession(async ask => /^y(es)?$/i.test((await ask('Run this trusted script? [y/N]: ')) ?? ''));
      if (!allowed) throw new InputError('Execution denied; review the script, then use --allow-exec or confirm in the menu.');
    }
    const controller = new AbortController(), interrupt = () => controller.abort();
    process.on('SIGINT', interrupt);
    let result;
    try { result = await runTask(command, o, { outputRoot, files, prepared, allowExec: Boolean(prepared), signal: controller.signal }); }
    catch (e) { if (command === 'compare') throw new InputError(e.message); throw e; }
    finally { process.removeListener('SIGINT', interrupt); }
    const { report: r, output } = result;
    show(`Report: ${output}`);
    if (json) process.stdout.write(JSON.stringify(r) + '\n');
    if (o.open || (interactive && !o['no-open'])) {
      try { await open(output, { wait: false }); } catch { show('Warning: browser could not open. Open the report path above.'); }
    }
    return r.status === 'interrupted' ? 130 : r.status === 'complete' ? 0 : 1;
  } catch (e) {
    const code = e instanceof InputError || ['ENOENT', 'ENOTDIR'].includes(e.code) ? 2 : 1;
    const message = sanitize(e.message);
    show(`CI Runner Lab: ${message}${code === 2 ? '\nUse npm start -- --help for usage.' : ''}`);
    try { await mkdir('.ci-runner-lab', { recursive: true }); await appendFile('.ci-runner-lab/diagnostics.txt', `${new Date().toISOString()} ${code}: ${message}\n`); } catch { /* Reporting must not mask the original error. */ }
    return code;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
