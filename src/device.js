import os from 'node:os';
import { statfs, mkdir } from 'node:fs/promises';
import { runProcess } from './process.js';

const GiB = 2 ** 30;
/** Conservative planning only; process limits may be unknown.
 * @param {{parallelism:number,totalBytes:number,freeBytes:number,memoryLimitBytes:number|null,availableBytes?:number|null}} d
 */
export function capacity(d) {
  const cpuSlots = Math.max(1, d.parallelism - Math.max(1, Math.ceil(d.parallelism / 4)));
  const bufferBytes = Math.max(2 * GiB, d.totalBytes / 4);
  const free = Math.min(d.freeBytes, d.availableBytes ?? d.freeBytes, d.memoryLimitBytes ?? d.freeBytes);
  const spareBytes = Math.max(0, free - bufferBytes);
  const workers = Math.min(4, cpuSlots, Math.floor(spareBytes / (2 * GiB)));
  return { cpuSlots, bufferBytes, spareBytes, workers, workerAssumptionBytes: 2 * GiB,
    confidence: d.memoryLimitBytes === null ? 'inferred; effective memory limit unknown' : 'inferred',
    advice: workers === 0 ? 'Postpone benchmarking: the spare-memory estimate cannot support one worker.' :
      `Consider 1–${workers} test workers initially, subject to workload measurement.` };
}

/** Portable snapshot; no identifiers or exhaustive VM detection. */
export async function inspectDevice(outputRoot, system = os) {
  const safe = fn => { try { return fn(); } catch { return null; } };
  const cpus = safe(() => system.cpus()) ?? [];
  const totalBytes = system.totalmem(), freeBytes = system.freemem();
  const limit = safe(() => process.constrainedMemory?.());
  const memoryLimitBytes = limit > 0 ? Math.min(limit, totalBytes) : null;
  const available = safe(() => process.availableMemory?.());
  const d = { os: system.platform(), osRelease: system.release(), architecture: system.arch(), node: process.version,
    cpuModel: cpus[0]?.model ?? null, logicalCpus: cpus.length || null,
    parallelism: system.availableParallelism(), totalBytes, freeBytes, memoryLimitBytes,
    availableBytes: available > 0 ? available : null, diskFreeBytes: null, npm: null, githubCli: 'unavailable' };
  try { await mkdir(outputRoot, { recursive: true }); const s = await statfs(outputRoot); d.diskFreeBytes = s.bavail * s.bsize; } catch { /* Optional. */ }
  try { const r = await runProcess('npm', ['--version']); if (r.code === 0) d.npm = r.stdout.trim(); } catch { /* Optional. */ }
  try { const r = await runProcess('gh', ['--version']); d.githubCli = r.code === 0 ? 'installed; login checked during GitHub audit' : 'unavailable'; } catch { /* Optional, offline readiness probe only. */ }
  return { ...d, planning: capacity(d), limitations: [
    'Architecture describes the Node runtime; emulation is possible. Container/VM limits may be unknown.',
    'Worker advice assumes 2 GiB per worker. It does not allocate resources or enforce CPU/RAM limits.',
    'One npm invocation can create many processes. Measure the trusted workload before increasing parallelism.'
  ] };
}
