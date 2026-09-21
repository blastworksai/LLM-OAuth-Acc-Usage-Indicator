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
  for(const file of ['src/setup-cli.cjs','src/setup.cjs','src/connection.cjs','src/connection-feed.cjs','collectors/passive.cjs']) {
    assert.deepEqual(await fs.readFile(path.join(h.root,file)),await fs.readFile(path.join(extensionPath,file)));
    assert.equal((await fs.stat(path.join(h.root,file))).mode&0o7777,file.startsWith('collectors')?0o444:0o555);
  }
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
    await assert.rejects(h.readResult(),/setup result could not be verified/i,mutation);
  }
});
test('disconnect accepts only the named disconnected profile and verifies the selected process',async t=>{
  const base=connectionIdentity({provider:'claude',uid:process.getuid(),settingsPath:'/home/target/.claude/settings.json'});
  const f=await fixture(t,{action:'disconnect',connectionId:base.id});
  assert.match(f.handoff.command,/ disconnect --connection-id '/);
  await publish(f.handoff,{ok:true,connection:{...f.connection,connected:false}});
  assert.equal((await f.handoff.readResult()).connection.connected,false);
});
test('a result is rejected when process revalidation fails with ENOENT',async t=>{
  const f=await fixture(t,{revalidate:async()=>{throw Object.assign(new Error('process gone'),{code:'ENOENT'});}});
  await publish(f.handoff,{ok:true,connection:f.connection});
  await assert.rejects(f.handoff.readResult(),/setup result could not be verified/i);
});
