/** Pure timing, findings, pricing and comparison functions. No process or network I/O. */
export const RATES = Object.freeze({ verifiedAt: '2026-11-06',
  source: 'https://docs.github.com/en/billing/reference/actions-runner-pricing',
  policy: 'https://docs.github.com/en/actions/concepts/billing-and-usage',
  usdPerMinute: { linux: 0.006, linuxArm: 0.005, linuxSlim: 0.002, windows: 0.010, windowsArm: 0.010, macos: 0.062 } });

export function distribution(values) {
  const v = values.filter(x => typeof x === 'number' && Number.isFinite(x) && x >= 0).sort((a, b) => a - b);
  if (!v.length) return { n: 0, medianMs: null, minMs: null, maxMs: null };
  const mid = Math.floor(v.length / 2);
  return { n: v.length, medianMs: v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2, minMs: v[0], maxMs: v.at(-1) };
}
export function duration(job) {
  if (job.status !== 'completed' || job.conclusion === 'skipped' || !job.startedAt || !job.completedAt) return null;
  const start = Date.parse(job.startedAt), end = Date.parse(job.completedAt);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null;
}
export function timing(run) {
  const jobs = run.jobs.map(j => ({ ...j, durationMs: duration(j) }));
  const valid = jobs.filter(j => j.durationMs !== null);
  const missing = jobs.filter(j => j.durationMs === null && j.conclusion !== 'skipped').length;
  const first = valid.length ? Math.min(...valid.map(j => Date.parse(j.startedAt))) : null;
  const last = valid.length ? Math.max(...valid.map(j => Date.parse(j.completedAt))) : null;
  const created = Date.parse(run.createdAt);
  return { jobs, missing, aggregateMs: valid.length ? valid.reduce((s, j) => s + j.durationMs, 0) : null,
    spanMs: valid.length ? last - first : null,
    complete: run.jobsComplete && missing === 0 && valid.length > 0,
    triggerToLastMs: run.attempt === 1 && Number.isFinite(created) && created <= first && valid.length ? last - created : null };
}
export function runnerClass(labels) {
  if (labels.includes('self-hosted')) return 'self';
  if (labels.length !== 1) return null;
  const l = labels[0];
  if (/^ubuntu-(latest|22\.04|24\.04)$/.test(l)) return 'linux';
  if (/^ubuntu-(22\.04|24\.04)-arm$/.test(l)) return 'linuxArm';
  if (l === 'ubuntu-slim') return 'linuxSlim';
  if (/^windows-(latest|2022|2025)$/.test(l)) return 'windows';
  if (l === 'windows-11-arm') return 'windowsArm';
  if (/^macos-(latest|13|14|15|26|15-intel|26-intel)$/.test(l)) return 'macos';
  return null;
}
/** Positive scenario inputs are explicit, never defaults masquerading as measurements. */
export function scenarioInputs(options = {}) {
  const result = { monthlyRuns: null, powerWatts: null, kwhPrice: null };
  for (const key of Object.keys(result)) {
    if (options[key] == null) continue;
    const n = Number(options[key]);
    if (!Number.isFinite(n) || n < 0 || (key === 'monthlyRuns' && (n === 0 || !Number.isInteger(n))) || n > 1e9) throw new Error(`Invalid ${key}: supply a bounded ${key === 'monthlyRuns' ? 'positive integer' : 'nonnegative number'}.`);
    result[key] = n;
  }
  return result;
}
export function costs(report, options = {}, today = new Date()) {
  const input = scenarioInputs(options);
  let subtotal = 0, knownJobs = 0, unknownJobs = 0;
  for (const run of report.runs) for (const job of run.jobs) {
    if (job.conclusion === 'skipped') continue;
    const ms = duration(job), kind = runnerClass(job.labels);
    if (ms === null || !kind || (kind !== 'self' && report.source.private == null)) { unknownJobs++; continue; }
    subtotal += kind === 'self' || report.source.private === false ? 0 : Math.ceil(ms / 60000) * RATES.usdPerMinute[kind];
    knownJobs++;
  }
  const incomplete = report.status === 'partial' || report.runs.some(r => !r.jobsComplete);
  const groups = new Set(report.runs.map(r => JSON.stringify([r.workflow, r.branch, r.event])));
  const projectionEligible = report.runs.length >= 3 && groups.size === 1 && !unknownJobs && !incomplete && knownJobs > 0;
  const measuredMs = report.benchmarks?.status === 'passed' ? report.benchmarks.summary.medianMs : null;
  return { ...input, rates: RATES, rateTableStale: today.getTime() - Date.parse(RATES.verifiedAt) > 90 * 86400000,
    knownSubtotalUsd: knownJobs ? Number(subtotal.toFixed(6)) : null, knownJobs, unknownJobs, incomplete,
    monthlyScenarioUsd: input.monthlyRuns && projectionEligible ? subtotal / report.runs.length * input.monthlyRuns : null,
    energyScenarioUsd: measuredMs !== null && input.powerWatts !== null && input.kwhPrice !== null ? input.powerWatts / 1000 * measuredMs / 3600000 * input.kwhPrice : null,
    assumptions: ['USD list-price compute usage before allowances/discounts; not an invoice.',
      'Runner class is inferred only from recognized standard labels or explicit self-hosted labels; custom/larger runners stay unknown.',
      'Public standard-hosted and self-hosted runner compute is free under the referenced policy; this is not a zero total bill.',
      'Rounding is per job. Failed-job time is included. Earlier attempts are excluded.',
      'Monthly scenarios need ≥3 runs in one workflow/branch/event with complete known usage; representativeness is user judgment.',
      'Energy uses user-supplied average watts and price, with measured benchmark median elapsed time.'],
    exclusions: ['Storage, artifacts, caches, bandwidth, subscriptions, hardware, administration, external VMs, earlier attempts and unknown jobs.'] };
}

export function analyze(report, options = {}) {
  const grouped = new Map();
  const longest = [];
  for (const run of report.runs) {
    const t = timing(run), key = JSON.stringify([run.workflow, run.branch, run.event]);
    if (!grouped.has(key)) grouped.set(key, { workflow: run.workflow, name: run.name, branch: run.branch, event: run.event, samples: [], excludedRuns: 0, aggregateMs: [], outcomes: {} });
    const g = grouped.get(key); g.outcomes[run.conclusion] = (g.outcomes[run.conclusion] ?? 0) + 1;
    if (run.conclusion === 'success' && t.complete) { g.samples.push(t.spanMs); g.aggregateMs.push(t.aggregateMs); } else g.excludedRuns++;
    for (const j of t.jobs) if (j.durationMs !== null) longest.push({ name: j.name, workflow: run.name, durationMs: j.durationMs, conclusion: j.conclusion, runId: run.id, attempt: run.attempt, url: j.url });
  }
  report.metrics = { groups: [...grouped.values()].map(g => ({ workflow: g.workflow, name: g.name, branch: g.branch, event: g.event,
    span: distribution(g.samples), aggregate: distribution(g.aggregateMs), excludedRuns: g.excludedRuns, outcomes: g.outcomes })),
    longestJobs: longest.sort((a, b) => b.durationMs - a.durationMs).slice(0, 10) };
  const findings = [];
  const add = (id, severity, confidence, title, explanation, evidence, nextAction) => findings.push({ id, severity, confidence, title, explanation, evidence, nextAction });
  for (const w of report.workflows) {
    const missing = w.jobs.filter(j => j.timeoutMinutes === null && !j.reusable);
    if (missing.length) add(`timeout:${w.file}`, 'review', 'observed', 'Review job time limits', 'Explicit time limits can bound runaway work; an omitted limit is not proof of a defect.', `${w.file}: ${missing.map(j => j.id).join(', ')} have no literal timeout-minutes.`, 'Choose a limit from measured normal durations and failure recovery needs.');
    if (!w.concurrency && w.jobs.some(j => !j.concurrency)) add(`concurrency:${w.file}`, 'review', 'observed', 'Review superseded work', 'Cancellation may reduce unnecessary work when newer commits supersede older runs.', `${w.file}: no workflow concurrency; some jobs lack concurrency.`, 'Consider a branch-aware concurrency group only if cancelling old work is safe.');
    if (w.triggers.includes('push') && w.triggers.includes('pull_request')) add(`triggers:${w.file}`, 'info', 'inferred', 'Check for duplicate trigger work', 'Push and pull-request triggers can overlap; branch filters may make this intentional.', `${w.file}: push and pull_request both present.`, 'Review filters before changing triggers.');
    for (const j of w.jobs) {
      if (j.unresolvedRunner || j.matrix || j.reusable) add(`unresolved:${w.file}:${j.id}`, 'info', 'unknown', 'Some workflow behavior remains unresolved', 'Expressions, matrices, reusable workflows and action internals are not evaluated.', `${w.file} / ${j.id}: runner=${j.runners.join(', ') || 'unknown'}, matrix=${j.matrix}, reusable=${j.reusable ?? 'none'}.`, 'Inspect the expanded jobs and referenced workflow before proposing migration.');
      if (report.source.private === false && j.runners.includes('self-hosted')) add(`exposure:${w.file}:${j.id}`, 'warning', 'observed', 'Review public self-hosted exposure', 'Public pull requests can run untrusted code on self-hosted machines.', `${w.file} / ${j.id}: self-hosted label in a public repository.`, 'Review fork access and isolation. Do not expose a personal workstation runner.');
      if (report.device && ((j.runners.some(r => r.startsWith('macos')) && report.device.os !== 'darwin') || ((j.services || j.container) && report.device.os !== 'linux') || j.runners.some(r => /arm/.test(r) && report.device.architecture !== 'arm64'))) add(`platform:${w.file}:${j.id}`, 'warning', 'inferred', 'Local execution may be incompatible', 'Operating system, architecture or service-container requirements differ from this Node environment.', `${j.id}: ${j.runners.join(', ') || 'runner unknown'}; services=${j.services}; container=${j.container}; local=${report.device.os}/${report.device.architecture}.`, 'Keep platform-specific work on a compatible runner; do not assume native portability.');
    }
  }
  if (longest.length) add('longest-job', 'info', 'observed', 'Start with the longest observed job', 'This is a measured job duration, not the exact workflow critical path.', `${longest[0].name}: ${(longest[0].durationMs / 1000).toFixed(1)} seconds.`, 'Inspect its individual steps before selecting an optimization.');
  const recurring = new Map();
  for (const r of report.runs) for (const j of r.jobs) { const key = JSON.stringify([r.workflow, r.branch, r.event, j.name]); if (!recurring.has(key)) recurring.set(key, []); const ms = duration(j); if (ms !== null) recurring.get(key).push(ms); }
  for (const [key, values] of recurring) if (values.length >= 3 && distribution(values).medianMs >= 60000) { add(`recurring:${key}`, 'review', 'observed', 'Repeatedly long job', 'Repeated observations make this a useful investigation candidate.', `${JSON.parse(key)[3]}: median ${(distribution(values).medianMs / 1000).toFixed(1)} s over ${values.length} observations.`, 'Compare step timings within this workflow, branch and event.'); break; }
  if (!report.runs.length || report.metrics.groups.some(g => g.span.n < 3)) add('sample-size', 'info', 'observed', 'More timing evidence is needed', 'Small or missing samples cannot establish a stable performance improvement.', `${report.runs.length} sampled runs; distributions include only successful runs with complete timing.`, 'Collect comparable runs before drawing a performance conclusion.');
  report.costScenario = costs(report, options);
  if (report.costScenario.knownJobs && report.costScenario.knownSubtotalUsd === 0) add('no-compute-savings', 'info', 'inferred', 'Migration has no sampled compute-charge saving', 'Known sampled standard public/self-hosted compute usage is zero under the referenced policy.', `${report.costScenario.knownJobs} known jobs; unknown components remain separate.`, 'Evaluate latency, isolation and operating effort instead of claiming cash savings.');
  const order = { warning: 0, review: 1, info: 2 };
  report.findings = findings.sort((a, b) => order[a.severity] - order[b.severity]);
  return report;
}

export function compareReports(before, after) {
  const warnings = ['Descriptive observations only. This is not a controlled performance experiment; equal test coverage is not established.'];
  if (before.mode !== after.mode) warnings.push('Report modes differ.');
  if (before.status !== 'complete' || after.status !== 'complete') warnings.push('At least one report has incomplete data or failed execution.');
  if (before.mode === 'demo' || after.mode === 'demo') warnings.push('Synthetic demo observations are not independent performance measurements.');
  if ([before, after].some(r => r.benchmarks && (r.benchmarks.dirty !== false || !r.benchmarks.commit))) warnings.push('Benchmark source is dirty, unversioned or unverified; workload equality is unknown.');
  if (before.benchmarks && after.benchmarks && JSON.stringify(before.benchmarks.limits) !== JSON.stringify(after.benchmarks.limits)) warnings.push('Benchmark warm-up, repetition or timeout settings differ.');
  const signature = r => JSON.stringify({ source: r.source.label, filters: r.source.filters, groups: r.metrics.groups.map(g => [g.workflow, g.branch, g.event]).sort(),
    script: r.benchmarks?.script, fingerprint: r.benchmarks?.fingerprint,
    environment: r.benchmarks ? [r.device?.os, r.device?.architecture, r.device?.cpuModel, r.device?.parallelism, r.device?.totalBytes, r.device?.node, r.device?.npm] :
      [...new Set(r.runs.flatMap(x => x.jobs.map(j => JSON.stringify(j.labels))))].sort() });
  if (signature(before) !== signature(after)) warnings.push('Workload, repository, script, group, fingerprint or runner environment differs.');
  const revisions = r => JSON.stringify([r.source.revision, [...new Set(r.runs.map(x => x.sha))].sort(), r.benchmarks?.commit]);
  if (revisions(before) !== revisions(after)) warnings.push('Revisions differ; code changes are a confounder.');
  const ids = new Set(before.runs.map(r => `${r.id}:${r.attempt}`));
  if (after.runs.some(r => ids.has(`${r.id}:${r.attempt}`))) warnings.push('Run IDs/attempts overlap; these are not independent samples.');
  const sample = r => r.benchmarks?.status === 'passed' ? r.benchmarks.summary : r.metrics.groups.length === 1 ? r.metrics.groups[0].span : distribution([]);
  const b = sample(before), a = sample(after);
  if (b.n < 3 || a.n < 3) warnings.push('Insufficient observations: at least three per side are needed.');
  if (b.n !== a.n) warnings.push('Sample sizes differ.');
  if (before.metrics.groups.length > 1 || after.metrics.groups.length > 1) warnings.push('Multiple workflow groups cannot be reduced to one performance number.');
  const change = b.medianMs > 0 && a.medianMs !== null ? (b.medianMs - a.medianMs) / b.medianMs * 100 : null;
  if (change === null) warnings.push('Relative change is undefined for a zero or missing baseline.');
  return { before: b, after: a, relativeMedianChangePercent: change, comparable: warnings.length === 1, warnings };
}
