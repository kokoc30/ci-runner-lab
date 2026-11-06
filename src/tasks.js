import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createReport, readReport, writeReport } from './report.js';
import { inspectDevice } from './device.js';
import { inspectWorkflows } from './workflows.js';
import { inspectGithub } from './github.js';
import { analyze, compareReports } from './analysis.js';
import { prepareBenchmark, benchmark } from './benchmark.js';
import { runProcess } from './process.js';

/** One orchestration path for terminal and browser; consent is checked before execution. */
export async function runTask(command, o = {}, { outputRoot = path.resolve(o.out ?? '.ci-runner-lab/reports'),
  files = [], comparison = undefined, prepared = undefined, allowExec = false, signal = undefined,
  onProgress = (_message) => {} } = {}) {
  onProgress(command === 'demo' ? 'Loading the synthetic demo…' : 'Collecting local context…');
  let r = createReport(command);
  if (command === 'demo') {
    Object.assign(r, JSON.parse(await readFile(new URL('../fixtures/demo.json', import.meta.url), 'utf8')));
    r.generatedAt = new Date().toISOString(); r.toolVersion = createReport(command).toolVersion;
  } else if (command === 'doctor') {
    r.device = await inspectDevice(outputRoot);
  } else if (command === 'audit') {
    r.device = await inspectDevice(outputRoot);
    if (o.repo) {
      onProgress('Reading GitHub workflows and recent runs…');
      Object.assign(r, await inspectGithub(o.repo, { runs: Number(o.runs ?? 10), workflow: o.workflow, branch: o.branch, event: o.event }, (cmd, args, options) => {
        if (signal?.aborted) throw new Error('Interrupted');
        return runProcess(cmd, args, { ...options, signal });
      }));
    }
    else {
      const target = path.resolve(o.path);
      r.source = { kind: 'local', label: target, private: null, revision: null };
      const data = await inspectWorkflows(target); r.workflows = data.workflows;
      r.coverage.excluded = data.excluded;
      r.coverage.notes.push('Local YAML only; no repository code executed. Visibility and historical timing are unknown.');
      if (data.excluded.length) r.status = 'partial';
    }
  } else if (command === 'bench') {
    if (!prepared || !allowExec) throw new Error('Execution denied; review and confirm the benchmark first.');
    r.source = { kind: 'local', label: prepared.root, private: null, revision: null };
    r.device = await inspectDevice(outputRoot);
    const current = await prepareBenchmark(prepared.root, prepared.script, prepared.limits);
    if (current.fingerprint !== prepared.fingerprint) throw new Error('package.json changed. Review the benchmark again.');
    onProgress('Running the trusted npm script…');
    r.benchmarks = await benchmark(current, { allowExec: true, signal });
    r.source.revision = r.benchmarks.commit;
    if (r.benchmarks.status !== 'passed') r.status = r.benchmarks.status === 'interrupted' ? 'interrupted' : 'failed';
  } else if (command === 'compare') {
    let before, after;
    [before, after] = comparison ?? await Promise.all(files.map(readReport));
    r.source.label = `${before.source.label} → ${after.source.label}`;
    r.source.kind = 'saved reports'; r.source.private = before.source.private === true || after.source.private === true ? true : null;
    r.comparison = compareReports(before, after);
    r.coverage.notes.push(`Before: ${before.generatedAt} (${before.mode}); after: ${after.generatedAt} (${after.mode}).`, ...r.comparison.warnings);
  }
  if (signal?.aborted) r.status = 'interrupted';
  onProgress('Writing your report…');
  r = analyze(r, { monthlyRuns: o['monthly-runs'], powerWatts: o['power-watts'], kwhPrice: o['kwh-price'] });
  const output = await writeReport(r, outputRoot);
  return { report: r, output };
}
