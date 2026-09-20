'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

function harness({discover,connect,disconnect,recover='Recover connection',confirm='Connect',pickPath='/example/profile',pickProvider='claude',savedTrust=[],terminal,detect=async()=>null,connections=[]}={}) {
  const commands=new Map(),connected=[],errors=[],warnings=[],confirmations=[],storage=new Map([['trustedDirectories',savedTrust]]);
  let provider,receive,picks=0,lastPickItems=[];
  const disposable=()=>({dispose(){}});
  const vscode={Uri:{file:value=>({fsPath:value}),joinPath:(_base,...parts)=>({fsPath:parts.join('/')})},workspace:{getConfiguration:()=>({get:()=>[]}),onDidChangeConfiguration:disposable},
    window:{activeTerminal:terminal,registerWebviewViewProvider:(_id,value)=>{provider=value;return disposable();},onDidChangeActiveTerminal:disposable,onDidCloseTerminal:disposable,
      showQuickPick:async items=>{picks++;lastPickItems=items;return items.find(item=>item.provider===pickProvider);},showOpenDialog:async()=>pickPath?[{fsPath:pickPath}]:undefined,
      showInformationMessage:async(message,options,...actions)=>{if(options?.modal){confirmations.push({message,options,actions});return confirm;}},
      showWarningMessage:async(message,action)=>{warnings.push(message);return action?.modal?recover:action;},
      showErrorMessage:async message=>{errors.push(message);}},
    commands:{registerCommand:(name,callback)=>{commands.set(name,callback);return disposable();},executeCommand:async()=>{}}};
  const setup={refreshRuntime:async()=>({warnings:[]}),listConnections:async()=>connections,discoverProvider:discover||
    (async()=>({profilePath:'/example/profile',hasExistingStatusLine:true})),
    connectProvider:async options=>{connected.push(options);return connect?.(options);},
    disconnectProvider:async options=>{connected.push(options);return disconnect?.(options);}};
  const core={SelectionController:require('../src/core.cjs').SelectionController,buildRows:()=>[],
    readFeeds:async()=>({reports:[],rejected:0}),matchReports:async()=>({status:'unavailable'})};
  const exports={};
  const sandbox={module:{exports},exports,process:{platform:'linux',execPath:'/example/editor-node'},setInterval:()=>1,clearInterval(){},
    require:name=>name==='vscode'?vscode:name==='./setup.cjs'?setup:name==='./core.cjs'?core:name==='./collect.cjs'?{collectTerminal:async()=>null}:name==='./provider.cjs'?{detectProvider:detect}:
      name==='./panel.cjs'?{buildViewModel:()=>({}),renderContent:()=>'',renderDocument:()=>''}:require(name)};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/extension.cjs'),'utf8'),sandbox);
  const api=sandbox.module.exports.activate({globalStorageUri:{fsPath:'/example/editor-storage'},extensionPath:'/example/extension',subscriptions:[],
    globalState:{get:(key,fallback)=>storage.get(key)??fallback,update:async(key,value)=>{storage.set(key,value);}}});
  const openCard=()=>{
    provider.resolveWebviewView({webview:{asWebviewUri:uri=>uri.fsPath,postMessage:async()=>{},
      onDidReceiveMessage:callback=>{receive=callback;return disposable();}},onDidChangeVisibility:disposable,onDidDispose:disposable});
    return async message=>{receive(message);await new Promise(setImmediate);};
  };
  return {commands,connected,errors,warnings,confirmations,storage,openCard,api,vscode,get picks(){return picks;},get lastPickItems(){return lastPickItems;}};
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
test('missing editor ownership is recovered only after explicit confirmation for connect and disconnect',async()=>{
  for(const command of ['connect','disconnect'])for(const consent of [true,false]) {
    const operation=async options=>{if(!options.confirmTakeover)throw problem('TAKEOVER_REQUIRED');};
    const h=harness({[command]:operation,recover:consent?'Recover connection':'Cancel'});
    await h.commands.get(`llmAccountUsage.${command}`)();
    assert.equal(h.connected.length,consent?2:1);
    assert.equal(h.connected[0].confirmTakeover,undefined);
    if(consent)assert.equal(h.connected[1].confirmTakeover,true);
    assert.equal(h.errors.length,0);
  }
});

test('shared-directory trust requires the explicit connection choice and is retained only after success',async()=>{
  const sharedDirectories=[{path:'/example/home',uid:1000,gid:1000},{path:'/example/home/.claude',uid:1000,gid:1000}];
  for(const confirm of ['Cancel','Connect','Trust and connect']) {
    const h=harness({confirm,discover:async()=>({profilePath:'/example/home/.claude',sharedDirectories})});
    await h.commands.get('llmAccountUsage.connect')();
    assert.match(h.confirmations[0].options.detail,/\/example\/home/);
    assert.match(h.confirmations[0].options.detail,/group 1000/);
    assert.equal(h.confirmations[0].actions[0],'Trust and connect');
    assert.equal(h.connected.length,confirm==='Trust and connect'?1:0);
    assert.deepEqual(JSON.parse(JSON.stringify(h.storage.get('trustedDirectories'))),confirm==='Trust and connect'?sharedDirectories:[]);
    if(h.connected.length)assert.deepEqual(JSON.parse(JSON.stringify(h.connected[0].trustedDirectories)),sharedDirectories);
  }
  const h=harness({confirm:'Trust and connect',discover:async()=>({profilePath:'/example/home/.claude',sharedDirectories}),
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

const target=provider=>({provider,cliPath:`/example/native/${{claude:'claude',codex:'codex',antigravity:'agy'}[provider]}`,process:{pid:20,uid:1000,start_ticks:'20',boot_id:'boot'}});
const terminal=()=>({name:'Example terminal',processId:Promise.resolve(10)});
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
  assert.equal(h.picks,0);
  assert.match(h.confirmations[0].message,new RegExp(provider==='claude'?'Claude Code':provider==='codex'?'Codex':'Antigravity'));
 }
  const cancelled=harness({confirm:'Cancel',terminal:terminal(),detect:async()=>target('claude')});
  await cancelled.api.refresh();
  await cancelled.openCard()({type:'connect'});
  assert.equal(cancelled.connected.length,0);
});

test('an unknown unavailable session offers only unconnected providers through the generic picker',async()=>{
 const h=harness({terminal:terminal(),pickProvider:'codex',connections:[{provider:'claude',reportDir:'/example/claude'}]});
 const send=h.openCard();
 await h.api.refresh();
 assert.deepEqual(JSON.parse(JSON.stringify(h.api.getState().setupTarget)),{provider:null});
 await send({type:'connect'});
 assert.equal(h.connected.length,1);
 assert.equal(h.connected[0].provider,'codex');
 assert.deepEqual(JSON.parse(JSON.stringify(h.lastPickItems.map(item=>item.provider))),['codex','antigravity']);
});

test('unknown sessions stop offering setup when all providers are connected',async()=>{
 const connections=['claude','codex','antigravity'].map(provider=>({provider,reportDir:`/example/${provider}`}));
 const h=harness({terminal:terminal(),connections});await h.api.refresh();
 assert.equal(h.api.getState().setupTarget,undefined);
 await h.openCard()({type:'connect'});
 assert.equal(h.connected.length,0);assert.equal(h.picks,0);
});

test('a detected connected provider waits for a fresh report without setup',async()=>{
 const h=harness({terminal:terminal(),detect:async()=>target('claude'),connections:[{provider:'claude',reportDir:'/example/reports'}]});
 await h.api.refresh();
 assert.equal(h.api.getState().setupTarget,undefined);
 assert.match(h.api.getState().reason,/connected.*fresh/i);
});

test('stale card actions and a terminal change during confirmation cannot connect a different session',async()=>{
 let detected=target('claude');
 const h=harness({terminal:terminal(),detect:async()=>detected});
 await h.api.refresh();detected=target('antigravity');
 await h.openCard()({type:'connect'});
 assert.equal(h.connected.length,0);assert.equal(h.confirmations.length,0);
 let active;
 active=harness({terminal:terminal(),detect:async()=>target('claude'),discover:async()=>{
  active.vscode.window.activeTerminal=terminal();return {profilePath:'/example/profile'};
 }});
 await active.api.refresh();await active.openCard()({type:'connect'});
 assert.equal(active.connected.length,0);
 let generic;
 generic=harness({terminal:terminal(),pickProvider:'codex',discover:async()=>{
  generic.vscode.window.activeTerminal=terminal();return {profilePath:'/example/profile'};
 }});
 await generic.api.refresh();await generic.openCard()({type:'connect'});
 assert.equal(generic.connected.length,0);
});
