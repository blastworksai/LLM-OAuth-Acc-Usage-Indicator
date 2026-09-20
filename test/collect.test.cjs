'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createCollector}=require('../src/collect.cjs');
const stamp='2026-09-19T12:00:00Z';
const proc=(pid,ppid,changes={})=>({pid,ppid,uid:1000,start_ticks:String(pid),boot_id:'boot',tty_nr:1,pgrp:pid===10?10:20,tpgid:20,...changes});
const report=()=>({schema_version:1,provider:'codex',session_id:'session-a',
 process:{pid:20,uid:1000,start_ticks:'20',boot_id:'boot'},model:null,plan_type:'pro',
 source:{kind:'codex-session-event',source_event_at:stamp,captured_at:stamp,provider_observed_at:null},
 windows:[],coverage:'Only reported limits.'});
function fixture(changes={}) {
 const processes=[proc(10,1),proc(20,10)];
 const calls=[];
 const deps={platform:'linux',uid:1000,
  processIds:async function*(){for(const p of processes)yield p.pid;},
  getProcess:async pid=>processes.find(p=>p.pid===pid)||null,
  getExecutable:async pid=>pid===20?'/opt/native/codex':'/usr/bin/bash',
  readCodex:async(...args)=>{calls.push(args);return report();},...changes};
 return {collect:createCollector(deps),calls,processes};
}
const options={};
test('selected native Codex is collected directly with bundled Node and sanitized schema',async()=>{
 const f=fixture();const got=await f.collect(10,options);
 assert.equal(got.status,'ready');assert.equal(got.report.plan_type,'pro');assert.equal(got.report.session_id,'session-a');
 assert.equal(f.calls.length,1);
 assert.deepEqual(f.calls[0].slice(0,2),[20,'/opt/native/codex']);
 assert.ok(Number.isFinite(Date.parse(f.calls[0][2])));
});
test('unsupported hosts, other users and non-native executables never spawn a collector',async()=>{
 for(const change of [
  {platform:'darwin'},
  {getProcess:async pid=>pid===10?proc(10,1):proc(20,10,{uid:2000})},
  {getExecutable:async()=>'/usr/bin/node'},
  {getExecutable:async()=>'/opt/native/codex-helper'},
  {getProcess:async()=>null}
 ]) {
  const f=fixture(change);assert.equal(await f.collect(10,options),null);assert.equal(f.calls.length,0);
 }
});
test('background or unrelated Codex cannot be selected from its executable name',async()=>{
 for(const candidate of [proc(20,1),proc(20,10,{tpgid:10})]) {
  const f=fixture({getProcess:async pid=>pid===10?proc(10,1):candidate});
  assert.equal(await f.collect(10,options),null);assert.equal(f.calls.length,0);
 }
});
test('multiple foreground Codex descendants remain ambiguous without collecting either',async()=>{
 const f=fixture({getExecutable:async pid=>pid===10?'/usr/bin/bash':'/opt/native/codex'});
 f.processes.push(proc(30,10));
 assert.equal((await f.collect(10,options)).status,'ambiguous');assert.equal(f.calls.length,0);
});
test('process scan cap allows other report sources; candidate cap refuses incomplete Codex discovery',async()=>{
 for(const count of [8193,33]) {
  const f=fixture({processIds:async function*(){for(let i=0;i<count;i++)yield 100+i;},
   getProcess:async pid=>pid===10?proc(10,1):proc(pid,10),
   getExecutable:async()=>count===33?'/opt/native/codex':'/usr/bin/bash'});
  const result=await f.collect(10,options);
  if(count===8193)assert.equal(result,null);else assert.equal(result.status,'unavailable');
  assert.equal(f.calls.length,0);
 }
});
test('unrelated Codex processes cannot exhaust the selected terminal candidate limit',async()=>{
 for(const hasSelectedCodex of [false,true]) {
  const f=fixture({getExecutable:async pid=>pid===10?'/usr/bin/bash':'/opt/native/codex'});
  f.processes.splice(1,1,...Array.from({length:33},(_,index)=>proc(100+index,1)));
  if(hasSelectedCodex)f.processes.push(proc(20,10));
  const got=await f.collect(10,options);
  if(hasSelectedCodex) {
   assert.equal(got.status,'ready');assert.equal(got.report.process.pid,20);assert.equal(f.calls.length,1);
  } else {
   assert.equal(got,null,'No selected Codex must leave the legacy report fallback available.');
   assert.equal(f.calls.length,0);
  }
 }
});
test('deleted executable suffix is normalized without invoking the vendor',async()=>{
 const f=fixture({getExecutable:async pid=>pid===20?'/opt/native/codex (deleted)':'/usr/bin/bash'});
 assert.equal((await f.collect(10,options)).status,'ready');
 assert.equal(f.calls[0][1],'/opt/native/codex');
});
test('collector failure and timeout never expose stderr or private details',async()=>{
 for(const code of ['ETIMEDOUT','ENOENT','ERR_CHILD_PROCESS_STDIO_MAXBUFFER']) {
  const f=fixture({readCodex:async()=>{throw Object.assign(new Error('/private/path SECRET'),{code,stderr:'SECRET'});}});
  const got=await f.collect(10,options);assert.equal(got.status,'unavailable');
  assert.doesNotMatch(JSON.stringify(got),/SECRET|private/);
 }
});
test('malformed, oversize, foreign-provider and wrong-process output is rejected',async()=>{
 const wrongProvider=report();wrongProvider.provider='claude';wrongProvider.source.kind='claude-statusline';delete wrongProvider.plan_type;
 const wrongBirth=report();wrongBirth.process.start_ticks='21';
 const unknownField={...report(),raw:'PRIVATE'};
 for(const value of ['not JSON','x'.repeat(32769),wrongProvider,wrongBirth,unknownField]) {
  const f=fixture({readCodex:async()=>value});const got=await f.collect(10,options);
  assert.equal(got.status,'unavailable');assert.doesNotMatch(JSON.stringify(got),/PRIVATE|not JSON/);
 }
});
test('process exit, executable change or foreground change during collection invalidates result',async()=>{
 for(const change of ['exit','birth','executable','foreground']) {
  let collected=false;
  const f=fixture({
   getProcess:async pid=>pid===10?proc(10,1,collected&&change==='foreground'?{tpgid:10}:{}):
    collected&&change==='exit'?null:proc(20,10,collected&&change==='birth'?{start_ticks:'new'}:{}),
   getExecutable:async pid=>pid===20?collected&&change==='executable'?'/opt/other/codex':'/opt/native/codex':'/usr/bin/bash',
   readCodex:async()=>{collected=true;return report();}
  });
  assert.equal((await f.collect(10,options)).status,'unavailable',change);
 }
});
test('a selected process changing before invocation is not read',async()=>{
 let lookups=0;
 const f=fixture({getExecutable:async pid=>pid===20&&++lookups>1?'/usr/bin/bash':pid===20?'/opt/native/codex':'/usr/bin/bash'});
 assert.equal((await f.collect(10,options)).status,'unavailable');assert.equal(f.calls.length,0);
});

test('account email binds only to a new usage event and is not relabeled on refresh',async()=>{
 let current=report(),email='first@example.test',queries=0;
 const f=fixture({now:()=>Date.parse('2026-09-19T12:01:00Z'),
  readCodex:async()=>current,
  readAccount:async()=>{queries++;return email;}});
 assert.equal((await f.collect(10,options)).report.account,undefined,'pre-existing event is a baseline');
 assert.equal(queries,0);
 current.source.source_event_at='2026-09-19T12:02:00Z';
 const fresh=await f.collect(10,options);
 assert.deepEqual(fresh.report.account,{email:'first@example.test',source:'codex-account-read',
  usage_event_at:'2026-09-19T12:02:00Z',observed_at:'2026-09-19T12:01:00.000Z'});
 email='second@example.test';
 assert.deepEqual((await f.collect(10,options)).report.account,fresh.report.account);
 assert.equal(queries,1,'same event must not query the current profile again');
 current.source.source_event_at='2026-09-19T12:03:00Z';
 assert.equal((await f.collect(10,options)).report.account.email,'second@example.test');
 assert.equal(queries,2);
});

test('first event since collector start can be sampled immediately',async()=>{
 const f=fixture({now:()=>Date.parse(stamp),readAccount:async()=> 'new@example.test'});
 assert.equal((await f.collect(10,options)).report.account?.email,'new@example.test');
});

test('a failed lookup for a new event clears the prior identity without losing usage',async()=>{
 for(const failure of [null,'bad email',new Error('SECRET private profile')]) {
  let current=report(),queries=0;
  const f=fixture({now:()=>Date.parse(stamp),readCodex:async()=>current,
   readAccount:async()=>{if(++queries===1)return 'first@example.test';if(failure instanceof Error)throw failure;return failure;}});
  assert.equal((await f.collect(10,options)).report.account?.email,'first@example.test');
  current.source.source_event_at='2026-09-19T12:01:00Z';
  const next=await f.collect(10,options);
  assert.equal(next.status,'ready');assert.equal(next.report.plan_type,'pro');assert.equal(next.report.account,undefined);
  assert.equal((await f.collect(10,options)).report.account,undefined);
  assert.equal(queries,2,'failed same-event samples are not retried');
  assert.doesNotMatch(JSON.stringify(next),/SECRET|private profile/);
 }
});

test('missing timestamps or native subscription provenance never triggers an account query',async()=>{
 for(const changes of [{plan_type:null},{plan_type:undefined},
  {plan_type:null,source:{...report().source,source_event_at:null}}]) {
  let queries=0;
  const f=fixture({now:()=>Date.parse(stamp),readCodex:async()=>({...report(),...changes}),
   readAccount:async()=>{queries++;return 'wrong@example.test';}});
  const got=await f.collect(10,options);
  assert.equal(got.status,'ready');assert.equal(got.report.account,undefined);assert.equal(queries,0);
 }
});

test('account cache is isolated by process birth and session and never applied to older events',async()=>{
 let current=report(),birth='20',queries=0;
 const f=fixture({now:()=>Date.parse(stamp),getProcess:async pid=>pid===10?proc(10,1):proc(20,10,{start_ticks:birth}),
  readCodex:async()=>current,readAccount:async()=>`account${++queries}@example.test`});
 assert.equal((await f.collect(10,options)).report.account?.email,'account1@example.test');
 current.session_id='session-b';current.source.source_event_at='2026-09-19T11:59:00Z';
 assert.equal((await f.collect(10,options)).report.account,undefined);
 current.source.source_event_at=stamp;
 assert.equal((await f.collect(10,options)).report.account?.email,'account2@example.test');
 birth='21';current.process.start_ticks=birth;current.source.source_event_at='2026-09-19T11:59:00Z';
 assert.equal((await f.collect(10,options)).report.account,undefined);
 current.source.source_event_at='2026-09-19T12:01:00Z';
 assert.equal((await f.collect(10,options)).report.account?.email,'account3@example.test');
 current.source.source_event_at='2026-09-19T11:58:00Z';
 assert.equal((await f.collect(10,options)).report.account,undefined);
 assert.equal(queries,3);
});

test('account samples for concurrent reads of the same event are coalesced',async()=>{
 let release,queries=0;
 const pending=new Promise(resolve=>{release=resolve;});
 const f=fixture({now:()=>Date.parse(stamp),readAccount:async()=>{queries++;await pending;return 'one@example.test';}});
 const first=f.collect(10,options),second=f.collect(10,options);
 await new Promise(resolve=>setImmediate(resolve));release();
 const results=await Promise.all([first,second]);
 assert.equal(queries,1);assert.deepEqual(results[0].report.account,results[1].report.account);
 assert.equal(results[0].report.account?.email,'one@example.test');
});

test('session cache evicts old entries instead of retaining every observed identity',async()=>{
 let current=report(),queries=0;
 const f=fixture({now:()=>Date.parse(stamp),readCodex:async()=>current,
  readAccount:async()=>`account${++queries}@example.test`});
 assert.equal((await f.collect(10,options)).report.account?.email,'account1@example.test');
 for(let index=0;index<70;index++) {current.session_id=`later-${index}`;await f.collect(10,options);}
 current.session_id='session-a';
 assert.equal((await f.collect(10,options)).report.account,undefined);
 current.source.source_event_at='2026-09-19T12:01:00Z';
 assert.notEqual((await f.collect(10,options)).report.account?.email,'account1@example.test');
});

test('process and foreground changes during the account query invalidate the combined result',async()=>{
 for(const change of ['exit','birth','executable','foreground']) {
  let queried=false;
  const f=fixture({now:()=>Date.parse(stamp),
   getProcess:async pid=>pid===10?proc(10,1,queried&&change==='foreground'?{tpgid:10}:{}):
    queried&&change==='exit'?null:proc(20,10,queried&&change==='birth'?{start_ticks:'21'}:{}),
   getExecutable:async pid=>pid===20?queried&&change==='executable'?'/other/codex':'/opt/native/codex':'/usr/bin/bash',
   readAccount:async()=>{queried=true;return 'valid@example.test';}});
  assert.equal((await f.collect(10,options)).status,'unavailable',change);
 }
});
