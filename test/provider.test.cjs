'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {createProviderDetector}=require('../src/provider.cjs');
const proc=(pid,ppid,changes={})=>({pid,ppid,uid:1000,start_ticks:String(pid),boot_id:'boot',tty_nr:1,pgrp:pid===10?10:20,tpgid:20,...changes});
const identity={pid:20,uid:1000,start_ticks:'20',boot_id:'boot'};
function fixture(changes={}) {
 const processes=[proc(10,1),proc(20,10)];
 const paths=new Map([['/opt/tools/claude','/opt/releases/claude/2.0.0'],['/opt/tools/codex','/opt/releases/codex/1.0.0'],['/opt/tools/agy','/opt/releases/agy/1.0.0']]);
 const dependencies={platform:'linux',uid:1000,env:{PATH:'/opt/tools'},home:'/home/example',
  processIds:async function*(){for(const p of processes)yield p.pid;},
  getProcess:async pid=>processes.find(p=>p.pid===pid)||null,
  getExecutable:async pid=>pid===20?'/opt/releases/claude/2.0.0':'/usr/bin/bash',
  resolveExecutable:async lookup=>paths.get(lookup)||null,...changes};
 return {detect:createProviderDetector(dependencies),processes,paths};
}

test('a foreground native Claude, Codex or AGY is detected through its stable CLI lookup',async()=>{
 for(const [provider,command,version] of [['claude','claude','2.0.0'],['codex','codex','1.0.0'],['antigravity','agy','1.0.0']]) {
  const f=fixture({getExecutable:async pid=>pid===20?`/opt/releases/${command}/${version}`:'/usr/bin/bash'});
  assert.deepEqual(await f.detect(10),{provider,cliPath:`/opt/tools/${command}`,process:identity});
 }
});
test('shells, unknown binaries and unsupported hosts produce no setup suggestion',async()=>{
 for(const changes of [
  {platform:'win32'}, {platform:'darwin'}, {getProcess:async()=>null},
  {getExecutable:async()=>'/usr/bin/bash'}, {getExecutable:async()=>'/opt/native/unknown-codex'},
  {getExecutable:async()=>'/unknown/claude'}, {getExecutable:async()=>'/unknown/agy'},
  {getExecutable:async()=>'/usr/bin/node'}, {getExecutable:async()=>'/opt/releases/claude/2.0.0 (deleted)'}
 ]) assert.equal(await fixture(changes).detect(10),null);
});
test('background jobs, another terminal and another user cannot select a provider',async()=>{
 for(const candidate of [proc(20,1),proc(20,10,{pgrp:30}),proc(20,10,{tty_nr:2,tpgid:30}),proc(20,10,{uid:2000})]) {
  const f=fixture();f.processes[1]=candidate;
  assert.equal(await f.detect(10),null);
 }
 const f=fixture();f.processes[0].uid=2000;
 assert.equal(await f.detect(10),null);
});
test('several matching foreground providers are ambiguous, even for the same vendor',async()=>{
 for(const secondExecutable of ['/opt/releases/claude/2.0.0','/opt/releases/agy/1.0.0']) {
  const f=fixture({getExecutable:async pid=>pid===20?'/opt/releases/claude/2.0.0':pid===30?secondExecutable:'/usr/bin/bash'});
  f.processes.push(proc(30,10));
  assert.equal(await f.detect(10),null);
 }
});
test('a native executable shared by both vendor command names cannot identify the vendor',async()=>{
 const f=fixture();f.paths.set('/opt/tools/agy','/opt/releases/claude/2.0.0');
 assert.equal(await f.detect(10),null);
});
test('relative PATH entries are ignored; a user-local stable CLI link is supported',async()=>{
 const f=fixture({env:{PATH:'.:relative::/missing'}});
 f.paths.set('/home/example/.local/bin/claude','/opt/releases/claude/2.0.0');
 assert.deepEqual(await f.detect(10),{provider:'claude',cliPath:'/home/example/.local/bin/claude',process:identity});
 const g=fixture({env:{PATH:'.:relative'},home:'relative-home'});
 g.paths.set('relative/claude','/opt/releases/claude/2.0.0');
 assert.equal(await g.detect(10),null);
});
test('process enumeration failure or overflow never returns a partial detection',async()=>{
 for(const fail of ['throw','cap']) {
  const f=fixture({processIds:async function*(){yield 20;if(fail==='throw')throw new Error('unreadable');for(let i=0;i<8192;i++)yield 100+i;}});
  assert.equal(await f.detect(10),null);
 }
});
test('more than 32 matching provider candidates aborts detection without scanning the rest',async()=>{
 let visited=0;
 const f=fixture({processIds:async function*(){for(let i=0;i<100;i++){visited++;yield 100+i;}},
  getProcess:async pid=>pid===10?proc(10,1):proc(pid,10),getExecutable:async()=>'/opt/releases/claude/2.0.0'});
 assert.equal(await f.detect(10),null);
 assert.ok(visited<=33,'A full terminal tree must not cause an unbounded candidate match.');
});
test('unrelated provider processes cannot exhaust the selected terminal candidate budget',async()=>{
 const f=fixture({getExecutable:async pid=>pid===10?'/usr/bin/bash':'/opt/releases/claude/2.0.0'});
 f.processes.push(...Array.from({length:40},(_,index)=>proc(index+100,1)));
 assert.deepEqual(await f.detect(10),{provider:'claude',cliPath:'/opt/tools/claude',process:identity});
});
test('PID reuse, process exit and foreground movement during discovery invalidate the suggestion',async()=>{
 for(const change of ['birth','exit','foreground','terminal']) {
  let scanned=false;
  const f=fixture({
   processIds:async function*(){yield 20;scanned=true;},
   getProcess:async pid=>pid===10?proc(10,1,scanned&&change==='terminal'?{start_ticks:'999'}:{}):
    scanned&&change==='exit'?null:proc(20,10,scanned&&change==='birth'?{start_ticks:'999'}:scanned&&change==='foreground'?{tpgid:10}:{})
  });
  assert.equal(await f.detect(10),null,change);
 }
});
test('an executable or stable CLI link changed during discovery invalidates the suggestion',async()=>{
 for(const change of ['exe','lookup']) {
  let scanned=false;
  const f=fixture({processIds:async function*(){yield 20;scanned=true;},
   getExecutable:async()=>scanned&&change==='exe'?'/opt/other/binary':'/opt/releases/claude/2.0.0',
   resolveExecutable:async lookup=>lookup==='/opt/tools/claude'?(scanned&&change==='lookup'?'/opt/releases/claude/2.0.1':'/opt/releases/claude/2.0.0'):null
  });
  assert.equal(await f.detect(10),null,change);
 }
});
test('real symlink layouts resolve versioned native files while shell launchers remain unsupported',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'account-provider-'));
 t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const bin=path.join(directory,'bin'),versions=path.join(directory,'versions');
 await fs.mkdir(bin);await fs.mkdir(versions);
 const native=path.join(versions,'2.0.0');
 await fs.copyFile(process.execPath,native);await fs.chmod(native,0o755);
 await fs.symlink(native,path.join(bin,'claude'));
 const script=path.join(bin,'agy');await fs.writeFile(script,'#!/bin/sh\nexit 0\n',{mode:0o755});
 const deps={env:{PATH:bin},home:directory,resolveExecutable:undefined,getExecutable:async pid=>pid===20?native:'/usr/bin/bash'};
 assert.deepEqual(await fixture(deps).detect(10),{provider:'claude',cliPath:path.join(bin,'claude'),process:identity});
 assert.equal(await fixture({...deps,getExecutable:async()=>script}).detect(10),null);
});
