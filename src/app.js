const $ = selector => document.querySelector(selector);
const token = $('meta[name="session-token"]').content;
const descriptions = {
  github: ['Understand your CI.', 'See where your workflows spend time, and what to investigate next.'],
  doctor: ['Know your starting point.', 'Inspect this computer before choosing a workload.'],
  bench: ['Measure a real workload.', 'Run a trusted npm script with explicit limits and permission.'],
  compare: ['See what changed.', 'Compare saved observations without losing their context.'],
  local: ['Read your workflows.', 'Inspect local workflow files without executing project code.']
};
let currentJob = null, shownReport = null, preparation = null, busy = false;
function element(tag, className = '', text = '') {
  const node = document.createElement(tag); node.className = className; node.textContent = String(text); return node;
}
function error(message) { $('#feedback').textContent = message; $('#feedback').hidden = !message; }
function lock(value) {
  busy = value;
  document.querySelectorAll('.task-switch button, .task-form button, .task-form input, .task-form select, .more button').forEach((/** @type {HTMLInputElement} */ el) => { el.disabled = value; });
  $('#workspace').setAttribute('aria-busy', String(value));
}
async function api(route, data = undefined) {
  const response = await fetch(route, { method: data === undefined ? 'GET' : 'POST', credentials: 'omit',
    headers: { Authorization: `Bearer ${token}`, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: data === undefined ? undefined : JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? 'The task could not be completed.');
  return result;
}
function choose(name) {
  if (busy) return;
  error('');
  $('#entry').hidden = false; $('#result').hidden = true; $('#progress').hidden = true;
  $('#task-title').textContent = descriptions[name][0]; $('#task-description').textContent = descriptions[name][1];
  document.querySelectorAll('[data-panel]').forEach((/** @type {HTMLElement} */ el) => { el.hidden = el.dataset.panel !== name; });
  document.querySelectorAll('.task-switch button').forEach((/** @type {HTMLElement} */ el) => el.setAttribute('aria-pressed', String(el.dataset.task === name)));
  if (name === 'compare') refresh().catch(e => error(e.message));
}
const seconds = value => value == null ? 'Unknown' : `${(value / 1000).toFixed(2)} s`;
const gib = value => `${(value / 2 ** 30).toFixed(1)} GiB`;
function metric(value, label) { const box = element('div'); box.append(element('strong', '', value), element('span', '', label)); return box; }
function disclosure(title, lines) {
  const box = element('details'); box.append(element('summary', '', title));
  for (const line of lines.filter(Boolean)) box.append(element('p', '', line));
  return box;
}
function chart(rows) {
  const bars = element('div', 'bars'), maximum = Math.max(1, ...rows.map(r => r.value ?? 0));
  for (const row of rows) {
    const container = element('div'), label = element('div', 'bar-label'), name = element('span', '', row.label);
    if (row.detail) name.append(element('small', '', row.detail));
    label.append(name, element('strong', '', seconds(row.value)));
    const track = element('div', 'track'), fill = element('div');
    track.setAttribute('aria-hidden', 'true'); fill.style.width = `${(row.value ?? 0) / maximum * 100}%`;
    track.append(fill); container.append(label, track); bars.append(container);
  }
  return bars;
}
function showResult({ report: r, output, base }) {
  const result = $('#result'); result.replaceChildren();
  const top = element('div', 'result-top');
  top.append(element('p', 'quiet', r.mode === 'demo' ? 'Demo · Synthetic data' : `${r.mode === 'doctor' ? 'My computer' : r.mode === 'bench' ? 'Benchmark' : r.mode === 'compare' ? 'Comparison' : 'Workflow analysis'} · ${r.status}`));
  const again = element('button', '', 'New analysis'); again.type = 'button'; again.addEventListener('click', () => { choose('github'); $('#repo').focus(); }); top.append(again);
  result.append(top, element('h1', 'result-title', r.mode === 'doctor' ? 'Your computer, at a glance.' : r.benchmarks ? `npm run ${r.benchmarks.script}` : r.comparison ? 'Before and after.' : 'Your CI, in perspective.'), element('p', 'result-source', r.source.label));
  if (r.mode === 'demo') result.append(element('p', 'notice', 'Fictional runs and device. No measurements of your repositories.'));
  if (r.source.private === true) result.append(element('p', 'result-warning', 'Private repository metadata. Review before sharing.'));
  if (r.status !== 'complete') result.append(element('p', 'result-warning', `${r.status === 'interrupted' ? 'Stopped' : r.status === 'failed' ? 'Measurement failed' : 'Partial evidence'}. ${r.coverage.excluded[0] ?? 'Collected observations are retained below.'}`));
  const surface = element('div', 'result-surface'), heading = element('div', 'performance-heading'), left = element('div'), headline = element('div', 'headline-metric');
  const primary = [...r.metrics.groups].filter(g => g.span.n).sort((a, b) => b.span.n - a.span.n)[0];
  let value = primary ? seconds(primary.span.medianMs) : '—', label = 'Median execution span', title = 'Successful workflow timing', context = primary ? `${primary.name} / ${primary.branch} / ${primary.event}` : 'No historical timings collected';
  let rows = r.metrics.groups.filter(g => g.span.n).map(g => ({ label: `${g.name} / ${g.branch} / ${g.event}`, value: g.span.medianMs, detail: `${g.span.n} samples · range ${seconds(g.span.minMs)}–${seconds(g.span.maxMs)}` }));
  const stats = element('div', 'stats');
  if (r.mode === 'doctor' && r.device) {
    value = String(r.device.parallelism); label = 'Usable CPU slots'; title = 'Observed capacity'; context = `${r.device.os} / ${r.device.architecture}`;
    stats.append(metric(gib(r.device.totalBytes), 'Total memory'), metric(gib(r.device.freeBytes), 'Free memory'), metric(r.device.planning.workers, 'Suggested worker cap'));
  } else if (r.benchmarks) {
    value = seconds(r.benchmarks.summary.medianMs); label = 'Passing measured median'; title = 'Local script timing'; context = r.benchmarks.status;
    rows = r.benchmarks.invocations.map((i, n) => ({ label: `${i.phase} ${n + 1}`, value: i.durationMs, detail: i.exitCode === 0 && !i.timedOut && !i.interrupted && !i.outputLimitExceeded ? 'Completed' : 'Unsuccessful invocation' }));
    stats.append(metric(r.benchmarks.summary.n, 'Passing samples'), metric(r.benchmarks.limits.warmups, 'Warm-ups'), metric(`${r.benchmarks.limits.timeout} s`, 'Timeout per run'));
  } else if (r.comparison) {
    value = seconds(r.comparison.after.medianMs); label = 'After median'; title = 'Saved observations'; context = 'Descriptive comparison';
    rows = [{ label: 'Before', value: r.comparison.before.medianMs }, { label: 'After', value: r.comparison.after.medianMs }];
    stats.append(metric(r.comparison.before.n, 'Before samples'), metric(r.comparison.after.n, 'After samples'), metric(r.comparison.warnings.length, 'Context warnings'));
  } else {
    stats.append(metric(r.runs.length, 'Sampled runs'), metric(r.workflows.length, 'Static workflows'), metric(r.coverage.excluded.length, 'Collection exclusions'));
  }
  left.append(element('h2', '', title), element('p', 'muted', context)); headline.append(element('strong', '', value), element('span', '', label)); heading.append(left, headline); surface.append(heading);
  if (rows.length) surface.append(chart(rows));
  else surface.append(element('p', 'result-note', r.mode === 'doctor' ? r.device.planning.advice : 'Static inspection does not measure workflow speed.'));
  if (r.benchmarks) surface.append(element('p', 'result-note', 'Warm-ups and unsuccessful invocations do not enter the passing median.'));
  if (r.comparison) surface.append(element('p', 'result-note', r.comparison.warnings[0] ?? 'These observations do not prove an optimization caused a change.'));
  surface.append(stats); result.append(surface);
  const findings = element('div', 'result-findings');
  if (r.findings.length) { findings.append(element('h2', '', 'Worth investigating')); for (const f of r.findings.slice(0, 3)) findings.append(disclosure(f.title, [f.explanation, f.evidence, f.nextAction])); }
  if (r.benchmarks) for (const i of r.benchmarks.invocations.filter(i => i.failureExcerpt)) findings.append(disclosure('Failure details', [i.failureExcerpt]));
  if (r.comparison) findings.append(disclosure('Comparison context', r.comparison.warnings));
  if (r.device) findings.append(disclosure('Computer details', [r.device.cpuModel, `${r.device.node} · ${r.device.os} / ${r.device.architecture}`, `${gib(r.device.totalBytes)} total RAM; ${gib(r.device.freeBytes)} free.`, `Inferred: ${r.device.planning.advice}`, ...r.device.limitations]));
  findings.append(disclosure('Evidence & limitations', [`${r.runs.length} sampled runs. ${r.workflows.length} static workflows.`, ...r.coverage.excluded, ...r.coverage.notes, ...r.limitations]));
  result.append(findings);
  if (base) {
    const links = element('div', 'report-actions');
    for (const [extension, text] of [['html', 'Open complete report'], ['json', 'Download JSON'], ['md', 'Download Markdown']]) {
      const a = element('a', '', text); a.href = `${base}.${extension}`; if (extension === 'html') { a.target = '_blank'; a.rel = 'noopener noreferrer'; } links.append(a);
    }
    result.append(links, disclosure('Saved on this computer', [output, 'report.json and report.md are beside the HTML file.']));
  }
  $('#entry').hidden = true; $('#progress').hidden = true; result.hidden = false; result.focus({ preventScroll: true }); window.scrollTo(0, 0);
}
function updateChoices(reports) {
  for (const name of ['before', 'after']) {
    const select = $(`#${name}`), previous = select.value;
    select.replaceChildren(element('option', '', 'Choose a report')); select.firstElementChild.value = '';
    for (const report of reports) { const option = element('option', '', `${report.label} · ${report.mode} · ${new Date(report.generatedAt).toLocaleTimeString()}`); option.value = report.id; select.append(option); }
    if (reports.some(r => r.id === previous)) select.value = previous;
    else if (reports.length) select.value = reports[Math.max(0, reports.length - (name === 'before' ? 2 : 1))].id;
  }
}
async function refresh() {
  const state = await api('/api/state'); updateChoices(state.reports);
  currentJob = state.job;
  if (currentJob?.status === 'running') {
    lock(true); $('#entry').hidden = true; $('#result').hidden = true; $('#progress').hidden = false;
    $('#progress-text').textContent = currentJob.message;
    setTimeout(() => refresh().catch(connectionLost), 500);
  } else {
    lock(false); $('#progress').hidden = true;
    if (currentJob?.status === 'error') { $('#entry').hidden = false; error(currentJob.message); }
    if (currentJob?.reportId && shownReport !== currentJob.reportId) {
      shownReport = currentJob.reportId; showResult(await api(`/api/reports/${shownReport}`));
      $('#session-status').textContent = currentJob.message;
    }
  }
}
function connectionLost() { lock(true); $('#progress').hidden = true; error('Connection lost. Keep the terminal open and reload this page to check the task.'); }
async function start(data) {
  error(''); lock(true); $('#cancel').disabled = false;
  try { await api('/api/start', data); await refresh(); } catch (e) { lock(false); error(e.message); }
}
function values(form) { return Object.fromEntries(new FormData(form).entries()); }
function handle(form, callback) { $(form).addEventListener('submit', async e => { e.preventDefault(); error(''); try { await callback(values(e.currentTarget)); } catch (e) { error(e.message); } }); }
document.querySelectorAll('[data-task]').forEach((/** @type {HTMLElement} */ el) => el.addEventListener('click', () => choose(el.dataset.task)));
$('#demo').addEventListener('click', () => start({ action: 'demo' }));
handle('#github-form', data => start({ action: 'audit', ...data, runs: Number(data.runs) }));
handle('#doctor-form', () => start({ action: 'doctor' }));
handle('#local-form', data => start({ action: 'local', ...data }));
handle('#compare-form', data => start({ action: 'compare', ...data }));
$('#cancel').addEventListener('click', async () => { $('#cancel').disabled = true; try { await api('/api/cancel', { id: currentJob.id }); } catch (e) { error(e.message); } });
$('#bench-path').addEventListener('input', () => { $('#script-picker').hidden = true; $('#script').replaceChildren(); preparation = null; });
$('#load-scripts').addEventListener('click', async () => {
  error(''); const button = $('#load-scripts'); button.disabled = true;
  try { const project = await api('/api/scripts', { path: $('#bench-path').value }); $('#bench-path').value = project.root;
    $('#script').replaceChildren(...project.scripts.map(name => { const option = element('option', '', name); option.value = name; return option; }));
    $('#script-picker').hidden = false; $('#script').focus();
  } catch (e) { error(e.message); } finally { button.disabled = false; }
});
handle('#bench-form', async data => {
  preparation = await api('/api/prepare', { ...data, warmups: Number(data.warmups), repetitions: Number(data.repetitions), timeout: Number(data.timeout) });
  $('#consent-path').textContent = preparation.root;
  $('#consent-commands').textContent = `npm run ${preparation.script}\n\n${preparation.commands.map(c => `${c.name}: ${c.command}`).join('\n')}`;
  $('#consent-limits').textContent = `${preparation.limits.warmups} warm-up(s), ${preparation.limits.repetitions} measured run(s), ${preparation.limits.timeout}s timeout each. Maximum budget: ${preparation.limits.maximumSeconds}s. Common secrets are redacted in the preview.`;
  $('#allow-run').checked = false; $('#confirm').disabled = true; $('#consent').showModal(); $('#decline').focus();
});
$('#allow-run').addEventListener('change', () => { $('#confirm').disabled = !$('#allow-run').checked; });
async function decline() { $('#consent').close(); preparation = null; try { await api('/api/discard', {}); $('#session-status').textContent = 'Benchmark declined. Nothing executed.'; } catch (e) { error(e.message); } }
$('#decline').addEventListener('click', decline);
$('#consent').addEventListener('cancel', e => { e.preventDefault(); decline(); });
$('#confirm').addEventListener('click', async () => {
  if (!preparation || !$('#allow-run').checked) return;
  const id = preparation.id; preparation = null; $('#consent').close();
  await start({ action: 'bench', preparation: id, consent: true });
});
document.querySelectorAll('[data-import]').forEach((/** @type {HTMLInputElement} */ input) => input.addEventListener('change', async () => {
  const file = input.files[0]; if (!file) return; error('');
  try { if (file.size > 8 * 1024 * 1024) throw new Error('Report exceeds 8 MiB.');
    const imported = await api('/api/import', JSON.parse(await file.text())); await refresh(); $(`#${input.dataset.import}`).value = imported.id;
  } catch (e) { error(e.message); } finally { input.value = ''; }
}));
refresh().catch(connectionLost);
