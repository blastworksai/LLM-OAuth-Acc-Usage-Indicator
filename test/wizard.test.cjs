'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {initial,step,can,STEPS}=require('../src/wizard.cjs');

const PROCESS={pid:1954197,uid:1053,start_ticks:'77',boot_id:'boot'};
const TARGET={provider:'claude',uid:1053,user:'claudebwai',pid:1954197,process:PROCESS};
const FEED='/var/lib/llm-account-usage/feeds/v2-edac862ca9874d8cb3e72c43e39a693b';
const FOLDER={id:'folder',as:'root',label:`Shared feed folder ${FEED}`,path:FEED};
const STATUS={id:'status',as:'claudebwai',label:'Claude status line reports usage to the feed'};
const PREVIEW={profilePath:'/home/claudebwai/.claude',reportDir:FEED,changes:[FOLDER,STATUS],sharedDirectories:[],hasExistingStatusLine:true};
const SECRET='hunter2-never-anywhere';
const WRITE_EFFECTS=new Set(['apply','rollback']);

const freeze=value=>{if(value&&typeof value==='object'&&!Object.isFrozen(value)){Object.freeze(value);for(const v of Object.values(value))freeze(v);}return value;};
// Drives the machine with every state deep-frozen, so any mutation throws.
function drive(actions,s=initial(),seen=[]) {
  for(const a of actions){s=step(freeze(s),a);seen.push(s);}
  return s;
}
const refused=(before,after,type)=>after===before||after.log.at(-1)===`(Not possible right now: ${type})`&&
  JSON.stringify({...after,log:null})===JSON.stringify({...before,log:null});
const open=(runId='r1',extra={})=>({type:'open',runId,mode:'connect',target:TARGET,...extra});
// Session -> Review, as the host would drive it.
const toReview=(sudo='passwordless',runId='r1',preview=PREVIEW)=>[open(runId),{type:'sudoProbed',runId,sudo},{type:'continue'},{type:'discovered',runId,preview}];
const applyAll=(runId='r1')=>[{type:'applied',runId,change:{id:'folder',created:true}},{type:'applied',runId,change:{id:'status',as:'claudebwai'}}];
const nothingWrittenBeforeConnect=seen=>{
  const at=seen.findIndex(s=>['connecting','fallback','password'].includes(s.step));
  for(const s of at<0?seen:seen.slice(0,at)){
    assert.deepEqual(s.applied,[],`applied before connect at ${s.step}`);
    assert.ok(!WRITE_EFFECTS.has(s.pending?.effect),`write effect due before connect at ${s.step}`);
  }
};

test('module is pure: no require, clock, randomness or terminal focus',()=>{
  const source=fs.readFileSync(path.join(__dirname,'..','src','wizard.cjs'),'utf8').replace(/^\s*\/\/.*$/gm,'');
  for(const banned of [/\brequire\s*\(/,/\bDate\b/,/Math\.random/,/activeTerminal/,/\bprocess\.(?!pid|uid)/,/\bawait\b|\bPromise\b/])
    assert.doesNotMatch(source,banned);
  assert.deepEqual(Object.keys(require('../src/wizard.cjs')).sort(),['STEPS','can','initial','step']);
  assert.deepEqual([...STEPS],['idle','detecting','detected','review','password','fallback','connecting','verifying','undoing','connected','undone','cancelled']);
});

test('initial state has the documented shape and nothing in flight',()=>{
  assert.deepEqual(initial(),{mode:'connect',step:'idle',target:null,connection:null,sudo:'unknown',sudoReason:null,preview:null,
    applied:[],undone:[],kept:[],tries:0,error:null,warning:null,busy:false,runId:null,pending:null,log:[]});
  assert.notEqual(initial().applied,initial().applied);
});

// ---- The seven prototype scenarios (prototype lines 292-307) ----

test('scenario "This server": three clicks, no terminal, the Connect click is the consent',()=>{
  const seen=[], clicks=[];
  const actions=[...toReview(),{type:'connect'},...applyAll(),{type:'verified',runId:'r1'}];
  const s=drive(actions,initial(),seen);
  for(const a of actions)if(!('runId' in a)||a.type==='open')clicks.push(a.type);
  assert.deepEqual(clicks,['open','continue','connect']);
  assert.deepEqual(seen.map(x=>x.step),['detecting','detected','detecting','review','connecting','connecting','verifying','connected']);
  assert.deepEqual(seen[4].pending,{effect:'apply',changes:[FOLDER,STATUS]});
  assert.deepEqual(seen[5].pending,{effect:'apply',changes:[STATUS]});
  assert.deepEqual(seen[6].pending,{effect:'verify'});
  nothingWrittenBeforeConnect(seen);
  assert.equal(s.step,'connected'); assert.equal(s.busy,false); assert.equal(s.error,null);
  assert.deepEqual(s.pending,{effect:'cleanup'});
  assert.deepEqual(s.applied.map(c=>c.id),['folder','status']);
  assert.ok(s.log.includes('You pressed Connect: that is the consent. sudo needs no password here.'));
});

test('scenario "Password host": the VS Code box asks, one wrong try is counted, then it connects',()=>{
  const seen=[];
  let s=drive([...toReview('password'),{type:'connect'}],initial(),seen);
  assert.equal(s.step,'password'); assert.deepEqual(s.pending,{effect:'askPassword',attempt:1}); assert.equal(s.busy,true);
  s=drive([{type:'wrongPassword',runId:'r1'}],s,seen);
  assert.equal(s.step,'password'); assert.equal(s.tries,1); assert.equal(s.error,'sudo refused the password (1 of 3).');
  assert.deepEqual(s.pending,{effect:'askPassword',attempt:2});
  s=drive([{type:'password',runId:'r1',password:SECRET}],s,seen);
  assert.equal(s.step,'connecting'); assert.equal(s.error,null);
  s=drive([...applyAll(),{type:'verified',runId:'r1'}],s,seen);
  assert.equal(s.step,'connected');
  nothingWrittenBeforeConnect(seen);
  for(const x of seen)assert.ok(!JSON.stringify(x).includes(SECRET),'the password reached state');
});

test('scenario "No sudo": one line to run as the target, the wizard writes nothing itself and finishes on its own',()=>{
  const seen=[];
  const noFolder={...PREVIEW,changes:[STATUS]};
  const s=drive([...toReview('none','r1',noFolder),{type:'connect'},
    {type:'fallbackResult',runId:'r1',ok:true,change:{id:'status',as:'claudebwai'}},{type:'verified',runId:'r1'}],initial(),seen);
  assert.deepEqual(seen.map(x=>x.step),['detecting','detected','detecting','review','fallback','verifying','connected']);
  assert.deepEqual(seen[4].pending,{effect:'fallback'});
  assert.ok(seen.every(x=>x.pending?.effect!=='apply'),'no sudo road may issue apply');
  assert.ok(seen[5].log.at(-1).includes('Consent came from your Connect click, so it asked nothing.'));
  nothingWrittenBeforeConnect(seen);
  assert.equal(s.step,'connected'); assert.deepEqual(s.applied,[{id:'status',as:'claudebwai'}]);
});

test('scenario "Feed unreadable": the target is never touched and the folder this run made is removed (finding 4)',()=>{
  let s=drive([...toReview(),{type:'connect'},{type:'applied',runId:'r1',change:{id:'folder',created:true,path:FEED}},
    {type:'failed',runId:'r1',error:'VS Code could not read the feed folder.'}]);
  assert.equal(s.step,'undoing'); assert.equal(s.busy,true);
  assert.deepEqual(s.pending,{effect:'rollback',undo:[{id:'folder',created:true,path:FEED}],keep:[]});
  assert.ok(!s.applied.some(c=>c.id==='status'),'the status line must not be applied');
  s=drive([{type:'rolledBack',runId:'r1',undone:['folder'],kept:[]}],s);
  assert.equal(s.step,'undone'); assert.equal(s.busy,false);
  assert.equal(s.error,'VS Code could not read the feed folder.');
  assert.deepEqual(s.undone,[{id:'folder',created:true,path:FEED}]); assert.deepEqual(s.kept,[]);
});

test('scenario "Click away mid-way": focus changes are not actions and the run stays on its process (finding 6)',()=>{
  const before=drive([...toReview()]);
  let s=before;
  for(const type of ['focusOther','focusClaude','focus','activeTerminal','world']){
    const next=step(freeze(s),{type,terminal:'bash',patch:{sessionAlive:false}});
    assert.ok(refused(s,next,type),type); s=next;
  }
  assert.deepEqual(s.target,TARGET); assert.equal(s.step,'review');
  s=drive([{type:'connect'},...applyAll(),{type:'verified',runId:'r1'}],s);
  assert.equal(s.step,'connected'); assert.deepEqual(s.target.process,PROCESS);
});

test('scenario "Cancel, then retry": nothing written, Connect is free again at once, the old run is ignored',()=>{
  const seen=[];
  let s=drive([...toReview(),{type:'cancel'}],initial(),seen);
  assert.equal(s.step,'cancelled'); assert.equal(s.busy,false); assert.equal(s.error,null); assert.deepEqual(s.applied,[]);
  nothingWrittenBeforeConnect(seen);
  assert.equal(can.open(s),true);
  s=drive([open('r2')],s);
  assert.equal(s.step,'detecting'); assert.equal(s.runId,'r2'); assert.equal(s.busy,true);
  for(const late of [{type:'discovered',runId:'r1',preview:PREVIEW},{type:'applied',runId:'r1',change:{id:'status'}},{type:'cleanedUp',runId:'r1',warning:'x'}])
    assert.equal(step(freeze(s),late),s,late.type);
});

test('scenario "Session quits": the wizard closes before Connect, and the Connect press that follows is refused',()=>{
  const seen=[];
  let s=drive([...toReview(),{type:'sessionEnded',runId:'r1'}],initial(),seen);
  assert.equal(s.step,'cancelled'); assert.equal(s.busy,false);
  assert.equal(s.error,'The Claude session ended. Nothing was changed.');
  const next=step(freeze(s),{type:'connect'});
  assert.ok(refused(s,next,'connect')); assert.equal(next.step,'cancelled');
  nothingWrittenBeforeConnect(seen);
});

// ---- Plan rules, Task 1.1 ----

test('rule: nothing is written before connect, and cancel before connect ends clean at every step',()=>{
  const paths={
    detectingProbe:[open()],detected:[open(),{type:'sudoProbed',runId:'r1',sudo:'passwordless'}],
    detectingDiscover:[open(),{type:'sudoProbed',runId:'r1',sudo:'passwordless'},{type:'continue'}],review:toReview(),
    password:[...toReview('password'),{type:'connect'}],fallback:[...toReview('none'),{type:'connect'}],
  };
  for(const [label,actions] of Object.entries(paths)){
    const seen=[]; const s=drive([...actions,{type:'cancel'}],initial(),seen);
    nothingWrittenBeforeConnect(seen);
    assert.equal(s.step,'cancelled',label); assert.deepEqual(s.applied,[],label); assert.equal(s.busy,false,label);
    assert.deepEqual(s.pending,{effect:'cleanup'},label);
  }
});

test('rule: three wrong passwords cancel with nothing changed',()=>{
  let s=drive([...toReview('password'),{type:'connect'}]);
  for(const n of [1,2]){
    s=drive([{type:'wrongPassword',runId:'r1'}],s);
    assert.equal(s.step,'password'); assert.equal(s.error,`sudo refused the password (${n} of 3).`);
  }
  s=drive([{type:'wrongPassword',runId:'r1'}],s);
  assert.equal(s.step,'cancelled'); assert.equal(s.tries,3); assert.equal(s.busy,false);
  assert.equal(s.error,'Three wrong passwords. Nothing was changed.'); assert.deepEqual(s.applied,[]);
  assert.ok(refused(s,step(freeze(s),{type:'password',runId:'r1'}),'password'));
});

test('rule: rollback undoes in reverse order and removes the folder only if this run created it',()=>{
  const created=drive([...toReview(),{type:'connect'},...applyAll(),{type:'failed',runId:'r1',error:'Descriptor did not match.'}]);
  assert.equal(created.step,'undoing');
  assert.deepEqual(created.pending.undo.map(c=>c.id),['status','folder']); assert.deepEqual(created.pending.keep,[]);
  const existing=drive([...toReview('passwordless','r1',{...PREVIEW,changes:[STATUS]}),{type:'connect'},
    {type:'applied',runId:'r1',change:{id:'folder',created:false,path:FEED}},{type:'applied',runId:'r1',change:{id:'status'}},
    {type:'failed',runId:'r1',error:'Descriptor did not match.'}]);
  assert.equal(existing.step,'undoing');
  assert.deepEqual(existing.pending.undo.map(c=>c.id),['status']);
  assert.deepEqual(existing.pending.keep,[{id:'folder',created:false,path:FEED}]);
  const done=drive([{type:'rolledBack',runId:'r1'}],existing);
  assert.equal(done.step,'undone'); assert.deepEqual(done.undone.map(c=>c.id),['status']); assert.deepEqual(done.kept.map(c=>c.id),['folder']);
  // A folder with no created flag is treated as pre-existing: root never removes what it cannot prove it made.
  const unflagged=drive([...toReview(),{type:'connect'},{type:'applied',runId:'r1',change:{id:'folder'}},{type:'failed',runId:'r1',error:'x'}]);
  assert.deepEqual(unflagged.pending,{effect:'rollback',undo:[],keep:[{id:'folder'}]});
});

test('rule: the host report of the rollback is what the done screen shows, warnings included',()=>{
  const s=drive([...toReview(),{type:'connect'},...applyAll(),{type:'failed',runId:'r1',error:'x'},
    {type:'rolledBack',runId:'r1',undone:['status'],kept:[{id:'folder',path:FEED,reason:'rmdir: not empty'}],warning:'The feed folder was not empty, so it was kept.'}]);
  assert.deepEqual(s.undone,[{id:'status',as:'claudebwai'}]);
  assert.deepEqual(s.kept,[{id:'folder',path:FEED,reason:'rmdir: not empty'}]);
  assert.equal(s.warning,'The feed folder was not empty, so it was kept.');
  const broken=drive([...toReview(),{type:'connect'},...applyAll(),{type:'failed',runId:'r1',error:'x'},{type:'failed',runId:'r1',error:'sudo timed out.'}]);
  assert.equal(broken.step,'undone'); assert.deepEqual(broken.undone,[]);
  assert.deepEqual(broken.kept.map(c=>c.id),['status','folder']); assert.equal(broken.warning,'sudo timed out.');
});

test('rule: a change the host finishes after the run stopped joins the rollback',()=>{
  let s=drive([...toReview(),{type:'connect'},{type:'cancel'}]);
  assert.equal(s.step,'undoing'); assert.deepEqual(s.pending,{effect:'rollback',undo:[],keep:[]});
  s=drive([{type:'applied',runId:'r1',change:{id:'folder',created:true}}],s);
  assert.deepEqual(s.pending.undo,[{id:'folder',created:true}]);
  s=drive([{type:'applied',runId:'r1',change:{id:'status'}}],s);
  assert.deepEqual(s.pending.undo.map(c=>c.id),['status','folder']);
  assert.equal(s.error,'You cancelled.');
});

test('rule: sessionEnded cancels before connect and rolls back once connecting',()=>{
  // The last pre-write step on each road: review (passwordless), the password box, the fallback line.
  for(const [sudo,connect] of [['passwordless',[]],['password',[{type:'connect'}]],['none',[{type:'connect'}]]]){
    const seen=[]; const s=drive([...toReview(sudo),...connect,{type:'sessionEnded',runId:'r1'}],initial(),seen);
    assert.equal(s.step,'cancelled',sudo); assert.equal(s.error,'The Claude session ended. Nothing was changed.');
    nothingWrittenBeforeConnect(seen);
  }
  const mid=drive([...toReview(),{type:'connect'},{type:'applied',runId:'r1',change:{id:'folder',created:true}},{type:'sessionEnded',runId:'r1'}]);
  assert.equal(mid.step,'undoing'); assert.equal(mid.error,'The Claude session ended during setup.');
  assert.deepEqual(mid.pending.undo.map(c=>c.id),['folder']);
  const codex=drive([open('r1',{target:{...TARGET,provider:'codex'}}),{type:'sessionEnded',runId:'r1'}]);
  assert.equal(codex.error,'The Codex session ended. Nothing was changed.');
});

test('rule: busy runs from open to a terminal step, and open is refused while busy (finding 1)',()=>{
  const seen=[];
  drive([...toReview(),{type:'connect'},...applyAll(),{type:'verified',runId:'r1'}],initial(),seen);
  drive([...toReview(),{type:'connect'},{type:'failed',runId:'r1',error:'x'},{type:'rolledBack',runId:'r1'}],initial(),seen);
  drive([...toReview('password'),{type:'connect'},{type:'wrongPassword',runId:'r1'},{type:'cancel'}],initial(),seen);
  for(const s of seen){
    const terminal=['connected','undone','cancelled'].includes(s.step);
    assert.equal(s.busy,!terminal,s.step);
    assert.equal(can.open(s),terminal,s.step);
    if(!terminal){const next=step(freeze(s),open('r9'));assert.ok(refused(s,next,'open'),s.step);assert.equal(next.runId,'r1');}
  }
});

test('rule: a cleanup warning is state on the done screen and never holds the lock (finding 1)',()=>{
  let s=drive([...toReview(),{type:'connect'},...applyAll(),{type:'verified',runId:'r1'}]);
  assert.equal(s.busy,false); assert.deepEqual(s.pending,{effect:'cleanup'});
  s=drive([{type:'cleanedUp',runId:'r1',warning:'The setup bundle could not be removed: /var/lib/llm-account-usage/bundles/x.'}],s);
  assert.equal(s.pending,null); assert.match(s.warning,/bundle could not be removed/); assert.equal(s.step,'connected');
  // A second open is allowed before cleanup reports, and the old run's late cleanup report is ignored.
  const early=drive([...toReview(),{type:'connect'},...applyAll(),{type:'verified',runId:'r1'},open('r2')]);
  assert.equal(early.step,'detecting'); assert.equal(early.warning,null);
  assert.equal(step(freeze(early),{type:'cleanedUp',runId:'r1',warning:'late'}),early);
});

test('rule: each open needs a fresh runId, and results carrying a stale or missing runId are ignored',()=>{
  const s=drive([...toReview()]);
  const done=drive([{type:'cancel'}],s);
  for(const runId of [undefined,'',42,'r1'])assert.ok(refused(done,step(freeze(done),{...open(),runId}),'open'),String(runId));
  for(const a of [{type:'discovered',preview:PREVIEW},{type:'sudoProbed',runId:'r0',sudo:'none'},{type:'password',runId:'other'},
    {type:'failed',runId:'r2',error:'x'},{type:'sessionEnded',runId:null}])
    assert.equal(step(freeze(s),a),s,a.type);
  assert.equal(step(freeze(s),null),s); assert.equal(step(freeze(s),{}),s);
});

test('rule: the password is never copied into state, whatever action carries it',()=>{
  const seen=[];
  const leak={password:SECRET,secret:SECRET};
  drive([{...open(),...leak},{type:'sudoProbed',runId:'r1',sudo:'password',...leak},{type:'continue',...leak},
    {type:'discovered',runId:'r1',preview:PREVIEW,...leak},{type:'connect',...leak},{type:'wrongPassword',runId:'r1',...leak},
    {type:'password',runId:'r1',...leak},{type:'applied',runId:'r1',change:{id:'folder',created:true},...leak},
    {type:'failed',runId:'r1',error:'x',...leak},{type:'rolledBack',runId:'r1',...leak},{type:'cleanedUp',runId:'r1',...leak}],initial(),seen);
  assert.equal(seen.at(-1).step,'undone');
  for(const s of seen)assert.ok(!JSON.stringify(s).includes(SECRET),s.step);
});

test('rule: an unreadable preview cancels before anything is written',()=>{
  for(const preview of [null,{},{changes:'x'},{changes:[{id:''}]},{changes:[STATUS,STATUS]}]){
    const seen=[]; const s=drive(toReview('passwordless','r1',preview),initial(),seen);
    assert.equal(s.step,'cancelled'); assert.equal(s.error,'The setup preview could not be read. Nothing was changed.');
    nothingWrittenBeforeConnect(seen);
  }
});

test('rule: a probe during discover can switch the run to the no-sudo road with its reason',()=>{
  const s=drive([open(),{type:'sudoProbed',runId:'r1',sudo:'passwordless'},{type:'continue'},
    {type:'sudoProbed',runId:'r1',sudo:'none',reason:'node is not on sudo secure_path for claudebwai.'},
    {type:'discovered',runId:'r1',preview:{...PREVIEW,changes:[STATUS]}},{type:'connect'}]);
  assert.equal(s.step,'fallback'); assert.equal(s.sudoReason,'node is not on sudo secure_path for claudebwai.');
  assert.ok(refused(s,step(freeze(s),{type:'sudoProbed',runId:'r1',sudo:'root'}),'sudoProbed'));
});

test('rule: an open without a target waits for the host to detect it',()=>{
  let s=drive([{type:'open',runId:'r1'}]);
  assert.equal(s.step,'detecting'); assert.deepEqual(s.pending,{effect:'detect'}); assert.equal(s.target,null);
  assert.ok(refused(s,step(freeze(s),{type:'detected',runId:'r1',target:{provider:'claude'}}),'detected'));
  s=drive([{type:'detected',runId:'r1',target:TARGET}],s);
  assert.deepEqual(s.pending,{effect:'probe'}); assert.deepEqual(s.target,TARGET);
});

test('no-sudo road: a failed check cannot roll back, so everything is listed as kept to undo by hand',()=>{
  const s=drive([...toReview('none','r1',{...PREVIEW,changes:[STATUS]}),{type:'connect'},
    {type:'fallbackResult',runId:'r1',ok:true},{type:'failed',runId:'r1',error:'VS Code could not read the connection descriptor.'}]);
  assert.equal(s.step,'undone'); assert.equal(s.busy,false); assert.deepEqual(s.undone,[]);
  assert.deepEqual(s.kept,[{id:'status',as:'claudebwai'}]);
  assert.ok(!['undoing'].includes(s.step)&&s.pending.effect==='cleanup');
  const bad=drive([...toReview('none'),{type:'connect'},{type:'fallbackResult',runId:'r1',ok:false,error:'setup-cli refused the profile.'}]);
  assert.equal(bad.step,'undone'); assert.equal(bad.error,'setup-cli refused the profile.'); assert.deepEqual(bad.kept,[]);
});

test('disconnect mode: same road, no rollback, and a mid-run cancel is refused',()=>{
  const connection={id:'v2-edac862ca9874d8cb3e72c43e39a693b',reportDir:FEED};
  const changes=[{id:'status',as:'claudebwai',label:'Status line restored'},{id:'folder',as:'root',label:'Shared folder removed',path:FEED}];
  const actions=[{type:'open',runId:'d1',mode:'disconnect',target:TARGET,connection},{type:'sudoProbed',runId:'d1',sudo:'passwordless'},
    {type:'continue'},{type:'discovered',runId:'d1',preview:{...PREVIEW,changes}},{type:'connect'}];
  let s=drive(actions);
  assert.equal(s.mode,'disconnect'); assert.deepEqual(s.connection,connection); assert.equal(s.step,'connecting');
  assert.equal(can.cancel(s),false);
  s=drive([{type:'applied',runId:'d1',change:{id:'status'}},{type:'sessionEnded',runId:'d1'}],s);
  assert.equal(s.step,'connecting'); assert.deepEqual(s.pending,{effect:'apply',changes:[changes[1]]});
  const ok=drive([{type:'applied',runId:'d1',change:{id:'folder'}},{type:'verified',runId:'d1'}],s);
  assert.equal(ok.step,'connected'); assert.equal(ok.log.at(-1),'Disconnected and checked.');
  const failed=drive([{type:'failed',runId:'d1',error:'rmdir refused: the folder is not empty.'}],s);
  assert.equal(failed.step,'undone'); assert.deepEqual(failed.undone,[]); assert.deepEqual(failed.kept,[changes[1]]);
  assert.equal(drive([{type:'retry',runId:'d2'}],failed).mode,'disconnect');
});

// ---- Status x operation grid (TESTING STRATEGY) ----

const REACH={
  idle:[],
  'detecting:probe':[open()],
  'detecting:discover':[open(),{type:'sudoProbed',runId:'r1',sudo:'passwordless'},{type:'continue'}],
  detected:[open(),{type:'sudoProbed',runId:'r1',sudo:'passwordless'}],
  review:toReview(),
  password:[...toReview('password'),{type:'connect'}],
  fallback:[...toReview('none'),{type:'connect'}],
  connecting:[...toReview(),{type:'connect'}],
  verifying:[...toReview(),{type:'connect'},...applyAll()],
  undoing:[...toReview(),{type:'connect'},{type:'cancel'}],
  connected:[...toReview(),{type:'connect'},...applyAll(),{type:'verified',runId:'r1'}],
  undone:[...toReview(),{type:'connect'},{type:'cancel'},{type:'rolledBack',runId:'r1'}],
  cancelled:[...toReview(),{type:'cancel'}],
};
const ACTIONS={
  open:()=>open('fresh'),retry:()=>({type:'retry',runId:'fresh'}),continue:()=>({type:'continue'}),connect:()=>({type:'connect'}),
  cancel:()=>({type:'cancel'}),detected:()=>({type:'detected',runId:'r1',target:TARGET}),sudoProbed:()=>({type:'sudoProbed',runId:'r1',sudo:'password'}),
  discovered:()=>({type:'discovered',runId:'r1',preview:PREVIEW}),password:()=>({type:'password',runId:'r1'}),
  wrongPassword:()=>({type:'wrongPassword',runId:'r1'}),applied:()=>({type:'applied',runId:'r1',change:{id:'late',created:true}}),
  verified:()=>({type:'verified',runId:'r1'}),failed:()=>({type:'failed',runId:'r1',error:'x'}),rolledBack:()=>({type:'rolledBack',runId:'r1'}),
  sessionEnded:()=>({type:'sessionEnded',runId:'r1'}),fallbackResult:()=>({type:'fallbackResult',runId:'r1',ok:true}),
  cleanedUp:()=>({type:'cleanedUp',runId:'r1'}),
};
const ACCEPTS={
  idle:['open'],
  'detecting:probe':['cancel','sudoProbed','failed','sessionEnded'],
  'detecting:discover':['cancel','sudoProbed','discovered','failed','sessionEnded'],
  detected:['continue','cancel','sessionEnded'],
  review:['connect','cancel','sessionEnded'],
  password:['password','wrongPassword','cancel','failed','sessionEnded'],
  fallback:['fallbackResult','cancel','failed','sessionEnded'],
  connecting:['applied','cancel','failed','sessionEnded'],
  verifying:['verified','cancel','failed','sessionEnded'],
  undoing:['applied','failed','rolledBack'],
  connected:['open','cleanedUp'],
  undone:['open','retry','cleanedUp'],
  cancelled:['open','retry','cleanedUp'],
};

test('grid: every step x every action is accepted exactly where the machine says',()=>{
  for(const [label,path] of Object.entries(REACH)){
    const s=drive(path);
    assert.equal(s.step,label.split(':')[0],label);
    for(const [type,make] of Object.entries(ACTIONS)){
      const next=step(freeze(s),make());
      assert.equal(!refused(s,next,type),ACCEPTS[label].includes(type),`${label} x ${type}`);
      assert.equal(can[type](s,make()),ACCEPTS[label].includes(type),`can.${type} at ${label}`);
    }
  }
  assert.deepEqual(new Set(Object.keys(REACH).map(k=>k.split(':')[0])),new Set(STEPS));
  assert.deepEqual(Object.keys(ACTIONS).sort(),Object.keys(can).sort());
});

test('grid: connect while connected is refused; open is required',()=>{
  const s=drive(REACH.connected);
  const next=step(freeze(s),{type:'connect'});
  assert.ok(refused(s,next,'connect')); assert.equal(next.step,'connected');
  assert.equal(drive([open('r2')],s).step,'detecting');
});

test('grid: cancel during connecting rolls back, it is not a plain cancel',()=>{
  const s=drive([...REACH.connecting,{type:'applied',runId:'r1',change:{id:'folder',created:true}},{type:'cancel'}]);
  assert.equal(s.step,'undoing'); assert.equal(s.busy,true); assert.equal(s.error,'You cancelled.');
  assert.deepEqual(s.pending.undo.map(c=>c.id),['folder']);
  const verifying=drive([...REACH.verifying,{type:'cancel'}]);
  assert.deepEqual(verifying.pending.undo.map(c=>c.id),['status','folder']);
});

test('grid: retry from undone starts a fresh run and ignores the old one',()=>{
  const s=drive(REACH.undone);
  const retried=drive([{type:'retry',runId:'r2'}],s);
  assert.equal(retried.step,'detecting'); assert.equal(retried.runId,'r2'); assert.deepEqual(retried.target,TARGET);
  assert.deepEqual(retried.applied,[]); assert.deepEqual(retried.undone,[]); assert.equal(retried.error,null); assert.equal(retried.busy,true);
  for(const late of [{type:'rolledBack',runId:'r1'},{type:'verified',runId:'r1'},{type:'sudoProbed',runId:'r1',sudo:'none'}])
    assert.equal(step(freeze(retried),late),retried,late.type);
  assert.ok(refused(s,step(freeze(s),{type:'retry',runId:'r1'}),'retry'),'retry reusing the old runId');
  assert.ok(refused(initial(),step(initial(),{type:'retry',runId:'r2'}),'retry'),'retry with no target');
});

test('grid: sessionEnded during verifying rolls back',()=>{
  const s=drive([...REACH.verifying,{type:'sessionEnded',runId:'r1'}]);
  assert.equal(s.step,'undoing'); assert.equal(s.error,'The Claude session ended during setup.');
  assert.deepEqual(s.pending.undo.map(c=>c.id),['status','folder']);
});

test('grid: open while busy is refused and starts no second run (finding 1)',()=>{
  for(const label of ['detecting:probe','detected','review','password','fallback','connecting','verifying','undoing']){
    const s=drive(REACH[label]);
    const next=step(freeze(s),open('r2'));
    assert.ok(refused(s,next,'open'),label); assert.equal(next.runId,'r1',label);
  }
});

test('grid: an unknown or inherited action name is refused, never dispatched',()=>{
  const s=drive(REACH.review);
  for(const type of ['constructor','toString','__proto__','hasOwnProperty','ranFallback','endSession'])
    assert.ok(refused(s,step(freeze(s),{type}),type),type);
});
