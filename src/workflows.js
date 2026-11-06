import { readdir, realpath, stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseDocument } from 'yaml';

export const MAX_FILE_BYTES = 1024 * 1024;
export const inside = (root, file) => { const r = path.relative(root, file); return r === '' || (!r.startsWith('..' + path.sep) && r !== '..' && !path.isAbsolute(r)); };
const strings = v => typeof v === 'string' ? [v] : Array.isArray(v) ? v.filter(x => typeof x === 'string') : [];
const display = v => v == null ? null : typeof v === 'string' ? v : JSON.stringify(v);

/** YAML 1.2; reject duplicates, bound aliases, preserve unresolved expressions. */
export function parseWorkflow(text, file) {
  if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new Error('Workflow exceeds 1 MiB.');
  const doc = parseDocument(text, { version: '1.2', uniqueKeys: true, merge: false });
  if (doc.errors.length) throw new Error(`Invalid YAML: ${doc.errors[0].code}`);
  const data = doc.toJS({ maxAliasCount: 30 });
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Workflow must be a mapping.');
  const jobs = Object.entries(data.jobs ?? {}).slice(0, 1000).map(([id, j]) => {
    if (!j || typeof j !== 'object') throw new Error('Job must be a mapping.');
    const runners = strings(j['runs-on']);
    return { id, name: typeof j.name === 'string' ? j.name : id, runners,
      unresolvedRunner: Boolean(j['runs-on'] && (!runners.length || runners.some(x => x.includes('${{')))),
      needs: strings(j.needs), timeoutMinutes: typeof j['timeout-minutes'] === 'number' ? j['timeout-minutes'] : null,
      concurrency: display(j.concurrency), permissions: display(j.permissions),
      services: Boolean(j.services), container: Boolean(j.container), matrix: Boolean(j.strategy?.matrix),
      reusable: typeof j.uses === 'string' ? j.uses : null };
  });
  const triggers = typeof data.on === 'string' ? [data.on] : Array.isArray(data.on) ? strings(data.on) : Object.keys(data.on ?? {});
  return { file, name: typeof data.name === 'string' ? data.name : file, triggers, jobs,
    concurrency: display(data.concurrency), permissions: display(data.permissions) };
}

/** Read only selected .github/workflows files, no traversal of project code. */
export async function inspectWorkflows(target) {
  const root = await realpath(target);
  if (!(await stat(root)).isDirectory()) throw new Error('Audit path must be a directory.');
  const workflows = [], excluded = [];
  const dir = path.join(root, '.github', 'workflows');
  let entries;
  try { const resolved = await realpath(dir); if (!inside(root, resolved)) return { workflows, excluded: ['Workflow directory symlink escapes selected root.'] }; entries = await readdir(dir); }
  catch (e) { if (e.code === 'ENOENT') return { workflows, excluded }; throw e; }
  const files = entries.filter(n => /\.ya?ml$/i.test(n)).sort();
  if (files.length > 100) excluded.push(`${files.length - 100} files excluded by the 100-file cap.`);
  for (const file of files.slice(0, 100)) {
    try {
      const resolved = await realpath(path.join(dir, file));
      if (!inside(root, resolved)) throw new Error('Symlink escapes selected root.');
      const s = await stat(resolved);
      if (!s.isFile() || s.size > MAX_FILE_BYTES) throw new Error('Not a regular file or exceeds 1 MiB.');
      workflows.push(parseWorkflow(await readFile(resolved, 'utf8'), file));
    } catch (e) { excluded.push(`${file}: ${e.message}`); }
  }
  return { workflows, excluded };
}
