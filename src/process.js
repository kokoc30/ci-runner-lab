import spawn from 'cross-spawn';

/** Remove common credentials; scripts still have normal user permissions. */
export function childEnvironment(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) =>
    !/^(GH_|GITHUB_|NPM_TOKEN$|NODE_AUTH_TOKEN$|NPM_CONFIG_.*(TOKEN|AUTH|PASSWORD))/i.test(key)));
}

/** Sanitize short diagnostics, never a full command log. */
export function sanitize(value) {
  return String(value).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, '[redacted]')
    .replace(/((?:token|password|authorization|secret)\s*[:=]\s*)\S+/gi, '$1[redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').slice(0, 1000);
}

/** Bounded argument-array spawning, with termination scoped to our owned PID tree.
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd?:string,env?:NodeJS.ProcessEnv,timeoutMs?:number,maxBytes?:number,signal?:AbortSignal}} [options]
 * @returns {Promise<{code:number|null,stdout:string,stderr:string,timedOut:boolean,interrupted:boolean,truncated:boolean,durationMs:number}>}
 */
export function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env,
      shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', bytes = 0, truncated = false, timedOut = false, interrupted = false;
    let cleanup = Promise.resolve(), stopping = false;
    const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
    const stop = () => {
      if (!child.pid || stopping) return;
      stopping = true;
      if (process.platform === 'win32') {
        cleanup = new Promise(done => {
          const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          killer.on('error', () => done()); killer.on('close', () => done());
        });
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ }
      }
    };
    const abort = () => { interrupted = true; stop(); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs ?? 15000);
    const collect = (chunk, error) => {
      bytes += chunk.length;
      const remaining = Math.max(0, maxBytes - Buffer.byteLength(stdout) - Buffer.byteLength(stderr));
      if (error) stderr += chunk.subarray(0, remaining).toString();
      else stdout += chunk.subarray(0, remaining).toString();
      if (bytes > maxBytes) { truncated = true; stop(); }
    };
    child.stdout.on('data', chunk => collect(chunk, false));
    child.stderr.on('data', chunk => collect(chunk, true));
    const finish = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); };
    child.on('error', error => { finish(); reject(error); });
    child.on('close', async code => { finish(); await cleanup;
      resolve({ code, stdout, stderr, timedOut, interrupted, truncated, durationMs: performance.now() - start });
    });
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
  });
}
