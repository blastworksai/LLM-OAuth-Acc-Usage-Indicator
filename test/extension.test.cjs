'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const vm=require('node:vm');
const {createSetup}=require('../src/setup.cjs');

// The wizard road runs the real wizard host (src/wizard-host.cjs) over a fake root: sudo, the shared-feed folder and the
// setup-cli answers are simulated here, so every elevated argv is recorded and nothing touches this machine.
const realSharedFeed=require('../src/shared-feed.cjs');
const REPO=path.resolve(__dirname,'..');
function fakeRoot({sudo='passwordless',password=null,connection=null,discover,connectResult,disconnectResult,bundleRemoved=true,readable=true,folders=[],onRun}={}) {
  const calls=[],present=new Set(folders);
  const json=value=>({code:0,stdout:JSON.stringify(value)+'\n',stderr:''});
  const elevate={
    probe:async()=>sudo,
    checkPassword:async value=>value===password,
    run:async(argv,options={})=>{
      calls.push({argv:[...argv],asUser:options.asUser,held:options.password!=null,password:options.password});
      await onRun?.(argv,options);
      if(argv[0]==='/bin/sh')return {code:0,stdout:'/usr/bin/node\n',stderr:''};
      if(options.asUser!==undefined&&argv[2]==='discover')return json(discover?discover(argv):{ok:true,preview:{id:connection.id,provider:connection.provider,
        profilePath:connection.profilePath,settingsPath:connection.settingsPath,reportDir:null,sharedDirectories:[],hasExistingStatusLine:true}});
      if(options.asUser!==undefined&&argv[2]==='connect')return json(connectResult?connectResult(argv):{ok:true,connection});
      if(options.asUser!==undefined&&argv[2]==='disconnect')return json(disconnectResult?disconnectResult(argv):{ok:true,connection:{...connection,connected:false},feed:{removed:true}});
      if(argv[0]==='/usr/bin/install'&&argv.includes('2750'))present.add(argv.at(-1));
      if(argv[0]==='/usr/bin/rmdir')present.delete(argv.at(-1));
      if(argv[0]==='/usr/bin/rm')return {code:bundleRemoved?0:1,stdout:'',stderr:''};
      return {code:0,stdout:'',stderr:''};
    }};
  const sharedFeed={...realSharedFeed,inspectFeed:async target=>present.has(target)?{exists:true,directory:true,uid:2000,gid:process.getgid(),mode:0o2750}:{exists:false},
    precheckReadable:async()=>readable};
  const as=user=>calls.filter(call=>user===undefined?call.asUser===undefined:call.asUser===user).map(call=>call.argv);
  return {elevate,sharedFeed,calls,present,as,verbs:()=>calls.filter(call=>call.asUser!==undefined&&call.argv[0]==='/usr/bin/node').map(call=>call.argv[2])};
}
function harness({discover,connect,disconnect,recover='Recover connection',confirm='Connect',pickPath='/example/profile',pickProvider='claude',pickConnection,savedTrust=[],terminal,detect=async()=>null,connections=[],reports=[],match,collect,
  uid=1000,descriptors=[],managed=[],version='0.4.0',feedRejected=0,descriptorRejected=0,sudo={},input,
  setupApi,realFeeds=false,configured=[],storagePath='/example/editor-storage',nodePath='/example/editor-node',extensionPath='/example/extension'}={}) {
  const commands=new Map(),connected=[],discovered=[],errors=[],warnings=[],confirmations=[],notices=[],inputs=[],posted=[],storage=new Map([['trustedDirectories',savedTrust],['managedFeedDirectories',managed]]);
  let clipboard='';const feedBatches=[],descriptorBatches=[],root=fakeRoot(sudo);
  let provider,receive,picks=0,lastPickItems=[],collectionCalls=0,feedDirectories=[];
  const disposable=()=>({dispose(){}});
  class CancellationTokenSource {constructor(){const listeners=[];this.token={isCancellationRequested:false,onCancellationRequested:listener=>{listeners.push(listener);return disposable();}};this.listeners=listeners;}
    cancel(){this.token.isCancellationRequested=true;for(const listener of this.listeners)listener();}dispose(){}}
  const vscode={CancellationTokenSource,env:{clipboard:{writeText:async text=>{clipboard=text;}}},Uri:{file:value=>({fsPath:value}),joinPath:(_base,...parts)=>({fsPath:parts.join('/')})},workspace:{getConfiguration:()=>({get:()=>configured}),onDidChangeConfiguration:disposable},
    window:{activeTerminal:terminal,registerWebviewViewProvider:(_id,value)=>{provider=value;return disposable();},onDidChangeActiveTerminal:disposable,onDidCloseTerminal:disposable,
      showQuickPick:async items=>{picks++;lastPickItems=items;return items.find(item=>pickConnection?item.connection?.id===pickConnection:(item.provider??item.connection?.provider)===pickProvider);},showOpenDialog:async()=>pickPath?[{fsPath:pickPath}]:undefined,
      showInformationMessage:async(message,options,...actions)=>{if(options?.modal){confirmations.push({message,options,actions});return typeof confirm==='function'?confirm():confirm;}notices.push(message);},
      showWarningMessage:async(message,action)=>{warnings.push(message);return action?.modal?(typeof recover==='function'?recover():recover):action;},
      showInputBox:async(options,token)=>{inputs.push({options,token});return typeof input==='function'?input(options,token):input;},
      showErrorMessage:async message=>{errors.push(message);}},
    commands:{registerCommand:(name,callback)=>{commands.set(name,callback);return disposable();},executeCommand:async()=>{}}};
  const setup=setupApi||{refreshRuntime:async()=>({warnings:[]}),listConnections:async()=>connections,listDisconnectConnections:async()=>connections,
    discoverProvider:async options=>{discovered.push({...options});return discover?discover(options):{profilePath:'/example/profile',hasExistingStatusLine:true};},
    connectProvider:async options=>{connected.push(options);return connect?.(options);},
    disconnectProvider:async options=>{connected.push(options);return disconnect?.(options);}};
  const core={...require('../src/core.cjs'),buildRows:()=>[],
    readFeeds:async directories=>{feedDirectories=directories;feedBatches.push([...directories]);return realFeeds?require('../src/core.cjs').readFeeds(directories):{reports,rejected:feedRejected};},matchReports:match|| (async()=>({status:'unavailable'}))};
  const users={1000:'glitch',2000:'claudebwai'};
  const exports={};
  const polls=[];
  const sandbox={module:{exports},exports,process:{platform:'linux',execPath:nodePath,getuid:()=>uid},setInterval:fn=>{polls.push(fn);return 1;},clearInterval(){},setTimeout,clearTimeout,
    require:name=>name==='vscode'?vscode:name==='./setup.cjs'?setup:name==='./core.cjs'?core:name==='./collect.cjs'?{collectTerminal:async pid=>{collectionCalls++;return collect?.(pid)??null;}}:name==='./provider.cjs'?{detectProvider:detect}:
      name==='./connection-feed.cjs'?{readConnectionFeeds:async directories=>{descriptorBatches.push([...directories]);return {connections:descriptors.filter(value=>directories.includes(value.reportDir)),rejected:descriptorRejected};}}:
      name==='./connection.cjs'?require('../src/connection.cjs'):name==='./panel.cjs'?{buildViewModel:()=>({}),renderContent:()=>'',renderDocument:()=>''}:
      name==='./wizard.cjs'?require('../src/wizard.cjs'):name==='./wizard-host.cjs'?require('../src/wizard-host.cjs'):name==='./wizard-view.cjs'?require('../src/wizard-view.cjs'):
      name==='./elevate.cjs'?{createElevate:()=>root.elevate,resolveUser:async value=>users[value]??'glitch'}:name==='./shared-feed.cjs'?root.sharedFeed:require(name)};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/extension.cjs'),'utf8'),sandbox);
  const api=sandbox.module.exports.activate({globalStorageUri:{fsPath:storagePath},extensionPath,extension:{packageJSON:{version}},subscriptions:[],
    globalState:{get:(key,fallback)=>storage.get(key)??fallback,update:async(key,value)=>{storage.set(key,value);}}});
  const openCard=()=>{
    provider.resolveWebviewView({webview:{asWebviewUri:uri=>uri.fsPath,postMessage:async message=>{posted.push(message);},
      onDidReceiveMessage:callback=>{receive=callback;return disposable();}},visible:true,onDidChangeVisibility:disposable,onDidDispose:disposable});
    return async message=>{receive(message);await settle(api);};
  };
  return {commands,connected,discovered,errors,warnings,confirmations,notices,inputs,posted,storage,openCard,api,vscode,root,polls,post:message=>receive(message),feedBatches,descriptorBatches,get clipboard(){return clipboard;},get picks(){return picks;},get lastPickItems(){return lastPickItems;},get collectionCalls(){return collectionCalls;},get feedDirectories(){return feedDirectories;}};
}
// Waits until the wizard host has no effect in flight, including a close deferred to the next microtask.
async function settle(api) {for(let i=0;i<4;i++){await api.wizardSettled();await new Promise(setImmediate);}return api.getWizardState();}
const problem=code=>Object.assign(new Error('Choose the required local resource.'),{code,safeToDisplay:true});

test('the seventeenth mixed local and managed feed can select its report',async t=>{
 const io=fs.promises,root=await io.mkdtemp(path.join(os.tmpdir(),'extension-feed-capacity-'));
 t.after(()=>io.rm(root,{recursive:true,force:true}));
 const dirs=[];
 for(let i=0;i<17;i++){const dir=path.join(root,String(i).padStart(3,'0'));await io.mkdir(dir,{mode:0o700});dirs.push(dir);}
 const report={schema_version:1,provider:'claude',session_id:'seventeenth',process:{pid:30,uid:process.getuid(),start_ticks:'30',boot_id:'boot'},
  model:null,source:{kind:'claude-statusline',source_event_at:null,captured_at:'2026-09-21T12:00:00Z',provider_observed_at:null},windows:[],coverage:'fixture'};
 await io.writeFile(path.join(dirs[16],require('../src/core.cjs').reportFilename(report)),JSON.stringify(report),{mode:0o600});
 const h=harness({terminal:terminal(),realFeeds:true,connections:dirs.slice(0,8).map(reportDir=>({reportDir})),
  managed:dirs.slice(8),descriptors:dirs.slice(8).map(reportDir=>({reportDir,connected:true})),
  match:async(_pid,reports)=>reports.length?{status:'ready',report:reports[0]}:{status:'unavailable'}});
 await h.api.refresh();assert.equal(h.api.getState().status,'ready');assert.equal(h.api.getState().report.session_id,'seventeenth');
});
test('all admitted local, managed and configured feeds remain selectable at the combined boundary',async t=>{
 const io=fs.promises,core=require('../src/core.cjs'),root=await io.mkdtemp(path.join(os.tmpdir(),'extension-feed-boundary-'));
 t.after(()=>io.rm(root,{recursive:true,force:true}));
 const dirs=[],reports=[];
 for(let i=0;i<384;i++) {
  const directory=path.join(root,String(i).padStart(3,'0'));await io.mkdir(directory,{mode:0o700});dirs.push(directory);
  const report={schema_version:1,provider:'claude',session_id:`profile-${i}`,process:{pid:100+i,uid:process.getuid(),start_ticks:String(100+i),boot_id:'boot'},
   model:null,source:{kind:'claude-statusline',source_event_at:null,captured_at:'2026-09-21T12:00:00Z',provider_observed_at:null},windows:[],coverage:'fixture'};
  reports.push(report);await io.writeFile(path.join(directory,core.reportFilename(report)),JSON.stringify(report),{mode:0o600});
 }
 // A corrupt earlier report never hides a later profile or another batch.
 await io.writeFile(path.join(dirs[2],core.reportFilename(reports[2])),'invalid',{mode:0o600});
 const local=dirs.slice(0,128).map(reportDir=>({reportDir})),managed=dirs.slice(128,256),configured=dirs.slice(256);
 let selected=reports[383];
 const h=harness({terminal:terminal(),realFeeds:true,connections:local,managed,configured,
  descriptors:managed.map(reportDir=>({reportDir,connected:true,runtimeVersion:'0.4.0',uid:2000,provider:'claude'})),
  match:(_pid,available)=>core.matchReports(10,available,async pid=>pid===10?{pid:10,ppid:1,uid:process.getuid(),start_ticks:'10',boot_id:'boot',tty_nr:1,pgrp:10,tpgid:selected.process.pid}:
   pid===selected.process.pid?{...selected.process,ppid:10,tty_nr:1,pgrp:pid,tpgid:pid}:null)});
 await h.api.refresh();
 for(const index of [16,127,128,255,383]) {
  selected=reports[index];await h.api.refresh();assert.equal(h.api.getState().report?.session_id,`profile-${index}`);
 }
 assert.ok(h.feedBatches.every(batch=>batch.length<=16));assert.ok(h.descriptorBatches.every(batch=>batch.length<=16));
 assert.equal(new Set(h.feedBatches.flat()).size,384);
 // Reordering and introducing a duplicate canonical path cannot displace the
 // selected last profile. Bounds still apply to each source of configuration.
 local.reverse();configured[0]=dirs[0]+'/../000';await h.api.refresh();assert.equal(h.api.getState().report.session_id,'profile-383');
});
test('feed overflow is diagnosed and managed capacity blocks the wizard before anything runs',async()=>{
 const full=Array.from({length:128},(_,index)=>`/feeds/${index}`);
 for(const source of ['managed','configured','local']) {
  const tooMany=[...full,'/feeds/overflow'];
  const h=harness({terminal:terminal(),managed:source==='managed'?tooMany:[],configured:source==='configured'?tooMany:[],
   connections:source==='local'?tooMany.map(reportDir=>({reportDir})):[]});
  await h.api.refresh();assert.equal(h.api.getState().status,'unavailable');assert.match(h.api.getState().reason,/too many report directories/i);
 }
 const h=harness({terminal:terminal(),managed:full,detect:async()=>target('claude',30,2000),extensionPath:REPO});
 await h.commands.get('llmAccountUsage.connect')();await settle(h.api);
 assert.equal(h.root.calls.length,0);assert.equal(h.api.getWizardState().step,'idle');assert.equal(h.discovered.length,0);
 assert.equal(h.connected.length,0);assert.equal(h.storage.get('managedFeedDirectories').length,128);assert.match(h.errors[0],/too many report directories/i);
});
test('a stale generic foreign card cannot start setup for a replacement process',async()=>{
 let detected={provider:null,cliPath:null,process:target('claude',30,2000).process};const connection=foreignConnection();
 const h=harness({terminal:terminal(),detect:async()=>detected,descriptors:[connection],extensionPath:REPO});
 const send=h.openCard();await h.api.refresh();detected={...detected,process:{...detected.process,start_ticks:'31'}};
 await send({type:'connect'});assert.equal(h.root.calls.length,0);assert.equal(h.api.getWizardState().step,'idle');
 assert.equal(h.discovered.length,0);assert.equal(h.connected.length,0);
});

test('a missing or overridden default profile can be chosen explicitly before any write',async()=>{
  const h=harness({discover:async options=>{
    if(!options.profilePath)throw problem('PROFILE_REQUIRED');
    return {profilePath:options.profilePath,hasExistingStatusLine:true};
  }});
  await h.commands.get('llmAccountUsage.connect')();
  assert.equal(h.connected.length,1);assert.equal(h.connected[0].profilePath,'/example/profile');
  assert.equal(h.connected[0].provider,'claude');assert.equal(h.errors.length,0);
});
test('a native CLI outside the editor PATH can be selected without workspace configuration',async()=>{
  const h=harness({pickPath:'/example/native/claude',discover:async options=>{
    if(!options.cliPath)throw problem('CLI_NOT_FOUND');
    return {profilePath:'/example/profile',hasExistingStatusLine:false};
  }});
  await h.commands.get('llmAccountUsage.connect')();
  assert.equal(h.connected.length,1);assert.equal(h.connected[0].cliPath,'/example/native/claude');
  assert.equal(h.connected[0].env,undefined);assert.equal(h.errors.length,0);
});
test('a script launcher on PATH offers the native executable picker instead of a dead end',async()=>{
  const h=harness({pickPath:'/example/native/codex',discover:async options=>{
    if(!options.cliPath)throw problem('UNSUPPORTED_CLI');
    return {profilePath:'/example/profile',hasExistingStatusLine:false};
  }});
  await h.commands.get('llmAccountUsage.connect')();
  assert.equal(h.connected.length,1);assert.equal(h.connected[0].cliPath,'/example/native/codex');
  assert.equal(h.errors.length,0);
});
test('cancelling the profile confirmation or picker never connects a provider',async()=>{
  for(const options of [{confirm:undefined},{pickPath:null,discover:async()=>{throw problem('PROFILE_REQUIRED');}}]) {
    if('confirm' in options)options.confirm='Cancel';
    const h=harness(options);await h.commands.get('llmAccountUsage.connect')();assert.equal(h.connected.length,0);
  }
});
test('unexpected setup errors never display raw command or credential text',async()=>{
  const h=harness({discover:async()=>{throw new Error('SENSITIVE_FIXTURE_VALUE');}});
  await h.commands.get('llmAccountUsage.connect')();
  assert.equal(h.connected.length,0);assert.equal(h.errors.length,1);assert.doesNotMatch(h.errors[0],/SENSITIVE_FIXTURE_VALUE/);
});
test('connect retries missing editor ownership only after explicit confirmation',async()=>{
  for(const consent of [true,false]) {
    const operation=async options=>{if(!options.confirmTakeover)throw problem('TAKEOVER_REQUIRED');};
    const h=harness({connect:operation,recover:consent?'Recover connection':'Cancel'});
    await h.commands.get('llmAccountUsage.connect')();
    assert.equal(h.connected.length,consent?2:1);
    assert.equal(h.connected[0].confirmTakeover,undefined);
    if(consent)assert.equal(h.connected[1].confirmTakeover,true);
    assert.equal(h.errors.length,0);
  }
});

async function disconnectFixture(t,{orphan=false,missingCli=false}={}) {
  const io=fs.promises;
  const homeDir=await io.mkdtemp(path.join(os.tmpdir(),'account-usage-extension-'));
  t.after(()=>io.rm(homeDir,{recursive:true,force:true}));
  const extensionPath=path.resolve(__dirname,'..'),storagePath=path.join(homeDir,'original-editor');
  const cliPath=path.join(homeDir,'native-cli');
  await io.symlink(process.execPath,cliPath);
  const setup=createSetup({homeDir,systemUid:(await io.stat('/')).uid,env:{PATH:''}});
  const options={provider:'claude',storagePath,nodePath:process.execPath,cliPath,
    collectorPath:path.join(extensionPath,'collectors/passive.cjs')};
  const installed=[],originals=[];
  for(const name of ['first','second']) {
    const profilePath=path.join(homeDir,name);
    await io.mkdir(profilePath,{mode:0o700});
    const original={theme:name,statusLine:{type:'command',command:`printf ${name}`}};
    await io.writeFile(path.join(profilePath,'settings.json'),JSON.stringify(original),{mode:0o600});
    installed.push(await setup.connectProvider({...options,profilePath}));
    originals.push(original);
  }
  if(orphan)await io.rmdir(storagePath);
  if(missingCli)await io.unlink(cliPath);
  return {setup,installed,originals,extensionPath,nodePath:process.execPath,uid:process.getuid(),
    storagePath:orphan?path.join(homeDir,'replacement-editor'):storagePath};
}

test('disconnect command finds actual orphaned receipts and restores only the selected profile after consent',async t=>{
  for(const consent of [false,true]) {
    const f=await disconnectFixture(t,{orphan:true});
    assert.deepEqual(await f.setup.listConnections({storagePath:f.storagePath}),[]);
    const files=f.installed.flatMap(connection=>[connection.settingsPath,
      path.join(path.dirname(connection.launcherPath),'connection.json')]);
    const before=await Promise.all(files.map(file=>fs.promises.readFile(file)));
    const h=harness({...f,setupApi:f.setup,pickConnection:f.installed[1].id,recover:consent?'Recover connection':'Cancel'});
    await h.commands.get('llmAccountUsage.disconnect')();
    assert.equal(h.lastPickItems.length,2);
    assert.equal(h.warnings.length,1);
    assert.equal(h.errors.length,0);
    const picked=h.lastPickItems.find(item=>item.connection.id===f.installed[1].id);
    assert.equal(picked.description,`UID ${process.getuid()} · ${f.installed[1].profilePath}`);
    assert.deepEqual(await Promise.all(files.slice(0,2).map(file=>fs.promises.readFile(file))),before.slice(0,2));
    if(consent) {
      assert.deepEqual(JSON.parse(await fs.promises.readFile(files[2],'utf8')),f.originals[1]);
      const saved=JSON.parse(await fs.promises.readFile(files[3],'utf8'));
      assert.equal(saved.status,'disconnected');
      assert.equal(saved.ownerStoragePath,f.storagePath);
    } else {
      assert.deepEqual(await Promise.all(files.map(file=>fs.promises.readFile(file))),before);
      await assert.rejects(fs.promises.stat(f.storagePath),{code:'ENOENT'});
    }
  }
});

test('disconnect command finds actual receipts after their CLI disappears',async t=>{
  const f=await disconnectFixture(t,{missingCli:true});
  assert.deepEqual(await f.setup.listConnections({storagePath:f.storagePath}),[]);
  const before=await fs.promises.readFile(f.installed[0].settingsPath);
  const h=harness({...f,setupApi:f.setup,pickConnection:f.installed[1].id});
  await h.commands.get('llmAccountUsage.disconnect')();
  assert.equal(h.lastPickItems.length,2);
  assert.equal(h.errors.length,0);
  assert.equal(h.warnings.length,0);
  assert.deepEqual(await fs.promises.readFile(f.installed[0].settingsPath),before);
  assert.deepEqual(JSON.parse(await fs.promises.readFile(f.installed[1].settingsPath,'utf8')),f.originals[1]);
});

test('shared-path trust explains the exact control boundary and is retained only after success',async()=>{
  const sharedDirectories=[
    {path:'/example/shared',kind:'directory',uid:2000,gid:1000,mode:0o2775},
    {path:'/example/shared/cli',kind:'executable',uid:3000,gid:1000,mode:0o775}
  ];
  for(const confirm of ['Cancel','Connect','Trust and connect']) {
    const h=harness({confirm,discover:async()=>({profilePath:'/example/profile',sharedDirectories})});
    await h.commands.get('llmAccountUsage.connect')();
    assert.match(h.confirmations[0].options.detail,/Directory: \/example\/shared \(owner UID 2000, group GID 1000, mode 2775\)/);
    assert.match(h.confirmations[0].options.detail,/Executable: \/example\/shared\/cli \(owner UID 3000, group GID 1000, mode 775\)/);
    assert.match(h.confirmations[0].options.detail,/trust the listed owners and everyone who can write through these groups/i);
    assert.equal(h.confirmations[0].actions[0],'Trust and connect');
    assert.equal(h.connected.length,confirm==='Trust and connect'?1:0);
    assert.deepEqual(JSON.parse(JSON.stringify(h.storage.get('trustedDirectories'))),confirm==='Trust and connect'?sharedDirectories:[]);
    if(h.connected.length)assert.deepEqual(JSON.parse(JSON.stringify(h.connected[0].trustedDirectories)),sharedDirectories);
  }
  const h=harness({confirm:'Trust and connect',discover:async()=>({profilePath:'/example/profile',sharedDirectories}),
    connect:async()=>{throw problem('SETTINGS_CHANGED');}});
  await h.commands.get('llmAccountUsage.connect')();
  assert.deepEqual(h.storage.get('trustedDirectories'),[]);
});

test('a previously approved exact directory is passed to later setup operations',async()=>{
  const savedTrust=[{path:'/example/home',uid:1000,gid:1000}];
  const h=harness({savedTrust});
  await h.commands.get('llmAccountUsage.connect')();
  assert.deepEqual(JSON.parse(JSON.stringify(h.connected[0].trustedDirectories)),savedTrust);
});

const target=(provider,pid=20,uid=1000)=>({provider,cliPath:`/example/native/${{claude:'claude',codex:'codex',antigravity:'agy'}[provider]}`,process:{pid,uid,start_ticks:String(pid),boot_id:'boot'}});
const terminal=()=>({name:'Example terminal',processId:Promise.resolve(10)});
function foreignConnection() {
  const base={provider:'claude',uid:2000,settingsPath:'/home/target/.claude/settings.json'};
  return {...require('../src/connection.cjs').connectionIdentity(base),profilePath:'/home/target/.claude',connected:true,
    cliLookupPath:target('claude').cliPath,reportDir:'/home/target/.llm-account-usage-feeds/example',
    launcherPath:'/home/target/runtime/run.sh',backupPath:'/home/target/runtime/backup.json',runtimeVersion:'0.4.0'};
}
test('unavailable foreign topology never falls back to host profile setup',async()=>{
 const h=harness({terminal:terminal(),detect:async()=>({provider:null,unavailable:true})});
 await h.commands.get('llmAccountUsage.connect')();
 assert.equal(h.discovered.length,0);assert.equal(h.connected.length,0);assert.equal(h.root.calls.length,0);
 assert.equal(h.api.getWizardState().step,'idle');assert.equal(h.errors.length,1);
});
test('foreign reuse during first ancestry matching cannot fall through to host setup',async()=>{
 const {createProviderDetector}=require('../src/provider.cjs');let reads=0;
 const detect=createProviderDetector({uid:1000,processIds:async function*(){yield 30;},getProcess:async pid=>pid===10?
  {pid:10,ppid:1,uid:1000,start_ticks:'10',boot_id:'boot',pgrp:10,tty_nr:1,tpgid:30}:
  {pid:30,ppid:10,uid:2000,start_ticks:++reads===1?'30':'reused',boot_id:'boot',pgrp:30,tty_nr:1,tpgid:30}});
 const h=harness({terminal:terminal(),detect:pid=>detect(pid,{allowForeign:true,topologyOnly:true})});
 await h.commands.get('llmAccountUsage.connect')();
 assert.equal(h.errors.length,1);assert.equal(h.discovered.length,0);assert.equal(h.connected.length,0);assert.equal(h.root.calls.length,0);
 assert.equal(h.api.getWizardState().step,'idle');
});
test('managed descriptor reload has no persistent pending process and retains reports beside a bad descriptor',async()=>{
  const connection=foreignConnection();
  const h=harness({terminal:terminal(),detect:async()=>target('claude',30,2000),managed:[connection.reportDir,'/bad'],descriptors:[connection],descriptorRejected:1});
  await h.api.refresh();assert.ok(h.api.getState().setupTarget);
  assert.ok(h.feedDirectories.includes(connection.reportDir));
});
test('an older managed runtime retains its last report and offers an explicit reconnect for that profile',async()=>{
  const connection={...foreignConnection(),runtimeVersion:'0.3.0'};
  const report={provider:'claude',process:target('claude',30,2000).process};
  const h=harness({terminal:terminal(),detect:async()=>target('claude',30,2000),managed:[connection.reportDir],descriptors:[connection],
    reports:[report],match:async()=>({status:'ready',report})});
  await h.api.refresh();assert.equal(h.api.getState().report,report);assert.equal(h.api.getState().needsReconnect,true);
  assert.equal(h.api.getState().setupTarget.provider,'claude');assert.equal(h.api.getState().reconnectConnection.id,connection.id);
  assert.deepEqual(JSON.parse(JSON.stringify(h.api.getState().reconnectTarget)),{provider:'claude',process:report.process});
  assert.match(h.api.getHtml(),/Reconnect/);assert.equal(h.api.getViewModel().stale,true);
});
test('command-palette reconnect refuses a replacement process behind a retained profile card',async()=>{
 const connection={...foreignConnection(),runtimeVersion:'0.3.0'},first=target('claude',30,2000);
 const report={provider:'claude',process:first.process};let detected=first;
 const h=harness({terminal:terminal(),detect:async()=>detected,managed:[connection.reportDir],descriptors:[connection],
  reports:[report],match:async()=>({status:'ready',report}),extensionPath:REPO});
 await h.api.refresh();assert.equal(h.api.getState().needsReconnect,true);
 detected=target('claude',40,2000);
 await h.commands.get('llmAccountUsage.connect')();await settle(h.api);
 assert.equal(h.root.calls.length,0);assert.equal(h.api.getWizardState().step,'idle');assert.equal(h.discovered.length,0);assert.equal(h.connected.length,0);
});
test('reconnect state refuses changed birth, boot, owner, provider or missing identity before any setup',async()=>{
 for(const mutation of ['birth','boot','owner','provider','missing']) {
  const first=target('claude',30,2000),connection={...foreignConnection(),runtimeVersion:'0.3.0'},report={provider:'claude',process:first.process};let detected=first;
  const h=harness({terminal:terminal(),detect:async()=>detected,managed:[connection.reportDir],descriptors:[connection],
   reports:[report],match:async()=>({status:'ready',report}),confirm:'Connect',extensionPath:REPO});
  await h.api.refresh();assert.equal(h.api.getState().needsReconnect,true);
  if(mutation==='missing')delete h.api.getState().reconnectTarget;
  else detected={...first,...(mutation==='provider'?{provider:'codex'}:{}),process:{...first.process,
   ...({birth:{start_ticks:'31'},boot:{boot_id:'other'},owner:{uid:1000}}[mutation]||{})}};
  await h.commands.get('llmAccountUsage.connect')();
  await settle(h.api);assert.equal(h.api.getWizardState().step,'idle',mutation);
  assert.equal(h.root.calls.length,0,mutation);assert.equal(h.discovered.length,0,mutation);assert.equal(h.connected.length,0,mutation);
 }
});
test('reconnect discovery cannot attach a retained report to another detected process',async()=>{
 const first=target('claude',30,2000),connection={...foreignConnection(),runtimeVersion:'0.3.0'},report={provider:'claude',process:first.process};
 const h=harness({terminal:terminal(),detect:async()=>target('claude',40,2000),managed:[connection.reportDir],descriptors:[connection],
  reports:[report],match:async()=>({status:'ready',report})});
 await h.api.refresh();assert.equal(h.api.getState().needsReconnect,undefined);assert.equal(h.api.getState().reconnectTarget,undefined);
 assert.equal(h.api.getState().report,report);
});
test('a generic foreign reconnect cannot pair another selected provider with the retained profile',async()=>{
 const connection={...foreignConnection(),runtimeVersion:'0.3.0'},targetProcess=target('claude',30,2000).process;
 const report={provider:'claude',process:targetProcess};
 const h=harness({terminal:terminal(),detect:async()=>({provider:null,cliPath:null,process:targetProcess}),
  managed:[connection.reportDir],descriptors:[connection],reports:[report],match:async()=>({status:'ready',report}),
  pickProvider:'codex',extensionPath:REPO});
 await h.api.refresh();assert.equal(h.api.getState().needsReconnect,true);
 await h.commands.get('llmAccountUsage.connect')();await settle(h.api);
 assert.equal(h.root.calls.length,0);assert.equal(h.api.getWizardState().step,'idle');assert.equal(h.discovered.length,0);
 assert.equal(h.connected.length,0);assert.match(h.errors[0],/provider.*profile/i);
});
test('card connects the detected provider without a picker and retains permission confirmation',async()=>{
 for(const provider of ['claude','codex','antigravity']) {
  const h=harness({terminal:terminal(),detect:async()=>target(provider)}),send=h.openCard();
  await h.api.refresh();
  await send({type:'unexpected',command:'llmAccountUsage.connect'});
  assert.equal(h.connected.length,0);
  await send({type:'connect'});
  assert.equal(h.connected.length,1);
  assert.equal(h.confirmations.length,1);
  assert.equal(h.connected[0].provider,provider);
  assert.equal(h.connected[0].cliPath,target(provider).cliPath);
  assert.ok(h.discovered[0].pendingProcess);
  assert.deepEqual(JSON.parse(JSON.stringify(h.discovered[0].pendingProcess)),target(provider).process);
  assert.ok(h.connected[0].pendingProcess);
  assert.deepEqual(JSON.parse(JSON.stringify(h.connected[0].pendingProcess)),target(provider).process);
  assert.equal(h.picks,0);
  assert.match(h.confirmations[0].message,new RegExp(provider==='claude'?'Claude Code':provider==='codex'?'Codex':'Antigravity'));
 }
  const cancelled=harness({confirm:'Cancel',terminal:terminal(),detect:async()=>target('claude')});
  const sendCancelled=cancelled.openCard();
  await cancelled.api.refresh();
  await sendCancelled({type:'connect'});
  assert.equal(cancelled.connected.length,0);
});

test('an unknown unavailable session offers every provider through the generic picker',async()=>{
 const h=harness({terminal:terminal(),pickProvider:'codex',connections:[{provider:'claude',reportDir:'/example/claude'}]});
 const send=h.openCard();
 await h.api.refresh();
 assert.deepEqual(JSON.parse(JSON.stringify(h.api.getState().setupTarget)),{provider:null});
 await send({type:'connect'});
 assert.equal(h.connected.length,1);
 assert.equal(h.connected[0].provider,'codex');
 assert.deepEqual(JSON.parse(JSON.stringify(h.lastPickItems.map(item=>item.provider))),['codex','claude','antigravity']);
 assert.equal(h.discovered[0].pendingProcess,undefined);
 assert.equal(h.connected[0].pendingProcess,undefined);
});

test('unknown sessions can connect another profile when all providers are already connected',async()=>{
 const connections=['claude','codex','antigravity'].map(provider=>({provider,reportDir:`/example/${provider}`}));
 const h=harness({terminal:terminal(),connections}),send=h.openCard();
 await h.api.refresh();
 assert.ok(h.api.getState().setupTarget);
 assert.deepEqual(JSON.parse(JSON.stringify(h.api.getState().setupTarget)),{provider:null});
 await send({type:'connect'});
 assert.equal(h.connected.length,1);assert.equal(h.picks,1);
 assert.equal(h.connected[0].provider,'claude');
 assert.deepEqual(JSON.parse(JSON.stringify(h.lastPickItems.map(item=>item.provider))),['codex','claude','antigravity']);
});

test('a detected exact pending connection waits for a fresh report without setup',async()=>{
 const detected=target('claude');
 const h=harness({terminal:terminal(),detect:async()=>detected,connections:[{id:'example',provider:'claude',uid:1000,
  reportDir:'/example/reports',cliLookupPath:detected.cliPath,pendingProcess:detected.process}]});
 await h.api.refresh();
 assert.equal(h.api.getState().setupTarget,undefined);
 assert.match(h.api.getState().reason,/connected.*fresh/i);
});

test('a detected package update can reconnect an existing provider to its new native target',async()=>{
 const detected=target('codex');
 const h=harness({terminal:terminal(),detect:async()=>detected,
  connections:[{provider:'codex',reportDir:'/example/codex',cliLookupPath:'/example/native/codex-v1'}]});
 await h.api.refresh();
 assert.deepEqual(JSON.parse(JSON.stringify(h.api.getState().setupTarget)),detected);
 await h.commands.get('llmAccountUsage.connect')();
 assert.equal(h.connected.length,1);
 assert.equal(h.connected[0].provider,'codex');
 assert.equal(h.connected[0].cliPath,detected.cliPath);
 assert.equal(h.picks,0);
});

test('Codex selection reads its connected report and never invokes direct collection',async()=>{
 const report={provider:'codex',session_id:'codex-session'};
 const h=harness({terminal:terminal(),connections:[{provider:'codex',reportDir:'/example/codex'}],reports:[report],
  collect:async()=>{throw new Error('direct collection must not run');},match:async(_pid,available)=>available.length?{status:'ready',report:available[0]}:{status:'unavailable'}});
 await h.api.refresh();assert.equal(h.collectionCalls,0);assert.deepEqual(JSON.parse(JSON.stringify(h.feedDirectories)),['/example/codex']);assert.equal(h.api.getState().status,'ready');assert.equal(h.api.getState().report.session_id,'codex-session');
});

test('each exact pending connection without a fresh report waits without a setup action',async()=>{
 for(const provider of ['codex','claude','antigravity']) {
  const h=harness({terminal:terminal(),detect:async()=>target(provider),connections:[{id:provider,provider,uid:1000,
   pendingProcess:target(provider).process,reportDir:`/example/${provider}`}],collect:async()=>{throw new Error('direct collection must not run');}});
  await h.api.refresh();assert.equal(h.collectionCalls,0,provider);assert.equal(h.api.getState().setupTarget,undefined,provider);assert.match(h.api.getState().reason,/connected.*fresh turn/i,provider);
 }
});

test('the first Claude connection does not suppress Connect Claude for a second process',async()=>{
 const first=target('claude',20,1000),second=target('claude',30,1000);
 const h=harness({terminal:terminal(),detect:async()=>second,connections:[{
  id:'first',provider:'claude',uid:1000,reportDir:'/feeds/first',pendingProcess:first.process
 }]});
 const send=h.openCard();
 await h.api.refresh();
 assert.ok(h.api.getState().setupTarget);
 assert.deepEqual(JSON.parse(JSON.stringify(h.api.getState().setupTarget)),second);
 await send({type:'connect'});
 assert.equal(h.connected.length,1);
 assert.equal(h.connected[0].pendingProcess.pid,30);
 assert.equal(h.discovered[0].pendingProcess.pid,30);
 assert.equal(h.picks,0);
});

test('two same-provider feeds are both read and exact pending state hides setup only for its process',async()=>{
 const first=target('claude',20,1000),second=target('claude',30,2000);
 const connections=[
  {id:'first',provider:'claude',uid:1000,reportDir:'/feeds/first',pendingProcess:first.process},
  {id:'second',provider:'claude',uid:2000,reportDir:'/feeds/second',pendingProcess:second.process}
 ];
 let detected=second;
 const h=harness({terminal:terminal(),detect:async()=>detected,connections});
 await h.api.refresh();
 assert.deepEqual(JSON.parse(JSON.stringify(h.feedDirectories)),['/feeds/first','/feeds/second']);
 assert.equal(h.api.getState().setupTarget,undefined);
 assert.match(h.api.getState().reason,/connected.*fresh turn/i);
 detected=target('claude',40,2000);
 await h.api.refresh();
 assert.ok(h.api.getState().setupTarget);
 assert.deepEqual(JSON.parse(JSON.stringify(h.api.getState().setupTarget)),detected);
});

test('a saved connection without an exact pending process still offers profile setup',async()=>{
 const detected=target('claude');
 const h=harness({terminal:terminal(),detect:async()=>detected,connections:[{
  id:'first',provider:'claude',uid:1000,reportDir:'/feeds/first',cliLookupPath:detected.cliPath
 }]});
 await h.api.refresh();
 assert.ok(h.api.getState().setupTarget);
 assert.deepEqual(JSON.parse(JSON.stringify(h.api.getState().setupTarget)),detected);
});

test('disconnect addresses one profile connection by ID',async()=>{
 const connections=[
  {id:'first',provider:'claude',uid:1000,profilePath:'/home/one/.claude',reportDir:'/feeds/first'},
  {id:'second',provider:'claude',uid:2000,profilePath:'/home/two/.claude',reportDir:'/feeds/second'}
 ];
 const h=harness({connections,pickConnection:'second',uid:2000});
 await h.commands.get('llmAccountUsage.disconnect')();
 assert.equal(h.connected.length,1);
 assert.equal(h.connected[0].connectionId,'second');
 assert.equal(h.connected[0].provider,undefined);
 assert.deepEqual(JSON.parse(JSON.stringify(h.lastPickItems.map(item=>({label:item.label,description:item.description})))),[
  {label:'Claude Code',description:'UID 1000 · /home/one/.claude'},
  {label:'Claude Code',description:'UID 2000 · /home/two/.claude'}
 ]);
});

test('a changed provider process during recovery confirmation cannot write a pending connection',async()=>{
 let detected=target('claude');
 const h=harness({terminal:terminal(),detect:async()=>detected,
  connect:async options=>{if(!options.confirmTakeover)throw problem('TAKEOVER_REQUIRED');},
  recover:()=>{detected=target('claude',30);return 'Recover connection';}
 });
 await h.commands.get('llmAccountUsage.connect')();
 assert.equal(h.connected.length,1);
 assert.equal(h.connected[0].confirmTakeover,undefined);
 assert.equal(h.errors.length,0);
});

test('a terminal switch during final process revalidation prevents profile setup',async()=>{
 let revalidating=false,h;
 h=harness({terminal:terminal(),detect:async()=>{
  if(revalidating)h.vscode.window.activeTerminal=terminal();
  return target('claude');
 },confirm:()=>{revalidating=true;return 'Connect';}});
 await h.api.refresh();
 await h.commands.get('llmAccountUsage.connect')();
 assert.equal(h.confirmations.length,1);
 assert.equal(h.connected.length,0);
 assert.equal(h.errors.length,0);
});

test('stale card actions and a terminal change during confirmation cannot connect a different session',async()=>{
 let detected=target('claude');
 const h=harness({terminal:terminal(),detect:async()=>detected}),send=h.openCard();
 await h.api.refresh();detected=target('antigravity');
 await send({type:'connect'});
 assert.equal(h.connected.length,0);assert.equal(h.confirmations.length,0);
 let active;
 active=harness({terminal:terminal(),detect:async()=>target('claude'),discover:async()=>{
  active.vscode.window.activeTerminal=terminal();return {profilePath:'/example/profile'};
 }});
 const sendActive=active.openCard();
 await active.api.refresh();await sendActive({type:'connect'});
 assert.equal(active.confirmations.length,1);
 assert.equal(active.connected.length,0);
 let generic;
 generic=harness({terminal:terminal(),pickProvider:'codex',discover:async()=>{
  generic.vscode.window.activeTerminal=terminal();return {profilePath:'/example/profile'};
 }});
 const sendGeneric=generic.openCard();
 await generic.api.refresh();await sendGeneric({type:'connect'});
 assert.equal(generic.confirmations.length,1);
 assert.equal(generic.connected.length,0);
});

// ---- Another account's session: the connect wizard in the card (0.4, Task 2.3) ----
// The connection a target run reports: its feed is the shared folder the wizard creates for it.
function wizardConnection(extra={}) {const base=foreignConnection();return {...base,reportDir:realSharedFeed.feedPath(base.id),...extra};}
function foreignHarness({connection=wizardConnection(),sudo={},...options}={}) {
  const h=harness({terminal:terminal(),detect:async()=>target('claude',30,2000),descriptors:[connection],extensionPath:REPO,...options,sudo:{connection,...sudo}});
  return {h,connection};
}
const rootArgv=h=>h.root.as(undefined);
const bundleRemovals=h=>rootArgv(h).filter(argv=>argv[0]==='/usr/bin/rm'&&argv[1]==='-r');

test('another account’s session opens the wizard in the card: no modal, no clipboard, three clicks, only the verified feed saved',async()=>{
  const {h,connection}=foreignHarness();const send=h.openCard();
  await h.api.refresh();assert.equal(h.api.getState().setupTarget.process.uid,2000);
  await send({type:'connect'});
  let state=h.api.getWizardState();
  assert.equal(state.step,'detected');assert.equal(state.target.user,'claudebwai');assert.equal(state.target.pid,30);
  assert.equal(h.confirmations.length,0);assert.equal(h.inputs.length,0);assert.equal(h.clipboard,'');
  assert.match(h.posted.at(-1).html,/data-intent="continue"/);assert.match(h.api.getHtml(),/wizard-card/);
  await send({type:'wizard',intent:'continue'});
  state=h.api.getWizardState();assert.equal(state.step,'review');
  // Nothing is written before Connect: discover as the target, the bundle as root, no feed folder, no setup-cli connect.
  assert.deepEqual(h.root.verbs(),['discover']);assert.equal(h.root.present.size,0);
  assert.deepEqual(state.preview.changes.map(change=>change.id),['folder','status']);
  await send({type:'wizard',intent:'connect'});
  state=h.api.getWizardState();
  assert.equal(state.step,'connected');assert.equal(state.busy,false);assert.equal(state.pending,null);assert.equal(state.error,null);
  assert.deepEqual(h.root.verbs(),['discover','connect']);assert.ok(h.root.present.has(connection.reportDir));
  assert.equal(bundleRemovals(h).length,1);
  assert.equal(h.confirmations.length,0);assert.equal(h.clipboard,'');assert.deepEqual(h.errors,[]);assert.deepEqual(h.warnings,[]);
  assert.equal(h.connected.length,0);assert.equal(h.discovered.length,0);
  assert.match(h.posted.at(-1).html,/Connected\./);
  assert.deepEqual([...h.storage.get('managedFeedDirectories')],[connection.reportDir]);
  assert.deepEqual([...h.storage.keys()].sort(),['managedFeedDirectories','trustedDirectories']);
  assert.doesNotMatch(JSON.stringify([...h.storage]),/"uid"|profilePath|pendingProcess/);
  await h.api.refresh();assert.equal(h.api.getState().setupTarget,undefined);assert.match(h.api.getState().reason,/fresh turn/);
});

test('switching the active terminal mid-run changes nothing: the run stays bound to its process (finding 6)',async()=>{
  let h;
  ({h}=foreignHarness({sudo:{onRun:()=>{h.vscode.window.activeTerminal=h.vscode.window.activeTerminal?undefined:terminal();}}}));
  const send=h.openCard();
  await h.commands.get('llmAccountUsage.connect')();await settle(h.api);
  h.vscode.window.activeTerminal=undefined;
  await send({type:'wizard',intent:'continue'});
  h.vscode.window.activeTerminal={name:'Another terminal',processId:Promise.resolve(99)};
  await send({type:'wizard',intent:'connect'});
  const state=h.api.getWizardState();
  assert.equal(state.step,'connected',state.error);assert.deepEqual(h.errors,[]);
  assert.ok(!h.notices.some(message=>/terminal changed/i.test(message)));
  assert.equal(h.storage.get('managedFeedDirectories').length,1);
});

test('a reused or unverifiable process after Connect is rolled back and saves no feed',async()=>{
  for(const mutation of ['reuse','ambiguous']) {
    let detected=target('claude',30,2000);
    const {h,connection}=foreignHarness({detect:async()=>detected,sudo:{onRun:argv=>{
      if(argv[2]!=='connect')return;
      detected=mutation==='reuse'?{...detected,process:{...detected.process,start_ticks:'31'}}:{provider:null,unavailable:true};
    }}});
    const send=h.openCard();
    await h.commands.get('llmAccountUsage.connect')();await settle(h.api);
    await send({type:'wizard',intent:'continue'});await send({type:'wizard',intent:'connect'});
    const state=h.api.getWizardState();
    assert.equal(state.step,'undone',mutation);assert.match(state.error,/could not be verified/,mutation);
    assert.deepEqual(h.root.verbs(),['discover','connect','disconnect'],mutation);
    assert.ok(!h.root.present.has(connection.reportDir),mutation);assert.equal(bundleRemovals(h).length,1,mutation);
    assert.deepEqual([...h.storage.get('managedFeedDirectories')],[],mutation);
  }
});

test('a cancel, a refused setup, an unreadable folder or feed, or a mismatched descriptor saves no feed and undoes the run',async()=>{
  for(const outcome of ['cancel','refused','folder','feed','descriptor','mismatch']) {
    const connection=wizardConnection();let h;
    ({h}=foreignHarness({connection,feedRejected:outcome==='feed'?1:0,descriptorRejected:outcome==='descriptor'?1:0,
      descriptors:[outcome==='mismatch'?{...connection,id:'v2-'+'b'.repeat(32)}:connection],
      sudo:{readable:outcome!=='folder',connectResult:()=>outcome==='refused'?{ok:false}:{ok:true,connection},
        onRun:argv=>{if(outcome==='cancel'&&argv[2]==='connect')h.post({type:'wizard',intent:'cancel'});}}}));
    const send=h.openCard();
    await h.commands.get('llmAccountUsage.connect')();await settle(h.api);
    await send({type:'wizard',intent:'continue'});await send({type:'wizard',intent:'connect'});
    const state=h.api.getWizardState();
    assert.equal(state.step,'undone',outcome);assert.equal(state.busy,false,outcome);
    assert.deepEqual([...h.storage.get('managedFeedDirectories')],[],outcome);assert.equal(h.connected.length,0,outcome);
    assert.equal(h.root.present.size,0,outcome);assert.equal(bundleRemovals(h).length,1,outcome);
    // Finding 4: a folder VS Code cannot read stops the run before the target account is touched.
    if(outcome==='folder')assert.deepEqual(h.root.verbs(),['discover'],outcome);
    else if(outcome!=='refused')assert.equal(h.root.verbs().at(-1),'disconnect',outcome);
  }
});

test('a second open while the wizard is busy is refused, the poll never drives it, and one run fills the final feed slot',async()=>{
  const full=Array.from({length:127},(_,index)=>`/feeds/${index}`);
  const {h,connection}=foreignHarness({managed:full});const send=h.openCard();
  await h.commands.get('llmAccountUsage.connect')();
  const runId=h.api.getWizardState().runId;assert.equal(h.api.getWizardState().busy,true);
  await h.commands.get('llmAccountUsage.connect')();
  assert.match(h.errors[0],/already in progress/i);assert.equal(h.api.getWizardState().runId,runId);
  // Every refresh rereads the managed descriptors; the poll must not, while the wizard is shown.
  assert.equal(h.polls.length,1);const reads=h.descriptorBatches.length;
  await h.polls[0]();
  assert.equal(h.descriptorBatches.length,reads);assert.equal(h.api.getWizardState().runId,runId);
  await settle(h.api);await send({type:'wizard',intent:'continue'});await send({type:'wizard',intent:'connect'});
  assert.equal(h.api.getWizardState().step,'connected');
  assert.equal(h.root.verbs().filter(verb=>verb==='discover').length,1);
  assert.equal(h.storage.get('managedFeedDirectories').length,128);assert.ok(h.storage.get('managedFeedDirectories').includes(connection.reportDir));
});

test('a cleanup warning is shown in the card and never blocks a second open (finding 1)',async()=>{
  const {h,connection}=foreignHarness({sudo:{bundleRemoved:false}});const send=h.openCard();
  await h.commands.get('llmAccountUsage.connect')();await settle(h.api);
  await send({type:'wizard',intent:'continue'});await send({type:'wizard',intent:'connect'});
  const first=h.api.getWizardState();
  assert.equal(first.step,'connected');assert.equal(first.busy,false);assert.match(first.warning,/bundle could not be removed/);
  assert.match(h.posted.at(-1).html,/bundle could not be removed/);
  assert.deepEqual(h.warnings,[]);assert.deepEqual(h.errors,[]);
  assert.deepEqual([...h.storage.get('managedFeedDirectories')],[connection.reportDir]);
  await h.commands.get('llmAccountUsage.connect')();await settle(h.api);
  const second=h.api.getWizardState();
  assert.notEqual(second.runId,first.runId);assert.equal(second.step,'detected');assert.equal(second.warning,null);
  assert.deepEqual(h.errors,[]);
});

test('Close on a done screen puts the card back, also when pressed before the cleanup has settled',async()=>{
  for(const early of [false,true]) {
    let release;const gate=new Promise(resolve=>{release=resolve;});
    const {h}=foreignHarness({sudo:{onRun:argv=>argv[0]==='/usr/bin/rm'&&early?gate:undefined}});const send=h.openCard();
    await h.commands.get('llmAccountUsage.connect')();await settle(h.api);
    await send({type:'wizard',intent:'continue'});
    if(early) {
      h.post({type:'wizard',intent:'connect'});
      while(h.api.getWizardState().step!=='connected')await new Promise(setImmediate);
      assert.deepEqual(h.api.getWizardState().pending,{effect:'cleanup'});
      h.post({type:'wizard',intent:'close'});await new Promise(setImmediate);
      assert.equal(h.api.getWizardState().step,'connected','closes only once the cleanup settles');
      release();
    } else await send({type:'wizard',intent:'connect'});
    await send({type:'wizard',intent:'close'});
    assert.equal(h.api.getWizardState().step,'idle',String(early));
    assert.doesNotMatch(h.api.getHtml(),/wizard-card/);assert.doesNotMatch(h.posted.at(-1).html,/wizard-card/);
  }
});

test('Copy puts the exact reviewed commands on the clipboard; the password box is asked once and the password goes nowhere',async()=>{
  const SECRET='correct horse battery staple';
  const {h,connection}=foreignHarness({input:()=>SECRET,sudo:{sudo:'password',password:SECRET}});const send=h.openCard();
  await h.commands.get('llmAccountUsage.connect')();await settle(h.api);
  await send({type:'wizard',intent:'copy'});
  assert.equal(h.clipboard,'');assert.ok(h.notices.includes('There is no command to copy on this screen.'));
  await send({type:'wizard',intent:'continue'});
  assert.equal(h.api.getWizardState().step,'review');assert.equal(h.inputs.length,1);
  const box=h.inputs[0].options;
  assert.equal(box.password,true);assert.equal(box.ignoreFocusOut,true);assert.match(box.prompt,/\(sudo\)/);
  await send({type:'wizard',intent:'copy'});
  const lines=h.clipboard.split('\n');
  assert.equal(lines.length,3);assert.ok(h.notices.includes('Copied 3 commands.'));
  assert.equal(lines[0],`/usr/bin/mkdir -m 0700 -- ${connection.reportDir}`);
  assert.match(lines[1],new RegExp(`^/usr/bin/install -d -m 2750 -o 2000 -g \\d+ ${connection.reportDir}$`));
  assert.match(lines[2],/^\/usr\/bin\/node \/var\/lib\/llm-account-usage\/bundles\/[0-9a-f-]+\/src\/setup-cli\.cjs connect --provider claude /);
  assert.ok(lines[2].includes(`--target '{"provider":"claude","process":{"pid":30,"uid":2000,"start_ticks":"30","boot_id":"boot"}}'`));
  assert.ok(lines[2].endsWith('--consent granted --result -'));
  await send({type:'wizard',intent:'connect'});
  assert.equal(h.api.getWizardState().step,'connected');assert.equal(h.inputs.length,1,'Connect does not ask again');
  assert.ok(h.root.calls.every(call=>call.held),'every elevated call carries the held password as an option');
  for(const [where,value] of [['argv',h.root.calls.map(call=>call.argv)],['html',h.posted],['state',h.api.getWizardState()],
    ['storage',[...h.storage]],['clipboard',h.clipboard],['notices',[h.notices,h.errors,h.warnings]]])
    assert.ok(!JSON.stringify(value).includes(SECRET),where);
});

test('the password box closes itself when the run is cancelled',async()=>{
  const {h}=foreignHarness({input:(_options,token)=>new Promise(resolve=>token.onCancellationRequested(()=>resolve(undefined))),
    sudo:{sudo:'password',password:'x'}});
  const send=h.openCard();
  await h.commands.get('llmAccountUsage.connect')();await settle(h.api);
  h.post({type:'wizard',intent:'continue'});
  while(!h.inputs.length)await new Promise(setImmediate);
  await send({type:'wizard',intent:'cancel'});
  assert.equal(h.inputs[0].token.isCancellationRequested,true);
  assert.equal(h.api.getWizardState().step,'cancelled');assert.equal(h.api.getWizardState().busy,false);
  assert.deepEqual(h.root.calls,[]);
});

test('the webview drives the wizard only through its allowlisted intents',async()=>{
  const {h}=foreignHarness();const send=h.openCard();
  await h.commands.get('llmAccountUsage.connect')();await settle(h.api);
  const before=h.api.getWizardState();
  for(const message of [{type:'wizard',intent:'open'},{type:'wizard',intent:'verified'},{type:'wizard',intent:'__proto__'},
    {type:'wizard',intent:'toString'},{type:'wizard'},{type:'wizard',intent:['continue']},{type:'connect'}])
    await send(message);
  const after=h.api.getWizardState();
  assert.equal(after.runId,before.runId);assert.equal(after.step,'detected');assert.equal(h.root.calls.length,0);
});

test('the generic picker hands an EACCES foreign process to the wizard without host setup',async()=>{
 const {createProviderDetector}=require('../src/provider.cjs');
 const processTable=[{pid:10,ppid:1,uid:1000,start_ticks:'10',boot_id:'boot',pgrp:10,tty_nr:1,tpgid:30},
  {pid:30,ppid:10,uid:2000,start_ticks:'30',boot_id:'boot',pgrp:30,tty_nr:1,tpgid:30}];
 const detector=createProviderDetector({uid:1000,env:{PATH:''},home:'/nonexistent',
  getProcess:async pid=>processTable.find(value=>value.pid===pid),processIds:async function*(){yield 10;yield 30;},
  resolveExecutable:async()=>null,resolveCommand:async()=>null,
  getExecutable:async()=>{throw Object.assign(new Error('foreign exe'),{code:'EACCES'});}});
 const {h,connection}=foreignHarness({detect:detector});const send=h.openCard();
 await h.commands.get('llmAccountUsage.connect')();await settle(h.api);
 assert.equal(h.picks,1);assert.equal(h.api.getWizardState().target.provider,'claude');
 await send({type:'wizard',intent:'continue'});await send({type:'wizard',intent:'connect'});
 assert.equal(h.api.getWizardState().step,'connected',h.api.getWizardState().error);
 assert.ok(h.root.calls.every(call=>!call.argv.includes('--cli')));assert.equal(h.discovered.length,0);assert.equal(h.connected.length,0);
 assert.deepEqual([...h.storage.get('managedFeedDirectories')],[connection.reportDir]);
 await h.api.refresh();assert.equal(h.api.getState().setupTarget,undefined);assert.match(h.api.getState().reason,/connected.*fresh turn/i);
});

test('an exact reconnect opens the wizard on its captured profile through a concurrent UI refresh',async()=>{
 const first=target('claude',30,2000),connection={...foreignConnection(),runtimeVersion:'0.3.0'},report={provider:'claude',process:first.process};
 let armed=false,h;
 h=harness({terminal:terminal(),detect:async()=>{
   // The detection that follows the click must not reread a different controller state.
   if(armed)h.api.getState().reconnectConnection={...connection,profilePath:'/another',reportDir:'/another-feed'};
   return first;
  },managed:[connection.reportDir],descriptors:[connection],reports:[report],match:async()=>({status:'ready',report}),extensionPath:REPO,sudo:{connection}});
 await h.api.refresh();assert.equal(h.api.getState().needsReconnect,true);
 armed=true;await h.commands.get('llmAccountUsage.connect')();await settle(h.api);
 const state=h.api.getWizardState();
 assert.equal(state.step,'detected');assert.equal(state.connection.id,connection.id);
 assert.equal(state.connection.profilePath,connection.profilePath);assert.equal(state.connection.reportDir,connection.reportDir);
 assert.equal(state.target.pid,30);assert.equal(h.discovered.length,0);assert.equal(h.connected.length,0);
});

test('cross-user disconnect runs in the wizard and removes only that managed path and its shared folder',async()=>{
  const connection=wizardConnection();
  const {h}=foreignHarness({connection,managed:[connection.reportDir,'/another'],pickConnection:connection.id,sudo:{folders:[connection.reportDir]}});
  const send=h.openCard();
  await h.commands.get('llmAccountUsage.disconnect')();await settle(h.api);
  assert.equal(h.api.getWizardState().mode,'disconnect');assert.equal(h.api.getWizardState().step,'detected');
  await send({type:'wizard',intent:'continue'});
  assert.deepEqual(h.api.getWizardState().preview.changes.map(change=>change.id),['status','folder']);
  await send({type:'wizard',intent:'connect'});
  const state=h.api.getWizardState();
  assert.equal(state.step,'connected',state.error);assert.match(h.posted.at(-1).html,/Disconnected\./);
  assert.deepEqual(h.root.verbs(),['disconnect']);
  const disconnect=h.root.calls.find(call=>call.argv[2]==='disconnect').argv;
  assert.deepEqual(disconnect.slice(3),['--connection-id',connection.id,'--consent','granted','--remove-feed','yes','--result','-']);
  assert.ok(rootArgv(h).some(argv=>argv[0]==='/usr/bin/rmdir'&&argv.at(-1)===connection.reportDir));
  assert.ok(!h.root.present.has(connection.reportDir));
  assert.equal(h.connected.length,0);assert.equal(h.confirmations.length,0);
  assert.deepEqual([...h.storage.get('managedFeedDirectories')],['/another']);
});

test('disconnect keeps saved paths when the result does not match the picked connection exactly',async()=>{
  for(const mutation of ['stale-feed','connected','wrong-id','extra','refused']) {
    const connection=wizardConnection(),newFeed=connection.reportDir+'-changed';
    const value={...connection,connected:false,...(mutation==='stale-feed'?{reportDir:newFeed}:mutation==='connected'?{connected:true}:
      mutation==='wrong-id'?{id:'v2-'+'b'.repeat(32)}:mutation==='extra'?{account:'unexpected'}:{})};
    const {h}=foreignHarness({connection,managed:[connection.reportDir,newFeed],pickConnection:connection.id,
      sudo:{folders:[connection.reportDir],disconnectResult:()=>mutation==='refused'?{ok:false}:{ok:true,connection:value,feed:{removed:true}}}});
    const send=h.openCard();
    await h.commands.get('llmAccountUsage.disconnect')();await settle(h.api);
    await send({type:'wizard',intent:'continue'});await send({type:'wizard',intent:'connect'});
    const state=h.api.getWizardState();
    assert.equal(state.step,'undone',mutation);assert.ok(state.error,mutation);
    assert.deepEqual([...h.storage.get('managedFeedDirectories')],[connection.reportDir,newFeed],mutation);
    assert.ok(!rootArgv(h).some(argv=>argv[0]==='/usr/bin/rmdir'),mutation);assert.ok(h.root.present.has(connection.reportDir),mutation);
  }
});

test('a disconnected descriptor stays actionable until the wizard removes it from the editor',async()=>{
  const connection=wizardConnection({connected:false});
  const {h}=foreignHarness({connection,managed:[connection.reportDir],pickConnection:connection.id,sudo:{folders:[connection.reportDir]}});
  const send=h.openCard();
  await h.commands.get('llmAccountUsage.disconnect')();await settle(h.api);
  assert.ok(h.lastPickItems.some(item=>item.connection.id===connection.id));
  await send({type:'wizard',intent:'continue'});await send({type:'wizard',intent:'connect'});
  assert.equal(h.api.getWizardState().step,'connected');assert.deepEqual([...h.storage.get('managedFeedDirectories')],[]);
});
