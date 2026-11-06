import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import { parseWorkflow, inspectWorkflows, MAX_FILE_BYTES, inside } from '../src/workflows.js';
test('YAML 1.2 on, runners, needs, permissions, services, matrix and reuse',()=>{
  const w=parseWorkflow('on: [push, pull_request]\npermissions: read-all\njobs:\n  a:\n    runs-on: ubuntu-latest\n    timeout-minutes: 5\n    services: { db: { image: postgres } }\n  b:\n    runs-on: [self-hosted, x64]\n    needs: a\n    strategy: { matrix: { node: [22, 24] } }\n  c:\n    uses: org/repo/.github/workflows/test.yml@main\n  d:\n    runs-on: ${{ matrix.os }}\n','ci.yml');
  assert.deepEqual(w.triggers,['push','pull_request']); assert.equal(w.jobs[0].services,true);
  assert.equal(w.jobs[0].timeoutMinutes,5); assert.deepEqual(w.jobs[1].runners,['self-hosted','x64']);
  assert.equal(w.jobs[1].matrix,true); assert.ok(w.jobs[2].reusable); assert.equal(w.jobs[3].unresolvedRunner,true);
});
for(const [name,text] of [['malformed','jobs: ['],['duplicate','on: push\non: pull_request'],['aliases','a: &a [x,x,x,x,x,x,x,x,x,x]\nb: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a,*a]\nc: [*b,*b,*b,*b,*b,*b,*b,*b]'],['oversized','x'.repeat(MAX_FILE_BYTES+1)]]) test(`rejects ${name}`,()=>assert.throws(()=>parseWorkflow(text,'bad.yml')));
test('prototype keys cannot mutate prototypes',()=>{ parseWorkflow('__proto__: { polluted: yes }\non: push\njobs: {}','x.yml'); assert.equal(Object.prototype['polluted'],undefined); });
test('empty, path with spaces, bounded file discovery and escaping directory junction',async()=>{
  await mkdir('.ci-runner-lab',{recursive:true}); const root=await mkdtemp(path.resolve('.ci-runner-lab/workflow space-'));
  try {
    const target=path.join(root,'target');await mkdir(target);
    assert.equal((await inspectWorkflows(target)).workflows.length,0);
    const dir=path.join(target,'.github','workflows');await mkdir(dir,{recursive:true});
    await writeFile(path.join(dir,'ci.yml'),'on: push\njobs: { a: { runs-on: ubuntu-latest } }');
    await writeFile(path.join(dir,'huge.yaml'),' '.repeat(MAX_FILE_BYTES+1));
    let r=await inspectWorkflows(target);assert.equal(r.workflows.length,1);assert.equal(r.excluded.length,1);
    for(let i=0;i<100;i++)await writeFile(path.join(dir,`file${i}.yml`),'on: push');
    r=await inspectWorkflows(target);assert.ok(r.excluded.some(x=>x.includes('100-file cap')));
    const escaped=path.join(root,'escaped');await mkdir(path.join(escaped,'.github'),{recursive:true});
    await symlink(dir,path.join(escaped,'.github','workflows'),process.platform==='win32'?'junction':'dir');
    assert.match((await inspectWorkflows(escaped)).excluded[0],/escapes/);
  } finally { await rm(root,{recursive:true,force:true}); }
});
test('path containment rejects siblings and other volumes',()=>{ assert.equal(inside(path.resolve('a'),path.resolve('ab')),false);assert.equal(inside(path.resolve('a'),path.resolve('a','b')),true); });
