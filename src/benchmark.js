import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runProcess, childEnvironment, sanitize } from './process.js';
import { distribution } from './analysis.js';

export function benchmarkLimits(options = {}) {
  const limits = { warmups: Number(options.warmups ?? 1), repetitions: Number(options.repetitions ?? 3), timeout: Number(options.timeout ?? 120) };
  for (const [key, lo, hi] of [['warmups', 0, 2], ['repetitions', 1, 10], ['timeout', 1, 600]]) {
    if (!Number.isInteger(limits[key]) || limits[key] < lo || limits[key] > hi) throw new Error(`${key} must be an integer from ${lo} to ${hi}.`);
  }
  return { ...limits, maximumSeconds: (limits.warmups + limits.repetitions) * limits.timeout };
}
/** Read script identity only. No script executes during preparation. */
export async function prepareBenchmark(target, script, options = {}) {
  if (typeof script !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:_.-]{0,99}$/.test(script)) throw new Error('Choose an ordinary existing npm script name.');
  const root = await realpath(target);
  const packageFile = path.join(root, 'package.json');
  if ((await stat(packageFile)).size > 1024 * 1024) throw new Error('package.json exceeds 1 MiB.');
  const text = await readFile(packageFile, 'utf8');
  const pkg = JSON.parse(text);
  if (!pkg.scripts || !Object.hasOwn(pkg.scripts, script) || typeof pkg.scripts[script] !== 'string') throw new Error(`Script ${script} does not exist in package.json.`);
  return { root, script, arguments: ['run', script], limits: benchmarkLimits(options),
    fingerprint: createHash('sha256').update(text).update('\0').update(script).digest('hex') };
}

/** Consent must precede every child process, including commit inspection. */
export async function benchmark(prepared, { allowExec = false, signal = undefined } = {}, execute = runProcess) {
  if (!allowExec) throw new Error('Execution denied. Review the script and pass --allow-exec, or confirm in the menu.');
  const environment = childEnvironment();
  let commit = null, dirty = null, packageTracked = null;
  try { const r = await execute('git', ['rev-parse', 'HEAD'], { cwd: prepared.root, env: environment }); if (r.code === 0 && /^[0-9a-f]{40}$/i.test(r.stdout.trim())) commit = r.stdout.trim(); } catch { /* Unversioned is valid. */ }
  try { const r = await execute('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: prepared.root, env: environment }); if (r.code === 0 && !r.truncated) dirty = r.stdout.trim().length > 0; } catch { /* Unknown is explicit. */ }
  try { const r = await execute('git', ['ls-files', '--error-unmatch', '--', 'package.json'], { cwd: prepared.root, env: environment }); packageTracked = r.code === 0 && !r.truncated; } catch { /* Unknown is explicit. */ }
  const invocations = [];
  let status = 'passed';
  for (let i = 0; i < prepared.limits.warmups + prepared.limits.repetitions; i++) {
    if (signal?.aborted) { status = 'interrupted'; break; }
    let r;
    try { r = await execute('npm', prepared.arguments, { cwd: prepared.root, env: environment, signal,
      timeoutMs: prepared.limits.timeout * 1000, maxBytes: 256 * 1024 }); }
    catch (e) { r = { code: null, durationMs: 0, timedOut: false, interrupted: false, truncated: false, stderr: sanitize(e.message), stdout: '' }; }
    const passed = r.code === 0 && !r.timedOut && !r.interrupted && !r.truncated;
    invocations.push({ phase: i < prepared.limits.warmups ? 'warmup' : 'measured', durationMs: r.durationMs, exitCode: r.code,
      timedOut: r.timedOut, interrupted: r.interrupted, outputLimitExceeded: r.truncated,
      failureExcerpt: passed ? null : sanitize(r.stderr || r.stdout, true) });
    if (!passed) { status = r.interrupted ? 'interrupted' : 'failed'; break; }
  }
  return { script: prepared.script, arguments: prepared.arguments, fingerprint: prepared.fingerprint, commit, dirty, packageTracked,
    limits: prepared.limits, invocations, status,
    summary: distribution(status === 'passed' ? invocations.filter(i => i.phase === 'measured').map(i => i.durationMs) : []),
    limitations: ['Elapsed time only; no measured tree RAM, CPU utilization or power.',
      'Fingerprint covers package.json and script name; source changes outside a clean commit may remain uncharacterized.',
      'npm runs the trusted script and lifecycle hooks with normal user permissions; files/network are accessible.',
      'Known GitHub/npm auth variables are removed. This is not a sandbox; credentials may be accessible elsewhere.',
      'Only owned process trees are terminated. Detached/adversarial processes are outside the cleanup guarantee.'] };
}
