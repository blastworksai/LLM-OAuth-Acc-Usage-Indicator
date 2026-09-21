'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {run}=require('../src/setup-cli.cjs');
const id='v2-'+'a'.repeat(32);
const argv=['connect','--provider','claude','--cli','/opt/claude','--result','/drop/result.json','--runtime-version','0.4.0'];
const foreignTarget={provider:'claude',process:{pid:30,uid:2000,start_ticks:'30',boot_id:'boot'}};
const foreignArgv=['connect','--provider','claude','--target',JSON.stringify(foreignTarget),'--result','/drop/result.json','--runtime-version','0.4.0'];
function deps(answer='yes') {
  const calls=[],results=[],output=[],feeds=[],directories=[];
  const preview={id,profilePath:'/home/target/.claude',sharedDirectories:[{path:'/opt/native',kind:'directory',uid:0,gid:2000,mode:0o2750}]};
  const connection={id,provider:'claude',uid:2000,profilePath:preview.profilePath,settingsPath:preview.profilePath+'/settings.json',connected:true,
    cliLookupPath:'/opt/claude',reportDir:'/home/target/.llm-account-usage-feeds/'+id,launcherPath:'/home/target/runtime/run.sh',backupPath:'/home/target/runtime/backup.json'};
  return {calls,results,output,feeds,directories,preview,connection,uid:()=>2000,home:()=>'/home/target',env:{PATH:'/usr/bin'},
    nodePath:'/usr/bin/node',collectorPath:'/bundle/passive.cjs',readConsent:async()=>answer,print:s=>output.push(s),
    ensureReportDirectory:async(...args)=>directories.push(args),checkConnectionFeed:async()=>{},withReportFeedClaim:async(_dir,_id,_options,action)=>action(),writeResult:async(...args)=>results.push(args),
    writeConnectionFeed:async(...args)=>feeds.push(args),
    setup:{discoverProvider:async()=>preview,connectProvider:async options=>{calls.push(options);return connection;},
      listDisconnectConnections:async()=>[connection],disconnectProvider:async options=>{calls.push(options);return {...connection,connected:false};}}};
}
test('target setup uses its own identity and only explicit options after exact trust consent',async()=>{
  const d=deps();assert.equal((await run(argv,d)).code,0);
  assert.equal(d.calls[0].uid,2000);assert.equal(d.calls[0].homeDir,'/home/target');assert.equal(d.calls[0].cliPath,'/opt/claude');
  assert.deepEqual(d.calls[0].trustedDirectories,d.preview.sharedDirectories);
  assert.equal(d.calls[0].pendingProcess,undefined);
  assert.equal(d.calls[0].reportDir,d.connection.reportDir);
  assert.equal(d.calls[0].storagePath,'/home/target/.local/state/llm-account-usage/target-setup');
  assert.match(d.output.join('\n'),/Profile: \/home\/target\/\.claude/);
  assert.match(d.output.join('\n'),/\/opt\/native.*UID 0.*GID 2000.*2750/);
  assert.match(d.output.join('\n'),/trust.*owners.*groups/i);
  assert.equal(d.feeds[0][1].runtimeVersion,'0.4.0');
  assert.equal(d.results[0][0],'/drop/result.json');assert.equal(d.results[0][1].ok,true);
});
test('foreign target verification precedes preview and repeats after consent before mutation',async()=>{
 for(const drift of [false,true]) {
  const d=deps(),order=[];let changed=false;
  d.verifyTargetProcess=async target=>{order.push('verify');assert.deepEqual(target,foreignTarget);return changed?null:{...target,cliPath:'/opt/claude'};};
  const discover=d.setup.discoverProvider;d.setup.discoverProvider=async options=>{order.push('preview');assert.equal(options.cliPath,'/opt/claude');return discover(options);};
  d.readConsent=async()=>{order.push('consent');changed=drift;return 'yes';};
  assert.equal((await run(foreignArgv,d)).code,drift?1:0);
  assert.deepEqual(order,['verify','preview','consent','verify']);assert.equal(d.calls.length,drift?0:1);
  if(drift)assert.equal(d.directories.length,0);
 }
});
test('a foreign target UID or provider mismatch cannot preview a host profile',async()=>{
 for(const target of [{...foreignTarget,provider:'codex'},{...foreignTarget,process:{...foreignTarget.process,uid:1000}}]) {
  const d=deps();d.setup.discoverProvider=async()=>assert.fail('unverified target reached preview');
  d.verifyTargetProcess=async()=>assert.fail('mismatched target must fail locally');
  const args=foreignArgv.map(value=>value===JSON.stringify(foreignTarget)?JSON.stringify(target):value);
  assert.notEqual((await run(args,d)).code,0);assert.equal(d.calls.length,0);
 }
});
test('invalid, duplicate, relative, unknown, oversized and malformed version arguments never reach setup',async()=>{
  for(const args of [[],[...argv,'--provider','codex'],[...argv,'--unknown','x'],argv.map(s=>s==='/opt/claude'?'relative':s),
    argv.map(s=>s==='claude'?'unknown':s),argv.map(s=>s==='0.4.0'?'x'.repeat(5000):s),
    argv.map(s=>s==='0.4.0'?'not-semver':s),argv.slice(0,-1),[...argv,'--runtime-version','0.5.0'],
    argv.map(s=>s==='/opt/claude'?'/opt/\ncli':s)]) {
    const d=deps();d.setup.discoverProvider=async()=>assert.fail('invalid input reached discovery');
    assert.equal((await run(args,d)).code,2);assert.equal(d.calls.length,0);assert.equal(d.results.length,0);
  }
});
test('EOF or anything except full yes cancels without changing a profile or feed',async()=>{
  for(const answer of [null,'','y','no','YES',' yes ']) {
    const d=deps(answer);assert.equal((await run(argv,d)).code,1);
    assert.equal(d.calls.length,0);assert.equal(d.feeds.length,0);assert.equal(d.directories.length,0);
    assert.deepEqual(d.results[0][1],{ok:false,code:'CANCELLED',message:'Setup cancelled.'});
  }
});
test('disconnect previews and disconnects the exact own connection only with yes',async()=>{
  for(const answer of ['no','yes']) {
    const d=deps(answer);
    assert.equal((await run(['disconnect','--connection-id',id,'--result','/drop/r'],d)).code,answer==='yes'?0:1);
    assert.equal(d.calls.length,answer==='yes'?1:0);
    if(answer==='yes') {assert.equal(d.calls[0].connectionId,id);assert.equal(d.feeds[0][1].connected,false);}
  }
});
test('setup errors publish bounded generic failures without raw settings or command output',async()=>{
  const d=deps();d.setup.connectProvider=async()=>{throw new Error('secret raw command output');};
  assert.equal((await run(argv,d)).code,1);assert.equal(d.results[0][1].ok,false);
  assert.doesNotMatch(JSON.stringify(d.results),/secret raw/);
});
test('the staged CLI resolves its collector beside src and previews the feed before consent',async()=>{
  const d=deps();delete d.collectorPath;
  let preview;d.readConsent=async()=>{preview=d.output.join('\n');return 'yes';};
  assert.equal((await run(argv,d)).code,0);
  assert.equal(d.calls[0].collectorPath,require('node:path').resolve(__dirname,'../collectors/passive.cjs'));
  assert.match(preview,/Report directory: \/home\/target\/\.llm-account-usage-feeds\//);
});
test('real target-local CLI setup reconnects idempotently and disconnects without losing the original profile',async t=>{
  const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'setup-cli-real-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));
  const profile=path.join(home,'.claude');await fs.mkdir(profile,{mode:0o700});
  const settings=path.join(profile,'settings.json'),original={theme:'private',statusLine:{type:'command',command:'printf original'}};
  await fs.writeFile(settings,JSON.stringify(original),{mode:0o600});
  const dependencies={home:()=>home,uid:()=>process.getuid(),env:{PATH:''},print:()=>{},readConsent:async()=>'yes',
    setup:require('../src/setup.cjs').createSetup({systemUid:(await fs.stat('/')).uid})};
  const args=['connect','--provider','claude','--cli',process.execPath,'--runtime-version','0.4.0','--result',path.join(home,'first.json')];
  assert.equal((await run(args,dependencies)).code,0);
  const first=JSON.parse(await fs.readFile(args.at(-1),'utf8'));
  assert.equal(first.ok,true);assert.equal(first.connection.uid,process.getuid());
  const descriptor=JSON.parse(await fs.readFile(path.join(first.connection.reportDir,'.connection.json'),'utf8'));
  assert.deepEqual(descriptor,first.connection);assert.equal(descriptor.pendingProcess,undefined);
  assert.doesNotMatch(JSON.stringify(first),/printf original|private/);
  const installed=await fs.readFile(settings);
  args[args.length-1]=path.join(home,'second.json');assert.equal((await run(args,dependencies)).code,0);
  const second=JSON.parse(await fs.readFile(args.at(-1),'utf8'));
  assert.equal(second.connection.backupPath,first.connection.backupPath);assert.deepEqual(await fs.readFile(settings),installed);
  const result=path.join(home,'disconnect.json');
  assert.equal((await run(['disconnect','--connection-id',first.connection.id,'--result',result],dependencies)).code,0);
  assert.deepEqual(JSON.parse(await fs.readFile(settings,'utf8')),original);
  assert.equal(JSON.parse(await fs.readFile(result,'utf8')).connection.connected,false);
});
test('result publication creates one bounded regular file and never overwrites or follows a link',async t=>{
  const {writeResult}=require('../src/setup-cli.cjs'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'setup-result-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'result.json'),result={ok:false,code:'CANCELLED',message:'Setup cancelled.'};
  await writeResult(file,result);assert.equal((await fs.stat(file)).mode&0o7777,0o644);
  await assert.rejects(writeResult(file,{different:true}),{code:'EEXIST'});
  assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),result);
  const link=path.join(dir,'link');await fs.symlink(file,link);await assert.rejects(writeResult(link,result));
  await assert.rejects(writeResult(path.join(dir,'large'),{value:'x'.repeat(32768)}));
  assert.deepEqual((await fs.readdir(dir)).sort(),['link','result.json']);
});
test('a feed already claimed by another connection fails before changing provider settings',async()=>{
  const d=deps();d.checkConnectionFeed=async()=>{throw new Error('feed belongs to another connection');};
  assert.equal((await run(argv,d)).code,1);assert.equal(d.calls.length,0);
});
test('atomic result publication cannot overwrite a file created at the publication boundary',async t=>{
  const {writeResult}=require('../src/setup-cli.cjs'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'result-race-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'result.json');
  const io=new Proxy(fs,{get(target,key){if(key==='link')return async(...args)=>{await fs.writeFile(file,'keep',{flag:'wx'});return fs.link(...args);};return target[key];}});
  await assert.rejects(writeResult(file,{ok:false,code:'CANCELLED',message:'Setup cancelled.'},io),{code:'EEXIST'});
  assert.equal(await fs.readFile(file,'utf8'),'keep');assert.deepEqual(await fs.readdir(dir),['result.json']);
});
test('two concurrent profiles cannot both install into the same shared feed',async t=>{
  const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'cli-feed-claim-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));
  const feed=path.join(home,'feed');await fs.mkdir(feed,{mode:0o700});
  for(const name of ['first','second']){await fs.mkdir(path.join(home,name),{mode:0o700});await fs.writeFile(path.join(home,name,'settings.json'),'{}',{mode:0o600});}
  const api=require('../src/setup.cjs').createSetup({systemUid:(await fs.stat('/')).uid});
  let entered,release;const active=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const setup={...api,connectProvider:async options=>{if(options.profilePath===path.join(home,'first')){entered();await gate;}return api.connectProvider(options);}};
  const dependency={setup,home:()=>home,uid:()=>process.getuid(),env:{PATH:''},readConsent:async()=>'yes',print:()=>{}};
  const args=name=>['connect','--provider','claude','--cli',process.execPath,'--runtime-version','0.4.0','--profile',path.join(home,name),'--report-dir',feed,'--result',path.join(home,name+'.json')];
  const first=run(args('first'),dependency);await active;
  let second;
  try {second=await run(args('second'),dependency);}finally {release();await first;}
  assert.equal(second.code,1);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(home,'second/settings.json'),'utf8')),{});
  const descriptor=JSON.parse(await fs.readFile(path.join(feed,'.connection.json'),'utf8'));
  assert.equal(descriptor.profilePath,path.join(home,'first'));
});
async function realCli(t) {
  const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'cli-review-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));
  const profile=path.join(home,'.claude'),settings=path.join(profile,'settings.json');
  await fs.mkdir(profile,{mode:0o700});await fs.writeFile(settings,'{}',{mode:0o600});
  const systemUid=(await fs.stat('/')).uid,output=[];
  const dependencies={home:()=>home,uid:()=>process.getuid(),env:{PATH:''},print:value=>output.push(value),readConsent:async()=>'yes',
    setup:require('../src/setup.cjs').createSetup({systemUid})};
  const args=result=>['connect','--provider','claude','--cli',process.execPath,'--runtime-version','0.4.0','--result',path.join(home,result)];
  return {home,profile,settings,fs,path,systemUid,output,dependencies,args};
}
test('Connect after reload preserves the exact saved explicit feed',async t=>{
  const f=await realCli(t),feed=f.path.join(f.home,'explicit-feed');await f.fs.mkdir(feed,{mode:0o700});
  assert.equal((await run([...f.args('first.json'),'--report-dir',feed],f.dependencies)).code,0);
  f.dependencies.setup=require('../src/setup.cjs').createSetup({systemUid:f.systemUid});
  assert.equal((await run(f.args('reloaded.json'),f.dependencies)).code,0);
  const result=JSON.parse(await f.fs.readFile(f.path.join(f.home,'reloaded.json'),'utf8'));
  assert.equal(result.connection.reportDir,feed);
  await assert.rejects(f.fs.stat(f.path.join(f.home,'.llm-account-usage-feeds')),{code:'ENOENT'});
});
test('the consent preview includes selected feed ancestry and revalidates its exact fingerprint',async t=>{
  for(const drift of [false,true]) {
    const f=await realCli(t),parent=f.path.join(f.home,'shared'),feed=f.path.join(parent,'feed');
    await f.fs.mkdir(parent,{mode:0o700});await f.fs.chmod(parent,0o2770);await f.fs.mkdir(feed,{mode:0o700});await f.fs.chmod(feed,0o2750);
    let preview;
    f.dependencies.readConsent=async()=>{preview=f.output.join('\n');if(drift)await f.fs.chmod(parent,0o770);return 'yes';};
    const result=await run([...f.args('result.json'),'--report-dir',feed],f.dependencies);
    assert.match(preview,new RegExp(parent+'.*UID '+process.getuid()+'.*mode 2770'));
    assert.equal(result.code,drift?1:0);
    if(drift)assert.deepEqual(JSON.parse(await f.fs.readFile(f.settings,'utf8')),{});
  }
});
test('disconnect retries acknowledge an already restored profile after descriptor or result publication failure',async t=>{
  for(const failure of ['descriptor','result']) {
    const f=await realCli(t);assert.equal((await run(f.args('connect.json'),f.dependencies)).code,0);
    const connection=JSON.parse(await f.fs.readFile(f.path.join(f.home,'connect.json'),'utf8')).connection;
    if(failure==='descriptor')f.dependencies.writeConnectionFeed=async()=>{throw new Error('descriptor publication failed');};
    else f.dependencies.writeResult=async(file,value)=>{if(value.ok)throw new Error('result publication failed');return require('../src/setup-cli.cjs').writeResult(file,value);};
    const args=result=>['disconnect','--connection-id',connection.id,'--result',f.path.join(f.home,result)];
    assert.equal((await run(args('failed.json'),f.dependencies)).code,1);
    assert.deepEqual(JSON.parse(await f.fs.readFile(f.settings,'utf8')),{});
    delete f.dependencies.writeConnectionFeed;delete f.dependencies.writeResult;
    assert.equal((await run(args('retry.json'),f.dependencies)).code,0,failure);
    const recovered=JSON.parse(await f.fs.readFile(f.path.join(f.home,'retry.json'),'utf8'));
    assert.equal(recovered.connection.id,connection.id);assert.equal(recovered.connection.connected,false);
  }
});
test('CLI retries initial descriptor link interruption under the same claim for connect and disconnect',async t=>{
  for(const action of ['connect','disconnect']) {
    const f=await realCli(t);let linked=false;
    const io=new Proxy(f.fs,{get(target,key){
      if(key==='link')return async(...args)=>{await f.fs.link(...args);if(String(args[1]).endsWith('/.connection.json'))linked=true;};
      if(key==='unlink')return async file=>{if(linked&&String(file).endsWith('/.connection-publication.json'))throw new Error('stopped after link');return f.fs.unlink(file);};
      return target[key];
    }});
    const setup=require('../src/setup.cjs').createSetup({fs:io,systemUid:f.systemUid});let connection,issue;
    f.dependencies.setup=Object.fromEntries(Object.entries(setup).map(([name,method])=>[name,async(...args)=>{
      try {const result=await method(...args);if(name==='connectProvider')connection=result;return result;}catch(error){issue=error;throw error;}
    }]));
    assert.equal((await run(f.args('interrupted.json'),f.dependencies)).code,1);
    assert.ok(connection,issue?.stack);const descriptor=f.path.join(connection.reportDir,'.connection.json');
    assert.equal((await f.fs.stat(descriptor)).nlink,2);
    f.dependencies.setup=require('../src/setup.cjs').createSetup({systemUid:f.systemUid});
    const args=action==='connect'?f.args('retry.json'):['disconnect','--connection-id',connection.id,'--result',f.path.join(f.home,'retry.json')];
    const installed=await f.fs.readFile(f.settings),cancelled=args.map(value=>value===f.path.join(f.home,'retry.json')?f.path.join(f.home,'cancelled.json'):value);
    f.dependencies.readConsent=async()=>'no';assert.equal((await run(cancelled,f.dependencies)).code,1);
    assert.equal((await f.fs.stat(descriptor)).nlink,2,'preview/cancellation must not repair before full yes');
    assert.deepEqual(await f.fs.readFile(f.settings),installed);
    f.dependencies.readConsent=async()=>'yes';
    assert.equal((await run(args,f.dependencies)).code,0,action);
    const result=JSON.parse(await f.fs.readFile(f.path.join(f.home,'retry.json'),'utf8'));
    assert.equal(result.connection.id,connection.id);assert.equal(result.connection.connected,action==='connect');
    assert.equal((await f.fs.stat(descriptor)).nlink,1);
    if(action==='disconnect')assert.deepEqual(JSON.parse(await f.fs.readFile(f.settings,'utf8')),{});
  }
});
