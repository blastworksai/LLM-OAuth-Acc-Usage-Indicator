'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {execFileSync}=require('node:child_process');
const {connectionIdentity}=require('../src/connection.cjs');
const {prepareHandoff}=require('../src/handoff.cjs');
const extensionPath=path.resolve(__dirname,'..');
async function fixture(t,overrides={}) {
  const tempRoot=await fs.mkdtemp(path.join(os.tmpdir(),'handoff-test-'));t.after(()=>fs.rm(tempRoot,{recursive:true,force:true}));
  const target={provider:'claude',cliPath:"/opt/native/claude's cli",process:{pid:20,uid:process.getuid(),start_ticks:'20',boot_id:'boot'}};
  const connection={...connectionIdentity({provider:'claude',uid:target.process.uid,settingsPath:'/home/target/.claude/settings.json'}),
    profilePath:'/home/target/.claude',connected:true,cliLookupPath:target.cliPath,reportDir:'/home/target/feed',
    launcherPath:'/home/target/runtime/run.sh',backupPath:'/home/target/runtime/backup.json',runtimeVersion:'0.4.0'};
  const handoff=await prepareHandoff({extensionPath,provider:'claude',target,tempRoot,runtimeVersion:'0.4.0',revalidate:async()=>target,...overrides});
  t.after(()=>handoff.dispose());return {handoff,target,connection};
}
async function publish(handoff,value) {await fs.writeFile(handoff.resultPath,JSON.stringify(value),{flag:'wx',mode:0o644});}
test('handoff stages exactly immutable readable code and a nonce result dropbox',async t=>{
  const f=await fixture(t),h=f.handoff;
  assert.equal((await fs.stat(h.root)).mode&0o7777,0o755);
  assert.equal((await fs.stat(path.dirname(h.resultPath))).mode&0o7777,0o1733);
  for(const file of ['src/setup-cli.cjs','src/setup.cjs','src/connection.cjs','src/connection-feed.cjs','src/provider.cjs','src/core.cjs','collectors/passive.cjs']) {
    assert.deepEqual(await fs.readFile(path.join(h.root,file)),await fs.readFile(path.join(extensionPath,file)));
    assert.equal((await fs.stat(path.join(h.root,file))).mode&0o7777,file.startsWith('collectors')?0o444:0o555);
  }
  assert.equal(typeof require(path.join(h.root,'src/provider.cjs')).verifyTargetProcess,'function','the staged verifier has every runtime dependency');
  assert.match(h.command,/^node '/);assert.doesNotMatch(h.command,/sudo|ELECTRON_RUN_AS_NODE/);
  // The shell decodes every argument literally, including a quoted CLI path.
  const command=h.command.replace(/^node /,'printf \'%s\\n\' ');
  const decoded=execFileSync('/bin/sh',['-c',command],{encoding:'utf8'}).trim().split('\n');
  assert.equal(decoded[decoded.indexOf('--cli')+1],f.target.cliPath);
  assert.equal(decoded[decoded.indexOf('--runtime-version')+1],'0.4.0');
  assert.equal(await h.readResult(),null);
  await publish(h,{ok:true,connection:f.connection});
  assert.deepEqual(await h.readResult(),{ok:true,connection:f.connection});
  await h.dispose();await h.dispose();await assert.rejects(fs.stat(h.root),{code:'ENOENT'});
  await assert.rejects(h.readResult(),/setup result could not be verified/i);
});
test('readable native handoffs carry the captured process identity beside the expected CLI path',async t=>{
 const f=await fixture(t),decoded=execFileSync('/bin/sh',['-c',f.handoff.command.replace(/^node /,'printf \'%s\\n\' ')],{encoding:'utf8'}).trim().split('\n');
 assert.equal(decoded.includes('--target'),true);
 assert.deepEqual(JSON.parse(decoded[decoded.indexOf('--target')+1]),{provider:'claude',process:f.target.process});
 assert.equal(decoded[decoded.indexOf('--cli')+1],f.target.cliPath);
});
test('a readable staged reconnect whose process exits after the command-line consent leaves profile receipt and feed untouched',async t=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'readable-handoff-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));
 const bin=path.join(home,'bin'),profile=path.join(home,'.claude');await fs.mkdir(bin);await fs.mkdir(profile,{mode:0o700});
 const cliPath=path.join(bin,'claude');await fs.symlink(process.execPath,cliPath);await fs.writeFile(path.join(profile,'settings.json'),'{}',{mode:0o600});
 const setup=require('../src/setup.cjs').createSetup({systemUid:(await fs.stat('/')).uid});
 const dependencies={setup,home:()=>home,uid:()=>process.getuid(),env:{PATH:bin},print:()=>{},readConsent:async()=>'yes'};
 const seedResult=path.join(home,'seed.json');
 assert.equal((await require('../src/setup-cli.cjs').run(['connect','--provider','claude','--cli',cliPath,'--runtime-version','0.3.0','--result',seedResult],dependencies)).code,0);
 const connection=JSON.parse(await fs.readFile(seedResult,'utf8')).connection;
 const target={provider:'claude',cliPath,process:{pid:20,uid:process.getuid(),start_ticks:'20',boot_id:'boot'}};
 const handoff=await prepareHandoff({extensionPath,provider:'claude',target,tempRoot:home,runtimeVersion:'0.4.0',
  profilePath:connection.profilePath,reportDir:connection.reportDir,revalidate:async()=>target});t.after(()=>handoff.dispose());
 const decoded=execFileSync('/bin/sh',['-c',handoff.command.replace(/^node /,'printf \'%s\\n\' ')],{encoding:'utf8'}).trim().split('\n');
 const files=[connection.settingsPath,path.join(path.dirname(connection.launcherPath),'connection.json'),path.join(connection.reportDir,'.connection.json')];
 const before=await Promise.all(files.map(file=>fs.readFile(file)));let live=true,mutationCalls=0,prompted=0,verifications=0;
 const verifier=require(path.join(handoff.root,'src/provider.cjs')).verifyTargetProcess;
 // The process is verified once before the review, then exits: the re-check after consent must stop every write.
 const result=await require(decoded[0]).run(decoded.slice(1),{...dependencies,
  verifyTargetProcess:async(value,options)=>{const call=++verifications,verified=await verifier(value,{...options,getProcess:async()=>live?{...target.process,ppid:10,tty_nr:1,pgrp:20,tpgid:20}:null,
   getExecutable:async()=>fs.realpath(process.execPath)});if(call===1)live=false;return verified;},
  readConsent:async()=>{prompted++;return 'yes';},
  ensureReportDirectory:async(...args)=>{mutationCalls++;return setup.ensureReportDirectory(...args);},
  setup:{...setup,connectProvider:async options=>{mutationCalls++;return setup.connectProvider(options);}}});
 assert.equal(prompted,0,'the handoff line carries the consent; it never waits on a prompt');
 assert.equal(verifications,2,'the real matching native process must pass the first check before the simulated exit');
 assert.equal(result.code,1);assert.equal(mutationCalls,0);
 assert.deepEqual(await Promise.all(files.map(file=>fs.readFile(file))),before);
 assert.equal(JSON.parse(await fs.readFile(handoff.resultPath,'utf8')).ok,false);
});
test('unresolved handoff stages process proof and accepts only the same foreign topology and selected provider',async t=>{
 for(const mutation of ['valid','reuse','provider','ambiguous','executable']) {
  const target={provider:'claude',cliPath:null,process:{pid:20,uid:process.getuid(),start_ticks:'20',boot_id:'boot'}};
  let changed=false;
  const f=await fixture(t,{target,revalidate:async()=>mutation==='ambiguous'&&changed?{provider:null,unavailable:true}:
   {...target,provider:null,...(mutation==='executable'&&changed?{cliPath:'/another'}:{}),
    process:{...target.process,...(mutation==='reuse'&&changed?{start_ticks:'21'}:{})}}});
  const decoded=execFileSync('/bin/sh',['-c',f.handoff.command.replace(/^node /,'printf \'%s\\n\' ')],{encoding:'utf8'}).trim().split('\n');
  assert.equal(decoded.includes('--cli'),false);assert.deepEqual(JSON.parse(decoded[decoded.indexOf('--target')+1]),{provider:'claude',process:target.process});
  const connection={...f.connection,cliLookupPath:'/home/target/bin/claude',...(mutation==='provider'?{provider:'codex'}:{})};
  await publish(f.handoff,{ok:true,connection});changed=true;
  if(mutation==='valid')assert.equal((await f.handoff.readResult()).connection.cliLookupPath,connection.cliLookupPath);
  else await assert.rejects(f.handoff.readResult(),/could not be verified/);
 }
});
test('result rejects unsafe ownership, mode, type, links, size, schema and changed target',async t=>{
  for(const mutation of ['owner','mode','symlink','hardlink','fifo','oversized','extra','provider','uid','id','version','process']) {
    let changed=false;
    const io=new Proxy(fs,{get(target,key){if(key==='open'&&mutation==='owner')return async(...args)=>{
      const handle=await fs.open(...args);if(String(args[0]).endsWith('.json')) {const stat=handle.stat.bind(handle);handle.stat=async()=>{const value=await stat();value.uid++;return value;};}return handle;
    };return target[key];}});
    const f=await fixture(t,{fs:io,...(mutation==='process'?{revalidate:async()=>changed?null:undefined}:{})}),h=f.handoff;
    let value={ok:true,connection:{...f.connection}};
    if(mutation==='extra')value.connection.account='secret';
    if(mutation==='provider')value.connection.provider='codex';
    if(mutation==='uid')value.connection.uid++;
    if(mutation==='id')value.connection.id='v2-'+'b'.repeat(32);
    if(mutation==='version')value.connection.runtimeVersion='0.3.0';
    if(mutation==='oversized')value.extra='x'.repeat(33000);
    await publish(h,value);
    if(mutation==='mode')await fs.chmod(h.resultPath,0o666);
    if(['symlink','hardlink','fifo'].includes(mutation)) {
      const saved=h.resultPath+'.saved';await fs.rename(h.resultPath,saved);
      if(mutation==='symlink')await fs.symlink(saved,h.resultPath);
      if(mutation==='hardlink')await fs.link(saved,h.resultPath);
      if(mutation==='fifo')execFileSync('/usr/bin/mkfifo',[h.resultPath]);
    }
    changed=true;
    if(mutation==='hardlink')assert.equal(await h.readResult(),null,'a two-link result is never accepted');
    else await assert.rejects(h.readResult(),/setup result could not be verified/i,mutation);
  }
});
test('disconnect accepts only the named disconnected profile and verifies the selected process',async t=>{
  const base=connectionIdentity({provider:'claude',uid:process.getuid(),settingsPath:'/home/target/.claude/settings.json'});
  const f=await fixture(t,{action:'disconnect',connectionId:base.id});
  assert.match(f.handoff.command,/ disconnect --connection-id '/);
  assert.doesNotMatch(f.handoff.command,/--target/,'readable disconnect retains its existing protocol');
  await publish(f.handoff,{ok:true,connection:{...f.connection,connected:false}});
  assert.equal((await f.handoff.readResult()).connection.connected,false);
});
test('disconnect handoff binds the returned feed to the picker-selected directory',async t=>{
  const base=connectionIdentity({provider:'claude',uid:process.getuid(),settingsPath:'/home/target/.claude/settings.json'});
  for(const reportDir of ['/home/target/feed','/home/target/changed-feed']) {
    const f=await fixture(t,{action:'disconnect',connectionId:base.id,reportDir:'/home/target/feed'});
    await publish(f.handoff,{ok:true,connection:{...f.connection,connected:false,reportDir}});
    if(reportDir==='/home/target/feed')assert.equal((await f.handoff.readResult()).connection.reportDir,reportDir);
    else await assert.rejects(f.handoff.readResult(),/setup result could not be verified/i);
  }
});
test('a result is rejected when process revalidation fails with ENOENT',async t=>{
  const f=await fixture(t,{revalidate:async()=>{throw Object.assign(new Error('process gone'),{code:'ENOENT'});}});
  await publish(f.handoff,{ok:true,connection:f.connection});
  await assert.rejects(f.handoff.readResult(),/setup result could not be verified/i);
});
test('cleanup never traverses unexpected dropbox children or their symlink targets',async t=>{
  const visited=[];
  const io=new Proxy(fs,{get(target,key){
    if(key==='rm')return async(...args)=>{visited.push(args);return fs.rm(...args);};
    return target[key];
  }});
  const f=await fixture(t,{fs:io}),drop=path.dirname(f.handoff.resultPath);
  const outside=await fs.mkdtemp(path.join(os.tmpdir(),'handoff-outside-'));t.after(()=>fs.rm(outside,{recursive:true,force:true}));
  const sentinel=path.join(outside,'keep');await fs.writeFile(sentinel,'untouched');
  await fs.mkdir(path.join(drop,'untrusted'));await fs.symlink(outside,path.join(drop,'untrusted','swappable'));
  await fs.writeFile(path.join(drop,'untrusted','leave'),'untrusted data');
  await publish(f.handoff,{ok:true,connection:f.connection});
  const result=await f.handoff.dispose();
  assert.equal(visited.length,0,'cleanup must never call recursive removal');
  assert.equal(await fs.readFile(sentinel,'utf8'),'untouched');
  assert.equal(await fs.readFile(path.join(drop,'untrusted','leave'),'utf8'),'untrusted data');
  assert.equal(result.removed,false);assert.match(result.warning,/unexpected entries.*left/i);
  await assert.rejects(fs.lstat(f.handoff.resultPath),{code:'ENOENT'});
  await assert.rejects(fs.lstat(path.join(f.handoff.root,'src/setup-cli.cjs')),{code:'ENOENT'});
});
test('polling cannot see a partial result while its completed bytes are prepared',async t=>{
  const f=await fixture(t),{writeResult}=require('../src/setup-cli.cjs');
  let entered,release;const preparing=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const io=new Proxy(fs,{get(target,key){if(key==='open')return async(...args)=>{
    const handle=await fs.open(...args),write=handle.writeFile.bind(handle);
    handle.writeFile=async bytes=>{entered();await gate;return write(bytes);};return handle;
  };return target[key];}});
  const writing=writeResult(f.handoff.resultPath,{ok:true,connection:f.connection},io);
  await preparing;
  try {assert.equal(await f.handoff.readResult(),null);}finally {release();await writing;}
  assert.deepEqual(await f.handoff.readResult(),{ok:true,connection:f.connection});
});
test('exclusive completed-result publication tolerates the temporary two-link window',async t=>{
  const f=await fixture(t),{writeResult}=require('../src/setup-cli.cjs');
  let entered,release;const linked=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const io=new Proxy(fs,{get(target,key){if(key==='link')return async(...args)=>{await fs.link(...args);entered(true);await gate;};return target[key];}});
  const writing=writeResult(f.handoff.resultPath,{ok:true,connection:f.connection},io);
  const sawLink=await Promise.race([linked,writing.then(()=>false)]);
  try {
    assert.equal(sawLink,true);assert.equal((await fs.lstat(f.handoff.resultPath)).nlink,2);
    assert.equal(await f.handoff.readResult(),null);
  } finally {release();await writing;}
  assert.equal((await fs.lstat(f.handoff.resultPath)).nlink,1);
  assert.equal((await f.handoff.readResult()).ok,true);
});

test('a failed result may carry one reason code; a malformed reason is refused',async t=>{
  const good=await fixture(t);
  await publish(good.handoff,{ok:false,code:'SETUP_FAILED',reason:'UNSAFE_PATH',message:'Target-user setup could not finish.'});
  assert.deepEqual(await good.handoff.readResult(),{ok:false,code:'SETUP_FAILED',reason:'UNSAFE_PATH',message:'Target-user setup could not finish.'});
  for(const reason of ['unsafe path','A','UNSAFE_PATH\n',7]) {
    const bad=await fixture(t);
    await publish(bad.handoff,{ok:false,code:'SETUP_FAILED',reason,message:'Target-user setup could not finish.'});
    await assert.rejects(bad.handoff.readResult(),/setup result could not be verified/i,String(reason));
  }
});
const decode=command=>execFileSync('/bin/sh',['-c',command.replace(/^node /,'printf \'%s\\n\' ')],{encoding:'utf8'}).trim().split('\n');
// setup-cli's own parser decides: invalid arguments return code 2 before anything else; valid ones reach home().
async function parses(argv) {
 const reached=new Error('parsed');
 try {return (await require('../src/setup-cli.cjs').run(argv,{setup:{},print:()=>{},home:()=>{throw reached;}})).code!==2;}
 catch(error) {if(error===reached)return true;throw error;}
}
test('finding 2: prepare then dispose on a real tmpdir removes the whole bundle, results/ included',async t=>{
 for(const published of [false,true]) {
  const f=await fixture(t),h=f.handoff;
  assert.equal((await fs.lstat(path.join(h.root,'results'))).isDirectory(),true);
  if(published)await publish(h,{ok:true,connection:f.connection});
  assert.deepEqual(await h.dispose(),{removed:true});
  await assert.rejects(fs.lstat(path.join(h.root,'results')),{code:'ENOENT'});
  await assert.rejects(fs.lstat(h.root),{code:'ENOENT'});
 }
});
test('finding 2: a staging failure after a folder is made still removes that folder and the root',async t=>{
 // Each fault lands between a mkdir and the open that pins it; the old cleanup skipped such a folder and kept the root.
 for(const [key,suffix] of [['open','/results'],['chmod','/results'],['open','/collectors']]) {
  const tempRoot=await fs.mkdtemp(path.join(os.tmpdir(),'handoff-fault-'));t.after(()=>fs.rm(tempRoot,{recursive:true,force:true}));
  const io=new Proxy(fs,{get(target,name){if(name===key)return async(file,...rest)=>{
   if(String(file).endsWith(suffix))throw Object.assign(new Error('injected'),{code:'EMFILE'});return fs[name](file,...rest);};return target[name];}});
  const target={provider:'claude',cliPath:'/usr/bin/claude',process:{pid:20,uid:process.getuid(),start_ticks:'20',boot_id:'boot'}};
  await assert.rejects(prepareHandoff({extensionPath,provider:'claude',target,tempRoot,runtimeVersion:'0.4.0',revalidate:async()=>target,fs:io}),{code:'EMFILE'});
  assert.deepEqual(await fs.readdir(tempRoot),[],`${key} ${suffix}: nothing of the bundle is left`);
 }
});
test('the handoff line carries the consent for connect and disconnect, and setup-cli accepts it',async t=>{
 const base=connectionIdentity({provider:'claude',uid:process.getuid(),settingsPath:'/home/target/.claude/settings.json'});
 for(const overrides of [{},{action:'disconnect',connectionId:base.id}]) {
  const decoded=decode((await fixture(t,overrides)).handoff.command);
  assert.equal(decoded[decoded.indexOf('--consent')+1],'granted',overrides.action||'connect');
  assert.equal(await parses(decoded.slice(1)),true,overrides.action||'connect');
 }
});
test('reportDir reaches a connect line as --report-dir, and every line stays inside setup-cli\'s argument limit',async t=>{
 const base=connectionIdentity({provider:'claude',uid:process.getuid(),settingsPath:'/home/target/.claude/settings.json'});
 const feed='/var/lib/llm-account-usage/feeds/'+base.id;
 const full=decode((await fixture(t,{reportDir:feed,profilePath:'/home/target/.claude'})).handoff.command);
 assert.equal(full[full.indexOf('--report-dir')+1],feed);assert.equal(full[full.indexOf('--profile')+1],'/home/target/.claude');
 assert.equal(await parses(full.slice(1)),true,'the widest connect line (every option) still parses');
 const unresolved={provider:'claude',cliPath:null,process:{pid:20,uid:process.getuid(),start_ticks:'20',boot_id:'boot'}};
 for(const target of [undefined,unresolved]) {
  const decoded=decode((await fixture(t,{action:'disconnect',connectionId:base.id,reportDir:feed,...(target?{target}:{})})).handoff.command);
  assert.equal(decoded.includes('--report-dir'),false,'disconnect names its feed by connection id; setup-cli refuses --report-dir there');
  assert.equal(await parses(decoded.slice(1)),true);
 }
});
