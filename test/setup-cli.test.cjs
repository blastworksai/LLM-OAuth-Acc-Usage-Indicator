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
test('readable target CLI accepts and verifies both process identity and the exact expected path',async()=>{
 const d=deps(),order=[];
 d.verifyTargetProcess=async target=>{order.push('verify');assert.deepEqual(target,{...foreignTarget,cliPath:'/opt/claude'});return target;};
 const preview=d.setup.discoverProvider;d.setup.discoverProvider=async options=>{order.push('preview');return preview(options);};
 d.readConsent=async()=>{order.push('yes');return 'yes';};
 assert.equal((await run([...argv,'--target',JSON.stringify(foreignTarget)],d)).code,0);
 assert.deepEqual(order,['verify','preview','yes','verify']);assert.equal(d.calls[0].cliPath,'/opt/claude');
});
test('readable target identity provider or expected path drift yields zero mutation before preview or after yes',async t=>{
 const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),{verifyTargetProcess}=require('../src/provider.cjs');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'readable-target-proof-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const bin=path.join(root,'bin'),alternate=path.join(root,'alternate');await fs.mkdir(bin);await fs.mkdir(alternate);
 const native=await fs.realpath(process.execPath),otherNative=path.join(root,'codex-native');await fs.copyFile(native,otherNative);await fs.chmod(otherNative,0o755);
 const cliPath=path.join(bin,'claude');await fs.symlink(native,cliPath);await fs.symlink(otherNative,path.join(bin,'codex'));
 await fs.symlink(native,path.join(alternate,'claude'));
 for(const phase of ['before-preview','after-yes'])for(const mutation of ['exit','pid','uid','start','boot','provider','path']) {
  const d=deps();let changed=false,previews=0,consents=0;
  d.env={PATH:bin+path.delimiter+alternate};
  const change=async()=>{changed=true;if(mutation==='path'){await fs.unlink(cliPath);await fs.symlink(otherNative,cliPath);}};
  d.verifyTargetProcess=(target,options)=>verifyTargetProcess(target,{...options,
   getProcess:async()=>changed&&mutation==='exit'?null:{...foreignTarget.process,ppid:10,tty_nr:1,pgrp:30,tpgid:30,
    ...(changed?({pid:{pid:31},uid:{uid:1000},start:{start_ticks:'31'},boot:{boot_id:'other'}}[mutation]||{}):{})},
   getExecutable:async()=>changed&&mutation==='provider'?otherNative:native});
  d.setup.discoverProvider=async()=>{previews++;return d.preview;};
  d.readConsent=async()=>{consents++;if(phase==='after-yes')await change();return 'yes';};
  if(phase==='before-preview')await change();
  const args=[...argv.map(value=>value==='/opt/claude'?cliPath:value),'--target',JSON.stringify(foreignTarget)];
  assert.equal((await run(args,d)).code,1,phase+' '+mutation);
  assert.equal(previews,phase==='after-yes'?1:0);assert.equal(consents,phase==='after-yes'?1:0);
  assert.equal(d.calls.length,0);assert.equal(d.directories.length,0);assert.equal(d.feeds.length,0);
  assert.equal(d.results[0][1].ok,false);
  if(mutation==='path'){await fs.unlink(cliPath);await fs.symlink(native,cliPath);}
 }
});
test('a readable target cannot replace its expected CLI path with another verifier result',async()=>{
 const d=deps();d.verifyTargetProcess=async()=>({...foreignTarget,cliPath:'/other/claude'});
 d.setup.discoverProvider=async()=>assert.fail('a different path reached preview');
 assert.equal((await run([...argv,'--target',JSON.stringify(foreignTarget)],d)).code,1);
 assert.equal(d.calls.length,0);assert.equal(d.directories.length,0);assert.equal(d.feeds.length,0);
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
    argv.map(s=>s==='/opt/claude'?'/opt/\ncli':s),
    ...['relative','/opt/../claude','/opt/\ncli'].map(cli=>[...foreignArgv,'--cli',cli])]) {
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
// ---- 0.4 CP1 Task 1.4: discover, --consent granted, --result -, disconnect --remove-feed yes, argv cap ----
const cliFile=require('node:path').resolve(__dirname,'../src/setup-cli.cjs');
const {removeFeed}=require('../src/setup-cli.cjs');
function capture(d) {const lines=[];d.writeStdout=async line=>{lines.push(line);};return lines;}
async function snapshot(root) {
  const fs=require('node:fs/promises'),path=require('node:path'),seen={};
  async function walk(dir) {
    for(const name of (await fs.readdir(dir)).sort()) {
      const file=path.join(dir,name),st=await fs.lstat(file);
      seen[path.relative(root,file)]=[st.isDirectory()?'d':st.isSymbolicLink()?'l':'f',st.mode,st.uid,st.gid,st.size,st.mtimeMs,st.ino].join(':');
      if(st.isDirectory())await walk(file);
    }
  }
  await walk(root);return seen;
}
function spawnCli(args,env) {
  return new Promise((resolve,reject)=>{
    const child=require('node:child_process').spawn(process.execPath,[cliFile,...args],{env,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.on('data',chunk=>{stderr+=chunk;});
    child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr}));
  });
}
function oneJsonLine(stdout) {
  const lines=stdout.split('\n');
  assert.equal(lines.length,2,'exactly one line on stdout: '+JSON.stringify(stdout));assert.equal(lines[1],'');
  return JSON.parse(lines[0]);
}
const hex=length=>'0123456789abcdef'.repeat(4).slice(0,length);
test('finding 3: --consent granted skips the prompt with no TTY; without it the prompt still decides',async()=>{
  for(const action of ['connect','disconnect']) {
    const base=action==='connect'?argv:['disconnect','--connection-id',id,'--result','/drop/r'];
    const granted=deps();granted.readConsent=async()=>assert.fail('--consent granted must not prompt');
    assert.equal((await run([...base,'--consent','granted'],granted)).code,0,action);
    assert.equal(granted.calls.length,1);assert.equal(granted.results[0][1].ok,true);
    let asked=0;const prompted=deps();prompted.readConsent=async()=>{asked++;return null;};
    assert.equal((await run(base,prompted)).code,1,action);assert.equal(asked,1);assert.equal(prompted.calls.length,0);
    assert.deepEqual(prompted.results[0][1],{ok:false,code:'CANCELLED',message:'Setup cancelled.'});
  }
});
test('--consent is the literal granted only, and only on connect and disconnect',async()=>{
  const discover=['discover','--provider','claude','--cli','/opt/claude','--result','-'];
  for(const args of [...['yes','Granted','granted ','','true'].map(value=>[...argv,'--consent',value]),
    ['disconnect','--connection-id',id,'--result','/drop/r','--consent','yes'],[...discover,'--consent','granted']]) {
    const d=deps(),lines=capture(d);d.setup.discoverProvider=async()=>assert.fail('invalid consent reached discovery');
    d.setup.listDisconnectConnections=async()=>assert.fail('invalid consent reached disconnect');
    assert.equal((await run(args,d)).code,2,JSON.stringify(args));assert.equal(d.calls.length,0);assert.equal(d.results.length,0);
    if(args.includes('-'))assert.deepEqual(lines.map(line=>JSON.parse(line).code),['INVALID_ARGUMENTS']);
  }
});
test('--remove-feed is the literal yes only, and only on disconnect',async()=>{
  for(const args of [...['no','YES','true',''].map(value=>['disconnect','--connection-id',id,'--result','/drop/r','--remove-feed',value]),
    [...argv,'--remove-feed','yes'],['discover','--provider','claude','--cli','/opt/claude','--result','-','--remove-feed','yes']]) {
    const d=deps();d.setup.listDisconnectConnections=async()=>assert.fail('invalid remove-feed reached disconnect');
    d.setup.discoverProvider=async()=>assert.fail('invalid remove-feed reached discovery');
    assert.equal((await run(args,d)).code,2,JSON.stringify(args));assert.equal(d.calls.length,0);
  }
});
test('argv cap: the widest connect (8 keys, 17 argv) runs; anything longer, or a key another action lacks, is refused',async()=>{
  const widest=[...argv,'--profile','/home/target/.claude','--report-dir','/var/lib/llm-account-usage/feeds/'+id,
    '--target',JSON.stringify(foreignTarget),'--consent','granted'];
  assert.equal(widest.length,17);
  const d=deps();d.verifyTargetProcess=async target=>({...target,cliPath:'/opt/claude'});
  assert.equal((await run(widest,d)).code,0);assert.equal(d.calls.length,1);
  const disconnect=['disconnect','--connection-id',id,'--result','-','--target',JSON.stringify(foreignTarget),'--consent','granted','--remove-feed','yes'];
  for(const args of [[...widest,'--unknown','x'],[...widest,'x'],new Array(18).fill('--provider'),[...disconnect,'--provider','claude'],
    ['discover','--provider','claude','--cli','/opt/claude','--result','-','--runtime-version','0.4.0']]) {
    const refused=deps();refused.setup.discoverProvider=async()=>assert.fail('over-long argv reached discovery');
    refused.setup.listDisconnectConnections=async()=>assert.fail('over-long argv reached disconnect');
    assert.equal((await run(args,refused)).code,2,String(args.length));
  }
});
test('discover publishes only the preview fields and never prompts, claims, creates or connects',async()=>{
  for(const result of ['-','/drop/discover.json']) {
    const d=deps(),lines=capture(d);
    const full={...d.preview,provider:'claude',settingsPath:'/home/target/.claude/settings.json',reportDir:'/var/lib/llm-account-usage/feeds/'+id,
      createReportDirectory:false,hasExistingStatusLine:true,hasExistingHooks:false,cliPath:'/opt/claude-real',cliLookupPath:'/opt/claude',identity:{id},
      sharedDirectories:[{path:'/opt/native',kind:'directory',uid:0,gid:2000,mode:0o2750,extra:'dropped'}]};
    d.setup.discoverProvider=async options=>{assert.equal(options.sharedFeed,true);return full;};
    const never=name=>async()=>assert.fail(name+' ran during discover');
    Object.assign(d,{readConsent:never('consent'),ensureReportDirectory:never('ensureReportDirectory'),withReportFeedClaim:never('claim'),
      checkConnectionFeed:never('checkConnectionFeed'),writeConnectionFeed:never('writeConnectionFeed')});
    d.setup.connectProvider=never('connect');d.setup.disconnectProvider=never('disconnect');
    assert.equal((await run(['discover','--provider','claude','--cli','/opt/claude','--report-dir','/var/lib/llm-account-usage/feeds/'+id,'--result',result],d)).code,0);
    const published=result==='-'?JSON.parse(lines[0]):d.results[0][1];
    assert.equal(result==='-'?lines.length:d.results.length,1);
    assert.deepEqual(published,{ok:true,preview:{id,provider:'claude',profilePath:'/home/target/.claude',settingsPath:'/home/target/.claude/settings.json',
      reportDir:'/var/lib/llm-account-usage/feeds/'+id,hasExistingStatusLine:true,hasExistingHooks:false,
      sharedDirectories:[{path:'/opt/native',kind:'directory',uid:0,gid:2000,mode:0o2750}]}});
    assert.match(d.output.join('\n'),/Discovery only reads\. Nothing was changed\./);
  }
});
test('--result - publishes exactly one line even when setup fails after preview output',async()=>{
  const d=deps(),lines=capture(d);d.setup.connectProvider=async()=>{throw new Error('secret raw command output');};
  assert.equal((await run([...argv.slice(0,-4),'--result','-','--runtime-version','0.4.0','--consent','granted'],d)).code,1);
  assert.equal(lines.length,1);assert.deepEqual(Object.keys(JSON.parse(lines[0])),['ok','code','message']);
  assert.equal(JSON.parse(lines[0]).code,'SETUP_FAILED','a throw from connectProvider means it undid itself or never wrote');assert.equal(d.results.length,0);assert.doesNotMatch(lines[0],/secret raw/);
  const failing=deps();let attempts=0;failing.writeStdout=async()=>{attempts++;throw new Error('EPIPE');};
  assert.equal((await run([...argv.slice(0,-4),'--result','-','--runtime-version','0.4.0','--consent','granted'],failing)).code,1);
  assert.equal(attempts,1,'a failed stdout write is never followed by a second JSON line');
});
async function realHome(t,prefix) {
  const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
  const base=await fs.mkdtemp(path.join(os.tmpdir(),prefix));t.after(()=>fs.rm(base,{recursive:true,force:true}));
  const home=path.join(base,'home');await fs.mkdir(home,{mode:0o700});
  const profile=path.join(home,'.claude'),settings=path.join(profile,'settings.json');await fs.mkdir(profile,{mode:0o700});
  const original={theme:'private',statusLine:{type:'command',command:'printf original'}};
  await fs.writeFile(settings,JSON.stringify(original),{mode:0o600});
  return {fs,path,base,home,profile,settings,original};
}
test('--result - in a real non-TTY child: one JSON line on stdout, human lines on stderr, consent granted connects (finding 3)',async t=>{
  const h=await realHome(t,'setup-cli-stdout-');
  // A clean environment: never inherit a provider profile override from the test runner.
  const env={HOME:h.home,PATH:'/usr/bin:/bin',LANG:'C.UTF-8'};
  const common=['--provider','claude','--cli',process.execPath,'--profile',h.profile,'--result','-'];
  const before=await snapshot(h.base);
  const discovered=await spawnCli(['discover',...common],env);
  assert.equal(discovered.code,0,discovered.stderr);const preview=oneJsonLine(discovered.stdout);
  assert.equal(preview.ok,true);assert.equal(preview.preview.profilePath,h.profile);assert.equal(preview.preview.hasExistingStatusLine,true);
  assert.equal(preview.preview.reportDir,h.path.join(h.home,'.llm-account-usage-feeds',preview.preview.id));
  assert.match(discovered.stderr,/Profile: /);assert.deepEqual(await snapshot(h.base),before,'discover wrote nothing');
  const cancelled=await spawnCli(['connect',...common,'--runtime-version','0.4.0'],env);
  assert.equal(cancelled.code,1);assert.deepEqual(oneJsonLine(cancelled.stdout),{ok:false,code:'CANCELLED',message:'Setup cancelled.'});
  assert.doesNotMatch(cancelled.stdout,/Type yes/);
  assert.deepEqual(JSON.parse(await h.fs.readFile(h.settings,'utf8')),h.original);
  const connected=await spawnCli(['connect',...common,'--runtime-version','0.4.0','--consent','granted'],env);
  assert.equal(connected.code,0,connected.stderr);const result=oneJsonLine(connected.stdout);
  assert.equal(result.ok,true);assert.equal(result.connection.connected,true);assert.equal(result.connection.id,preview.preview.id);
  assert.match(connected.stderr,/Report directory: .*\n/);assert.match(connected.stderr,/--consent granted/);
  assert.notDeepEqual(JSON.parse(await h.fs.readFile(h.settings,'utf8')),h.original);
  const disconnected=await spawnCli(['disconnect','--connection-id',result.connection.id,'--result','-','--consent','granted','--remove-feed','yes'],env);
  assert.equal(disconnected.code,0,disconnected.stderr);
  assert.deepEqual(oneJsonLine(disconnected.stdout).feed,{removed:true});
  assert.deepEqual(JSON.parse(await h.fs.readFile(h.settings,'utf8')),h.original);
  assert.deepEqual(await h.fs.readdir(result.connection.reportDir),[]);
  const invalid=await spawnCli(['connect','--provider','claude','--cli','relative','--result','-'],env);
  assert.equal(invalid.code,2);assert.equal(oneJsonLine(invalid.stdout).code,'INVALID_ARGUMENTS');assert.match(invalid.stderr,/Invalid setup arguments/);
});
test('GOTCHA: a 2750 target-owned feed under root-owned 0755 parents passes discover (no create), connect and remove-feed',async t=>{
  const h=await realHome(t,'setup-cli-shared-feed-'),uid=process.getuid();
  const {connectionIdentity}=require('../src/connection.cjs');
  const feedId=connectionIdentity({provider:'claude',uid,settingsPath:h.path.join(await h.fs.realpath(h.profile),'settings.json')}).id;
  // /var/lib/llm-account-usage/feeds/<id>: parents 0755, the feed folder 2750 made by root for the target.
  const parents=['var','var/lib','var/lib/llm-account-usage','var/lib/llm-account-usage/feeds'].map(name=>h.path.join(h.base,name));
  for(const dir of parents){await h.fs.mkdir(dir,{mode:0o755});await h.fs.chmod(dir,0o755);}
  const feed=h.path.join(parents.at(-1),feedId);await h.fs.mkdir(feed,{mode:0o700});await h.fs.chmod(feed,0o2750);
  // Without root the parents cannot really be root-owned, so setup's own view of them is: uid 0, gid 0 (as
  // install -d -o root -g root makes them); the feed keeps its real owner and shows the VS Code account's gid.
  const clone=(st,change)=>Object.assign(Object.create(Object.getPrototypeOf(st)),st,change);
  const view=(file,st)=>parents.includes(file)?clone(st,{uid:0,gid:0}):file===feed?clone(st,{gid:4242}):st;
  const io=new Proxy(h.fs,{get(target,key){
    if(key==='lstat'||key==='stat')return async(file,...rest)=>view(String(file),await target[key](file,...rest));
    return target[key];
  }});
  const setup=require('../src/setup.cjs').createSetup({fs:io,systemUid:0});
  const d={setup,home:()=>h.home,uid:()=>uid,env:{PATH:''},print:()=>{},readConsent:async()=>assert.fail('consent is granted on the command line')};
  const lines=capture(d);
  const common=['--provider','claude','--cli',process.execPath,'--profile',h.profile,'--report-dir',feed,'--result','-'];
  const before=await snapshot(h.base);
  assert.equal((await run(['discover',...common],d)).code,0,lines[0]);
  const discovered=JSON.parse(lines.shift());
  assert.equal(discovered.ok,true,JSON.stringify(discovered));assert.equal(discovered.preview.reportDir,feed);assert.equal(discovered.preview.id,feedId);
  assert.deepEqual(discovered.preview.sharedDirectories,[],'root-owned 0755 parents and the 2750 feed need no extra trust');
  assert.deepEqual(await snapshot(h.base),before,'discover created nothing');
  assert.equal((await run(['connect',...common,'--runtime-version','0.4.0','--consent','granted'],d)).code,0,lines[0]);
  const connected=JSON.parse(lines.shift());
  assert.equal(connected.ok,true,JSON.stringify(connected));assert.equal(connected.connection.reportDir,feed);
  assert.equal((await h.fs.stat(feed)).mode&0o7777,0o2750,'the existing feed folder was not re-created or re-moded');
  assert.equal((await h.fs.stat(h.path.join(feed,'.connection.json'))).mode&0o7777,0o640);
  await assert.rejects(h.fs.stat(h.path.join(h.home,'.llm-account-usage-feeds')),{code:'ENOENT'});
  assert.deepEqual(await h.fs.readdir(parents.at(-1)),[feedId]);
  // Collector leftovers the target made: one report, one stale native-query lock.
  await h.fs.writeFile(h.path.join(feed,`claude-${hex(24)}.json`),'{}',{mode:0o640});
  const lock=h.path.join(feed,'.native-queries',`query-${hex(32)}`);await h.fs.mkdir(lock,{recursive:true,mode:0o700});
  await h.fs.writeFile(h.path.join(lock,`owner-${hex(32)}.json`),'{}',{mode:0o600});
  assert.equal((await run(['disconnect','--connection-id',feedId,'--result','-','--consent','granted','--remove-feed','yes'],d)).code,0,lines[0]);
  const disconnected=JSON.parse(lines.shift());
  assert.equal(disconnected.connection.connected,false);assert.deepEqual(disconnected.feed,{removed:true});
  assert.deepEqual(await h.fs.readdir(feed),[],'only the folder is left, for root to rmdir');
  assert.equal((await h.fs.stat(feed)).mode&0o7777,0o2750);
  assert.deepEqual(JSON.parse(await h.fs.readFile(h.settings,'utf8')),h.original);
});
test('remove-feed deletes only the known names; a planted unknown file keeps everything and the retry finishes',async t=>{
  const h=await realHome(t,'setup-cli-remove-feed-'),lines=[];
  const d={home:()=>h.home,uid:()=>process.getuid(),env:{PATH:''},print:()=>{},writeStdout:async line=>{lines.push(line);},
    setup:require('../src/setup.cjs').createSetup({systemUid:0})};
  assert.equal((await run(['connect','--provider','claude','--cli',process.execPath,'--profile',h.profile,'--runtime-version','0.4.0','--result','-','--consent','granted'],d)).code,0);
  const {connection}=JSON.parse(lines.shift()),feed=connection.reportDir;
  await h.fs.writeFile(h.path.join(feed,`codex-${hex(24)}.json`),'{}',{mode:0o640});
  await h.fs.writeFile(h.path.join(feed,'notes.txt'),'keep me',{mode:0o640});
  const names=async()=>{const all=[];for(const name of (await h.fs.readdir(feed)).sort()){all.push(name);
    if((await h.fs.lstat(h.path.join(feed,name))).isDirectory())for(const inner of (await h.fs.readdir(h.path.join(feed,name))).sort())all.push(name+'/'+inner);}return all;};
  const planted=await names();
  assert.deepEqual(planted,['.connection-control','.connection-control/claim.json','.connection.json',`codex-${hex(24)}.json`,'notes.txt']);
  const args=['disconnect','--connection-id',connection.id,'--result','-','--consent','granted','--remove-feed','yes'];
  assert.equal((await run(args,d)).code,1);
  const refused=JSON.parse(lines.shift());
  assert.equal(refused.ok,true);assert.equal(refused.connection.connected,false);
  assert.deepEqual(refused.feed,{removed:false,code:'FEED_NOT_EMPTY',message:'The report folder holds entries Account Usage did not create. They were left in place.'});
  assert.deepEqual(await names(),planted,'nothing was removed');assert.equal(await h.fs.readFile(h.path.join(feed,'notes.txt'),'utf8'),'keep me');
  assert.deepEqual(JSON.parse(await h.fs.readFile(h.settings,'utf8')),h.original,'the disconnect itself still happened');
  await h.fs.unlink(h.path.join(feed,'notes.txt'));
  assert.equal((await run(args,d)).code,0);
  assert.deepEqual(JSON.parse(lines.shift()).feed,{removed:true});assert.deepEqual(await h.fs.readdir(feed),[]);
});
test('remove-feed refuses planted symlinks and unknown nested entries without removing anything',async t=>{
  const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
  const base=await fs.mkdtemp(path.join(os.tmpdir(),'remove-feed-links-'));t.after(()=>fs.rm(base,{recursive:true,force:true}));
  const outside=path.join(base,'outside');await fs.mkdir(outside);await fs.writeFile(path.join(outside,'precious.json'),'precious');
  await fs.mkdir(path.join(outside,`query-${hex(32)}`));
  const plants={
    'report-named symlink':feed=>fs.symlink(path.join(outside,'precious.json'),path.join(feed,`claude-${hex(24)}.json`)),
    'descriptor symlink':async feed=>{await fs.unlink(path.join(feed,'.connection.json'));await fs.symlink(path.join(outside,'precious.json'),path.join(feed,'.connection.json'));},
    'native-queries symlink':feed=>fs.symlink(outside,path.join(feed,'.native-queries')),
    'claim symlink':async feed=>{await fs.unlink(path.join(feed,'.connection-control/claim.json'));await fs.symlink(path.join(outside,'precious.json'),path.join(feed,'.connection-control/claim.json'));},
    'unknown file in the control folder':feed=>fs.writeFile(path.join(feed,'.connection-control/other.json'),'{}'),
    'unknown entry in a native-query lock':async feed=>{const lock=path.join(feed,'.native-queries',`query-${hex(32)}`);await fs.mkdir(lock,{recursive:true});await fs.writeFile(path.join(lock,'payload'),'x');},
    'report-named folder':feed=>fs.mkdir(path.join(feed,`antigravity-${hex(24)}.json`)),
    'unknown dot file':feed=>fs.writeFile(path.join(feed,'.collector-lock'),'x'),
  };
  let index=0;
  for(const [label,plant] of Object.entries(plants)) {
    const feed=path.join(base,`feed-${index++}`);await fs.mkdir(feed,{mode:0o700});await fs.chmod(feed,0o2750);
    await fs.writeFile(path.join(feed,'.connection.json'),'{}',{mode:0o640});await fs.writeFile(path.join(feed,`claude-${hex(24).replace(/0/g,'f')}.json`),'{}',{mode:0o640});
    await fs.mkdir(path.join(feed,'.connection-control'),{mode:0o700});await fs.writeFile(path.join(feed,'.connection-control/claim.json'),'{}',{mode:0o600});
    await plant(feed);
    const before=await snapshot(feed),outsideBefore=await snapshot(outside);
    assert.deepEqual(await removeFeed(feed,process.getuid()),
      {removed:false,code:'FEED_NOT_EMPTY',message:'The report folder holds entries Account Usage did not create. They were left in place.'},label);
    assert.deepEqual(await snapshot(feed),before,label+': nothing in the feed was removed');
    assert.deepEqual(await snapshot(outside),outsideBefore,label+': nothing outside the feed was touched');
  }
  const clean=path.join(base,'clean');await fs.mkdir(clean,{mode:0o700});await fs.chmod(clean,0o2750);
  await fs.writeFile(path.join(clean,'.connection.json'),'{}');const lock=path.join(clean,'.native-queries',`.lock-${hex(32)}`);
  await fs.mkdir(lock,{recursive:true});await fs.writeFile(path.join(lock,`owner-${hex(32)}.json`),'{}');await fs.mkdir(path.join(clean,'.connection-control'));
  assert.deepEqual(await removeFeed(clean,process.getuid()),{removed:true});assert.deepEqual(await fs.readdir(clean),[]);
  const link=path.join(base,'feed-link');await fs.symlink(clean,link);
  assert.equal((await removeFeed(link,process.getuid())).code,'FEED_REMOVE_FAILED','a linked feed folder is never followed');
  assert.equal((await removeFeed('relative/feed',process.getuid())).code,'FEED_REMOVE_FAILED');
});

test('a failure before the provider settings are touched reports SETUP_FAILED, never SETUP_FAILED_CHANGED',async()=>{
  const d=deps(),lines=capture(d);let entered=false;
  d.ensureReportDirectory=async()=>{throw new Error('feed folder refused');};
  d.setup.connectProvider=async()=>{entered=true;throw new Error('must not be reached');};
  assert.equal((await run([...argv.slice(0,-4),'--result','-','--runtime-version','0.4.0','--consent','granted'],d)).code,1);
  assert.equal(entered,false);assert.equal(JSON.parse(lines[0]).code,'SETUP_FAILED');
});

test('SETUP_FAILED_CHANGED only when setup replaced the settings and a later step failed; a reconnect never is',async()=>{
  const cli=[...argv.slice(0,-4),'--result','-','--runtime-version','0.4.0','--consent','granted'];
  const fresh=deps(),freshLines=capture(fresh),real=fresh.setup.connectProvider;
  fresh.setup.connectProvider=async options=>{const value=await real(options);options.onSettingsChanged();return value;};
  fresh.writeConnectionFeed=async()=>{throw new Error('descriptor write failed');};
  assert.equal((await run(cli,fresh)).code,1);
  assert.equal(JSON.parse(freshLines[0]).code,'SETUP_FAILED_CHANGED');
  const again=deps(),againLines=capture(again); // a reconnect: connectProvider returns without touching settings
  again.writeConnectionFeed=async()=>{throw new Error('descriptor write failed');};
  assert.equal((await run(cli,again)).code,1);
  assert.equal(JSON.parse(againLines[0]).code,'SETUP_FAILED');
});
