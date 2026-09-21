'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {run}=require('../src/setup-cli.cjs');
const id='v2-'+'a'.repeat(32);
const argv=['connect','--provider','claude','--cli','/opt/claude','--result','/drop/result.json','--runtime-version','0.4.0'];
function deps(answer='yes') {
  const calls=[],results=[],output=[],feeds=[],directories=[];
  const preview={id,profilePath:'/home/target/.claude',sharedDirectories:[{path:'/opt/native',kind:'directory',uid:0,gid:2000,mode:0o2750}]};
  const connection={id,provider:'claude',uid:2000,profilePath:preview.profilePath,settingsPath:preview.profilePath+'/settings.json',connected:true,
    cliLookupPath:'/opt/claude',reportDir:'/home/target/.llm-account-usage-feeds/'+id,launcherPath:'/home/target/runtime/run.sh',backupPath:'/home/target/runtime/backup.json'};
  return {calls,results,output,feeds,directories,preview,connection,uid:()=>2000,home:()=>'/home/target',env:{PATH:'/usr/bin'},
    nodePath:'/usr/bin/node',collectorPath:'/bundle/passive.cjs',readConsent:async()=>answer,print:s=>output.push(s),
    ensureReportDirectory:async(...args)=>directories.push(args),checkConnectionFeed:async()=>{},writeResult:async(...args)=>results.push(args),
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
