'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const vm=require('node:vm');
const {createSetup}=require('../src/setup.cjs');

function harness({discover,connect,disconnect,recover='Recover connection',confirm='Connect',pickPath='/example/profile',pickProvider='claude',pickConnection,savedTrust=[],terminal,detect=async()=>null,connections=[],reports=[],match,collect,
  uid=1000,handoff,descriptors=[],managed=[],version='0.4.0',cancelProgress=false,feedRejected=0,descriptorRejected=0,
  setupApi,storagePath='/example/editor-storage',nodePath='/example/editor-node',extensionPath='/example/extension'}={}) {
  const commands=new Map(),connected=[],discovered=[],errors=[],warnings=[],confirmations=[],storage=new Map([['trustedDirectories',savedTrust],['managedFeedDirectories',managed]]);
  let clipboard='',disposedHandoffs=0;const handoffCalls=[];
  let provider,receive,picks=0,lastPickItems=[],collectionCalls=0,feedDirectories=[];
  const disposable=()=>({dispose(){}});
  const vscode={ProgressLocation:{Notification:15},env:{clipboard:{writeText:async text=>{clipboard=text;}}},Uri:{file:value=>({fsPath:value}),joinPath:(_base,...parts)=>({fsPath:parts.join('/')})},workspace:{getConfiguration:()=>({get:()=>[]}),onDidChangeConfiguration:disposable},
    window:{activeTerminal:terminal,registerWebviewViewProvider:(_id,value)=>{provider=value;return disposable();},onDidChangeActiveTerminal:disposable,onDidCloseTerminal:disposable,
      showQuickPick:async items=>{picks++;lastPickItems=items;return items.find(item=>pickConnection?item.connection?.id===pickConnection:(item.provider??item.connection?.provider)===pickProvider);},showOpenDialog:async()=>pickPath?[{fsPath:pickPath}]:undefined,
      showInformationMessage:async(message,options,...actions)=>{if(options?.modal){confirmations.push({message,options,actions});return typeof confirm==='function'?confirm():confirm;}},
      showWarningMessage:async(message,action)=>{warnings.push(message);return action?.modal?(typeof recover==='function'?recover():recover):action;},
      withProgress:async(_options,callback)=>callback({report(){}},{isCancellationRequested:cancelProgress,onCancellationRequested:disposable}),
      showErrorMessage:async message=>{errors.push(message);}},
    commands:{registerCommand:(name,callback)=>{commands.set(name,callback);return disposable();},executeCommand:async()=>{}}};
  const setup=setupApi||{refreshRuntime:async()=>({warnings:[]}),listConnections:async()=>connections,listDisconnectConnections:async()=>connections,
    discoverProvider:async options=>{discovered.push({...options});return discover?discover(options):{profilePath:'/example/profile',hasExistingStatusLine:true};},
    connectProvider:async options=>{connected.push(options);return connect?.(options);},
    disconnectProvider:async options=>{connected.push(options);return disconnect?.(options);}};
  const core={SelectionController:require('../src/core.cjs').SelectionController,buildRows:()=>[],
    readFeeds:async directories=>{feedDirectories=directories;return {reports,rejected:feedRejected};},matchReports:match|| (async()=>({status:'unavailable'}))};
  const exports={};
  const sandbox={module:{exports},exports,process:{platform:'linux',execPath:nodePath,getuid:()=>uid},setInterval:()=>1,clearInterval(){},setTimeout,clearTimeout,
    require:name=>name==='vscode'?vscode:name==='./setup.cjs'?setup:name==='./core.cjs'?core:name==='./collect.cjs'?{collectTerminal:async pid=>{collectionCalls++;return collect?.(pid)??null;}}:name==='./provider.cjs'?{detectProvider:detect}:
      name==='./handoff.cjs'?{prepareHandoff:async options=>{handoffCalls.push(options);return {command:"node '/bundle/src/setup-cli.cjs' connect",resultPath:'/drop/r',readResult:async()=>handoff(options),dispose:async()=>{disposedHandoffs++;}};}}:
      name==='./connection-feed.cjs'?{readConnectionFeeds:async directories=>({connections:descriptors.filter(value=>directories.includes(value.reportDir)),rejected:descriptorRejected})}:
      name==='./connection.cjs'?require('../src/connection.cjs'):name==='./panel.cjs'?{buildViewModel:()=>({}),renderContent:()=>'',renderDocument:()=>''}:require(name)};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/extension.cjs'),'utf8'),sandbox);
  const api=sandbox.module.exports.activate({globalStorageUri:{fsPath:storagePath},extensionPath,extension:{packageJSON:{version}},subscriptions:[],
    globalState:{get:(key,fallback)=>storage.get(key)??fallback,update:async(key,value)=>{storage.set(key,value);}}});
  const openCard=()=>{
    provider.resolveWebviewView({webview:{asWebviewUri:uri=>uri.fsPath,postMessage:async()=>{},
      onDidReceiveMessage:callback=>{receive=callback;return disposable();}},onDidChangeVisibility:disposable,onDidDispose:disposable});
    return async message=>{receive(message);await new Promise(setImmediate);};
  };
  return {commands,connected,discovered,errors,warnings,confirmations,storage,openCard,api,vscode,handoffCalls,get clipboard(){return clipboard;},get disposedHandoffs(){return disposedHandoffs;},get picks(){return picks;},get lastPickItems(){return lastPickItems;},get collectionCalls(){return collectionCalls;},get feedDirectories(){return feedDirectories;}};
}
const problem=code=>Object.assign(new Error('Choose the required local resource.'),{code,safeToDisplay:true});

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
test('cross-user Connect stages a command and stores only the validated feed path',async()=>{
  const foreign=target('claude',30,2000),connection=foreignConnection();
  const h=harness({terminal:terminal(),detect:async()=>foreign,confirm:'Copy setup command',descriptors:[connection],handoff:async()=>({ok:true,connection})});
  await h.commands.get('llmAccountUsage.connect')();
  assert.equal(h.connected.length,0);assert.equal(h.discovered.length,0);
  assert.match(h.clipboard,/setup-cli\.cjs' connect/);
  assert.deepEqual([...h.storage.get('managedFeedDirectories')],[connection.reportDir]);
  assert.deepEqual([...h.storage.keys()].sort(),['managedFeedDirectories','trustedDirectories']);
  assert.doesNotMatch(JSON.stringify([...h.storage]),/"uid"|profilePath|pendingProcess/);
  assert.equal(h.disposedHandoffs,1);assert.equal(h.errors.length,0);
  assert.match(h.confirmations[0].options.detail,/UID 2000/);assert.match(h.confirmations[0].options.detail,/node/);
  await h.api.refresh();assert.equal(h.api.getState().setupTarget,undefined);
  assert.match(h.api.getState().reason,/fresh turn/);
});
test('cancelled, unsafe, unreadable or mismatched cross-user results persist no feed',async()=>{
  for(const outcome of ['cancel','wrong-owner','feed','descriptor','mismatch','changed-terminal']) {
    const connection=foreignConnection();let h;
    h=harness({terminal:terminal(),detect:async()=>target('claude',30,2000),confirm:'Copy setup command',
      cancelProgress:outcome==='cancel',feedRejected:outcome==='feed'?1:0,descriptorRejected:outcome==='descriptor'?1:0,
      descriptors:[outcome==='mismatch'?{...connection,id:'v2-'+'b'.repeat(32)}:connection],handoff:async()=>{
        if(outcome==='wrong-owner')throw problem('UNVERIFIED_SETUP_RESULT');
        if(outcome==='changed-terminal')h.vscode.window.activeTerminal=terminal();
        return {ok:true,connection};
      }});
    await h.commands.get('llmAccountUsage.connect')();
    assert.deepEqual([...h.storage.get('managedFeedDirectories')],[],outcome);assert.equal(h.connected.length,0,outcome);
    assert.equal(h.disposedHandoffs,1,outcome);
  }
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
  assert.match(h.api.getHtml(),/Reconnect/);assert.equal(h.api.getViewModel().stale,true);
});
test('cross-user disconnect runs a target-user handoff and removes only that managed path',async()=>{
  const connection=foreignConnection();
  const h=harness({terminal:terminal(),detect:async()=>target('claude',30,2000),managed:[connection.reportDir,'/another'],descriptors:[connection],
    confirm:'Copy setup command',pickConnection:connection.id,handoff:async()=>({ok:true,connection:{...connection,connected:false}})});
  await h.commands.get('llmAccountUsage.disconnect')();
  assert.equal(h.connected.length,0);assert.equal(h.handoffCalls[0].action,'disconnect');
  assert.equal(h.handoffCalls[0].connectionId,connection.id);
  assert.deepEqual([...h.storage.get('managedFeedDirectories')],['/another']);assert.equal(h.disposedHandoffs,1);
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
