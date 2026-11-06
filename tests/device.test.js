import test from 'node:test';
import assert from 'node:assert/strict';
import { capacity, inspectDevice } from '../src/device.js';
import os from 'node:os';
const GiB = 2 ** 30;
/** @type {Array<[string,number,number,number,number|null,number]>} */
const cases = [
  ['small',2,4,4,4,1], ['mid',8,16,12,16,4], ['large',64,128,100,128,4],
  ['low free',8,16,1,16,0], ['smaller limit',8,16,12,3,0], ['unknown limit',8,16,12,null,4], ['single CPU',1,8,8,8,1]
];
for (const [name,cpu,total,free,limit,want] of cases) test(`capacity: ${name}`, () => {
  const p=capacity({parallelism:cpu,totalBytes:total*GiB,freeBytes:free*GiB,memoryLimitBytes:limit===null?null:limit*GiB});
  assert.equal(p.workers,want); assert.ok(p.cpuSlots>=1); assert.ok(p.bufferBytes>=2*GiB);
  if (!want) assert.match(p.advice,/Postpone/);
  if (limit===null) assert.match(p.confidence,/unknown/);
});
test('process available memory further bounds free memory',()=>assert.equal(capacity({parallelism:8,totalBytes:16*GiB,freeBytes:12*GiB,memoryLimitBytes:16*GiB,availableBytes:GiB}).workers,0));
test('device tolerates unavailable disk; collects no identity fields',async()=>{
  const d=await inspectDevice('\0'); assert.equal(d.diskFreeBytes,null);
  assert.ok(d.parallelism>0); assert.ok(!('hostname' in d)); assert.ok(!('username' in d));
});
test('unavailable CPU metadata does not prevent useful inspection',async()=>{const d=await inspectDevice('\0',{...os,cpus:()=>{throw new Error('unavailable');}});assert.equal(d.cpuModel,null);assert.equal(d.logicalCpus,null);assert.ok(d.parallelism>0);});
