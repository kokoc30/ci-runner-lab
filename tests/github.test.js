import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectGithub, validateRepo } from '../src/github.js';
const sha='a'.repeat(40);
const raw=(id,extra={})=>({id,run_attempt:2,workflow_id:id%2,name:'CI',head_branch:'main',event:id%2?'push':'pull_request',head_sha:sha,status:'completed',conclusion:'success',created_at:'2026-11-01T00:00:00Z',html_url:null,...extra});
const job=id=>({id,name:'test',status:'completed',conclusion:'success',started_at:'2026-11-01T00:00:00Z',completed_at:'2026-11-01T00:00:01Z',labels:['ubuntu-latest']});
/** @param {(url:string)=>any} responder */
function mock(responder){return async (_command,args)=>{
  assert.equal(args[args.indexOf('--method')+1],'GET');assert.equal(args[args.indexOf('--hostname')+1],'github.com');
  assert.ok(!args.includes('--paginate'));const data=responder(args.at(-1));
  return typeof data==='string'?{code:1,stdout:'',stderr:data,timedOut:false,interrupted:false,truncated:false,durationMs:0}:{code:0,stdout:JSON.stringify(data),stderr:'',timedOut:false,interrupted:false,truncated:false,durationMs:0};
};}
function basic(url){if(url==='repos/owner/repo')return {private:false,default_branch:'main'};if(url.includes('/commits/'))return {sha};if(url.includes('/contents/'))return [];if(url.includes('/actions/runs?'))return {total_count:0,workflow_runs:[]};throw new Error(`Unexpected endpoint: ${url}`);}
for(const repo of ['https://github.com/a/b','a/b;evil','../b','a/..','a/b/c','-a/b','a/']) test(`reject repo ${repo}`,()=>assert.throws(()=>validateRepo(repo)));
test('pagination, >100 matrix jobs and latest attempt only; group metadata retained',async()=>{
  const calls=[];
  const r=await inspectGithub('owner/repo',{runs:2},mock(url=>{
    calls.push(url);
    if(url.includes('/actions/runs?'))return {total_count:2,workflow_runs:[raw(1),raw(2)]};
    if(url.includes('/attempts/2/jobs'))return {total_count:101,jobs:url.endsWith('page=1')?Array.from({length:100},(_,i)=>job(i)): [job(100)]};
    return basic(url);
  }));
  assert.equal(r.status,'complete');assert.equal(r.runs[0].jobs.length,101);assert.equal(r.runs[1].event,'pull_request');
  assert.ok(calls.filter(x=>x.includes('/jobs')).every(x=>x.includes('/attempts/2/')));assert.equal(r.source.revision,sha);
});
test('multiple run pages are bounded and duplicate run IDs ignored',async()=>{
  let pages=0;
  const r=await inspectGithub('owner/repo',{runs:1,workflow:'ci.yml',branch:'feature/a',event:'push'},mock(url=>{
    if(url.includes('/actions/workflows/ci.yml/runs?')){pages++;assert.match(url,/branch=feature%2Fa/);return {total_count:101,workflow_runs:pages===1?Array.from({length:100},(_,i)=>raw(i,{status:'in_progress'})):[raw(101)]};}
    if(url.includes('/jobs?'))return {total_count:0,jobs:[]};return basic(url);
  }));assert.equal(pages,2);assert.equal(r.runs.length,1);
});
test('partial job page failure retains already collected jobs',async()=>{
  const r=await inspectGithub('owner/repo',{runs:1},mock(url=>{
    if(url.includes('/actions/runs?'))return {total_count:1,workflow_runs:[raw(1)]};
    if(url.includes('/jobs?'))return url.endsWith('page=1')?{total_count:101,jobs:Array.from({length:100},(_,i)=>job(i))}:'HTTP 403 denied';
    return basic(url);
  }));assert.equal(r.status,'partial');assert.equal(r.runs[0].jobs.length,100);assert.equal(r.runs[0].jobsComplete,false);assert.match(r.coverage.excluded[0],/403/);
});
/** @type {Array<[string, RegExp]>} */
const errors=[['HTTP 401 bad token',/authentication/],['HTTP 403 denied',/permissions/],['HTTP 404 gone',/404/],['HTTP 429 rate limit',/rate limit/],['offline connection refused',/network/],['please run gh auth login',/authentication/]];
for(const [error,pattern] of errors)test(`GitHub error ${error}`,async()=>{
  const r=await inspectGithub('owner/repo',{},mock(()=>error+' ghp_fakecredential123'));assert.equal(r.status,'partial');assert.match(r.coverage.excluded[0],pattern);assert.ok(!JSON.stringify(r).includes('fakecredential'));
});
test('missing gh produces actionable partial report',async()=>{const r=await inspectGithub('owner/repo',{},async()=>{throw new Error('ENOENT');});assert.match(r.coverage.excluded[0],/install gh/);});
test('timeout produces partial, no retry loop',async()=>{let n=0;const r=await inspectGithub('owner/repo',{},async()=>{n++;return {code:null,stdout:'',stderr:'',timedOut:true,interrupted:false,truncated:false,durationMs:0};});assert.equal(n,1);assert.match(r.coverage.excluded[0],/timed out/);});
test('empty repository history and missing workflow directory are honest empty states',async()=>{const r=await inspectGithub('owner/repo',{},mock(url=>url.includes('/contents/')?'HTTP 404':basic(url)));assert.equal(r.status,'complete');assert.equal(r.runs.length,0);});
test('GET workflow content pinned at source revision and decoded safely',async()=>{
  const r=await inspectGithub('owner/repo',{},mock(url=>{
    if(url.includes('/contents/.github/workflows?'))return [{name:'ci.yml',type:'file',size:50}];
    if(url.includes('/contents/.github/workflows/ci.yml')){assert.ok(url.endsWith(sha));return {encoding:'base64',content:Buffer.from('on: push\njobs: {}').toString('base64')};}
    return basic(url);
  }));assert.deepEqual(r.workflows[0].triggers,['push']);
});
test('transient server error retries once',async()=>{let n=0;const r=await inspectGithub('owner/repo',{},mock(url=>{if(url==='repos/owner/repo'&&n++===0)return 'HTTP 503';return basic(url);}));assert.equal(r.status,'complete');assert.equal(n,2);});
