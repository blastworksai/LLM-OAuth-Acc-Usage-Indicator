'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {connectionIdentity,sameProcess}=require('../src/connection.cjs');

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
