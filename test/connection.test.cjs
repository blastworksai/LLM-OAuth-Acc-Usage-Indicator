'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {connectionIdentity,sameProcess,connectionForTarget,runtimeVersion}=require('../src/connection.cjs');

test('public runtime versions accept SemVer and reject leading-zero numeric prereleases',()=>{
  for(const value of ['0.4.0','1.0.0-rc.1','1.0.0+build.001','1.0.0-0'])assert.equal(runtimeVersion(value),true,value);
  for(const value of ['1.0.0-01','01.0.0','1.0.0-rc.01','1.0.0\n','v1.0.0','1.0','1'.repeat(129)] )assert.equal(runtimeVersion(value),false,value);
});

test('connection identity is stable per provider UID and canonical settings path',()=>{
  const base={provider:'claude',uid:1000,settingsPath:'/home/a/.claude/settings.json'};
  const first=connectionIdentity(base);
  assert.match(first.id,/^v2-[a-f0-9]{32}$/);
  assert.deepEqual(connectionIdentity({...base}),first);
  assert.deepEqual(connectionIdentity({...base,settingsPath:'/home/a/.claude/../.claude/settings.json'}),first);
  assert.notEqual(connectionIdentity({...base,uid:1001}).id,first.id);
  assert.notEqual(connectionIdentity({...base,settingsPath:'/home/a/second/settings.json'}).id,first.id);
  assert.notEqual(connectionIdentity({...base,provider:'antigravity'}).id,first.id);
  for(const change of [{provider:'unknown'},{uid:-1},{uid:1.5},{settingsPath:'relative'}])
    assert.throws(()=>connectionIdentity({...base,...change}),TypeError);
});

test('process equality includes Linux owner and birth identity',()=>{
  const process={pid:20,uid:1000,start_ticks:'20',boot_id:'boot'};
  assert.equal(sameProcess(process,{...process}),true);
  for(const change of [{pid:21},{uid:1001},{start_ticks:'21'},{boot_id:'other'}])
    assert.equal(sameProcess(process,{...process,...change}),false);
  assert.equal(sameProcess(process,null),false);
});

test('connectionForTarget never treats provider equality as profile equality',()=>{
  const first={id:'first',provider:'claude',uid:1000,pendingProcess:{pid:20,uid:1000,start_ticks:'20',boot_id:'boot'}};
  const second={id:'second',provider:'claude',uid:2000,pendingProcess:{pid:30,uid:2000,start_ticks:'30',boot_id:'boot'}};
  assert.equal(connectionForTarget([first,second],{provider:'claude',process:{...second.pendingProcess}}).id,'second');
  assert.equal(connectionForTarget([first,second],{provider:'claude',process:{...second.pendingProcess,pid:31}}),null);
  assert.equal(connectionForTarget([first],{provider:'codex',process:{...first.pendingProcess}}),null);
});

test('connectionForTarget requires one exact pending owner and process birth identity',()=>{
  const connection={id:'first',provider:'claude',uid:1000,pendingProcess:{pid:20,uid:1000,start_ticks:'20',boot_id:'boot'}};
  const target={provider:'claude',process:{...connection.pendingProcess}};
  for(const change of [{pid:21},{uid:1001},{start_ticks:'21'},{boot_id:'other'}])
    assert.equal(connectionForTarget([connection],{...target,process:{...target.process,...change}}),null);
  assert.equal(connectionForTarget([{...connection,uid:2000}],target),null);
  assert.equal(connectionForTarget([{...connection,pendingProcess:undefined}],target),null);
  assert.equal(connectionForTarget([connection,{...connection,id:'second'}],target),null);
  assert.equal(connectionForTarget([null,connection],target),connection);
  assert.equal(connectionForTarget([],target),null);
  assert.equal(connectionForTarget(null,target),null);
  assert.equal(connectionForTarget([connection],null),null);
  assert.equal(connectionForTarget([connection],{provider:'claude'}),null);
});
test('a target-verified pending connection binds unresolved host detection only for its exact unique process',()=>{
  const connection={id:'first',provider:'claude',uid:2000,pendingProcess:{pid:30,uid:2000,start_ticks:'30',boot_id:'boot'}};
  const target={provider:null,process:{...connection.pendingProcess}};
  assert.equal(connectionForTarget([null,connection],target),connection);
  assert.equal(connectionForTarget([connection,{...connection,id:'second',provider:'codex'}],target),null);
  assert.equal(connectionForTarget([connection],{...target,process:{...target.process,start_ticks:'31'}}),null);
  assert.equal(connectionForTarget([{...connection,pendingProcess:undefined}],target),null);
});
