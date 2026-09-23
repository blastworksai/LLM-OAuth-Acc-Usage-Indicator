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
  resolveExecutable:async lookup=>paths.get(lookup)||null,processGone:async()=>false,...changes};
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
test('the exact foreground provider may run as another Linux user',async()=>{
 const f=fixture();f.processes[1]=proc(20,10,{uid:2000});
 assert.deepEqual(await f.detect(10),{
  provider:'claude',cliPath:'/opt/tools/claude',
  process:{pid:20,uid:2000,start_ticks:'20',boot_id:'boot'}
 });
});
test('explicit foreign discovery survives host EACCES without claiming a provider',async()=>{
 const f=fixture({getExecutable:async()=>{throw Object.assign(new Error('readlink denied'),{code:'EACCES'});}});
 f.processes[1]=proc(20,10,{uid:2000});
 assert.equal(await f.detect(10),null,'automatic detection still requires executable proof');
 assert.deepEqual(await f.detect(10,{allowForeign:true}),{
  provider:null,cliPath:null,process:{pid:20,uid:2000,start_ticks:'20',boot_id:'boot'}
 });
});
test('foreign topology fails closed for ambiguity, unreadable ancestry, reuse and terminal changes',async()=>{
 for(const mutation of ['ambiguous','unreadable','birth','uid','boot','background','terminal','terminal-owner','terminal-foreground']) {
  let scanned=false;
  const f=fixture({getExecutable:async()=>{throw Object.assign(new Error('denied'),{code:'EACCES'});},
   processIds:async function*(){yield 10;yield 20;if(mutation==='ambiguous')yield 30;scanned=true;},
   getProcess:async pid=>{
    if(pid===10)return proc(10,1,scanned?({'terminal':{start_ticks:'99'},'terminal-owner':{uid:2000},'terminal-foreground':{tpgid:10}}[mutation]||{}):{});
    if(pid===30)return proc(30,10,{uid:2000});
    if(mutation==='unreadable')return null;
    return proc(20,10,{uid:2000,...(scanned?({birth:{start_ticks:'99'},uid:{uid:3000},boot:{boot_id:'changed'},background:{tpgid:10}}[mutation]||{}):{})});
   }});
  assert.deepEqual(await f.detect(10,{allowForeign:true,topologyOnly:true}),{provider:null,unavailable:true},mutation);
 }
});
test('foreign topology rechecks the original terminal after final ancestry matching',async()=>{
 let terminalReads=0;
 const f=fixture({processIds:async function*(){yield 20;},getProcess:async pid=>pid===10?
  proc(10,1,{start_ticks:++terminalReads>=6?'changed':'10'}):proc(20,10,{uid:2000})});
 assert.deepEqual(await f.detect(10,{allowForeign:true,topologyOnly:true}),{provider:null,unavailable:true});
});
test('foreign reuse during the first ancestry match remains unavailable instead of absent',async()=>{
 for(const mutation of [{start_ticks:'21'},{uid:1000},{boot_id:'changed'},{ppid:1},{pgrp:10,tpgid:10}]) {
  let reads=0;
  const f=fixture({processIds:async function*(){yield 20;},getProcess:async pid=>pid===10?proc(10,1):
   proc(20,10,{uid:2000,...(++reads>1?mutation:{})})});
  assert.deepEqual(await f.detect(10,{allowForeign:true,topologyOnly:true}),{provider:null,unavailable:true});
 }
});
test('stable unrelated, background and host-owned processes do not become foreign targets',async()=>{
 for(const candidate of [proc(20,10),proc(20,1,{uid:2000}),proc(20,10,{uid:2000,pgrp:10}),
  proc(20,10,{uid:2000,tty_nr:2,pgrp:30,tpgid:30})]) {
  const f=fixture({processIds:async function*(){yield 20;},getProcess:async pid=>pid===10?proc(10,1):candidate});
  assert.equal(await f.detect(10,{allowForeign:true,topologyOnly:true}),null);
 }
});
// Shape measured on a Remote-SSH host whose window user starts each CLI through
// `sudo -u <user>`: the outer sudo stays in the terminal's foreground group on the
// terminal's tty, and sudo gives the CLI a pty of its own.
const sudoPane=()=>[
 proc(10,1,{pgrp:10,tpgid:10}),
 proc(11,10,{uid:0,pgrp:10,tpgid:10}),
 proc(12,11,{uid:0,tty_nr:2,pgrp:12,tpgid:13}),
 proc(13,12,{uid:2000,tty_nr:2,pgrp:13,tpgid:13})
];
const denied=async()=>{throw Object.assign(new Error('denied'),{code:'EACCES'});};
test('a wrapper around the foreign CLI yields the innermost foreground process, not ambiguity',async()=>{
 const processes=sudoPane();
 const f=fixture({getExecutable:denied,processIds:async function*(){for(const p of processes)yield p.pid;},
  getProcess:async pid=>processes.find(p=>p.pid===pid)||null});
 assert.deepEqual(await f.detect(10,{allowForeign:true,topologyOnly:true}),{
  provider:null,cliPath:null,process:{pid:13,uid:2000,start_ticks:'13',boot_id:'boot'}
 });
});
test('two foreign foreground processes that do not nest stay ambiguous',async()=>{
 const processes=[...sudoPane(),proc(14,10,{uid:3000,pgrp:10,tpgid:10})];
 const f=fixture({getExecutable:denied,processIds:async function*(){for(const p of processes)yield p.pid;},
  getProcess:async pid=>processes.find(p=>p.pid===pid)||null});
 assert.deepEqual(await f.detect(10,{allowForeign:true,topologyOnly:true}),{provider:null,unavailable:true});
});
test('an exited or zombie process elsewhere on the host does not fail foreign discovery',async()=>{
 const processes=sudoPane();
 const f=fixture({getExecutable:denied,processGone:async pid=>pid===99,
  processIds:async function*(){yield 99;for(const p of processes)yield p.pid;},
  getProcess:async pid=>processes.find(p=>p.pid===pid)||null});
 assert.deepEqual(await f.detect(10,{allowForeign:true,topologyOnly:true}),{
  provider:null,cliPath:null,process:{pid:13,uid:2000,start_ticks:'13',boot_id:'boot'}
 });
});
test('a live process that cannot be read still fails foreign discovery closed',async()=>{
 const processes=sudoPane();
 const f=fixture({getExecutable:denied,processGone:async()=>false,
  processIds:async function*(){yield 99;for(const p of processes)yield p.pid;},
  getProcess:async pid=>processes.find(p=>p.pid===pid)||null});
 assert.deepEqual(await f.detect(10,{allowForeign:true,topologyOnly:true}),{provider:null,unavailable:true});
});
test('target-user verification resolves only the same live native selected provider',async t=>{
 const {verifyTargetProcess}=require('../src/provider.cjs');
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'target-provider-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const bin=path.join(directory,'bin');await fs.mkdir(bin);
 const native=path.join(directory,'native');await fs.copyFile(process.execPath,native);await fs.chmod(native,0o755);
 await fs.symlink(native,path.join(bin,'claude'));await fs.writeFile(path.join(bin,'codex'),'#!/bin/sh\n',{mode:0o755});
 const target={provider:'claude',process:{...identity,uid:2000}};
 const dependencies={uid:2000,env:{PATH:bin},home:directory,getProcess:async()=>proc(20,10,{uid:2000}),getExecutable:async()=>native};
 assert.deepEqual(await verifyTargetProcess(target,dependencies),{...target,cliPath:path.join(bin,'claude')});
 for(const change of ['owner','reuse','boot','provider','shell','exit','foreground','exec-change']) {
  let reads=0;
  const next={...dependencies,
   ...(change==='owner'?{uid:1000}:{}),
   getProcess:async()=>change==='exit'?null:proc(20,10,{uid:2000,...({reuse:{start_ticks:'99'},boot:{boot_id:'other'},foreground:{tpgid:10}}[change]||{})}),
   getExecutable:async()=>change==='shell'||(change==='exec-change'&&++reads>1)?path.join(bin,'codex'):native};
  assert.equal(await verifyTargetProcess({...target,...(change==='provider'?{provider:'codex'}:{})},next),null,change);
 }
});
test('an unrelated other-user provider is never selected',async()=>{
 const f=fixture({getExecutable:async pid=>pid===10?'/usr/bin/bash':'/opt/releases/claude/2.0.0'});
 f.processes.push(proc(30,1,{uid:2000}));
 assert.deepEqual(await f.detect(10),{provider:'claude',cliPath:'/opt/tools/claude',process:identity});
 f.processes.splice(1,1);
 assert.equal(await f.detect(10),null);
});
test('background jobs and another terminal cannot select a provider under either user',async()=>{
 for(const uid of [1000,2000])for(const candidate of [proc(20,1,{uid}),proc(20,10,{uid,pgrp:30}),proc(20,10,{uid,tty_nr:2,tpgid:30})]) {
  const f=fixture();f.processes[1]=candidate;
  assert.equal(await f.detect(10),null);
 }
});
test('the selected terminal must remain owned by the extension host',async()=>{
 for(const uid of [1000,2000]) {
  const f=fixture();f.processes[0]=proc(10,1,{uid:2000});f.processes[1]=proc(20,10,{uid});
  assert.equal(await f.detect(10),null);
 }
});
test('several matching foreground providers are ambiguous, even for the same vendor',async()=>{
 for(const uid of [1000,2000])for(const secondExecutable of ['/opt/releases/claude/2.0.0','/opt/releases/agy/1.0.0']) {
  const f=fixture({getExecutable:async pid=>pid===20?'/opt/releases/claude/2.0.0':pid===30?secondExecutable:'/usr/bin/bash'});
  f.processes.push(proc(30,10,{uid}));
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
 for(const uid of [1000,2000])for(const change of ['birth','boot','owner','exit','foreground','terminal','terminal-owner','terminal-boot','terminal-foreground']) {
  let scanned=false;
  const candidateChanges={birth:{start_ticks:'999'},boot:{boot_id:'other'},owner:{uid:3000},foreground:{tpgid:10}};
  const terminalChanges={terminal:{start_ticks:'999'},'terminal-owner':{uid:2000},'terminal-boot':{boot_id:'other'},'terminal-foreground':{tpgid:10}};
  const f=fixture({
   processIds:async function*(){yield 20;scanned=true;},
   getProcess:async pid=>pid===10?proc(10,1,scanned?terminalChanges[change]:{}):
    scanned&&change==='exit'?null:proc(20,10,{uid,...(scanned?candidateChanges[change]:{})})
  });
  assert.equal(await f.detect(10),null,change);
 }
});
test('an executable or stable CLI link changed during discovery invalidates the suggestion',async()=>{
 for(const uid of [1000,2000])for(const change of ['exe','lookup']) {
  let scanned=false;
  const f=fixture({processIds:async function*(){yield 20;scanned=true;},
   getExecutable:async()=>scanned&&change==='exe'?'/opt/other/binary':'/opt/releases/claude/2.0.0',
   resolveExecutable:async lookup=>lookup==='/opt/tools/claude'?(scanned&&change==='lookup'?'/opt/releases/claude/2.0.1':'/opt/releases/claude/2.0.0'):null
  });
  f.processes[1]=proc(20,10,{uid});
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

test('a package-manager launcher binds the exact native provider process without assuming its layout',async()=>{
 const wrapper='/opt/shared/node_modules/vendor/bin/codex.js',native='/srv/provider/releases/42/codex';
 const f=fixture({
  getExecutable:async pid=>pid===20?native:'/usr/bin/bash',
  resolveCommand:async lookup=>lookup==='/opt/tools/codex'?wrapper:null,
  resolveExecutable:async lookup=>lookup===native?native:null
 });
 assert.deepEqual(await f.detect(10),{provider:'codex',cliPath:native,process:identity});
});
