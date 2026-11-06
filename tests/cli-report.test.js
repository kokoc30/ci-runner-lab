import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { argumentsFor, wizard } from '../src/cli.js';
import { createReport, validateReport, readReport, writeReport, htmlReport, markdownReport, safeUrl, publishDirectory } from '../src/report.js';
import { analyze } from '../src/analysis.js';
const cli=path.resolve('src/cli.js');
const invoke=(args,options={})=>spawnSync(process.execPath,[cli,...args],{encoding:'utf8',timeout:30000,...options});
async function output(t){await mkdir('.ci-runner-lab',{recursive:true});const dir=await mkdtemp(path.resolve('.ci-runner-lab/report test-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
test('help and non-TTY invocations never prompt',()=>{assert.match(invoke(['--help']).stdout,/--allow-exec/);const r=invoke([]);assert.equal(r.status,2);assert.match(r.stderr,/noninteractive/);});
for(const args of [['wat'],['audit'],['audit','--path','.','--repo','a/b'],['audit','--repo','../bad'],['audit','--repo','a/b','--runs','51'],['bench','--path','.','--script','test','--timeout','0'],['compare','one'],['demo','--open','--no-open'],['demo','--monthly-runs','-1'],['--unknown']])test(`CLI rejects ${args.join(' ')}`,()=>{assert.throws(()=>argumentsFor(args));});
test('wizard default demo, back, cancel and EOF',async()=>{
  const choose=async list=>wizard(async()=>list.shift()??null,()=>{});
  assert.equal((await choose([''])).command,'demo');assert.equal((await choose(['4','back','2'])).command,'doctor');
  assert.equal(await choose(['6',null]),null);assert.equal(await choose(['0']),null);assert.equal(await choose(['5','.','cancel','0']),null);
});
test('real demo path works offline with clean JSON stdout and consistent companions',async t=>{
  const dir=await output(t), r=invoke(['demo','--no-open','--json','--out',dir],{env:{...process.env,GH_TOKEN:'',GITHUB_TOKEN:''}});
  assert.equal(r.status,0,r.stderr);const data=JSON.parse(r.stdout);assert.equal(data.mode,'demo');assert.equal(data.source.kind,'synthetic');
  const htmlPath=r.stderr.match(/Report: (.+)/)[1].trim();
  const exported=await readReport(path.join(path.dirname(htmlPath),'report.json'));assert.deepEqual(exported,data);
  const html=await readFile(htmlPath,'utf8'),md=await readFile(path.join(path.dirname(htmlPath),'report.md'),'utf8');
  for(const s of [html,md]){assert.match(s,/SYNTHETIC DEMO/);assert.match(s,/2026-/);assert.match(s,/0\.0000/);}
  const second=await writeReport(data,dir);assert.notEqual(second,htmlPath);
});
test('doctor and local audit work when optional tools are absent and do not touch target',async t=>{
  const dir=await output(t), target=path.join(dir,'target');await mkdir(target);await writeFile(path.join(target,'package.json'),'malformed: audits never read or execute me');
  const env={...process.env,PATH:'',Path:'',CI:'1'};
  for(const args of [['doctor'],['audit','--path',target]]){const r=invoke([...args,'--no-open','--json','--out',path.join(dir,'reports')],{env});assert.equal(r.status,0,r.stderr);const model=JSON.parse(r.stdout);assert.equal(model.device.githubCli,'unavailable');}
  assert.equal(await readFile(path.join(target,'package.json'),'utf8'),'malformed: audits never read or execute me');
});
test('CLI denied benchmark and failures have helpful exit codes',async t=>{
  const denied=invoke(['bench','--path','.','--script','test','--no-open']);assert.equal(denied.status,2);assert.match(denied.stderr,/Maximum execution budget: 480s/);
  const dir=await output(t);await writeFile(path.join(dir,'package.json'),JSON.stringify({scripts:{bad:'node -e "process.exit(5)"'}}));
  const failed=invoke(['bench','--path',dir,'--script','bad','--allow-exec','--no-open','--out',path.join(dir,'reports'),'--json']);assert.equal(failed.status,1,failed.stderr);assert.equal(JSON.parse(failed.stdout).status,'failed');
});
test('CLI partial remote data retains useful report and exit 1 without fallback demo',async t=>{
  const r=invoke(['audit','--repo','owner/repo','--no-open','--json','--out',await output(t)],{env:{...process.env,PATH:'',Path:'',CI:'1'}});
  assert.equal(r.status,1,r.stderr);const model=JSON.parse(r.stdout);assert.equal(model.mode,'audit');assert.equal(model.status,'partial');assert.match(model.coverage.excluded.join(' '),/install gh/);
});
test('import schema missing fields negative and nonfinite values rejected',async t=>{
  const r=analyze(createReport('doctor'));assert.equal(validateReport(r),r);
  for(const patch of [{schemaVersion:99},{runs:[{}]},{device:{}},{costScenario:{knownSubtotalUsd:-1}},{metrics:{groups:[{span:{n:2,medianMs:-3}}],longestJobs:[]}}])assert.throws(()=>validateReport({...r,...patch}));
  const copy=structuredClone(r);copy.costScenario.knownJobs=NaN;assert.throws(()=>validateReport(copy));
  const dir=await output(t),big=path.join(dir,'big.json');await writeFile(big,' '.repeat(8*1024*1024+1));await assert.rejects(()=>readReport(big),/8 MiB/);
});
test('unsafe HTML and links escaped, private and partial states visible in all formats',async()=>{
  const r=analyze(createReport('audit',{kind:'github',label:'<img src=x onerror=alert(1)>',private:true,revision:null}));
  r.status='partial';r.coverage.excluded=['<script>alert(1)</script>'];r.source['url']='javascript:alert(1)';
  const html=await htmlReport(r),md=markdownReport(r);assert.ok(!html.includes('<script>'));assert.match(html,/&lt;img/);assert.ok(!html.includes('href="javascript:'));
  for(const s of [html,md]){assert.match(s,/PRIVATE METADATA/);assert.match(s,/partial/i);assert.ok(!s.includes('<img'));}
  for(const u of ['https://evil.test','javascript:alert(1)','https://user:pass@github.com','https://github.com.evil.test'])assert.equal(safeUrl(u),null);
});
test('compare command uses saved validated reports and warns about overlapping demo samples',async t=>{
  const dir=await output(t);const d=JSON.parse(await readFile('fixtures/demo.json','utf8'));analyze(d);const first=await writeReport(d,dir);const p=path.join(path.dirname(first),'report.json');
  const result=invoke(['compare',p,p,'--no-open','--json','--out',dir]);assert.equal(result.status,0,result.stderr);const r=JSON.parse(result.stdout);assert.equal(r.comparison.comparable,false);assert.ok(r.comparison.warnings.some(x=>/overlap/.test(x)));
});
for (const code of ['EPERM', 'EACCES', 'EBUSY']) test(`atomic publication retries transient Windows ${code} locks`,async()=>{let calls=0;const waits=[];await publishDirectory('owned-temp','new-report',{platform:'win32',move:async()=>{if(++calls<3)throw Object.assign(new Error('locked'),{code});},pause:async ms=>{waits.push(ms);}});assert.equal(calls,3);assert.deepEqual(waits,[50,100]);});
test('atomic publication bounds retries and preserves permanent failures',async()=>{
  /** @type {Array<[NodeJS.Platform,string,number]>} */
  const cases=[['win32','EPERM',5],['win32','ENOSPC',1],['linux','EPERM',1]];
  for(const [platform,code,want] of cases){let calls=0;await assert.rejects(()=>publishDirectory('owned-temp','new-report',{platform,move:async()=>{calls++;throw Object.assign(new Error('failed'),{code});},pause:async()=>{}}),/failed/);assert.equal(calls,want);}
});
