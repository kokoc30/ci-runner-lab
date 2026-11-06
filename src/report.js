import { mkdir, readFile, stat, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function createReport(mode, source = { kind: 'local', label: 'This computer', private: null, revision: null }) {
  return { schemaVersion: 1, toolVersion: '0.2.0', generatedAt: new Date().toISOString(), mode, status: 'complete',
    source, device: null, coverage: { requested: null, sampled: 0, excluded: [], notes: [] },
    workflows: [], runs: [], benchmarks: null, metrics: { groups: [], longestJobs: [] }, findings: [],
    costScenario: null, comparison: null,
    limitations: ['Static inspection does not execute actions or resolve expressions, reusable workflows or action internals.',
      'Execution span is earliest valid job start to latest valid job finish. Aggregate job time sums individual jobs.',
      'Successful-run distributions exclude cancelled/failed runs and incomplete timing. Failed-job time remains in usage estimates.',
      'Trigger-to-last-job intervals are observable only on first attempts; they are not proof of runner queue time.',
      'No automatic workflow changes or runner installation.'] };
}

function invalid(message) { throw new Error(`Invalid report: ${message}`); }
const object = v => v && typeof v === 'object' && !Array.isArray(v);
const str = v => typeof v === 'string';
const num = v => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const nullableNumber = v => v === null || num(v);
const stringList = v => Array.isArray(v) && v.every(str);
function summary(s) { return object(s) && Number.isInteger(s.n) && s.n >= 0 && ['medianMs', 'minMs', 'maxMs'].every(k => s.n ? num(s[k]) : s[k] === null) && (!s.n || s.minMs <= s.medianMs && s.medianMs <= s.maxMs); }

/** Validate imported v1 data before analysis/rendering; reject nonfinite or oversized structures. */
export function validateReport(r) {
  if (!object(r) || r.schemaVersion !== 1) invalid('unsupported schemaVersion; expected 1.');
  let nodes = 0;
  const walk = (v, depth = 0) => {
    if (++nodes > 200000 || depth > 30) invalid('structure exceeds safety limits.');
    if (typeof v === 'number' && (!Number.isFinite(v) || Math.abs(v) > Number.MAX_SAFE_INTEGER)) invalid('numeric values must be finite and bounded.');
    if (str(v) && v.length > 1024 * 1024) invalid('text exceeds safety limit.');
    if (Array.isArray(v)) v.forEach(x => walk(x, depth + 1));
    else if (object(v)) Object.values(v).forEach(x => walk(x, depth + 1));
  }; walk(r);
  if (!['demo', 'doctor', 'audit', 'bench', 'compare'].includes(r.mode) || !['complete', 'partial', 'failed', 'interrupted'].includes(r.status)) invalid('mode or status.');
  if (!str(r.toolVersion) || !str(r.generatedAt) || !Number.isFinite(Date.parse(r.generatedAt))) invalid('version/date.');
  if (!object(r.source) || !str(r.source.label) || ![true, false, null].includes(r.source.private)) invalid('source.');
  if (!object(r.coverage) || !stringList(r.coverage.excluded) || !stringList(r.coverage.notes)) invalid('coverage.');
  for (const field of ['workflows', 'runs', 'findings', 'limitations']) if (!Array.isArray(r[field])) invalid(`${field} must be an array.`);
  if (!stringList(r.limitations)) invalid('limitations.');
  if (r.device !== null) {
    const d = r.device;
    if (!object(d) || !str(d.os) || !str(d.architecture) || !str(d.node) || !num(d.parallelism) || !num(d.totalBytes) || !num(d.freeBytes) || !nullableNumber(d.memoryLimitBytes) || !nullableNumber(d.diskFreeBytes) || !object(d.planning) || !num(d.planning.workers) || d.planning.workers > 4 || !str(d.planning.advice) || !stringList(d.limitations)) invalid('device.');
  }
  for (const w of r.workflows) {
    if (!object(w) || !str(w.file) || !str(w.name) || !stringList(w.triggers) || !Array.isArray(w.jobs)) invalid('workflow.');
    for (const j of w.jobs) if (!object(j) || !str(j.id) || !str(j.name) || !stringList(j.runners) || !stringList(j.needs) || !nullableNumber(j.timeoutMinutes)) invalid('workflow job.');
  }
  for (const run of r.runs) {
    if (!object(run) || !Number.isSafeInteger(run.id) || run.id < 0 || !Number.isSafeInteger(run.attempt) || run.attempt < 1 || !['workflow', 'name', 'branch', 'event', 'conclusion'].every(k => str(run[k])) || typeof run.jobsComplete !== 'boolean' || !Array.isArray(run.jobs)) invalid('run identity or jobs.');
    for (const j of run.jobs) if (!object(j) || !str(j.name) || !str(j.status) || !str(j.conclusion) || !stringList(j.labels) || ![j.startedAt, j.completedAt].every(t => t === null || str(t))) invalid('run job.');
  }
  if (!object(r.metrics) || !Array.isArray(r.metrics.groups) || !Array.isArray(r.metrics.longestJobs)) invalid('metrics.');
  for (const g of r.metrics.groups) if (!object(g) || !summary(g.span) || !summary(g.aggregate) || !['workflow', 'name', 'branch', 'event'].every(k => str(g[k])) || !num(g.excludedRuns) || !object(g.outcomes)) invalid('metric group.');
  for (const j of r.metrics.longestJobs) if (!str(j.name) || !num(j.durationMs)) invalid('longest job.');
  for (const f of r.findings) if (!['id', 'severity', 'confidence', 'title', 'explanation', 'evidence', 'nextAction'].every(k => str(f[k])) || !['info', 'review', 'warning'].includes(f.severity)) invalid('finding.');
  if (r.benchmarks !== null) {
    const b = r.benchmarks;
    if (!object(b) || !['passed', 'failed', 'interrupted'].includes(b.status) || !str(b.script) || !str(b.fingerprint) || !stringList(b.arguments) || !summary(b.summary) || !Array.isArray(b.invocations) || !object(b.limits) || !stringList(b.limitations)) invalid('benchmark.');
    for (const i of b.invocations) if (!num(i.durationMs) || !['warmup', 'measured'].includes(i.phase) || !(i.exitCode === null || Number.isInteger(i.exitCode))) invalid('benchmark invocation.');
  }
  if (r.costScenario !== null) {
    const c = r.costScenario;
    if (!object(c) || !object(c.rates) || !str(c.rates.verifiedAt) || !object(c.rates.usdPerMinute) || !Object.values(c.rates.usdPerMinute).every(num) || !stringList(c.assumptions) || !stringList(c.exclusions) || !['knownSubtotalUsd', 'monthlyScenarioUsd', 'energyScenarioUsd', 'monthlyRuns', 'powerWatts', 'kwhPrice'].every(k => nullableNumber(c[k])) || !num(c.knownJobs) || !num(c.unknownJobs)) invalid('cost scenario.');
  }
  if (r.comparison !== null && (!object(r.comparison) || !summary(r.comparison.before) || !summary(r.comparison.after) || !stringList(r.comparison.warnings) || !(r.comparison.relativeMedianChangePercent === null || typeof r.comparison.relativeMedianChangePercent === 'number'))) invalid('comparison.');
  return r;
}

export async function readReport(file) {
  if ((await stat(file)).size > 8 * 1024 * 1024) invalid('file exceeds 8 MiB.');
  return validateReport(JSON.parse(await readFile(file, 'utf8')));
}
export const escapeHtml = value => String(value ?? 'Unknown').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const md = value => String(value ?? 'Unknown').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]).replace(/([\\`*_[\]{}()|#!])/g, '\\$1').replace(/[\r\n]/g, ' ');
export const seconds = n => n == null ? 'Unknown' : `${(n / 1000).toFixed(2)} s`;
const money = n => n == null ? 'Unknown' : `$${n.toFixed(4)}`;
const gib = n => n == null ? 'Unknown' : `${(n / 2 ** 30).toFixed(1)} GiB`;
export function safeUrl(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && !u.port && ['github.com', 'docs.github.com', 'nodejs.org', 'eemeli.org', 'cli.github.com'].includes(u.hostname) ? u.href : null; } catch { return null; }
}
const link = (url, label) => safeUrl(url) ? `<a href="${escapeHtml(safeUrl(url))}" rel="noopener noreferrer">${escapeHtml(label)}</a>` : escapeHtml(label);
const table = (headers, rows) => `<div class="table-scroll" tabindex="0" role="region" aria-label="${escapeHtml(headers.join(', '))}"><table><thead><tr>${headers.map(x => `<th scope="col">${escapeHtml(x)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(x => `<td>${escapeHtml(x)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
const list = items => `<ul>${items.map(x => `<li>${escapeHtml(x)}</li>`).join('')}</ul>`;

/** Shared zero-baseline bars; visible values remain the accessible source of truth. */
function timingBars(rows) {
  const maximum = Math.max(1, ...rows.map(row => row.value ?? 0));
  return `<div class="bars">${rows.map(row => `<div class="bar-row"><div class="bar-label"><span>${escapeHtml(row.label)}</span><strong>${seconds(row.value)}</strong></div><div class="track" aria-hidden="true"><div style="width:${((row.value ?? 0) / maximum * 100).toFixed(2)}%"></div></div></div>`).join('')}</div>`;
}

/** Render existing analyzed values only; never combine unlike timing groups. */
function spanChart(groups) {
  const sampled = groups.filter(g => g.span.n);
  if (!sampled.length) return '<p class="empty">No run timings collected. Static inspection does not measure workflow speed.</p>';
  const maximum = Math.max(1, ...sampled.map(g => g.span.maxMs));
  return `<figure class="span-chart"><figcaption><span>Successful execution span</span><span class="chart-key"><b aria-hidden="true"></b> Range <i aria-hidden="true"></i> Median</span></figcaption><div class="chart-axis" aria-hidden="true"><span>0 s</span><span>${seconds(maximum / 2)}</span><span>${seconds(maximum)}</span></div>${sampled.map(g => `<div class="span-row"><div class="bar-label"><span><strong>${escapeHtml(g.name)}</strong> / ${escapeHtml(g.branch)} / ${escapeHtml(g.event)}<small>${g.span.n} successful samples · range ${seconds(g.span.minMs)}–${seconds(g.span.maxMs)}</small></span><strong>${seconds(g.span.medianMs)}</strong></div><div class="span-track" aria-hidden="true"><div class="span-fill" style="width:${(g.span.medianMs / maximum * 100).toFixed(2)}%"></div><div class="span-range" style="left:${(g.span.minMs / maximum * 100).toFixed(2)}%;width:${((g.span.maxMs - g.span.minMs) / maximum * 100).toFixed(2)}%"></div><span class="median" style="left:${(g.span.medianMs / maximum * 100).toFixed(2)}%"></span></div></div>`).join('')}<p class="chart-note">Each row keeps its workflow, branch and event separate. Failed or incomplete runs do not enter these timing distributions.</p></figure>`;
}

export async function htmlReport(r) {
  validateReport(r);
  const e = escapeHtml, d = r.device, c = r.costScenario;
  const css = await readFile(new URL('./report.css', import.meta.url), 'utf8');
  const primary = [...r.metrics.groups].filter(g => g.span.n).sort((a, b) => b.span.n - a.span.n)[0];
  const samples = r.metrics.groups.reduce((n, g) => n + g.span.n, 0);
  const takeaway = r.status !== 'complete' ? `${r.status === 'partial' ? 'Incomplete evidence' : r.status === 'failed' ? 'Measurement failed' : 'Measurement interrupted'}. Review the details.` : r.benchmarks ? `Your script, measured.` : r.comparison ? 'Two observations. Full context.' : primary ? 'Your CI, in perspective.' : 'Start with what you know.';
  const generated = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(r.generatedAt));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'none'; script-src 'none'"><title>CI Runner Lab · ${e(r.source.label)}</title><style>${css}</style></head><body>
  <a class="skip" href="#overview">Skip to report</a><header><a class="brand" href="#overview"><span class="mark" aria-hidden="true">/</span> CI Runner Lab</a><span class="edition">Local report <span aria-hidden="true">/</span> v${e(r.toolVersion)}</span></header>
  <div class="layout"><nav aria-label="Report sections">${['Overview', 'Workflows', 'Benchmarks', 'Compare'].map((label, i) => `<a href="#${['overview', 'workflows', 'benchmarks', 'compare'][i]}">${label}</a>`).join('')}</nav><main>
  <section id="overview" tabindex="-1">
  <div class="report-meta"><span>${e(r.mode === 'demo' ? 'Demo report' : r.mode === 'doctor' ? 'Device report' : r.mode === 'bench' ? 'Benchmark report' : r.mode === 'compare' ? 'Comparison report' : 'Workflow report')}</span><span class="badge ${r.status === 'complete' ? '' : 'attention'}">${e(r.status.toUpperCase())}</span></div>
  <h1>${e(takeaway)}</h1><p class="subtitle">${e(r.source.label)}</p>
  ${r.mode === 'demo' ? '<p class="notice"><strong>SYNTHETIC DEMO</strong> · Fictional runs and device, not measurements of your repositories.</p>' : ''}
  ${r.source.private === true ? '<p class="notice"><strong>PRIVATE METADATA</strong> · Review repository information before sharing.</p>' : ''}
  ${r.status !== 'complete' ? '<p class="notice">Some measurements may be missing or unsuccessful. <a href="#evidence">Review coverage and limitations</a> before drawing conclusions.</p>' : ''}
  <div class="performance-surface" id="performance"><div class="performance-heading"><div><h2>${r.benchmarks ? 'Benchmark timing' : r.comparison ? 'Comparison timing' : 'CI performance'}</h2><p class="muted">${primary ? `${e(primary.name)} / ${e(primary.branch)} / ${e(primary.event)}` : r.benchmarks ? `Local script: ${e(r.benchmarks.script)}` : r.comparison ? 'Saved-report medians' : 'Observed evidence'}</p></div><div class="headline-metric"><strong>${primary ? seconds(primary.span.medianMs) : r.benchmarks ? seconds(r.benchmarks.summary.medianMs) : r.comparison ? seconds(r.comparison.after.medianMs) : '—'}</strong><span>${primary ? 'Median execution span' : r.benchmarks ? 'Measured median' : r.comparison ? 'After median' : 'No timing samples'}</span></div></div>
  ${r.benchmarks ? timingBars(r.benchmarks.invocations.map((i, n) => ({ label: `${i.phase} ${n + 1}${i.exitCode === 0 && !i.timedOut && !i.interrupted && !i.outputLimitExceeded ? '' : ' · unsuccessful'}`, value: i.durationMs }))) : r.comparison ? timingBars([{ label: `Before · ${r.comparison.before.n} samples`, value: r.comparison.before.medianMs }, { label: `After · ${r.comparison.after.n} samples`, value: r.comparison.after.medianMs }]) : spanChart(r.metrics.groups)}
  ${r.benchmarks ? '<p class="chart-note">Warm-ups are shown for context and excluded from the median. Unsuccessful invocations do not count as passing measurements.</p>' : ''}
  ${r.comparison ? `<p class="chart-note">${r.comparison.warnings.length ? `${r.comparison.warnings.length} context warnings. ${e(r.comparison.warnings[0])}` : 'Descriptive observations, not proof of an optimization.'} <a href="#compare">Review comparison context</a>.</p>` : ''}
  <div class="stats"><div><strong>${r.benchmarks ? r.benchmarks.summary.n : r.comparison ? r.comparison.after.n : samples}</strong><span>${r.benchmarks ? 'Measured invocations' : r.comparison ? 'After samples' : 'Successful timing samples'}</span></div><div><strong>${r.comparison ? r.comparison.before.n : r.runs.length}</strong><span>${r.comparison ? 'Before samples' : 'Sampled workflow runs'}</span></div><div><strong>${r.coverage.excluded.length}</strong><span>Collection exclusions</span></div></div></div>
  <div class="context"><details id="computer"><summary>This computer <span>${d ? `${e(d.parallelism)} CPU slots / ${gib(d.totalBytes)}` : 'Not collected'}</span></summary>${d ? `<div class="two-col"><div><h3>${e(d.cpuModel ?? 'CPU model unavailable')}</h3><p>${e(d.os)} / ${e(d.architecture)} · ${e(d.node)}</p>${table(['Observed snapshot', 'Value'], [['Usable parallelism', d.parallelism], ['Logical CPUs', d.logicalCpus], ['Total / free RAM', `${gib(d.totalBytes)} / ${gib(d.freeBytes)}`], ['Effective memory limit', gib(d.memoryLimitBytes)], ['Output volume free', gib(d.diskFreeBytes)], ['npm / GitHub CLI', `${d.npm ?? 'Unavailable'} / ${d.githubCli}`]])}</div><aside class="callout"><span class="eyebrow">INFERRED · HEURISTIC</span><h3>${e(d.planning.advice)}</h3><p>Reserve ≥1 CPU slot and 25% of usable parallelism; reserve max(2 GiB, 25% total RAM). Assume 2 GiB per worker; cap at four.</p><p>${e(d.planning.confidence)}</p><p>No hard CPU or RAM limits are enforced.</p></aside></div>${list(d.limitations)}` : '<p class="empty">No device snapshot belongs to this report. Use <code>doctor</code> to inspect this computer.</p>'}</details>
  <details id="cost"><summary>Cost &amp; assumptions <span>${money(c?.knownSubtotalUsd)} known subtotal</span></summary>${c ? `<div class="callout"><h3>${money(c.knownSubtotalUsd)} known sampled compute subtotal</h3><p>${c.knownJobs} known jobs · ${c.unknownJobs} jobs with unknown usage · collection ${c.incomplete ? 'incomplete' : 'complete within scope'}.</p><p>Monthly scenario: ${money(c.monthlyScenarioUsd)} · runs/month: ${e(c.monthlyRuns)}. Energy per measured median invocation: ${money(c.energyScenarioUsd)}.</p><p>User-supplied average power: ${e(c.powerWatts)} W · electricity: ${e(c.kwhPrice)} USD/kWh.</p></div><p>Rate table verified ${e(c.rates.verifiedAt)} · ${c.rateTableStale ? 'STALE: revalidate (90-day internal policy)' : 'Within 90-day revalidation policy'} · ${link(c.rates.source, 'Official runner prices')} · ${link(c.rates.policy, 'Billing policy')}</p>${table(['Rate class', 'USD / rounded job-minute'], Object.entries(c.rates.usdPerMinute))}${list(c.assumptions)}<h3>Excluded components</h3>${list(c.exclusions)}` : '<p class="empty">No cost scenario available.</p>'}</details></div>
  <p class="timestamp"><time datetime="${e(r.generatedAt)}">${e(generated)} UTC</time> · <a href="#evidence">Evidence and limitations</a></p></section>
  <section id="workflows" tabindex="-1"><div class="section-heading"><h2>Workflows</h2><span>${r.workflows.length} static workflows</span></div>
  ${r.metrics.groups.length ? `<details><summary>Timing breakdown <span>Spans, aggregate time and outcomes</span></summary>${table(['Workflow / branch / event', 'Samples', 'Median span', 'Span range', 'Median aggregate', 'Excluded / outcomes'], r.metrics.groups.map(g => [`${g.name} / ${g.branch} / ${g.event}`, g.span.n, seconds(g.span.medianMs), `${seconds(g.span.minMs)}–${seconds(g.span.maxMs)}`, seconds(g.aggregate.medianMs), `${g.excludedRuns} / ${JSON.stringify(g.outcomes)}`]))}<p>Execution span is elapsed job execution; aggregate job time sums parallel work.</p></details>` : '<p class="empty">No historical timings collected. Use <code>npm start -- audit --repo owner/repository</code> for GitHub run evidence.</p>'}
  ${r.workflows.length ? r.workflows.map(w => `<details><summary>${e(w.name)} <span>${w.jobs.length} jobs / ${e(w.file)}</span></summary><p>Triggers: ${e(w.triggers.join(', '))}</p>${table(['Job', 'Runner', 'Dependencies', 'Timeout (min)'], w.jobs.map(j => [j.name, j.runners.join(', ') || 'Unresolved', j.needs.join(', ') || 'None', j.timeoutMinutes]))}</details>`).join('') : '<p class="empty">No workflow files in this report. Use <code>npm start -- audit --path &quot;my-project&quot;</code> to inspect local YAML.</p>'}
  ${r.metrics.longestJobs.length ? `<details><summary>Longest observed jobs <span>Individual observations</span></summary><p class="muted">Not the exact workflow critical path.</p>${timingBars(r.metrics.longestJobs.slice(0, 5).map(j => ({ label: `${j.name} · ${j.conclusion}`, value: j.durationMs })))}</details>` : ''}
  <h3 class="investigations-title" id="recommendations">Worth investigating</h3>${r.findings.length ? r.findings.slice(0, 5).map(f => `<article class="finding"><p class="eyebrow">${e(f.severity)} · ${e(f.confidence)}</p><h3>${e(f.title)}</h3><p>${e(f.explanation)}</p><details><summary>Evidence and next action</summary><p>${e(f.evidence)}</p><p><strong>Next:</strong> ${e(f.nextAction)}</p><small>ID: ${e(f.id)}</small></details></article>`).join('') : '<p class="empty">No applicable findings. This is not a universal CI score.</p>'}${r.findings.length > 5 ? `<details><summary>${r.findings.length - 5} more findings</summary>${r.findings.slice(5).map(f => `<h3>${e(f.title)}</h3><p>${e(f.confidence)} · ${e(f.explanation)}</p><p>${e(f.evidence)}</p><p>${e(f.nextAction)}</p>`).join('')}</details>` : ''}</section>
  <section id="benchmarks" tabindex="-1"><h2>Benchmarks</h2>${r.benchmarks ? `<h3>Trusted npm benchmark · ${e(r.benchmarks.status)}</h3><p><code>npm run ${e(r.benchmarks.script)}</code> · ${r.benchmarks.summary.n} measured samples · median ${seconds(r.benchmarks.summary.medianMs)}</p>${table(['Phase', 'Elapsed', 'Exit', 'Timeout / interrupted / output cap'], r.benchmarks.invocations.map(i => [i.phase, seconds(i.durationMs), i.exitCode, `${i.timedOut} / ${i.interrupted} / ${i.outputLimitExceeded}`]))}${list(r.benchmarks.limitations)}${r.benchmarks.invocations.filter(i => i.failureExcerpt).map(i => `<pre>${e(i.failureExcerpt)}</pre>`).join('')}` : '<p class="empty">No local benchmark in this report. In the terminal, run <code>npm start -- bench --path &quot;my-project&quot; --script test:ci</code>. Review and confirm execution of trusted code when prompted.</p>'}</section>
  <section id="compare" tabindex="-1"><h2>Compare</h2>${r.comparison ? `<h3>Saved-report comparison</h3>${table(['Observation', 'Before', 'After'], [['Samples', r.comparison.before.n, r.comparison.after.n], ['Median', seconds(r.comparison.before.medianMs), seconds(r.comparison.after.medianMs)]])}<p>Descriptive relative median change: <strong>${r.comparison.relativeMedianChangePercent === null ? 'Undefined' : `${r.comparison.relativeMedianChangePercent.toFixed(2)}%`}</strong> (negative means slower).</p>${list(r.comparison.warnings)}` : '<p class="empty">Compare two saved observations in the terminal with <code>npm start -- compare &quot;before/report.json&quot; &quot;after/report.json&quot;</code>. Environment and workload differences stay visible alongside the result.</p>'}</section>
  <section id="evidence" tabindex="-1"><details${r.status !== 'complete' ? ' open' : ''}><summary>Evidence and limitations <span>Coverage, source and methodology</span></summary><h3>Coverage</h3>${list([...r.coverage.notes, ...r.coverage.excluded])}<p>Source revision: <code>${e(r.source.revision)}</code>. ${link(r.source.url, 'Repository source')}</p>
  ${r.runs.length ? `<details><summary>Run identities, attempts and revisions (${r.runs.length})</summary><ul>${r.runs.map(run => `<li>${link(run.url, `${run.name}: run ${run.id}, attempt ${run.attempt}`)} · ${e(run.branch)} / ${e(run.event)} / ${e(run.conclusion)}<br><code>${e(run.sha)}</code> · jobs ${run.jobs.length} · ${run.jobsComplete ? 'complete' : 'partial'}</li>`).join('')}</ul></details>` : ''}
  ${r.workflows.length ? `<details><summary>Static workflow inventory (${r.workflows.length})</summary>${r.workflows.map(w => `<h3>${e(w.file)}</h3><p>Triggers: ${e(w.triggers.join(', '))}. Workflow concurrency: ${e(w.concurrency)}. Permissions: ${e(w.permissions)}</p>${table(['Job', 'Runner labels', 'Needs', 'Timeout min', 'Matrix / reusable / services / container', 'Permissions / concurrency'], w.jobs.map(j => [j.name, j.runners.join(', ') || 'Unresolved', j.needs.join(', '), j.timeoutMinutes, `${j.matrix} / ${j.reusable ?? 'none'} / ${j.services} / ${j.container}`, `${j.permissions ?? 'unknown'} / ${j.concurrency ?? 'unknown'}`]))}`).join('')}</details>` : ''}${list(r.limitations)}</details></section>
  <footer><span>CI Runner Lab · Local-first evidence</span><span>Schema ${r.schemaVersion} · Companion files: report.json and report.md</span></footer></main></div></body></html>`;
}

export function markdownReport(r) {
  validateReport(r);
  return `# CI Runner Lab\n\n${r.mode === 'demo' ? '**SYNTHETIC DEMO — fictional evidence.**\n\n' : ''}${r.source.private === true ? '**PRIVATE METADATA — review before sharing.**\n\n' : ''}Status: **${md(r.status)}** · Mode: ${md(r.mode)} · ${md(r.generatedAt)}\n\nSource: ${md(r.source.label)} · revision ${md(r.source.revision)}\n\n## This computer\n\n${r.device ? `${md(r.device.os)} / ${md(r.device.architecture)} · ${r.device.parallelism} usable CPU slots · free RAM ${gib(r.device.freeBytes)}\n\n${md(r.device.planning.advice)}\n\n${r.device.limitations.map(x => `- ${md(x)}`).join('\n')}` : 'No device snapshot.'}\n\n## CI performance\n\nExecution span is elapsed job execution; aggregate sums individual jobs. Successful distributions exclude failed/cancelled/incomplete runs.\n\n${r.metrics.groups.map(g => `- ${md(g.name)} / ${md(g.branch)} / ${md(g.event)}: n=${g.span.n}, median span ${seconds(g.span.medianMs)}, range ${seconds(g.span.minMs)}–${seconds(g.span.maxMs)}, aggregate median ${seconds(g.aggregate.medianMs)}; excluded ${g.excludedRuns}.`).join('\n') || 'No observed run timing.'}\n\n${r.benchmarks ? `Benchmark ${md(r.benchmarks.script)}: ${md(r.benchmarks.status)}, n=${r.benchmarks.summary.n}, median ${seconds(r.benchmarks.summary.medianMs)}.\n\n${r.benchmarks.limitations.map(x => `- ${md(x)}`).join('\n')}` : ''}${r.comparison ? `\nComparison: before ${seconds(r.comparison.before.medianMs)}, after ${seconds(r.comparison.after.medianMs)}, descriptive change ${r.comparison.relativeMedianChangePercent ?? 'undefined'}%.\n\n${r.comparison.warnings.map(x => `- ${md(x)}`).join('\n')}` : ''}\n\n## Recommendations\n\n${r.findings.map(f => `### ${md(f.title)}\n\n${md(f.severity)} · ${md(f.confidence)} · ${md(f.id)}\n\n${md(f.explanation)}\n\nEvidence: ${md(f.evidence)}\n\nNext: ${md(f.nextAction)}\n`).join('\n') || 'No applicable findings.'}\n\n## Cost scenario\n\n${r.costScenario ? `Known subtotal ${money(r.costScenario.knownSubtotalUsd)}; known jobs ${r.costScenario.knownJobs}; unknown jobs ${r.costScenario.unknownJobs}; incomplete=${r.costScenario.incomplete}.\n\nMonthly scenario ${money(r.costScenario.monthlyScenarioUsd)}, runs/month ${r.costScenario.monthlyRuns ?? 'unknown'}; energy per median invocation ${money(r.costScenario.energyScenarioUsd)}. User-supplied average watts ${r.costScenario.powerWatts ?? 'unknown'}, USD/kWh ${r.costScenario.kwhPrice ?? 'unknown'}.\n\nRates verified ${md(r.costScenario.rates.verifiedAt)}; stale=${r.costScenario.rateTableStale}.\n\n${Object.entries(r.costScenario.rates.usdPerMinute).map(([k, v]) => `- ${md(k)}: ${v} USD/minute`).join('\n')}\n\n[Official pricing](${safeUrl(r.costScenario.rates.source) ?? ''}) · [Billing policy](${safeUrl(r.costScenario.rates.policy) ?? ''})\n\n${[...r.costScenario.assumptions, ...r.costScenario.exclusions].map(x => `- ${md(x)}`).join('\n')}` : 'No scenario.'}\n\n## Evidence and limitations\n\n${[...r.coverage.notes, ...r.coverage.excluded, ...r.limitations].map(x => `- ${md(x)}`).join('\n')}\n\n${r.runs.map(run => `- Run ${run.id}, attempt ${run.attempt}, ${md(run.name)} / ${md(run.branch)} / ${md(run.event)}: ${md(run.conclusion)}, revision ${md(run.sha)}, jobs ${run.jobs.length} (complete=${run.jobsComplete}). ${safeUrl(run.url) ? `[GitHub run](${safeUrl(run.url)})` : ''}`).join('\n')}\n\nFull structured inventory and invocation evidence: report.json (schema 1).\n`;
}

/** Windows scanners can briefly lock a newly written directory. Keep publication atomic,
 * retry only transient lock errors, and preserve a real failure after a bounded wait. */
export async function publishDirectory(temp, dest, { move = rename, platform = process.platform,
  pause = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  for (let attempt = 0; ; attempt++) {
    try { await move(temp, dest); return; }
    catch (e) {
      if (platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code) || attempt >= 4) throw e;
      await pause(50 * 2 ** attempt);
    }
  }
}

/** Directory rename publishes all three companions together; old reports never overwritten. */
export async function writeReport(report, outputRoot) {
  validateReport(report);
  const root = path.resolve(outputRoot); await mkdir(root, { recursive: true });
  const name = `${report.generatedAt.replace(/[:.]/g, '-')}-${report.mode}-${randomUUID().slice(0, 8)}`;
  const temp = path.join(root, `.pending-${randomUUID()}`), dest = path.join(root, name);
  await mkdir(temp);
  try {
    await writeFile(path.join(temp, 'report.html'), await htmlReport(report));
    await writeFile(path.join(temp, 'report.md'), markdownReport(report));
    await writeFile(path.join(temp, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    await publishDirectory(temp, dest);
  } catch (e) { await rm(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); throw e; }
  return path.join(dest, 'report.html');
}
