'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {execFileSync, spawnSync} = require('node:child_process');
const {createSetup} = require('../src/setup.cjs');

async function fixture(t, provider = 'claude') {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'account-usage-setup-'));
  t.after(() => fs.rm(homeDir, {recursive:true, force:true}));
  const profilePath = path.join(homeDir, provider === 'claude' ? '.claude' : provider === 'codex' ? '.codex' : '.gemini/antigravity-cli');
  await fs.mkdir(profilePath, {recursive:true, mode:0o700});
  const settingsPath = path.join(profilePath, provider === 'codex' ? 'hooks.json' : 'settings.json');
  const collectorPath = path.join(homeDir, 'collector.cjs');
  await fs.writeFile(collectorPath, `const fs=require('node:fs');const cp=require('node:child_process');const args=process.argv.slice(2);const i=args.indexOf('--original-argv-json');const input=fs.readFileSync(0);if(i>=0){const [file,...argv]=JSON.parse(args[i+1]);const r=cp.spawnSync(file,argv,{input,encoding:null,env:process.env});if(r.stdout)process.stdout.write(r.stdout);if(r.stderr)process.stderr.write(r.stderr);process.exitCode=r.status??1;}else process.stdout.write(JSON.stringify({args,node:process.execPath,electron:process.env.ELECTRON_RUN_AS_NODE}));`, {mode:0o600});
  // Test sandboxes may remap system-owned files to the overflow UID.
  const options = {provider, homeDir, systemUid:(await fs.stat('/')).uid, env:{PATH:process.env.PATH}, storagePath:path.join(homeDir, 'extension-storage'), nodePath:process.execPath, collectorPath, cliPath:process.execPath};
  const setup = createSetup();
  return {homeDir,profilePath,settingsPath,collectorPath,options,setup};
}
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const writeJson = (file, value) => fs.writeFile(file, JSON.stringify(value), {mode:0o600});

test('explicit target-owned setgid feed survives reconnect, listing and refresh',async t=>{
  const f=await fixture(t),feed=path.join(f.homeDir,'shared-feed');
  await fs.mkdir(feed,{mode:0o2750});await fs.chmod(feed,0o2750);
  const connection=await f.setup.connectProvider({...f.options,reportDir:feed});
  assert.equal(connection.reportDir,feed);
  assert.equal((await fs.stat(feed)).mode&0o7777,0o2750);
  const invocation=JSON.parse(execFileSync('/bin/sh',[connection.launcherPath],{input:'{}',encoding:'utf8'}));
  assert.equal(invocation.args[invocation.args.indexOf('--report-dir')+1],feed);
  const receiptPath=path.join(path.dirname(connection.launcherPath),'connection.json');
  assert.equal((await readJson(receiptPath)).reportDir,feed);
  assert.equal((await f.setup.connectProvider(f.options)).reportDir,feed);
  assert.equal((await f.setup.listConnections(f.options))[0].reportDir,feed);
  assert.deepEqual((await f.setup.refreshRuntime(f.options)).refreshed,[connection.id]);
  assert.equal((await f.setup.disconnectProvider({...f.options,connectionId:connection.id})).reportDir,feed);
  assert.equal((await f.setup.connectProvider(f.options)).reportDir,feed);
});
test('shared feed refuses world access, group writes, links, wrong owners and special mode bits',async t=>{
  const f=await fixture(t);
  for(const mode of [0o2755,0o2770,0o2777,0o4750,0o1750]) {
    const feed=path.join(f.homeDir,`feed-${mode}`);await fs.mkdir(feed,{mode:0o700});await fs.chmod(feed,mode);
    await assert.rejects(f.setup.connectProvider({...f.options,reportDir:feed}),{code:'UNSAFE_REPORT_DIRECTORY'});
  }
  const feed=path.join(f.homeDir,'safe');await fs.mkdir(feed,{mode:0o700});
  const linked=path.join(f.homeDir,'linked');await fs.symlink(feed,linked);
  await assert.rejects(f.setup.connectProvider({...f.options,reportDir:linked}),{code:'UNSAFE_REPORT_DIRECTORY'});
  const io=new Proxy(fs,{get(target,key){if(key==='lstat')return async file=>{const st=await fs.lstat(file);if(file===feed)st.uid=process.getuid()+1;return st;};return target[key];}});
  await assert.rejects(createSetup({fs:io}).connectProvider({...f.options,reportDir:feed}),{code:'UNSAFE_REPORT_DIRECTORY'});
  assert.equal(await fs.stat(f.settingsPath).catch(()=>null),null);
});
test('default shared feed creation validates home ancestry and creates only root and leaf with mode 2750',async t=>{
  const f=await fixture(t),feed=path.join(f.homeDir,'.llm-account-usage-feeds','v2-'+'a'.repeat(32));
  await f.setup.ensureReportDirectory(feed,{...f.options,create:true});
  assert.equal((await fs.stat(path.dirname(feed))).mode&0o7777,0o2750);
  assert.equal((await fs.stat(feed)).mode&0o7777,0o2750);
  await assert.rejects(f.setup.ensureReportDirectory(path.join(f.homeDir,'other','new'),{...f.options,create:true}),{code:'UNSAFE_REPORT_DIRECTORY'});
});
test('disconnect discovery can review a shared profile without requiring its vanished CLI',async t=>{
  const f=await fixture(t),cli=path.join(f.homeDir,'cli');await fs.symlink(process.execPath,cli);f.options.cliPath=cli;
  await fs.chmod(f.profilePath,0o770);
  const preview=await f.setup.discoverProvider(f.options);
  await f.setup.connectProvider({...f.options,trustedDirectories:preview.sharedDirectories});await fs.unlink(cli);
  const sharedDirectoryReview=new Map();
  const [connection]=await f.setup.listDisconnectConnections({...f.options,sharedDirectoryReview});
  assert.ok(connection);
  assert.ok([...sharedDirectoryReview.values()].some(value=>value.path===f.profilePath));
  await f.setup.disconnectProvider({...f.options,connectionId:connection.id,trustedDirectories:[...sharedDirectoryReview.values()]});
});
test('feed claims exclude another live installer and retain exact identity after failure',async t=>{
  const f=await fixture(t),feed=path.join(f.homeDir,'claimed');await fs.mkdir(feed,{mode:0o700});
  const first='v2-'+'a'.repeat(32),second='v2-'+'b'.repeat(32);
  let entered,release;const active=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const work=f.setup.withReportFeedClaim(feed,first,f.options,async()=>{entered();await gate;throw new Error('publication failed');});
  await active;
  try {await assert.rejects(f.setup.withReportFeedClaim(feed,second,f.options,async()=>assert.fail('second installer entered')),{code:'SETUP_BUSY'});}
  finally {release();await assert.rejects(work,/publication failed/);}
  await assert.rejects(f.setup.withReportFeedClaim(feed,second,f.options,async()=>assert.fail('different identity reused uncertain claim')),{code:'FEED_ALREADY_CLAIMED'});
  assert.equal(await f.setup.withReportFeedClaim(feed,first,f.options,async()=>true),true);
});
test('feed claim recovery removes only a proven dead process marker and rejects unsafe claim files',async t=>{
  const f=await fixture(t),feed=path.join(f.homeDir,'claimed');await fs.mkdir(feed,{mode:0o700});
  const id='v2-'+'a'.repeat(32);
  await f.setup.withReportFeedClaim(feed,id,f.options,async()=>{});
  const control=path.join(feed,'.connection-control'),lock=path.join(control,'.setup-lock');
  await fs.mkdir(lock,{mode:0o700});
  await fs.writeFile(path.join(lock,'owner-00000000-0000-0000-0000-000000000001.json'),JSON.stringify({pid:2147483647,uid:process.getuid(),start_ticks:'1',
    boot_id:'00000000-0000-0000-0000-000000000000',connectionId:id}),{mode:0o600});
  assert.equal(await f.setup.withReportFeedClaim(feed,id,f.options,async()=>true),true);
  const claim=path.join(control,'claim.json');await fs.chmod(claim,0o660);
  await assert.rejects(f.setup.withReportFeedClaim(feed,id,f.options,async()=>assert.fail('unsafe claim entered')));
});
test('exact-ID claim recovers descriptor publication interrupted between link and unlink',async t=>{
  const {readConnectionFeeds,writeConnectionFeed}=require('../src/connection-feed.cjs');
  for(const connected of [true,false]) {
    const f=await fixture(t),feed=path.join(f.homeDir,'claimed');await fs.mkdir(feed,{mode:0o700});
    const installed=await f.setup.connectProvider({...f.options,reportDir:feed});
    const connection={};
    for(const key of ['id','provider','uid','profilePath','settingsPath','connected','cliLookupPath','reportDir','launcherPath','backupPath'])connection[key]=installed[key];
    connection.runtimeVersion='0.4.0';
    let linked=false;
    const io=new Proxy(fs,{get(target,key){
      if(key==='link')return async(...args)=>{await fs.link(...args);if(String(args[1]).endsWith('/.connection.json'))linked=true;};
      if(key==='unlink')return async file=>{if(linked && /\/(?:\.connection-[^/]+\.tmp|\.connection-publication\.json)$/.test(String(file)))throw new Error('interrupted after link');return fs.unlink(file);};
      return target[key];
    }});
    await assert.rejects(createSetup({fs:io}).withReportFeedClaim(feed,connection.id,f.options,
      publication=>writeConnectionFeed(feed,connection,{fs:io,publication})),/interrupted after link/);
    assert.equal((await fs.stat(path.join(feed,'.connection.json'))).nlink,2);
    assert.equal((await readConnectionFeeds([feed])).rejected,1,'ordinary readers must not accept a two-link descriptor');
    await assert.rejects(f.setup.withReportFeedClaim(feed,'v2-'+'b'.repeat(32),f.options,()=>assert.fail('other profile entered')),{code:'FEED_ALREADY_CLAIMED'});
    await f.setup.withReportFeedClaim(feed,connection.id,f.options,async publication=>{
      assert.deepEqual((await readConnectionFeeds([feed])).connections,[connection]);
      await writeConnectionFeed(feed,{...connection,connected},{publication});
    });
    assert.equal((await fs.stat(path.join(feed,'.connection.json'))).nlink,1);
    assert.deepEqual((await readConnectionFeeds([feed])).connections,[{...connection,connected}]);
  }
});
test('claim recovery never repairs arbitrary hardlinks or unsafe private publication slots',async t=>{
  const {writeConnectionFeed}=require('../src/connection-feed.cjs');
  for(const mutation of ['outside-link','third-link','wrong-id','extra','oversized','mode','symlink','fifo','wrong-inode','wrong-owner','unlocked-directory']) {
    const f=await fixture(t),feed=path.join(f.homeDir,'claimed');await fs.mkdir(feed,{mode:0o700});
    const installed=await f.setup.connectProvider({...f.options,reportDir:feed}),connection={};
    for(const key of ['id','provider','uid','profilePath','settingsPath','connected','cliLookupPath','reportDir','launcherPath','backupPath'])connection[key]=installed[key];
    connection.runtimeVersion='0.4.0';
    await f.setup.withReportFeedClaim(feed,connection.id,f.options,publication=>writeConnectionFeed(feed,connection,{publication}));
    const control=path.join(feed,'.connection-control'),slot=path.join(control,'.connection-publication.json'),descriptor=path.join(feed,'.connection.json'),outside=path.join(f.homeDir,'keep');
    if(mutation==='outside-link')await fs.link(descriptor,outside);
    else if(mutation==='third-link'){await fs.link(descriptor,slot);await fs.link(descriptor,outside);}
    else if(mutation==='symlink')await fs.symlink(descriptor,slot);
    else if(mutation==='fifo')execFileSync('/usr/bin/mkfifo',[slot]);
    else if(mutation!=='unlocked-directory') {
      const value={...connection,...(mutation==='wrong-id'?{id:'v2-'+'b'.repeat(32)}:mutation==='extra'?{account:'private'}:{})};
      await fs.writeFile(slot,mutation==='oversized'?'x'.repeat(32769):JSON.stringify(value),{mode:0o640});await fs.chmod(slot,mutation==='mode'?0o660:0o640);
      if(mutation==='wrong-inode')await fs.link(slot,outside);
    }
    const before=await fs.lstat(descriptor),slotBefore=await fs.lstat(slot).catch(()=>null);
    const io=new Proxy(fs,{get(target,key){
      if(key==='open'&&mutation==='wrong-owner')return async(...args)=>{
        const handle=await fs.open(...args);if(String(args[0]).endsWith('/.connection-publication.json')) {
          const stat=handle.stat.bind(handle);handle.stat=async()=>{const st=await stat();st.uid++;return st;};
        }return handle;
      };
      if(key==='lstat'&&mutation==='unlocked-directory')return async file=>{
      const st=await fs.lstat(file);if(String(file).startsWith('/proc/self/fd/')&&String(file).endsWith('/.connection-control'))st.ino++;return st;
    };return target[key];}});
    let entered=false;
    await assert.rejects(createSetup({fs:io}).withReportFeedClaim(feed,connection.id,f.options,()=>{entered=true;}),mutation);
    assert.equal(entered,false,mutation);
    const after=await fs.lstat(descriptor);assert.equal(after.ino,before.ino,mutation);assert.equal(after.nlink,before.nlink,mutation);
    if(slotBefore)assert.equal((await fs.lstat(slot)).ino,slotBefore.ino,mutation);
  }
});
test('a feed publication capability expires when its claim lock is released',async t=>{
  const f=await fixture(t),feed=path.join(f.homeDir,'claimed');await fs.mkdir(feed,{mode:0o700});
  let publication;
  await f.setup.withReportFeedClaim(feed,'v2-'+'a'.repeat(32),f.options,value=>{publication=value;});
  await assert.rejects(publication({}),/invalid-publication-capability/);
});

async function createProfile(f,name) {
  const profilePath=path.join(f.homeDir,name);
  await fs.mkdir(profilePath,{mode:0o700});
  await writeJson(path.join(profilePath,f.options.provider==='codex'?'hooks.json':'settings.json'),{profile:name});
  return profilePath;
}

async function seedLegacyConnection(f,{settingsPath=f.settingsPath}={}) {
  const provider=f.options.provider;
  const root=path.join(f.homeDir,'.local/state/llm-account-usage/providers',provider);
  const launcherPath=path.join(root,'run.sh'),reportDir=path.join(root,'reports');
  await fs.mkdir(reportDir,{recursive:true,mode:0o700});
  await fs.mkdir(f.options.storagePath,{recursive:true,mode:0o700});
  const original={theme:'legacy'};
  const command=`'${launcherPath}' # llm-account-usage-managed-v1`;
  const data={version:1,status:'connected',provider,uid:process.getuid(),settingsPath,
    cliPath:await fs.realpath(f.options.cliPath),cliLookupPath:f.options.cliPath,
    ownerStoragePath:f.options.storagePath,settingsExisted:true};
  let installed;
  if(provider==='codex') {
    Object.assign(data,{kind:'codex-hook',hadHooks:false,hadStop:false,backupName:'hooks.before-legacy.json',
      installedHook:{matcher:'.*',hooks:[{type:'command',statusMessage:'Account Usage',command}]}});
    installed={...original,hooks:{Stop:[data.installedHook]}};
  } else {
    Object.assign(data,{hadStatusLine:false,originalStatusLine:null,backupName:'settings.before-legacy.json',
      installedStatusLine:{type:'command',command}});
    installed={...original,statusLine:data.installedStatusLine};
  }
  const receiptPath=path.join(root,'connection.json'),backupPath=path.join(root,data.backupName);
  await writeJson(receiptPath,data);
  await writeJson(backupPath,original);
  await fs.writeFile(launcherPath,'#!/bin/sh\nexit 0\n',{mode:0o700});
  await fs.copyFile(f.collectorPath,path.join(root,'passive.cjs'));
  await writeJson(settingsPath,installed);
  return {root,receiptPath,launcherPath,reportDir,backupPath,original};
}

test('a valid version-1 connection gains a stable ID without moving its installed launcher',async t=>{
  for(const provider of ['claude','codex','antigravity']) {
    const f=await fixture(t,provider);
    const legacy=await seedLegacyConnection(f);
    const before=await fs.readFile(f.settingsPath),saved=await fs.readFile(legacy.receiptPath);
    const [listed]=await f.setup.listConnections(f.options);
    assert.ok(listed,'the legacy connection must be discoverable');
    assert.match(listed.id,/^v2-[a-f0-9]{32}$/);
    assert.equal(listed.legacy,true);
    assert.equal(listed.profilePath,f.profilePath);
    assert.equal(listed.launcherPath,legacy.launcherPath);
    assert.equal(listed.reportDir,legacy.reportDir);
    assert.equal(listed.backupPath,legacy.backupPath);
    assert.equal(before.includes(legacy.launcherPath),true);
    assert.deepEqual(await fs.readFile(legacy.receiptPath),saved,'listing must not rewrite the receipt');

    const reconnected=await f.setup.connectProvider(f.options);
    assert.equal(reconnected.id,listed.id);
    assert.equal(reconnected.legacy,true);
    assert.equal(reconnected.launcherPath,legacy.launcherPath);
    assert.deepEqual(await fs.readFile(f.settingsPath),before);
    assert.equal((await readJson(legacy.receiptPath)).version,1);
    assert.deepEqual((await f.setup.refreshRuntime(f.options)).refreshed,[listed.id]);
    await f.setup.disconnectProvider({...f.options,connectionId:listed.id});
    assert.deepEqual(await readJson(f.settingsPath),legacy.original);
    assert.equal((await f.setup.connectProvider(f.options)).id,listed.id);
    assert.equal((await f.setup.listConnections(f.options))[0].id,listed.id);
  }
});

test('a legacy connection permits distinct version-2 profiles and exact default disconnect',async t=>{
  const f=await fixture(t);
  const legacy=await seedLegacyConnection(f);
  const second=await f.setup.connectProvider({...f.options,profilePath:await createProfile(f,'other-claude')});
  assert.equal(second.legacy,false);
  assert.notEqual(second.launcherPath,legacy.launcherPath);
  assert.equal((await f.setup.listConnections(f.options)).length,2);
  const secondSettings=await fs.readFile(second.settingsPath);
  await f.setup.disconnectProvider(f.options);
  assert.deepEqual(await readJson(f.settingsPath),legacy.original);
  assert.deepEqual(await fs.readFile(second.settingsPath),secondSettings);
  assert.deepEqual((await f.setup.listConnections(f.options)).map(value=>value.id),[second.id]);
});

test('a corrupt Claude connection does not hide or disable another Claude profile',async t=>{
  const f=await fixture(t);
  const first=await f.setup.connectProvider(f.options);
  const second=await f.setup.connectProvider({...f.options,profilePath:await createProfile(f,'other-claude')});
  const launcher=await fs.readFile(first.launcherPath);
  await fs.writeFile(path.join(path.dirname(first.launcherPath),'connection.json'),'{bad',{mode:0o600});
  assert.deepEqual((await f.setup.listConnections(f.options)).map(value=>value.id),[second.id]);
  const refreshed=await f.setup.refreshRuntime(f.options);
  assert.deepEqual(refreshed.refreshed,[second.id]);
  assert.equal(refreshed.warnings.length,1);
  assert.ok(refreshed.warnings[0].includes(first.id));
  assert.deepEqual(await fs.readFile(first.launcherPath),launcher);
});

test('disconnect and refresh touch only the addressed profile',async t=>{
  const f=await fixture(t);
  const first=await f.setup.connectProvider(f.options);
  const second=await f.setup.connectProvider({...f.options,profilePath:await createProfile(f,'other-claude')});
  const secondSettings=await fs.readFile(second.settingsPath),firstLauncher=await fs.readFile(first.launcherPath);
  const firstRuntime=path.join(path.dirname(first.launcherPath),'passive.cjs');
  const firstCollector=await fs.readFile(firstRuntime);
  await f.setup.disconnectProvider({...f.options,connectionId:first.id});
  assert.deepEqual(await fs.readFile(second.settingsPath),secondSettings);
  assert.deepEqual((await f.setup.listConnections(f.options)).map(value=>value.id),[second.id]);
  await fs.writeFile(f.collectorPath,'process.stdout.write("updated");',{mode:0o600});
  assert.deepEqual((await f.setup.refreshRuntime(f.options)).refreshed,[second.id]);
  assert.deepEqual(await fs.readFile(firstRuntime),firstCollector);
  assert.deepEqual(await fs.readFile(first.launcherPath),firstLauncher);
  assert.deepEqual(await fs.readFile(second.settingsPath),secondSettings);
  assert.deepEqual(await fs.readFile(path.join(path.dirname(second.launcherPath),'passive.cjs')),await fs.readFile(f.collectorPath));
});

test('a legacy and version-2 receipt claiming one identity fail closed',async t=>{
  const f=await fixture(t);
  const current=await f.setup.connectProvider(f.options);
  const legacy=await seedLegacyConnection(f,{settingsPath:current.settingsPath});
  const files=[f.settingsPath,current.launcherPath,legacy.launcherPath,legacy.receiptPath,
    path.join(path.dirname(current.launcherPath),'connection.json')];
  const before=await Promise.all(files.map(file=>fs.readFile(file)));
  await assert.rejects(f.setup.listConnections(f.options),{code:'DUPLICATE_CONNECTION'});
  await assert.rejects(f.setup.listDisconnectConnections(f.options),{code:'DUPLICATE_CONNECTION'});
  await assert.rejects(f.setup.refreshRuntime(f.options),{code:'DUPLICATE_CONNECTION'});
  await assert.rejects(f.setup.connectProvider(f.options),{code:'DUPLICATE_CONNECTION'});
  await assert.rejects(f.setup.disconnectProvider({...f.options,connectionId:current.id}),{code:'DUPLICATE_CONNECTION'});
  await assert.rejects(f.setup.disconnectProvider(f.options),{code:'DUPLICATE_CONNECTION'});
  assert.deepEqual(await Promise.all(files.map(file=>fs.readFile(file))),before);
});

test('version-1 takeover retains the legacy backup and explicit ownership confirmation',async t=>{
  const f=await fixture(t),legacy=await seedLegacyConnection(f);
  const before=await fs.readFile(f.settingsPath);
  const other={...f.options,storagePath:path.join(f.homeDir,'other-editor')};
  await assert.rejects(f.setup.connectProvider({...other,confirmTakeover:true}),{code:'ALREADY_CONNECTED'});
  await fs.rmdir(f.options.storagePath);
  await assert.rejects(f.setup.connectProvider(other),{code:'TAKEOVER_REQUIRED'});
  const taken=await f.setup.connectProvider({...other,confirmTakeover:true});
  assert.equal(taken.backupPath,legacy.backupPath);
  assert.equal(taken.launcherPath,legacy.launcherPath);
  assert.deepEqual(await fs.readFile(f.settingsPath),before);
  await f.setup.disconnectProvider({...other,connectionId:taken.id});
  assert.deepEqual(await readJson(f.settingsPath),legacy.original);
});

test('legacy takeover discovery includes shared runtime ancestry before confirmation',async t=>{
  const f=await fixture(t),legacy=await seedLegacyConnection(f);
  const ancestor=path.dirname(legacy.root);
  await fs.chmod(ancestor,0o2770);
  await fs.rmdir(f.options.storagePath);
  const other={...f.options,storagePath:path.join(f.homeDir,'other-editor')};
  const files=[f.settingsPath,legacy.receiptPath,legacy.launcherPath,legacy.backupPath];
  const before=await Promise.all(files.map(file=>fs.readFile(file)));
  const preview=await f.setup.discoverProvider(other);
  const info=await fs.stat(ancestor);
  assert.deepEqual(preview.sharedDirectories,[{path:ancestor,kind:'directory',uid:info.uid,gid:info.gid,mode:0o2770}]);
  assert.deepEqual(await Promise.all(files.map(file=>fs.readFile(file))),before);
  await assert.rejects(fs.stat(other.storagePath),{code:'ENOENT'});
  await assert.rejects(fs.stat(path.join(f.homeDir,'.local/state/llm-account-usage/connections')),{code:'ENOENT'});
  await assert.rejects(f.setup.connectProvider({...other,confirmTakeover:true}));
  assert.deepEqual(await Promise.all(files.map(file=>fs.readFile(file))),before);
  const reviewed={...other,trustedDirectories:preview.sharedDirectories};
  await assert.rejects(f.setup.connectProvider(reviewed),{code:'TAKEOVER_REQUIRED'});
  const connected=await f.setup.connectProvider({...reviewed,confirmTakeover:true});
  assert.equal(connected.legacy,true);
  assert.equal(connected.launcherPath,legacy.launcherPath);
  assert.deepEqual(await fs.readFile(f.settingsPath),before[0]);
  assert.equal((await fs.stat(ancestor)).mode&0o7777,0o2770);
  await f.setup.disconnectProvider({...reviewed,connectionId:connected.id});
  assert.deepEqual(await readJson(f.settingsPath),legacy.original);
});

test('legacy discovery renews a changed runtime ancestor fingerprint',async t=>{
  const f=await fixture(t),legacy=await seedLegacyConnection(f);
  const ancestor=path.dirname(legacy.root);
  await fs.chmod(ancestor,0o2770);
  const initial=await f.setup.discoverProvider(f.options);
  assert.equal(initial.sharedDirectories.length,1);
  const previous={...f.options,trustedDirectories:initial.sharedDirectories};
  await f.setup.connectProvider(previous);
  await fs.chmod(ancestor,0o2750);
  const renewed=await f.setup.discoverProvider(previous);
  assert.deepEqual(renewed.sharedDirectories,[{...initial.sharedDirectories[0],mode:0o2750}]);
  await assert.rejects(f.setup.connectProvider(previous));
  const connected=await f.setup.connectProvider({...f.options,trustedDirectories:renewed.sharedDirectories});
  assert.equal(connected.launcherPath,legacy.launcherPath);
  assert.deepEqual((await f.setup.listConnections({...f.options,trustedDirectories:renewed.sharedDirectories})).map(value=>value.id),[connected.id]);
  assert.equal((await fs.stat(ancestor)).mode&0o7777,0o2750);
  await f.setup.disconnectProvider({...f.options,trustedDirectories:renewed.sharedDirectories});
  assert.deepEqual(await readJson(f.settingsPath),legacy.original);
});

test('legacy discovery does not request trust for another profile runtime',async t=>{
  const f=await fixture(t),legacy=await seedLegacyConnection(f);
  await fs.chmod(path.dirname(legacy.root),0o2770);
  const profilePath=await createProfile(f,'other-claude');
  const preview=await f.setup.discoverProvider({...f.options,profilePath});
  assert.deepEqual(preview.sharedDirectories,[]);
  const connected=await f.setup.connectProvider({...f.options,profilePath});
  assert.equal(connected.legacy,false);
  assert.notEqual(connected.launcherPath,legacy.launcherPath);
});

for(const stale of [false,true]) {
  test(`legacy discovery previews ${stale?'stale':'missing'} scan-parent trust without inspecting siblings`,async t=>{
    const f=await fixture(t),legacy=await seedLegacyConnection(f);
    const profilePath=await createProfile(f,'sibling-claude');
    const sibling=await f.setup.connectProvider({...f.options,profilePath});
    const siblingRoot=path.dirname(sibling.launcherPath),parent=path.dirname(siblingRoot);
    await fs.chmod(parent,0o2770);
    const info=await fs.stat(parent);
    const previous={path:parent,kind:'directory',uid:info.uid,gid:info.gid,mode:0o2770};
    const mode=stale?0o2750:0o2770;
    if(stale)await fs.chmod(parent,mode);
    await fs.chmod(siblingRoot,0o2770);
    const options={...f.options,trustedDirectories:stale?[previous]:[]};
    const files=[f.settingsPath,legacy.receiptPath,legacy.launcherPath,sibling.settingsPath,sibling.launcherPath];
    const before=await Promise.all(files.map(file=>fs.readFile(file)));
    const siblingReads=[];
    const io=new Proxy(fs,{get(target,key){
      if(['lstat','open','opendir','readFile','realpath'].includes(key))return async(file,...args)=>{
        if([siblingRoot,profilePath].some(root=>file===root||String(file).startsWith(root+path.sep)))siblingReads.push(file);
        return target[key](file,...args);
      };
      return target[key];
    }});
    const preview=await createSetup({fs:io}).discoverProvider(options);
    assert.deepEqual(preview.sharedDirectories,[{...previous,mode}]);
    assert.deepEqual(siblingReads,[]);
    assert.deepEqual(await Promise.all(files.map(file=>fs.readFile(file))),before);
    await assert.rejects(f.setup.connectProvider(options),{code:'DIRECTORY_TRUST_REQUIRED'});
    const approved={...f.options,trustedDirectories:preview.sharedDirectories};
    const connected=await f.setup.connectProvider(approved);
    assert.equal(connected.legacy,true);
    assert.equal(connected.launcherPath,legacy.launcherPath);
    await f.setup.disconnectProvider({...approved,connectionId:connected.id});
    assert.deepEqual(await readJson(f.settingsPath),legacy.original);
    assert.deepEqual(await fs.readFile(sibling.settingsPath),before[3]);
    assert.deepEqual(await fs.readFile(sibling.launcherPath),before[4]);
    assert.equal((await fs.stat(parent)).mode&0o7777,mode);
    assert.equal((await fs.stat(siblingRoot)).mode&0o7777,0o2770);
  });
}

test('refresh warnings identify the failed provider and profile without disabling its neighbor',async t=>{
  const f=await fixture(t),first=await f.setup.connectProvider(f.options);
  const second=await f.setup.connectProvider({...f.options,profilePath:await createProfile(f,'other-claude')});
  const receiptPath=path.join(path.dirname(first.launcherPath),'connection.json');
  const saved=await readJson(receiptPath);
  await writeJson(receiptPath,{...saved,cliLookupPath:path.join(f.homeDir,'missing-cli'),email:'private@example.test'});
  const refreshed=await f.setup.refreshRuntime(f.options);
  assert.deepEqual(refreshed.refreshed,[second.id]);
  assert.equal(refreshed.warnings.length,1);
  assert.ok(refreshed.warnings[0].includes(first.id));
  assert.ok(refreshed.warnings[0].includes('claude'));
  assert.ok(refreshed.warnings[0].includes(first.profilePath));
  assert.equal(refreshed.warnings[0].includes('private@example.test'),false);
});

test('two profiles of one provider connect and disconnect independently in either order',async t=>{
  for(const reverse of [false,true]) {
    const f=await fixture(t);
    const secondProfile=await createProfile(f,'second-claude');
    const second=await f.setup.connectProvider({...f.options,profilePath:secondProfile,
      pendingProcess:{pid:22,uid:process.getuid(),start_ticks:'22',boot_id:'boot'}});
    const first=await f.setup.connectProvider({...f.options,
      pendingProcess:{pid:11,uid:process.getuid(),start_ticks:'11',boot_id:'boot'}});
    assert.notEqual(first.id,second.id);
    assert.notEqual(path.dirname(first.launcherPath),path.dirname(second.launcherPath));
    assert.deepEqual(new Set((await f.setup.listConnections(f.options)).map(value=>value.id)),new Set([first.id,second.id]));
    assert.equal(first.uid,process.getuid());
    assert.equal(first.profilePath,f.profilePath);
    assert.equal(first.pendingProcess.pid,11);
    const [removed,kept]=reverse?[first,second]:[second,first];
    await f.setup.disconnectProvider({...f.options,connectionId:removed.id});
    assert.deepEqual((await f.setup.listConnections(f.options)).map(value=>value.id),[kept.id]);
    assert.match((await readJson(kept.settingsPath)).statusLine.command,/llm-account-usage-managed-v1/);
    assert.deepEqual(await readJson(removed.settingsPath),reverse?{}:{profile:'second-claude'});
  }
});

test('every provider keeps two profile receipts independent in both connection orders',async t=>{
  for(const provider of ['claude','codex','antigravity'])for(const reverse of [false,true]) {
    const f=await fixture(t,provider);
    const other=await createProfile(f,`${provider}-${reverse?'reverse':'forward'}`);
    const profiles=reverse?[other,f.profilePath]:[f.profilePath,other];
    const connected=[];
    for(const profilePath of profiles)connected.push(await f.setup.connectProvider({...f.options,profilePath}));
    assert.equal(new Set(connected.map(value=>value.id)).size,2);
    assert.equal(new Set(connected.map(value=>value.launcherPath)).size,2);
    await f.setup.disconnectProvider({...f.options,profilePath:profiles[0]});
    assert.deepEqual((await f.setup.listConnections(f.options)).map(value=>value.id),[connected[1].id]);
    assert.equal((await f.setup.refreshRuntime(f.options)).refreshed.length,1);
  }
});

test('connection rejects mismatched pending owner and unknown disconnect identities',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.setup.connectProvider({...f.options,pendingProcess:{pid:20,uid:process.getuid()+1,start_ticks:'20',boot_id:'boot'}}),{code:'INVALID_PROCESS'});
  for(const connectionId of ['bad','v2-'+'0'.repeat(32),['v2-'+'0'.repeat(32)]])
    await assert.rejects(f.setup.disconnectProvider({...f.options,connectionId}),{code:'INVALID_CONNECTION'});
});

test('a damaged profile receipt or unsafe runtime cannot suppress a sibling profile',async t=>{
  const f=await fixture(t);
  const first=await f.setup.connectProvider(f.options);
  const second=await f.setup.connectProvider({...f.options,profilePath:await createProfile(f,'sibling')});
  const receiptPath=path.join(path.dirname(first.launcherPath),'connection.json');
  const saved=await readJson(receiptPath);
  for(const change of [{id:second.id},{settingsPath:second.settingsPath}]) {
    await writeJson(receiptPath,{...saved,...change});
    assert.deepEqual((await f.setup.listConnections(f.options)).map(value=>value.id),[second.id]);
    const refresh=await f.setup.refreshRuntime(f.options);
    assert.equal(refresh.warnings.length,1);
    assert.equal(refresh.refreshed.length,1);
  }
  await writeJson(receiptPath,saved);
  await fs.chmod(path.dirname(first.launcherPath),0o755);
  assert.deepEqual((await f.setup.listConnections(f.options)).map(value=>value.id),[second.id]);
  assert.equal((await f.setup.refreshRuntime(f.options)).warnings.length,1);
});

test('connection directory enumeration refuses more than 128 entries',async t=>{
  const f=await fixture(t);
  const first=await f.setup.connectProvider(f.options);
  const parent=path.dirname(path.dirname(first.launcherPath));
  for(let i=0;i<128;i++)await fs.mkdir(path.join(parent,`ignored-${i}`),{mode:0o700});
  await assert.rejects(f.setup.listConnections(f.options),{code:'TOO_MANY_CONNECTIONS'});
  await assert.rejects(f.setup.refreshRuntime(f.options),{code:'TOO_MANY_CONNECTIONS'});
});

test('connection capacity rejects creation while existing connections remain usable',async t=>{
  const f=await fixture(t);
  const first=await f.setup.connectProvider(f.options);
  const parent=path.dirname(path.dirname(first.launcherPath));
  for(let i=0;i<127;i++)await fs.mkdir(path.join(parent,`v2-${i.toString(16).padStart(32,'0')}`),{mode:0o700});
  const profilePath=await createProfile(f,'overflow');
  await assert.rejects(f.setup.connectProvider({...f.options,profilePath}),{code:'TOO_MANY_CONNECTIONS'});
  assert.equal((await fs.readdir(parent)).length,128);
  assert.deepEqual(await readJson(path.join(profilePath,'settings.json')),{profile:'overflow'});
  assert.equal((await f.setup.connectProvider(f.options)).id,first.id);
  assert.deepEqual((await f.setup.listConnections(f.options)).map(value=>value.id),[first.id]);
  assert.deepEqual((await f.setup.refreshRuntime(f.options)).refreshed,[first.id]);
  assert.equal((await f.setup.disconnectProvider({...f.options,connectionId:first.id})).connected,false);
});

test('concurrent connection creation cannot claim the same final capacity slot',async t=>{
  const f=await fixture(t);
  const first=await f.setup.connectProvider(f.options);
  const parent=path.dirname(path.dirname(first.launcherPath));
  for(let i=0;i<126;i++)await fs.mkdir(path.join(parent,`v2-${i.toString(16).padStart(32,'0')}`),{mode:0o700});
  const profileA=await createProfile(f,'racing-a'),profileB=await createProfile(f,'racing-b');
  const preview=await f.setup.discoverProvider({...f.options,profilePath:profileA});
  const rootA=path.join(parent,preview.id);
  let release,entered;
  const gate=new Promise(resolve=>{release=resolve;});
  const reached=new Promise(resolve=>{entered=resolve;});
  const io=new Proxy(fs,{get(target,key){
    if(key==='mkdir')return async(file,...args)=>{
      if(file===rootA){entered();await gate;}
      return target.mkdir(file,...args);
    };
    return target[key];
  }});
  const setup=createSetup({fs:io});
  const connecting=setup.connectProvider({...f.options,profilePath:profileA});
  await reached;
  let competing;
  try {
    assert.equal((await f.setup.connectProvider(f.options)).id,first.id);
    competing=await Promise.allSettled([f.setup.connectProvider({...f.options,profilePath:profileB})]);
  } finally {release();}
  await connecting;
  assert.equal(competing[0].status,'rejected');
  assert.ok(['SETUP_BUSY','TOO_MANY_CONNECTIONS'].includes(competing[0].reason.code));
  assert.equal((await fs.readdir(parent)).length,128);
  assert.deepEqual(await readJson(path.join(profileB,'settings.json')),{profile:'racing-b'});
  assert.equal((await f.setup.listConnections(f.options)).length,2);
});

test('fresh connect installs stable private runtime and preserves unrelated config', async t => {
  const f = await fixture(t);
  await writeJson(f.settingsPath, {theme:'dark', permissions:{deny:['example']}});
  const before = await fs.readFile(f.settingsPath);
  const preview = await f.setup.discoverProvider(f.options);
  assert.equal(preview.hasExistingStatusLine, false);
  assert.equal(preview.settingsPath, f.settingsPath);
  const result = await f.setup.connectProvider(f.options);
  const config = await readJson(f.settingsPath);
  assert.equal(config.theme, 'dark');
  assert.deepEqual(config.permissions, {deny:['example']});
  assert.equal(result.connected, true);
  assert.deepEqual(await fs.readFile(result.backupPath), before);
  assert.equal((await fs.stat(result.reportDir)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(result.backupPath)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.dirname(result.launcherPath))).mode & 0o777, 0o700);
  const run = JSON.parse(execFileSync('/bin/sh', [result.launcherPath], {input:'{}', encoding:'utf8'}));
  assert.ok(run.args.includes('--claude-auth-status'));
  const trustIndex = run.args.indexOf('--trusted-cli-paths-json');
  assert.notEqual(trustIndex, -1);
  assert.deepEqual(JSON.parse(run.args[trustIndex + 1]), []);
  assert.equal(run.electron, '1');
  assert.equal(run.args[0], 'claude-statusline');
  assert.deepEqual((await f.setup.listConnections(f.options)).map(v => v.reportDir), [result.reportDir]);
});

test('shared home and profile require reviewed trust, then connect without changing permissions', async t => {
  const f = await fixture(t);
  await writeJson(f.settingsPath, {theme:'keep'});
  await fs.chmod(f.homeDir, 0o2770);
  await fs.chmod(f.profilePath, 0o2775);
  const before = await fs.readFile(f.settingsPath);
  const preview = await f.setup.discoverProvider(f.options);
  assert.deepEqual(preview.sharedDirectories.map(item => item.path), [f.homeDir, f.profilePath]);
  assert.deepEqual(await fs.readFile(f.settingsPath), before);
  await assert.rejects(fs.stat(f.options.storagePath), {code:'ENOENT'});
  await assert.rejects(f.setup.connectProvider(f.options), {code:'DIRECTORY_TRUST_REQUIRED'});
  const options = {...f.options, trustedDirectories:preview.sharedDirectories};
  const result = await f.setup.connectProvider(options);
  assert.equal(result.connected, true);
  assert.deepEqual((await f.setup.listConnections(options)).map(value => value.provider), ['claude']);
  assert.deepEqual((await f.setup.refreshRuntime(options)).warnings, []);
  assert.equal((await fs.stat(f.homeDir)).mode & 0o7777, 0o2770);
  assert.equal((await fs.stat(f.profilePath)).mode & 0o7777, 0o2775);
  await f.setup.disconnectProvider(options);
  assert.deepEqual(await readJson(f.settingsPath), {theme:'keep'});
});

test('shared directory trust cannot approve a different group, world writes, links or writable settings', async t => {
  const f = await fixture(t);
  await writeJson(f.settingsPath, {});
  await fs.chmod(f.homeDir, 0o2770);
  const preview = await f.setup.discoverProvider(f.options);
  const wrongGroup = preview.sharedDirectories.map(item => ({...item, gid:item.gid + 1}));
  await assert.rejects(f.setup.connectProvider({...f.options, trustedDirectories:wrongGroup}), {code:'DIRECTORY_TRUST_REQUIRED'});
  const options = {...f.options, trustedDirectories:preview.sharedDirectories};
  await fs.chmod(f.homeDir, 0o777);
  await assert.rejects(f.setup.discoverProvider(options), {code:'UNSAFE_PATH'});
  await fs.chmod(f.homeDir, 0o2770);
  await fs.chmod(f.settingsPath, 0o660);
  await assert.rejects(f.setup.connectProvider(options), {code:'UNSAFE_PATH'});
  await fs.chmod(f.settingsPath, 0o600);
  const link = path.join(f.homeDir, 'linked');
  await fs.symlink(f.profilePath, link);
  await assert.rejects(f.setup.connectProvider({...options, profilePath:link}), {code:'UNSAFE_PATH'});
});

test('a CLI controlled by another user or shared group reaches explicit trust instead of being refused', async t => {
  const f = await fixture(t, 'codex');
  await writeJson(f.settingsPath, {});
  const sharedRoot = path.join(f.homeDir, 'shared-cli');
  const sharedLib = path.join(sharedRoot, 'lib');
  const executable = path.join(sharedLib, 'codex');
  await fs.mkdir(sharedLib, {recursive:true, mode:0o2775});
  await fs.chmod(sharedRoot, 0o2775);
  await fs.chmod(sharedLib, 0o2775);
  await fs.copyFile(process.execPath, executable);
  await fs.chmod(executable, 0o775);
  const externalUid = process.getuid() + 1000;
  const sharedGid = 4242;
  const externalInfo = async (method, file, ...args) => {
    const info = await fs[method](file, ...args);
    if(file === sharedRoot || file === sharedLib || file === executable) {
      info.uid = externalUid;
      info.gid = sharedGid;
    }
    return info;
  };
  const io = new Proxy(fs, {get(target, key) {
    if(key === 'lstat' || key === 'stat')return (file, ...args) => externalInfo(key, file, ...args);
    return target[key];
  }});
  const setup = createSetup({fs:io});
  const options = {...f.options, cliPath:executable};

  const preview = await setup.discoverProvider(options);
  assert.deepEqual(preview.sharedDirectories.map(item => ({path:item.path,kind:item.kind,uid:item.uid,gid:item.gid})), [
    {path:sharedRoot,kind:'directory',uid:externalUid,gid:sharedGid},
    {path:sharedLib,kind:'directory',uid:externalUid,gid:sharedGid},
    {path:executable,kind:'executable',uid:externalUid,gid:sharedGid}
  ]);
  await assert.rejects(setup.connectProvider(options), {code:'DIRECTORY_TRUST_REQUIRED'});
  const result = await setup.connectProvider({...options, trustedDirectories:preview.sharedDirectories});
  assert.equal(result.connected, true);
});

test('CLI trust is invalidated by changed ownership or permissions and never accepts world writes', async t => {
  const f = await fixture(t, 'codex');
  await writeJson(f.settingsPath, {});
  const executable = path.join(f.homeDir, 'shared-codex');
  await fs.copyFile(process.execPath, executable);
  await fs.chmod(executable, 0o755);
  const externalUid = process.getuid() + 1000;
  const sharedGid = 4242;
  let permissions = 0o755;
  const io = new Proxy(fs, {get(target, key) {
    if(key === 'stat')return async (file, ...args) => {
      const info = await target.stat(file, ...args);
      if(file === executable) {
        info.uid = externalUid;
        info.gid = sharedGid;
        info.mode = (info.mode & ~0o7777) | permissions;
      }
      return info;
    };
    return target[key];
  }});
  const setup = createSetup({fs:io});
  const options = {...f.options, cliPath:executable};
  const preview = await setup.discoverProvider(options);
  const trusted = {...options, trustedDirectories:preview.sharedDirectories};

  assert.deepEqual((await setup.discoverProvider(trusted)).sharedDirectories, []);
  permissions = 0o775;
  const changed = await setup.discoverProvider(trusted);
  assert.deepEqual(changed.sharedDirectories.map(item => item.path), [executable]);
  await assert.rejects(setup.connectProvider(trusted), {code:'DIRECTORY_TRUST_REQUIRED'});
  permissions = 0o777;
  await assert.rejects(setup.discoverProvider(trusted), {code:'UNSUPPORTED_CLI'});
});

test('permission drift hides the connection, disables its launcher and requires renewed trust', async t => {
  const f = await fixture(t);
  await writeJson(f.settingsPath, {});
  const executable = path.join(f.homeDir, 'shared-claude');
  await fs.copyFile(process.execPath, executable);
  await fs.chmod(executable, 0o755);
  const externalUid = process.getuid() + 1000, sharedGid = 4242;
  let permissions = 0o755;
  const io = new Proxy(fs, {get(target, key) {
    if(key === 'stat')return async (file, ...args) => {
      const info = await target.stat(file, ...args);
      if(file === executable) {
        info.uid = externalUid;info.gid = sharedGid;
        info.mode = (info.mode & ~0o7777) | permissions;
      }
      return info;
    };
    return target[key];
  }});
  const setup = createSetup({fs:io});
  const options = {...f.options, cliPath:executable};
  const firstReview = await setup.discoverProvider(options);
  const trusted = {...options, trustedDirectories:firstReview.sharedDirectories};
  const installed = await setup.connectProvider(trusted);
  permissions = 0o775;
  assert.deepEqual(await setup.listConnections(trusted), []);
  const refreshed = await setup.refreshRuntime(trusted);
  assert.deepEqual(refreshed.refreshed, []);
  assert.equal(refreshed.warnings.length, 1);
  // A disabled launcher exits immediately; no stdin writer is needed to prove
  // it emits nothing, and racing a write against that exit can raise EPIPE.
  assert.equal(execFileSync('/bin/sh', [installed.launcherPath], {stdio:['ignore','pipe','pipe'], encoding:'utf8'}), '');
  const nextReview = await setup.discoverProvider(trusted);
  assert.deepEqual(nextReview.sharedDirectories.map(item => item.path), [executable]);
  const renewed = {...options, trustedDirectories:firstReview.sharedDirectories.filter(item => item.path !== executable).concat(nextReview.sharedDirectories)};
  await setup.connectProvider(renewed);
  const run = JSON.parse(execFileSync('/bin/sh', [installed.launcherPath], {input:'{}', encoding:'utf8'}));
  const trustIndex = run.args.indexOf('--trusted-cli-paths-json');
  assert.deepEqual(JSON.parse(run.args[trustIndex + 1]).find(item => item.path === executable).mode, 0o775);
});

test('reconnect persists a newly detected native target after a package launcher update', async t => {
  const f = await fixture(t);
  const first = path.join(f.homeDir, 'native-v1'), second = path.join(f.homeDir, 'native-v2');
  await fs.copyFile(process.execPath, first);await fs.chmod(first, 0o700);
  await fs.copyFile(process.execPath, second);await fs.chmod(second, 0o700);
  const installed = await f.setup.connectProvider({...f.options,cliPath:first});
  await f.setup.connectProvider({...f.options,cliPath:second});
  const run = JSON.parse(execFileSync('/bin/sh', [installed.launcherPath], {input:'{}', encoding:'utf8'}));
  assert.equal(run.args[run.args.indexOf('--cli-executable') + 1], second);
  const receipt = await readJson(path.join(path.dirname(installed.launcherPath), 'connection.json'));
  assert.equal(receipt.cliPath, second);
  assert.equal(receipt.cliLookupPath, second);
});

test('disabling a drifted collector still preserves the original statusline byte stream', async t => {
  const f = await fixture(t);
  await writeJson(f.settingsPath, {statusLine:{type:'command',command:'printf "kept:"; cat'}});
  const executable = path.join(f.homeDir, 'shared-claude');
  await fs.copyFile(process.execPath, executable);await fs.chmod(executable, 0o770);
  const options = {...f.options,cliPath:executable};
  const preview = await f.setup.discoverProvider(options);
  const trusted = {...options,trustedDirectories:preview.sharedDirectories};
  await f.setup.connectProvider(trusted);
  await fs.chmod(executable, 0o750);
  assert.equal((await f.setup.refreshRuntime(trusted)).warnings.length, 1);
  const command = (await readJson(f.settingsPath)).statusLine.command;
  assert.equal(execFileSync('/bin/sh', ['-c', command], {input:'original bytes',encoding:'utf8'}), 'kept:original bytes');
});

test('repeated connect preserves original backup and statusline stdin, shell syntax and stdout', async t => {
  const f = await fixture(t);
  const original = {type:'command', command:'prefix=kept; printf "%s:" "$prefix"; cat', padding:2};
  await writeJson(f.settingsPath, {statusLine:original, other:1});
  const first = await f.setup.connectProvider(f.options);
  const second = await f.setup.connectProvider(f.options);
  assert.equal(first.backupPath, second.backupPath);
  assert.equal((await readJson(f.settingsPath)).statusLine.padding, 2);
  const input = Buffer.from([0, 10, 13, 255, 123, 125]);
  const output = execFileSync('/bin/sh', ['-c', (await readJson(f.settingsPath)).statusLine.command], {input});
  assert.deepEqual(output, Buffer.concat([Buffer.from('kept:'), input]));
  await f.setup.disconnectProvider(f.options);
  assert.deepEqual((await readJson(f.settingsPath)).statusLine, original);
});

test('disconnect removes only installed key and preserves later unrelated edits', async t => {
  const f = await fixture(t);
  const result = await f.setup.connectProvider(f.options);
  const config = await readJson(f.settingsPath);
  config.theme = 'changed';
  await writeJson(f.settingsPath, config);
  await fs.writeFile(path.join(result.reportDir, 'someone-elses-file'), 'keep', {mode:0o600});
  const disconnected = await f.setup.disconnectProvider(f.options);
  assert.equal(disconnected.connected, false);
  assert.deepEqual(await readJson(f.settingsPath), {theme:'changed'});
  assert.equal(await fs.readFile(path.join(result.reportDir, 'someone-elses-file'), 'utf8'), 'keep');
  assert.deepEqual(await f.setup.listConnections(f.options), []);
  assert.equal((await f.setup.disconnectProvider(f.options)).connected, false);
});

test('edited installed statusline blocks reconnect and disconnect without clobbering', async t => {
  const f = await fixture(t);
  await f.setup.connectProvider(f.options);
  const config = await readJson(f.settingsPath);
  config.statusLine.command += ' # edited';
  await writeJson(f.settingsPath, config);
  const before = await fs.readFile(f.settingsPath);
  await assert.rejects(f.setup.disconnectProvider(f.options), {code:'SETTINGS_CHANGED'});
  await assert.rejects(f.setup.connectProvider(f.options), {code:'SETTINGS_CHANGED'});
  assert.deepEqual(await fs.readFile(f.settingsPath), before);
});

test('activation refresh updates owned runtime without writing provider settings', async t => {
  const f = await fixture(t);
  const result = await f.setup.connectProvider(f.options);
  const before = await fs.readFile(f.settingsPath);
  await fs.writeFile(f.collectorPath, 'process.stdout.write("upgraded");', {mode:0o600});
  const refreshed = await f.setup.refreshRuntime(f.options);
  assert.deepEqual(refreshed.warnings, []);
  assert.deepEqual(await fs.readFile(f.settingsPath), before);
  assert.equal(execFileSync('/bin/sh', [result.launcherPath], {encoding:'utf8'}), 'upgraded');
  await f.setup.disconnectProvider(f.options);
  assert.deepEqual(await readJson(f.settingsPath), {});
});

test('existing statusline survives a missing or crashing Node runtime and removed editor storage', async t => {
  const f = await fixture(t);
  await writeJson(f.settingsPath, {statusLine:{type:'command', command:'cat; exit 7'}});
  const localNode = path.join(f.homeDir, 'old-node');
  await fs.copyFile(process.execPath, localNode);
  await fs.chmod(localNode, 0o700);
  const result = await f.setup.connectProvider({...f.options, nodePath:localNode});
  const command = (await readJson(f.settingsPath)).statusLine.command;
  await fs.unlink(localNode);
  await fs.rm(f.options.storagePath, {recursive:true, force:true});
  const input = Buffer.from([0, 255, 10, 123, 125]);
  function run() {
    try { execFileSync('/bin/sh', ['-c', command], {input}); assert.fail('original must exit 7'); }
    catch(error) { assert.equal(error.status, 7); assert.deepEqual(error.stdout, input); }
  }
  run();
  await fs.writeFile(f.collectorPath, 'process.exit(23);', {mode:0o600});
  await f.setup.refreshRuntime(f.options);
  run();
});

test('a hung collector is bounded while original statusline keeps its bytes and exit status', {timeout:17000}, async t => {
  const f = await fixture(t);
  await writeJson(f.settingsPath, {statusLine:{type:'command', command:'cat; exit 9'}});
  await fs.writeFile(f.collectorPath, 'process.stdin.resume();setInterval(()=>{},1000);', {mode:0o600});
  const result = await f.setup.connectProvider(f.options);
  const started = Date.now();
  const command = (await readJson(f.settingsPath)).statusLine.command;
  try { execFileSync('/bin/sh', ['-c', command], {input:'unchanged bytes', timeout:15000}); assert.fail('original must exit 9'); }
  catch(error) { assert.equal(error.status, 9); assert.equal(error.stdout.toString(), 'unchanged bytes'); }
  assert.ok(Date.now() - started < 14500);
  assert.equal((await fs.readdir(path.dirname(result.launcherPath))).some(name => name.startsWith('.stream-')), false);
});

test('the provider execution shell retains bash-only syntax and original command exit status', async t => {
  const f = await fixture(t);
  const original = 'values=(one two); [[ ${values[1]} == two ]] || exit 3; printf "%s:" "${values[0]}"; cat; exit 7';
  await writeJson(f.settingsPath, {statusLine:{type:'command', command:original}});
  await f.setup.connectProvider(f.options);
  const command = (await readJson(f.settingsPath)).statusLine.command;
  try { execFileSync('/bin/bash', ['-c', command], {input:'preserved'}); assert.fail('original must exit 7'); }
  catch(error) { assert.equal(error.status, 7); assert.equal(error.stdout.toString(), 'one:preserved'); }
});

test('another editor storage cannot chain an already managed provider hook', async t => {
  const f = await fixture(t);
  await f.setup.connectProvider(f.options);
  const before = await fs.readFile(f.settingsPath);
  const other = {...f.options, storagePath:path.join(f.homeDir, 'other-editor')};
  await assert.rejects(f.setup.connectProvider(other), {code:'ALREADY_CONNECTED'});
  assert.deepEqual(await fs.readFile(f.settingsPath), before);
});

test('missing editor ownership requires explicit takeover confirmation', async t => {
  const f = await fixture(t);
  const installed = await f.setup.connectProvider(f.options);
  const original = await fs.readFile(f.settingsPath);
  const other = {...f.options, storagePath:path.join(f.homeDir, 'other-editor')};
  await assert.rejects(f.setup.connectProvider({...other, confirmTakeover:true}), {code:'ALREADY_CONNECTED'});
  await fs.rm(f.options.storagePath, {recursive:true, force:true});
  await assert.rejects(f.setup.connectProvider(other), {code:'TAKEOVER_REQUIRED', recoverable:true, recoveryAction:'confirm-takeover', safeToDisplay:true});
  assert.deepEqual(await fs.readFile(f.settingsPath), original);
  const taken = await f.setup.connectProvider({...other, confirmTakeover:true});
  assert.equal(taken.backupPath, installed.backupPath);
  assert.deepEqual(await fs.readFile(f.settingsPath), original);
  await f.setup.disconnectProvider(other);
  assert.deepEqual(await readJson(f.settingsPath), {});
});

test('disconnect recovery listing retains orphaned receipts without changing live report eligibility or files',async t=>{
  for(const provider of ['claude','codex','antigravity'])for(const legacy of [false,true]) {
    const f=await fixture(t,provider);
    if(legacy)await seedLegacyConnection(f);
    else await f.setup.connectProvider(f.options);
    const [installed]=await f.setup.listConnections(f.options);
    const original=await fs.readFile(installed.backupPath);
    const receiptPath=path.join(path.dirname(installed.launcherPath),'connection.json');
    const files=[installed.settingsPath,receiptPath,installed.launcherPath,installed.backupPath];
    const before=await Promise.all(files.map(file=>fs.readFile(file)));
    await fs.rmdir(f.options.storagePath);
    const other={...f.options,storagePath:path.join(f.homeDir,'other-editor')};
    assert.deepEqual(await f.setup.listConnections(other),[]);
    const listed=await f.setup.listDisconnectConnections(other);
    assert.deepEqual(listed,[installed]);
    assert.deepEqual(await Promise.all(files.map(file=>fs.readFile(file))),before);
    await assert.rejects(fs.stat(other.storagePath),{code:'ENOENT'});
    await assert.rejects(f.setup.disconnectProvider({...other,connectionId:listed[0].id}),{code:'TAKEOVER_REQUIRED'});
    assert.deepEqual(await Promise.all(files.map(file=>fs.readFile(file))),before);
    await f.setup.disconnectProvider({...other,connectionId:listed[0].id,confirmTakeover:true});
    assert.deepEqual(await readJson(installed.settingsPath),JSON.parse(original));
    assert.deepEqual(await f.setup.listDisconnectConnections(other),[]);
  }
});

test('disconnect recovery listing retains a connection whose CLI disappeared',async t=>{
  const f=await fixture(t);
  const cliPath=path.join(f.homeDir,'native-cli');
  await fs.symlink(process.execPath,cliPath);
  const installed=await f.setup.connectProvider({...f.options,cliPath});
  await fs.unlink(cliPath);
  const receiptPath=path.join(path.dirname(installed.launcherPath),'connection.json');
  const files=[installed.settingsPath,receiptPath,installed.launcherPath,installed.backupPath];
  const before=await Promise.all(files.map(file=>fs.readFile(file)));
  assert.deepEqual(await f.setup.listConnections(f.options),[]);
  assert.deepEqual(await f.setup.listDisconnectConnections(f.options),[installed]);
  assert.deepEqual(await Promise.all(files.map(file=>fs.readFile(file))),before);
  await f.setup.disconnectProvider({...f.options,connectionId:installed.id});
  assert.deepEqual(await readJson(installed.settingsPath),{});
  assert.deepEqual(await f.setup.listDisconnectConnections(f.options),[]);
});

test('disconnect recovery listing isolates corrupt receipts and excludes another live editor',async t=>{
  const f=await fixture(t);
  const current=await f.setup.connectProvider(f.options);
  const corrupt=await f.setup.connectProvider({...f.options,profilePath:await createProfile(f,'corrupt-profile')});
  const other=await f.setup.connectProvider({...f.options,profilePath:await createProfile(f,'other-editor-profile'),
    storagePath:path.join(f.homeDir,'other-editor')});
  const corruptReceipt=path.join(path.dirname(corrupt.launcherPath),'connection.json');
  await fs.writeFile(corruptReceipt,'{bad',{mode:0o600});
  const files=[current.settingsPath,other.settingsPath,corruptReceipt,current.launcherPath,other.launcherPath];
  const before=await Promise.all(files.map(file=>fs.readFile(file)));
  assert.deepEqual(await f.setup.listDisconnectConnections(f.options),[current]);
  assert.deepEqual(await Promise.all(files.map(file=>fs.readFile(file))),before);
  await assert.rejects(f.setup.disconnectProvider({...f.options,connectionId:other.id,confirmTakeover:true}),{code:'ALREADY_CONNECTED'});
});

test('interrupted install and manual hook removal recover without overwriting replacement settings', async t => {
  const f = await fixture(t);
  for(const replacement of [{theme:'new'}, {statusLine:{type:'command',command:'printf owner-replacement'}, theme:'new'}]) {
    await f.setup.connectProvider(f.options);
    await writeJson(f.settingsPath, replacement);
    const before = await fs.readFile(f.settingsPath);
    const result = await f.setup.disconnectProvider(f.options);
    assert.equal(result.connected, false);
    assert.deepEqual(await fs.readFile(f.settingsPath), before);
    await f.setup.connectProvider(f.options);
    await f.setup.disconnectProvider(f.options);
    assert.deepEqual(await readJson(f.settingsPath), replacement);
  }
  await f.setup.connectProvider(f.options);
  await fs.unlink(f.settingsPath);
  await f.setup.connectProvider(f.options);
  assert.ok((await readJson(f.settingsPath)).statusLine.command.includes('llm-account-usage-managed-v1'));
});

async function processMarker() {
  const text = await fs.readFile(`/proc/${process.pid}/stat`, 'utf8');
  return {pid:process.pid, uid:process.getuid(), start_ticks:text.slice(text.lastIndexOf(')') + 2).split(' ')[19],
    boot_id:(await fs.readFile('/proc/sys/kernel/random/boot_id','utf8')).trim()};
}
async function installLock(root, marker) {
  const directory = path.join(root, '.setup-lock');
  await fs.mkdir(directory, {mode:0o700});
  await writeJson(path.join(directory, 'owner-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.json'), marker);
  return directory;
}
test('only provably dead setup locks are reclaimed and live activation contention is benign', async t => {
  const f = await fixture(t);
  const installed = await f.setup.connectProvider(f.options);
  const root = path.dirname(installed.launcherPath), marker = await processMarker();
  let lock = await installLock(root, {...marker, boot_id:'00000000-0000-0000-0000-000000000000'});
  await f.setup.connectProvider(f.options);
  assert.equal(await fs.stat(lock).catch(e => e.code), 'ENOENT');
  lock = await installLock(root, {...marker, start_ticks:String(BigInt(marker.start_ticks) + 1n)});
  await f.setup.disconnectProvider(f.options);
  await f.setup.connectProvider(f.options);
  lock = await installLock(root, marker);
  await assert.rejects(f.setup.disconnectProvider(f.options), {code:'SETUP_BUSY'});
  assert.deepEqual((await f.setup.refreshRuntime(f.options)).warnings, []);
  assert.ok(await fs.stat(lock));
  await fs.rm(lock, {recursive:true});
  await fs.writeFile(lock, '', {mode:0o600});
  await assert.rejects(f.setup.connectProvider(f.options), {code:'SETUP_LOCK_UNVERIFIABLE', recoverable:true, recoveryAction:'review-lock'});
  assert.equal((await fs.stat(lock)).isFile(), true);
});

test('process crashes before installation, after installation, and after restoration remain recoverable', async t => {
  const f = await fixture(t);
  const original = {theme:'retained',statusLine:{type:'command',command:'printf original'}};
  await writeJson(f.settingsPath, original);
  const child = `const fs=require('node:fs/promises');const {createSetup}=require(process.argv[1]);
    const options=JSON.parse(process.argv[2]),phase=process.argv[3];
    const io=new Proxy(fs,{get(target,key){if(key==='rename')return async(from,to)=>{
      await target.rename(from,to);
      if((phase==='receipt'&&String(to).endsWith('/connection.json'))||
         (phase!=='receipt'&&to===options.homeDir+'/.claude/settings.json'))process.exit(17);
    };return target[key];}});
    createSetup({fs:io})[phase==='restore'?'disconnectProvider':'connectProvider'](options).then(()=>process.exit(99)).catch(()=>process.exit(98));`;
  const crash = phase => {
    const result = spawnSync(process.execPath, ['-e', child, path.resolve(__dirname, '../src/setup.cjs'), JSON.stringify(f.options), phase],
      {env:{...process.env,NODE_NO_WARNINGS:'1'},timeout:5000});
    assert.equal(result.status, 17);
  };
  crash('receipt');
  assert.deepEqual(await readJson(f.settingsPath), original);
  await f.setup.disconnectProvider(f.options);
  assert.deepEqual(await readJson(f.settingsPath), original);
  crash('install');
  assert.ok((await readJson(f.settingsPath)).statusLine.command.includes('llm-account-usage-managed-v1'));
  await f.setup.connectProvider(f.options);
  crash('restore');
  assert.deepEqual(await readJson(f.settingsPath), original);
  await f.setup.disconnectProvider(f.options);
  await f.setup.connectProvider(f.options);
  await f.setup.disconnectProvider(f.options);
  assert.deepEqual(await readJson(f.settingsPath), original);
});

test('a corrupt receipt cannot suppress another valid provider connection', async t => {
  const f = await fixture(t);
  const claude = await f.setup.connectProvider(f.options);
  const agyProfile = path.join(f.homeDir, '.gemini/antigravity-cli');
  await fs.mkdir(agyProfile, {recursive:true, mode:0o700});
  const antigravity = await f.setup.connectProvider({...f.options, provider:'antigravity'});
  await fs.writeFile(path.join(path.dirname(claude.launcherPath), 'connection.json'), '{bad', {mode:0o600});
  const connections = await f.setup.listConnections(f.options);
  assert.deepEqual(connections.map(v => v.provider), ['antigravity']);
  const refreshed = await f.setup.refreshRuntime(f.options);
  assert.equal(refreshed.warnings.length, 1);
  assert.deepEqual(refreshed.refreshed, [antigravity.id]);
});

test('settings owned by another user and shared runtime directories are refused', async t => {
  const f = await fixture(t);
  await writeJson(f.settingsPath, {});
  const io = new Proxy(fs, {get(target, key) {
    if(key === 'lstat') return async file => {
      const info = await target.lstat(file);
      if(file === f.settingsPath) info.uid += 1;
      return info;
    };
    return target[key];
  }});
  await assert.rejects(createSetup({fs:io}).connectProvider(f.options), {code:'UNSAFE_PATH'});
  const result = await f.setup.connectProvider(f.options);
  await fs.chmod(path.dirname(result.launcherPath), 0o755);
  await assert.rejects(f.setup.disconnectProvider(f.options), {code:'UNSAFE_PATH'});
});

test('provider CLI symlink upgrades refresh runtime without changing settings', async t => {
  const f = await fixture(t);
  const first = path.join(f.homeDir, 'cli-first');
  const second = path.join(f.homeDir, 'cli-second');
  const alias = path.join(f.homeDir, 'cli');
  await fs.copyFile(process.execPath, first);
  await fs.chmod(first, 0o700);
  await fs.copyFile('/usr/bin/true', second);
  await fs.chmod(second, 0o700);
  await fs.symlink(first, alias);
  const result = await f.setup.connectProvider({...f.options, cliPath:alias});
  const before = await fs.readFile(f.settingsPath);
  await fs.unlink(alias);
  await fs.symlink(second, alias);
  await fs.unlink(first);
  const unrefreshed = JSON.parse(execFileSync('/bin/sh', [result.launcherPath], {input:'{}', encoding:'utf8'}));
  assert.equal(unrefreshed.args[unrefreshed.args.indexOf('--cli-lookup-path') + 1], alias);
  assert.equal(await fs.realpath(unrefreshed.args[unrefreshed.args.indexOf('--cli-lookup-path') + 1]), second);
  await f.setup.refreshRuntime(f.options);
  const run = JSON.parse(execFileSync('/bin/sh', [result.launcherPath], {input:'{}', encoding:'utf8'}));
  assert.equal(run.args[run.args.indexOf('--cli-executable') + 1], second);
  assert.deepEqual(await fs.readFile(f.settingsPath), before);
});

test('profile overrides are explicit and preview contains no existing command text', async t => {
  const f = await fixture(t);
  const custom = path.join(f.homeDir, 'custom-profile');
  await fs.mkdir(custom, {mode:0o700});
  await writeJson(path.join(custom, 'settings.json'), {statusLine:{type:'command', command:'printf secret-value'}});
  const preview = await f.setup.discoverProvider({...f.options, env:{CLAUDE_CONFIG_DIR:custom}});
  assert.equal(preview.profilePath, custom);
  assert.equal(preview.hasExistingStatusLine, true);
  assert.equal(JSON.stringify(preview).includes('secret-value'), false);
  await assert.rejects(f.setup.discoverProvider({...f.options, env:{CLAUDE_CONFIG_DIR:'relative'}}), {code:'PROFILE_REQUIRED'});
  await assert.rejects(f.setup.discoverProvider({...f.options, env:{CLAUDE_PROFILE:'unknown'}}), {code:'PROFILE_REQUIRED'});
});

test('Antigravity uses its own config and native idle usage collector', async t => {
  const f = await fixture(t, 'antigravity');
  const result = await f.setup.connectProvider(f.options);
  const config = await readJson(f.settingsPath);
  assert.equal(config.statusLine.stack_with_default, true);
  const run = JSON.parse(execFileSync('/bin/sh', [result.launcherPath], {input:'{}', encoding:'utf8'}));
  assert.equal(run.args[0], 'antigravity-statusline');
  assert.ok(run.args.includes('--agy-full-usage'));
  await assert.rejects(f.setup.discoverProvider({...f.options, env:{GEMINI_CLI_HOME:'/unknown'}}), {code:'PROFILE_REQUIRED'});
});

test('Codex connect appends one managed Stop hook and preserves unrelated hooks', async t => {
  const f = await fixture(t, 'codex'),invocation=path.join(f.homeDir,'codex-invocation.json');
  await fs.writeFile(f.collectorPath,`const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(invocation)},JSON.stringify({args:process.argv.slice(2),input:fs.readFileSync(0,'utf8'),electron:process.env.ELECTRON_RUN_AS_NODE}));process.stdout.write('PRIVATE');process.stderr.write('PRIVATE');`,{mode:0o600});
  const sessionStart = [{matcher:'.*', hooks:[{type:'command',command:'printf session'}]}];
  const originalStop = [{matcher:'first',hooks:[{type:'command',command:'printf first'}]}, {matcher:'second',hooks:[{type:'command',command:'printf second'}]}];
  await writeJson(f.settingsPath, {theme:'dark', hooks:{SessionStart:sessionStart, Stop:originalStop}});
  const first = await f.setup.connectProvider(f.options), second = await f.setup.connectProvider(f.options);
  assert.equal(first.backupPath, second.backupPath);
  const config = await readJson(f.settingsPath);
  assert.equal(config.theme, 'dark');assert.deepEqual(config.hooks.SessionStart, sessionStart);assert.deepEqual(config.hooks.Stop.slice(0,2), originalStop);
  const managed = config.hooks.Stop.filter(entry => entry.hooks?.some(hook => hook.command?.includes('llm-account-usage-managed-v1')));
  assert.equal(managed.length, 1);assert.equal(managed[0].matcher, '.*');assert.equal(managed[0].hooks[0].type, 'command');
  assert.deepEqual((await f.setup.listConnections(f.options)).map(value=>value.provider), ['codex']);
  const input=JSON.stringify({hook_event_name:'Stop',session_id:'s'}),run=execFileSync('/bin/sh',['-c',managed[0].hooks[0].command],{input,encoding:'utf8'});
  assert.equal(run,'');const called=await readJson(invocation);assert.equal(called.args[0],'codex-hook');assert.ok(called.args.includes('--report-dir'));assert.equal(called.args.includes('--claude-auth-status'),false);assert.equal(called.args.includes('--agy-full-usage'),false);assert.equal(called.input,input);assert.equal(called.electron,'1');
});

test('Codex disconnect removes only its exact managed Stop hook', async t => {
  const f = await fixture(t, 'codex'),original={matcher:'original',hooks:[{type:'command',command:'printf original'}]};
  await writeJson(f.settingsPath, {hooks:{Stop:[original]},theme:'before'});
  await f.setup.connectProvider(f.options);
  const config = await readJson(f.settingsPath),later={matcher:'later',hooks:[{type:'command',command:'printf later'}]};
  config.hooks.Stop.push(later);config.theme='later';await writeJson(f.settingsPath, config);
  const disconnected=await f.setup.disconnectProvider(f.options);assert.equal(disconnected.connected,false);
  const restored=await readJson(f.settingsPath);assert.deepEqual(restored,{hooks:{Stop:[original,later]},theme:'later'});
  assert.deepEqual(await f.setup.listConnections(f.options),[]);
});

test('edited or replaced managed Codex hooks fail closed with recovery intact', async t => {
  const f = await fixture(t, 'codex'),installed=await f.setup.connectProvider(f.options);
  const backup=await fs.readFile(installed.backupPath),runtime=await fs.readFile(path.join(path.dirname(installed.launcherPath),'passive.cjs'));
  const config=await readJson(f.settingsPath),managed=config.hooks.Stop.find(entry=>entry.hooks?.some(hook=>hook.command?.includes('llm-account-usage-managed-v1')));
  managed.hooks[0].command='printf replacement # llm-account-usage-managed-v1';await writeJson(f.settingsPath,config);
  const changed=await fs.readFile(f.settingsPath);await fs.writeFile(f.collectorPath,'process.stdout.write("changed");',{mode:0o600});
  const refreshed=await f.setup.refreshRuntime(f.options);assert.equal(refreshed.refreshed.includes(installed.id),false);assert.equal(refreshed.warnings.length,1);
  assert.deepEqual(await fs.readFile(path.join(path.dirname(installed.launcherPath),'passive.cjs')),runtime);
  await assert.rejects(f.setup.connectProvider(f.options),{code:'SETTINGS_CHANGED'});await assert.rejects(f.setup.disconnectProvider(f.options),{code:'SETTINGS_CHANGED'});
  assert.deepEqual(await fs.readFile(f.settingsPath),changed);assert.deepEqual(await fs.readFile(installed.backupPath),backup);
});

test('unsafe config, symlink directories and unrecognized statuslines are refused', async t => {
  const f = await fixture(t);
  await writeJson(f.settingsPath, {statusLine:{type:'prompt', command:'private'}});
  await assert.rejects(f.setup.connectProvider(f.options), {code:'UNSUPPORTED_STATUSLINE'});
  await writeJson(f.settingsPath, {});
  await fs.chmod(f.settingsPath, 0o666);
  await assert.rejects(f.setup.connectProvider(f.options), {code:'UNSAFE_PATH'});
  await fs.chmod(f.settingsPath, 0o600);
  const link = path.join(f.homeDir, 'linked-profile');
  await fs.symlink(f.profilePath, link);
  await assert.rejects(f.setup.connectProvider({...f.options, profilePath:link}), {code:'UNSAFE_PATH'});
  await fs.unlink(f.settingsPath);
  await fs.symlink(f.collectorPath, f.settingsPath);
  await assert.rejects(f.setup.connectProvider(f.options), {code:'UNSAFE_PATH'});
});

test('non-Linux hosts, missing profiles and script-based CLI launchers are explicit failures', async t => {
  const f = await fixture(t);
  await assert.rejects(f.setup.connectProvider({...f.options, platform:'win32'}), {code:'UNSUPPORTED_PLATFORM'});
  await assert.rejects(f.setup.connectProvider({...f.options, profilePath:path.join(f.homeDir,'missing')}), {code:'PROFILE_REQUIRED'});
  const script = path.join(f.homeDir, 'claude');
  await fs.writeFile(script, '#!/bin/sh\nexit 0\n', {mode:0o700});
  await assert.rejects(f.setup.connectProvider({...f.options, cliPath:script}), {code:'UNSUPPORTED_CLI'});
});

test('compare-before-write refuses a concurrent provider settings edit', async t => {
  const f = await fixture(t);
  await writeJson(f.settingsPath, {old:true});
  let changed = false;
  const io = new Proxy(fs, {get(target, key) {
    if(key === 'open') return async (filename, ...args) => {
      if(path.dirname(String(filename)) === f.profilePath && path.basename(String(filename)).startsWith('.account-usage-')) {
        changed = true;
        await writeJson(f.settingsPath, {new:true});
      }
      return target.open(filename, ...args);
    };
    return target[key];
  }});
  const setup = createSetup({fs:io});
  await assert.rejects(setup.connectProvider(f.options), {code:'SETTINGS_CHANGED'});
  assert.equal(changed, true);
  assert.deepEqual(await readJson(f.settingsPath), {new:true});
});
