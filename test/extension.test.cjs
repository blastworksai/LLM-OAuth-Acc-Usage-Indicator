'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

function harness({discover,connect,disconnect,recover='Recover connection',confirm='Connect',pickPath='/example/profile'}={}) {
  const commands=new Map(),connected=[],errors=[],warnings=[];
  const disposable=()=>({dispose(){}});
  const vscode={Uri:{file:value=>({fsPath:value})},workspace:{getConfiguration:()=>({get:()=>[]}),onDidChangeConfiguration:disposable},
    window:{registerWebviewViewProvider:disposable,onDidChangeActiveTerminal:disposable,onDidCloseTerminal:disposable,
      showQuickPick:async()=>({provider:'claude'}),showOpenDialog:async()=>pickPath?[{fsPath:pickPath}]:undefined,
      showInformationMessage:async(_message,options)=>options?.modal?confirm:undefined,
      showWarningMessage:async(message,action)=>{warnings.push(message);return action?.modal?recover:action;},
      showErrorMessage:async message=>{errors.push(message);}},
    commands:{registerCommand:(name,callback)=>{commands.set(name,callback);return disposable();},executeCommand:async()=>{}}};
  const setup={refreshRuntime:async()=>({warnings:[]}),listConnections:async()=>[],discoverProvider:discover||
    (async()=>({profilePath:'/example/profile',hasExistingStatusLine:true})),
    connectProvider:async options=>{connected.push(options);return connect?.(options);},
    disconnectProvider:async options=>{connected.push(options);return disconnect?.(options);}};
  const core={SelectionController:class{constructor(){this.state={status:'no-terminal'};}select(){return Promise.resolve();}dispose(){}},buildRows:()=>[]};
  const exports={};
  const sandbox={module:{exports},exports,process:{platform:'linux',execPath:'/example/editor-node'},setInterval:()=>1,clearInterval(){},
    require:name=>name==='vscode'?vscode:name==='./setup.cjs'?setup:name==='./core.cjs'?core:name==='./collect.cjs'?{}:
      name==='./panel.cjs'?{buildViewModel:()=>({}),renderContent:()=>'',renderDocument:()=>''}:require(name)};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/extension.cjs'),'utf8'),sandbox);
  sandbox.module.exports.activate({globalStorageUri:{fsPath:'/example/editor-storage'},extensionPath:'/example/extension',subscriptions:[]});
  return {commands,connected,errors,warnings};
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
