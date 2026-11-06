import { runProcess } from './process.js';
import { parseWorkflow, MAX_FILE_BYTES } from './workflows.js';

export const API_VERSION = '2026-03-10';
export function validateRepo(repo) {
  if (typeof repo !== 'string' || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]{1,100}$/.test(repo) || /\/(?:\.+)$/.test(repo)) {
    throw new Error('Use a GitHub.com repository in owner/repository form.');
  }
  return repo;
}

/** Classify operational errors without leaking command output or credentials. */
export function githubError(result) {
  if (result.timedOut) return 'GitHub request timed out; check your connection and retry.';
  if (result.truncated) return 'GitHub response exceeded the size limit.';
  const s = result.stderr ?? '';
  if (/429|rate.?limit/i.test(s)) return 'GitHub rate limit reached; retry after your quota resets.';
  if (/401|auth login|authentication|not logged/i.test(s)) return 'GitHub authentication required; run gh auth login.';
  if (/403/.test(s)) return 'GitHub denied access (403); check repository read permissions.';
  if (/404/.test(s)) return 'Repository or resource unavailable (404); check its name and your access.';
  return 'GitHub request failed; check your network and gh auth status.';
}

/** Serialized GET-only adapter. Injection keeps tests offline.
 * @param {string} repo
 * @param {{runs?:number,workflow?:string,branch?:string,event?:string}} [options]
 * @param {typeof runProcess} [execute]
 */
export async function inspectGithub(repo, options = {}, execute = runProcess) {
  validateRepo(repo);
  const requested = options.runs ?? 10;
  if (!Number.isInteger(requested) || requested < 1 || requested > 50) throw new Error('Runs must be an integer from 1 to 50.');
  for (const v of [options.workflow, options.branch, options.event]) if (v && (v.length > 200 || /[\x00-\x1f]/.test(v))) throw new Error('Invalid GitHub filter.');
  const source = { kind: 'github', label: repo, repo, private: null, revision: null, branch: null,
    url: `https://github.com/${repo}`, filters: { workflow: options.workflow ?? null, branch: options.branch ?? null, event: options.event ?? null } };
  const workflows = [], runs = [], excluded = [];
  let requests = 0, responseBytes = 0;
  const deadline = Date.now() + 90000;
  const get = async endpoint => {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (++requests > 140 || Date.now() >= deadline || responseBytes > 32 * 1024 * 1024) throw new Error('Audit safety cap or 90-second deadline reached.');
      let result;
      try { result = await execute('gh', ['api', '--hostname', 'github.com', '--method', 'GET',
        '-H', 'Accept: application/vnd.github+json', '-H', `X-GitHub-Api-Version: ${API_VERSION}`, endpoint],
      { timeoutMs: Math.min(12000, deadline - Date.now()), maxBytes: 4 * 1024 * 1024 }); }
      catch { throw new Error('GitHub CLI unavailable; install gh and run gh auth login.'); }
      responseBytes += Buffer.byteLength(result.stdout);
      if (result.code === 0 && !result.timedOut && !result.truncated) {
        try { return JSON.parse(result.stdout); } catch { throw new Error('GitHub returned an invalid JSON response.'); }
      }
      if (attempt === 0 && !result.timedOut && /HTTP 50[234]/.test(result.stderr)) {
        await new Promise(resolve => setTimeout(resolve, 250)); continue;
      }
      const e = new Error(githubError(result));
      // A missing workflow directory is a valid empty state; repository 404 is not.
      e.name = /404/.test(result.stderr) ? 'NotFound' : 'GitHubError';
      throw e;
    }
  };
  try {
    const meta = await get(`repos/${repo}`);
    source.private = typeof meta.private === 'boolean' ? meta.private : null;
    source.branch = meta.default_branch;
    if (typeof source.branch !== 'string') throw new Error('GitHub repository metadata is incomplete.');
    const commit = await get(`repos/${repo}/commits/${encodeURIComponent(source.branch)}`);
    if (!/^[a-f0-9]{40}$/i.test(commit.sha)) throw new Error('GitHub source revision is unavailable.');
    source.revision = commit.sha;
    try {
      const files = await get(`repos/${repo}/contents/.github/workflows?ref=${source.revision}`);
      if (!Array.isArray(files)) throw new Error('Workflow listing is not a directory.');
      const selected = files.filter(f => typeof f.name === 'string' && /\.ya?ml$/i.test(f.name));
      if (selected.length > 100) excluded.push('Workflow file count exceeds 100-file cap.');
      for (const f of selected.slice(0, 100)) {
        if (f.type !== 'file' || f.size > MAX_FILE_BYTES || !/^[^/\\]+\.ya?ml$/i.test(f.name)) { excluded.push('Unsupported or oversized workflow file.'); continue; }
        try {
          const file = await get(`repos/${repo}/contents/.github/workflows/${encodeURIComponent(f.name)}?ref=${source.revision}`);
          if (file.encoding !== 'base64' || typeof file.content !== 'string') throw new Error('Workflow content is unavailable.');
          workflows.push(parseWorkflow(Buffer.from(file.content, 'base64').toString('utf8'), f.name));
        } catch (e) { excluded.push(`${f.name}: ${e.message}`); }
      }
    } catch (e) { if (e.name !== 'NotFound') excluded.push(e.message); }
    const params = new URLSearchParams({ status: 'completed', per_page: '100' });
    if (options.branch) params.set('branch', options.branch);
    if (options.event) params.set('event', options.event);
    const prefix = options.workflow ? `actions/workflows/${encodeURIComponent(options.workflow)}/runs` : 'actions/runs';
    const seen = new Set();
    for (let page = 1; page <= 5 && runs.length < requested; page++) {
      const data = await get(`repos/${repo}/${prefix}?${params}&page=${page}`);
      if (!Array.isArray(data.workflow_runs)) throw new Error('Run listing is incomplete.');
      for (const raw of data.workflow_runs) {
        if (runs.length >= requested) break;
        if (raw.status !== 'completed' || seen.has(raw.id)) continue;
        seen.add(raw.id);
        const attempt = raw.run_attempt;
        if (!Number.isSafeInteger(raw.id) || !Number.isSafeInteger(attempt) || attempt < 1) throw new Error('Run identity/attempt is missing.');
        const run = { id: raw.id, attempt, workflow: String(raw.workflow_id ?? raw.path ?? raw.name), name: raw.name ?? 'Unnamed workflow',
          branch: raw.head_branch ?? 'unknown', event: raw.event ?? 'unknown', sha: raw.head_sha ?? null,
          conclusion: raw.conclusion ?? 'unknown', createdAt: raw.created_at ?? null, url: raw.html_url ?? null, jobs: [], jobsComplete: false };
        runs.push(run);
        try {
          const jobIds = new Set();
          for (let jp = 1; jp <= 10; jp++) {
            const data = await get(`repos/${repo}/actions/runs/${run.id}/attempts/${attempt}/jobs?per_page=100&page=${jp}`);
            if (!Array.isArray(data.jobs) || !Number.isInteger(data.total_count)) throw new Error('Job listing is incomplete.');
            for (const j of data.jobs) {
              if (jobIds.has(j.id)) continue; jobIds.add(j.id);
              run.jobs.push({ id: j.id, name: String(j.name ?? 'Unnamed job'), status: j.status ?? 'unknown', conclusion: j.conclusion ?? 'unknown',
                startedAt: j.started_at ?? null, completedAt: j.completed_at ?? null,
                labels: Array.isArray(j.labels) ? j.labels.filter(s => typeof s === 'string') : [], url: j.html_url ?? null });
            }
            if (run.jobs.length >= data.total_count) { run.jobsComplete = true; break; }
            if (data.jobs.length === 0) throw new Error('Job pagination ended before total_count.');
          }
          if (!run.jobsComplete) throw new Error('Job pagination exceeded 1,000-job cap.');
        } catch (e) { excluded.push(`Run ${run.id}, attempt ${attempt}: ${e.message}`); }
      }
      if (data.workflow_runs.length < 100 || seen.size >= data.total_count) break;
      if (page === 5 && runs.length < requested) excluded.push('Run listing reached its 500-run safety cap.');
    }
  } catch (e) { excluded.push(e.message); }
  return { source, workflows, runs, status: excluded.length ? 'partial' : 'complete',
    coverage: { requested, sampled: runs.length, requests, excluded, latestAttemptsOnly: true,
      notes: ['Only latest attempts are sampled; earlier attempt time/cost is excluded.',
        'Static workflows are read at the reported default-branch revision, not each historical run SHA.'] } };
}
