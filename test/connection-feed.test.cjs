'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {execFileSync}=require('node:child_process');
const {connectionIdentity}=require('../src/connection.cjs');
const {readConnectionFeeds,writeConnectionFeed}=require('../src/connection-feed.cjs');
async function fixture(t) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'connection-feed-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));await fs.chmod(dir,0o2750);
  const base={provider:'claude',uid:process.getuid(),settingsPath:'/home/target/.claude/settings.json'};
  const connection={...connectionIdentity(base),profilePath:'/home/target/.claude',connected:true,cliLookupPath:'/opt/native/claude',
    reportDir:dir,launcherPath:'/home/target/runtime/run.sh',backupPath:'/home/target/runtime/before.json',runtimeVersion:'0.4.0'};
  return {dir,connection,file:path.join(dir,'.connection.json')};
}
test('connection feed round-trips only bounded public metadata at mode 0640',async t=>{
  const f=await fixture(t);await writeConnectionFeed(f.dir,f.connection);
  assert.deepEqual(await readConnectionFeeds([f.dir]),{connections:[f.connection],rejected:0});
  assert.equal((await fs.stat(f.file)).mode&0o7777,0o640);
  await writeConnectionFeed(f.dir,{...f.connection,runtimeVersion:'0.4.1'});
  assert.equal((await readConnectionFeeds([f.dir])).connections[0].runtimeVersion,'0.4.1');
});
test('malformed, sensitive, mismatched and oversized descriptors are rejected independently',async t=>{
  const good=await fixture(t);await writeConnectionFeed(good.dir,good.connection);
  for(const mutation of [value=>({...value,account:'secret'}),value=>({...value,pendingProcess:{pid:1}}),value=>({...value,id:'v2-'+'a'.repeat(32)}),
    value=>({...value,uid:value.uid+1}),value=>({...value,reportDir:'/elsewhere'}),value=>({...value,runtimeVersion:'bad'}),
    value=>({...value,profilePath:'/wrong'}),value=>({...value,cliLookupPath:'relative'}),value=>({...value,backupPath:'/a\nsecret'}),
    value=>({...value,runtimeVersion:'1'.repeat(33000)})]) {
    const bad=await fixture(t);await fs.writeFile(bad.file,JSON.stringify(mutation(bad.connection)),{mode:0o640});
    assert.deepEqual(await readConnectionFeeds([bad.dir,good.dir]),{connections:[good.connection],rejected:1});
    await assert.rejects(writeConnectionFeed(bad.dir,mutation(bad.connection)));
  }
});
test('descriptor links, hardlinks, FIFOs, writable modes and directory links never pass the file boundary',async t=>{
  for(const mutation of ['symlink','hardlink','fifo','mode','world','directory','parent-link']) {
    const f=await fixture(t);await writeConnectionFeed(f.dir,f.connection);
    let directory=f.dir;
    if(mutation==='mode')await fs.chmod(f.file,0o660);
    else if(mutation==='world')await fs.chmod(f.file,0o644);
    else if(mutation==='directory')await fs.chmod(f.dir,0o2770);
    else if(mutation==='parent-link') {const link=f.dir+'-link';await fs.symlink(f.dir,link);t.after(()=>fs.unlink(link));directory=link;}
    else {
      await fs.rename(f.file,path.join(f.dir,'saved'));
      if(mutation==='symlink')await fs.symlink(path.join(f.dir,'saved'),f.file);
      if(mutation==='hardlink')await fs.link(path.join(f.dir,'saved'),f.file);
      if(mutation==='fifo')execFileSync('/usr/bin/mkfifo',[f.file]);
    }
    assert.deepEqual(await readConnectionFeeds([directory]),{connections:[],rejected:1},mutation);
  }
});
test('file descriptor owner is checked after open, independently of JSON owner',async t=>{
  const f=await fixture(t);await writeConnectionFeed(f.dir,f.connection);
  const io=new Proxy(fs,{get(target,key){if(key==='open')return async(...args)=>{
    const handle=await fs.open(...args);if(String(args[0]).endsWith('.connection.json')) {
      const stat=handle.stat.bind(handle);handle.stat=async()=>{const value=await stat();value.uid++;return value;};
    }return handle;
  };return target[key];}});
  assert.deepEqual(await readConnectionFeeds([f.dir],{fs:io}),{connections:[],rejected:1});
});
test('a descriptor writer cannot replace a different profile in an existing feed',async t=>{
  const f=await fixture(t);await writeConnectionFeed(f.dir,f.connection);
  const other={...f.connection,...connectionIdentity({provider:'claude',uid:process.getuid(),settingsPath:'/home/target/other/settings.json'}),profilePath:'/home/target/other'};
  await assert.rejects(writeConnectionFeed(f.dir,other));
  assert.deepEqual(await readConnectionFeeds([f.dir]),{connections:[f.connection],rejected:0});
});
test('feed directories require an exact allowed mode before and after opening',async t=>{
  for(const mode of [0o550,0o500,0o2500,0o2550]) {
    const f=await fixture(t);await writeConnectionFeed(f.dir,f.connection);await fs.chmod(f.dir,mode);
    assert.deepEqual(await readConnectionFeeds([f.dir]),{connections:[],rejected:1});
    await assert.rejects(writeConnectionFeed(f.dir,f.connection));await fs.chmod(f.dir,0o700);
  }
  const f=await fixture(t);await writeConnectionFeed(f.dir,f.connection);
  const io=new Proxy(fs,{get(target,key){if(key==='open')return async(...args)=>{
    const handle=await fs.open(...args);if(args[0]===f.dir){const stat=handle.stat.bind(handle);handle.stat=async()=>{const value=await stat();value.mode=(value.mode&~0o7777)|0o550;return value;};}return handle;
  };return target[key];}});
  assert.deepEqual(await readConnectionFeeds([f.dir],{fs:io}),{connections:[],rejected:1});
});
