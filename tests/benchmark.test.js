import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { prepareBenchmark, benchmark, benchmarkLimits } from '../src/benchmark.js';
import { runProcess, childEnvironment, sanitize } from '../src/process.js';

async function target(t){await mkdir('.ci-runner-lab',{recursive:true});const root=await mkdtemp(path.resolve('.ci-runner-lab/npm space ü-'));t.after(()=>rm(root,{recursive:true,force:true}));await writeFile(path.join(root,'package.json'),JSON.stringify({scripts:{ok:'node ok.cjs',bad:'node -e "process.exit(7)"',tree:'node tree.cjs'}}));await writeFile(path.join(root,'ok.cjs'),'console.log("ok")');return root;}
test('no consent starts no child (including git)',async t=>{const p=await prepareBenchmark(await target(t),'ok');let calls=0;await assert.rejects(()=>benchmark(p,{},async()=>{calls++;throw new Error('called');}),/denied/);assert.equal(calls,0);});
test('invalid or missing script rejected before execution',async t=>{const root=await target(t);for(const s of ['bad;cmd','--help','missing','../ok'])await assert.rejects(()=>prepareBenchmark(root,s));});
test('bounded overrides and maximum execution budget',()=>{assert.equal(benchmarkLimits().maximumSeconds,480);for(const v of [{warmups:3},{repetitions:0},{timeout:601},{timeout:NaN}])assert.throws(()=>benchmarkLimits(v));});
test('real npm spawning supports spaces and Unicode, warmups excluded',async t=>{const p=await prepareBenchmark(await target(t),'ok',{warmups:1,repetitions:2});const b=await benchmark(p,{allowExec:true});assert.equal(b.status,'passed');assert.equal(b.invocations.length,3);assert.equal(b.summary.n,2);assert.ok(b.summary.medianMs>0);});
test('failure aborts warmup and has no passing speed distribution',async t=>{const b=await benchmark(await prepareBenchmark(await target(t),'bad'),{allowExec:true});assert.equal(b.status,'failed');assert.equal(b.invocations.length,1);assert.equal(b.invocations[0].exitCode,7);assert.equal(b.summary.n,0);assert.equal(b.summary.medianMs,null);});
test('sequential execution and bounded sanitized failure excerpts',async t=>{const p=await prepareBenchmark(await target(t),'ok');let active=0,max=0;const b=await benchmark(p,{allowExec:true},async command=>{active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,5));active--;return {code:command==='git'?1:0,stdout:'',stderr:'',durationMs:10,timedOut:false,interrupted:false,truncated:false};});assert.equal(max,1);assert.equal(b.summary.n,3);assert.ok(!sanitize('token=abc ghp_123abc').includes('123abc'));});
test('child environment removes known credentials case-insensitively',()=>{assert.deepEqual(childEnvironment({PATH:'ok',GH_TOKEN:'x',GITHUB_TOKEN:'x',NODE_AUTH_TOKEN:'x',npm_config_password:'x',NPM_TOKEN:'x'}),{PATH:'ok'});});
test('output cap terminates only its invocation and does not save full output',async()=>{const r=await runProcess(process.execPath,['-e','setInterval(()=>process.stdout.write("x".repeat(1024)),1)'],{maxBytes:4096,timeoutMs:10000});assert.equal(r.truncated,true);assert.ok(Buffer.byteLength(r.stdout)<=4096);});

for(const mode of ['timeout','interrupt'])test(`${mode} cleans controlled child and grandchild`,async t=>{
  const root=await target(t);
  await writeFile(path.join(root,'tree.cjs'),`const {spawn}=require('node:child_process'),fs=require('node:fs');const c=spawn(process.execPath,['-e',\`const {spawn}=require('node:child_process'),fs=require('node:fs');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)']);fs.writeFileSync('grand.pid',String(c.pid));setInterval(()=>{},1000);\`],{stdio:'inherit'});fs.writeFileSync('child.pid',String(c.pid));setInterval(()=>{},1000);`);
  const controller=new AbortController();
  const pending=benchmark(await prepareBenchmark(root,'tree',{warmups:0,repetitions:1,timeout:mode==='timeout'?1:15}),{allowExec:true,signal:controller.signal});
  if(mode==='interrupt'){
    let ready=false;for(let i=0;i<100;i++){try{await readFile(path.join(root,'grand.pid'));ready=true;break;}catch{await new Promise(r=>setTimeout(r,50));}}
    assert.equal(ready,true);controller.abort();
  }
  const b=await pending;assert.equal(b.status,mode==='timeout'?'failed':'interrupted');assert.equal(b.summary.n,0);
  for(const f of ['child.pid','grand.pid']){const pid=Number(await readFile(path.join(root,f),'utf8'));let alive=true;for(let i=0;i<40;i++){try{process.kill(pid,0);await new Promise(r=>setTimeout(r,50));}catch{alive=false;break;}}assert.equal(alive,false,`owned descendant ${f} must terminate`);}
});
