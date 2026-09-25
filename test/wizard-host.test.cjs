'use strict';
// Task 2.1 VALIDATE: the connect wizard host, driven through fakes only. No real sudo, no real filesystem writes.
// The fake elevate records every argv plus its options; the real shared-feed argv builders are used, with inspectFeed
// and precheckReadable stubbed onto a small in-memory "world" (does the feed folder exist, can VS Code read it).
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const realFeed=require('../src/shared-feed.cjs');
const {createWizardHost}=require('../src/wizard-host.cjs');
const {connectionIdentity}=require('../src/connection.cjs');
const {MANIFEST}=require('../src/handoff.cjs');

const PID=4242,UID=1053,USER='claudebwai',GID=1001,SELF_UID=1001,SELF='glitch';
const PROC={pid:PID,uid:UID,start_ticks:'77',boot_id:'boot-1'};
const PROFILE='/home/claudebwai/.claude',SETTINGS=`${PROFILE}/settings.json`;
const ID=connectionIdentity({provider:'claude',uid:UID,settingsPath:SETTINGS}).id;
const FEED=realFeed.feedPath(ID);
const EXT='/opt/ext/llm-oauth-acc-usage-indicator';
const VERSION='0.4.0',NODE='/usr/bin/node';
const SECRET='hunter2-GOOD-never-anywhere',WRONG='wrong-pw-never-anywhere';
const OPEN={type:'open',mode:'connect',target:{provider:'claude',process:{...PROC}},terminalPid:PID};
const CONNECTION={id:ID,provider:'claude',uid:UID,profilePath:PROFILE,reportDir:FEED};
const OPEN_DISCONNECT={type:'open',mode:'disconnect',target:{provider:'claude',process:{...PROC}},terminalPid:PID,connection:CONNECTION};
const descriptor=(extra={})=>({id:ID,provider:'claude',uid:UID,profilePath:PROFILE,settingsPath:SETTINGS,connected:true,
  cliLookupPath:'/usr/bin/claude',reportDir:FEED,launcherPath:`${PROFILE}/llm-account-usage/statusline.cjs`,
  backupPath:`${PROFILE}/llm-account-usage/backup.json`,runtimeVersion:VERSION,...extra});
const PREVIEW_OUT={id:ID,provider:'claude',profilePath:PROFILE,settingsPath:SETTINGS,reportDir:`${PROFILE}/llm-account-usage/reports`,
  hasExistingStatusLine:true,hasExistingHooks:false,sharedDirectories:[]};
const json=value=>({code:0,stdout:`${JSON.stringify(value)}\n`,stderr:''});
const OK={code:0,stdout:'',stderr:''};
const GENERIC_ERROR='Setup stopped on an unexpected error.';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
// Waits for an in-flight effect to reach a fake; bounded, so a regression fails the test instead of spinning forever.
async function until(condition,what) {
  for(let i=0;i<1000;i++){if(condition())return;await new Promise(resolve=>setImmediate(resolve));}
  assert.fail(`never reached: ${what}`);
}

// Names every argv the host can hand to elevate.run; anything else is 'unknown' and fails the root sweep.
function classify(argv) {
  const [bin,a1,a2,a3]=argv;
  if(bin==='/usr/bin/install'&&a1==='-d'&&argv.includes(realFeed.ROOT))return 'roots';
  if(bin==='/usr/bin/install'&&a1==='-d'&&a3==='2750')return 'createFeed';
  if(bin==='/usr/bin/install'&&a1==='-d'&&argv.at(-1).startsWith(realFeed.BUNDLES+'/'))return 'bundleDir';
  if(bin==='/usr/bin/install'&&a1==='-m')return 'bundleFile';
  if(bin==='/bin/sh'&&a1==='-c'&&a2==='command -v node')return 'node';
  if(bin===NODE&&typeof a1==='string'&&a1.endsWith('/src/setup-cli.cjs')&&['discover','connect','disconnect'].includes(a2))return a2;
  if(bin==='/usr/bin/mkdir')return 'claimFeed';
  if(bin==='/usr/bin/rmdir')return 'rmdir';
  if(bin==='/usr/bin/rm')return 'rmBundle';
  return 'unknown';
}
const STAGE=['run:roots','run:bundleDir',...MANIFEST.map(()=>'run:bundleFile')];

function harness({world:w={},on={},probe,checkPassword,answers=[],detect,deps={},onConnected}={}) {
  const world={feedExists:false,feedUid:UID,feedGid:GID,feedMode:0o2750,readable:true,descriptorReadable:true,feedsRejected:false,
    liveProcess:{...PROC},sudo:'passwordless',...w};
  const events=[],calls=[],states=[],connected=[],disconnected=[],asked=[],checked=[],detects=[];
  const handlers={
    roots:()=>OK,bundleDir:()=>OK,bundleFile:()=>OK,
    node:()=>({code:0,stdout:`${NODE}\n`,stderr:''}),
    discover:()=>json({ok:true,preview:PREVIEW_OUT}),
    // mkdir is atomic: it fails when the folder is already there (another run made it first).
    claimFeed:()=>{if(world.feedExists)return {code:1,stdout:'',stderr:'File exists'};world.feedExists=true;return OK;},
    createFeed:()=>{world.feedExists=true;return OK;},
    connect:()=>json({ok:true,connection:descriptor()}),
    disconnect:()=>json({ok:true,connection:descriptor({connected:false}),feed:{removed:true}}),
    rmdir:()=>{world.feedExists=false;return OK;},
    rmBundle:()=>OK,
    unknown:()=>({code:1,stdout:'',stderr:''}),
    ...on,
  };
  let n=0,lastStep=null;
  const elevate={
    probe:async()=>{events.push('probe');return probe?probe():world.sudo;},
    checkPassword:async secret=>{events.push('checkPassword');checked.push(secret);return checkPassword?checkPassword(secret):false;},
    run:async(argv,options={})=>{
      const kind=classify(argv);
      events.push(`run:${kind}`);calls.push({kind,argv:[...argv],options:{...options}});
      return handlers[kind](argv,options,calls.length-1);
    },
  };
  const sharedFeed={...realFeed,
    inspectFeed:async target=>{events.push('inspect');return target!==FEED||!world.feedExists?{exists:false}:
      {exists:true,directory:true,uid:world.feedUid,gid:world.feedGid,mode:world.feedMode};},
    precheckReadable:async target=>{events.push('precheck');return target===FEED&&world.readable;},
  };
  const host=createWizardHost({
    elevate,sharedFeed,
    detectProvider:async(pid,options)=>{events.push('detectProvider');detects.push({pid,options});
      return detect?detect(pid,options):{provider:'claude',process:{...world.liveProcess},cliPath:null};},
    readFeeds:async dirs=>{events.push('readFeeds');return {reports:[],rejected:world.feedsRejected&&dirs[0]===FEED?1:0};},
    readConnectionFeeds:async dirs=>{events.push('readConnectionFeeds');
      return world.descriptorReadable&&dirs[0]===FEED?{connections:[descriptor()],rejected:0}:{connections:[],rejected:1};},
    resolveUser:async uid=>{events.push('resolveUser');if(uid===UID)return USER;if(uid===SELF_UID)return SELF;
      throw Object.assign(new Error('no passwd entry'),{code:'USER_NOT_FOUND'});},
    askPassword:async({attempt,tries,prompt,error,signal})=>{events.push('askPassword');asked.push({attempt,tries,prompt,error,signal});
      const next=answers.shift();return typeof next==='function'?next():next;},
    extensionPath:EXT,runtimeVersion:VERSION,getgid:()=>GID,getuid:()=>SELF_UID,
    uuid:()=>`00000000-0000-4000-8000-${String(++n).padStart(12,'0')}`,
    fs:{lstat:async()=>({isSymbolicLink:()=>false,isFile:()=>true,size:1000})},
    onState:state=>{states.push(state);if(state.step!==lastStep){lastStep=state.step;events.push(`state:${state.step}`);}},
    onConnected:async(...args)=>{events.push('onConnected');connected.push(args);if(onConnected)await onConnected(...args);},
    onDisconnected:async(...args)=>{events.push('onDisconnected');disconnected.push(args);},
    ...deps,
  });
  const kinds=()=>calls.map(call=>call.kind);
  const drive=async(...actions)=>{for(const action of actions){host.dispatch(action);await host.settled();}return host.getState();};
  return {host,world,events,calls,states,connected,disconnected,asked,checked,detects,kinds,drive};
}
const toReview=h=>h.drive(OPEN,{type:'continue'});
const connectRun=h=>h.drive(OPEN,{type:'continue'},{type:'connect'});
const bundleOf=h=>{const dir=h.calls.find(call=>call.kind==='bundleDir');return dir?dir.argv[8]:null;};
const isRoot=call=>call.options.asUser===undefined;

// Root only ever makes its own folders, stages its own bundle, rmdirs a feed folder, or rm -r's a bundle.
function assertRootSafe(h) {
  for(const call of h.calls.filter(isRoot)) {
    assert.ok(['roots','bundleDir','bundleFile','claimFeed','createFeed','rmdir','rmBundle'].includes(call.kind),`unexpected root argv ${call.argv.join(' ')}`);
    if(call.kind==='rmBundle')assert.ok(call.argv[3].startsWith(realFeed.BUNDLES+'/')&&call.argv.length===4);
    if(call.kind==='rmdir')assert.deepEqual(call.argv,['/usr/bin/rmdir','--',FEED]);
  }
  for(const call of h.calls.filter(call=>!isRoot(call)))assert.equal(call.options.asUser,USER,`target argv not run as ${USER}`);
}
// The bundle, once staged, is removed exactly once, as the last command, and the run is finished and unlocked.
function assertBundleRemoved(h) {
  const bundle=bundleOf(h),removals=h.calls.filter(call=>call.kind==='rmBundle');
  assert.ok(bundle,'bundle was staged');
  assert.equal(removals.length,1,'exactly one bundle removal');
  assert.deepEqual(removals[0].argv,['/usr/bin/rm','-r','--',bundle]);
  assert.equal(h.calls.at(-1).kind,'rmBundle','bundle removal is the last command');
  assert.ok(isRoot(removals[0]));
  const state=h.host.getState();
  assert.equal(state.busy,false);
  assert.equal(state.pending,null,'cleanup ran');
}
function assertNoSecret(h,...secrets) {
  const everything=JSON.stringify({states:h.states,argv:h.calls.map(call=>call.argv),final:h.host.getState()});
  for(const secret of secrets)assert.ok(!everything.includes(secret),'the password leaked into state or argv');
  for(const state of h.states)for(const secret of secrets)assert.ok(!JSON.stringify(state).includes(secret));
}

test('missing dependencies are refused at construction',()=>{
  assert.throws(()=>createWizardHost({}),TypeError);
  const h=harness();
  assert.equal(h.host.getState().step,'idle');
});

test('1. passwordless connect: exact command order, roles and argv',async()=>{
  const h=harness();
  const state=await connectRun(h);
  assert.equal(state.step,'connected');
  assert.equal(state.mode,'connect');
  assert.deepEqual(h.events,[
    'state:detecting','resolveUser','probe','state:detected',
    'state:detecting',...STAGE,'run:node','run:discover','inspect','state:review',
    'detectProvider','state:connecting','inspect','run:claimFeed','run:createFeed','precheck','run:connect',
    'state:verifying','detectProvider','readFeeds','readConnectionFeeds','onConnected','state:connected','run:rmBundle',
  ]);
  const bundle=bundleOf(h),script=`${bundle}/src/setup-cli.cjs`;
  assert.match(bundle,/^\/var\/lib\/llm-account-usage\/bundles\/[0-9a-f-]{36}$/);
  const by=kind=>h.calls.find(call=>call.kind===kind);
  assert.deepEqual(by('roots').argv,realFeed.ensureRootsArgv());
  assert.deepEqual(h.calls.filter(call=>call.kind==='bundleDir'||call.kind==='bundleFile').map(call=>call.argv),
    realFeed.stageBundleArgv({bundleId:bundle.split('/').pop(),files:[...MANIFEST],extensionPath:EXT}));
  assert.deepEqual(by('node').argv,['/bin/sh','-c','command -v node']);
  assert.deepEqual(by('discover').argv,[NODE,script,'discover','--provider','claude','--target',JSON.stringify({provider:'claude',process:PROC}),'--result','-']);
  assert.deepEqual(by('claimFeed').argv,['/usr/bin/mkdir','-m','0700','--',FEED]);
  assert.deepEqual(by('createFeed').argv,['/usr/bin/install','-d','-m','2750','-o',String(UID),'-g',String(GID),FEED]);
  assert.deepEqual(by('connect').argv,[NODE,script,'connect','--provider','claude','--profile',PROFILE,'--report-dir',FEED,
    '--runtime-version',VERSION,'--target',JSON.stringify({provider:'claude',process:PROC}),'--consent','granted','--result','-']);
  for(const kind of ['roots','bundleDir','bundleFile','claimFeed','createFeed','rmBundle'])assert.ok(h.calls.filter(call=>call.kind===kind).every(isRoot),`${kind} as root`);
  for(const kind of ['node','discover','connect'])assert.equal(by(kind).options.asUser,USER,`${kind} as target`);
  assert.ok(h.calls.every(call=>call.options.password===null||call.options.password===undefined),'no password on a passwordless host');
  // The review screen listed the real changes: the folder (root) then the status line (target).
  const review=h.states.find(s=>s.step==='review');
  assert.deepEqual(review.preview.changes.map(c=>[c.id,c.as]),[['folder','root'],['status',USER]]);
  assert.deepEqual(review.preview.commands.map(c=>c.as),['root','root',USER]);
  assert.deepEqual(state.applied.map(c=>c.id),['folder','status']);
  assert.equal(state.applied[0].created,true);
  assert.equal(h.connected.length,1);
  assert.equal(h.connected[0][0],FEED);
  assert.deepEqual(h.connected[0][1],PROC);
  assert.equal(h.connected[0][2].id,ID);
  assertRootSafe(h);assertBundleRemoved(h);
});

test('nothing is written before Connect: the review stops after the read-only discover',async()=>{
  const h=harness();
  const state=await toReview(h);
  assert.equal(state.step,'review');
  assert.deepEqual(h.kinds(),['roots','bundleDir',...MANIFEST.map(()=>'bundleFile'),'node','discover']);
  assert.ok(!h.kinds().some(kind=>['createFeed','connect','disconnect','rmdir'].includes(kind)));
});

test('2. finding 4: precheckReadable fails -> no setup-cli connect, the folder this run made is removed by rmdir',async()=>{
  const h=harness({world:{readable:false}});
  const state=await connectRun(h);
  assert.equal(state.step,'undone');
  assert.equal(state.error,'VS Code could not read the feed folder.');
  assert.ok(!h.kinds().includes('connect'),'the target account was never touched');
  assert.ok(!h.kinds().includes('disconnect'));
  const after=h.kinds().slice(h.kinds().indexOf('createFeed'));
  assert.deepEqual(after,['createFeed','rmdir','rmBundle']);
  assert.deepEqual(h.calls.find(call=>call.kind==='rmdir').argv,realFeed.removeFeedArgv(ID));
  assert.equal(h.world.feedExists,false);
  assert.deepEqual(state.undone.map(c=>c.id),['folder']);
  assert.deepEqual(state.kept,[]);
  assert.equal(h.connected.length,0);
  assertRootSafe(h);assertBundleRemoved(h);
});

test('3. descriptor unreadable at verify -> disconnect --remove-feed yes as target, then rmdir as root',async()=>{
  const h=harness({world:{descriptorReadable:false}});
  const state=await connectRun(h);
  assert.equal(state.step,'undone');
  assert.equal(state.error,'The target-user connection descriptor could not be verified.');
  const after=h.kinds().slice(h.kinds().indexOf('connect'));
  assert.deepEqual(after,['connect','disconnect','rmdir','rmBundle']);
  const bundle=bundleOf(h),disconnect=h.calls.find(call=>call.kind==='disconnect');
  assert.deepEqual(disconnect.argv,[NODE,`${bundle}/src/setup-cli.cjs`,'disconnect','--connection-id',ID,'--consent','granted','--remove-feed','yes','--result','-']);
  assert.equal(disconnect.options.asUser,USER);
  assert.deepEqual(h.calls.find(call=>call.kind==='rmdir').argv,realFeed.removeFeedArgv(ID));
  assert.deepEqual(state.undone.map(c=>c.id),['status','folder']);
  assert.equal(h.connected.length,0,'onConnected never fires for an unverified connection');
  assertRootSafe(h);assertBundleRemoved(h);
});

test('3b. an unreadable feed probe at verify rolls back the same way',async()=>{
  const h=harness({world:{feedsRejected:true}});
  const state=await connectRun(h);
  assert.equal(state.step,'undone');
  assert.match(state.error,/not safely readable/);
  assert.deepEqual(h.kinds().slice(h.kinds().indexOf('connect')),['connect','disconnect','rmdir','rmBundle']);
  assertRootSafe(h);assertBundleRemoved(h);
});

test('4. a pre-existing folder is never removed or recreated (success and rollback)',async()=>{
  const ok=harness({world:{feedExists:true}});
  let state=await connectRun(ok);
  assert.equal(state.step,'connected');
  assert.deepEqual(ok.states.find(s=>s.step==='review').preview.changes.map(c=>c.id),['status']);
  assert.ok(!ok.kinds().includes('createFeed')&&!ok.kinds().includes('rmdir'));
  assert.equal(ok.world.feedExists,true);
  assertRootSafe(ok);assertBundleRemoved(ok);

  const failed=harness({world:{feedExists:true,descriptorReadable:false}});
  state=await connectRun(failed);
  assert.equal(state.step,'undone');
  assert.deepEqual(failed.kinds().slice(failed.kinds().indexOf('connect')),['connect','disconnect','rmBundle']);
  assert.ok(!failed.kinds().includes('createFeed')&&!failed.kinds().includes('rmdir'));
  assert.equal(failed.world.feedExists,true);
  // The folder was not made by this run, so the rollback leaves its files alone: no --remove-feed.
  assert.ok(!failed.calls.find(call=>call.kind==='disconnect').argv.includes('--remove-feed'));
  assertRootSafe(failed);assertBundleRemoved(failed);
});

test('4d. a reconnect discovers the saved profile, not the account default',async()=>{
  const h=harness();
  const state=await h.drive({...OPEN,connection:CONNECTION},{type:'continue'});
  assert.equal(state.step,'review');
  const discover=h.calls.find(call=>call.kind==='discover').argv;
  assert.deepEqual(discover.slice(discover.indexOf('--profile'),discover.indexOf('--profile')+2),['--profile',PROFILE]);
  const fresh=harness();await toReview(fresh);
  assert.ok(!fresh.calls.find(call=>call.kind==='discover').argv.includes('--profile'),'a fresh connect names no profile');
});

test('4e. a reconnect whose discover reads another profile stops before any write',async()=>{
  const h=harness({on:{discover:()=>json({ok:true,preview:{...PREVIEW_OUT,profilePath:'/home/claudebwai/.claude-other'}})}});
  const state=await h.drive({...OPEN,connection:CONNECTION},{type:'continue'});
  assert.notEqual(state.step,'review');
  assert.ok(!h.kinds().some(kind=>['createFeed','connect','disconnect','rmdir'].includes(kind)));
  assertRootSafe(h);assertBundleRemoved(h);
});

test('4b. a folder that appears between review and Connect is neither recreated nor removed',async()=>{
  const h=harness();
  await toReview(h);
  h.world.feedExists=true;
  const state=await h.drive({type:'connect'});
  assert.equal(state.step,'undone');
  assert.match(state.error,/appeared after the review/);
  assert.ok(!h.kinds().some(kind=>['createFeed','rmdir','connect','disconnect'].includes(kind)));
  assert.equal(h.world.feedExists,true);
  assertRootSafe(h);assertBundleRemoved(h);
});

test('4c. an existing folder with the wrong owner is refused at review with its stat, never chowned',async()=>{
  const h=harness({world:{feedExists:true,feedUid:0,feedMode:0o755}});
  const state=await toReview(h);
  assert.equal(state.step,'cancelled');
  assert.match(state.error,/owner uid 0, group gid 1001, mode 755/);
  assert.ok(!h.kinds().some(kind=>['createFeed','rmdir','connect','disconnect'].includes(kind)));
  assert.ok(!h.calls.some(call=>call.argv.some(arg=>/chown|chmod/.test(arg))));
  assertRootSafe(h);assertBundleRemoved(h);
});

test('5. password host: three wrong passwords -> zero writes, cancelled, the password nowhere',async()=>{
  const h=harness({world:{sudo:'password'},answers:[WRONG,`${WRONG}-2`,`${WRONG}-3`],
    checkPassword:secret=>{if(secret===`${WRONG}-2`)throw Object.assign(new Error('bad'),{code:'INVALID_PASSWORD'});return false;}});
  let state=await h.drive(OPEN);
  assert.equal(state.step,'detected');
  assert.equal(state.sudo,'password');
  state=await h.drive({type:'continue'});
  assert.equal(state.step,'cancelled');
  assert.equal(state.error,'Three wrong passwords. Nothing was changed.');
  assert.equal(state.busy,false);
  assert.deepEqual(h.calls,[],'no elevated command at all: no roots, no bundle, no folder, no setup-cli');
  assert.deepEqual(h.asked.map(a=>a.attempt),[1,2,3]);
  assert.ok(h.asked.every(a=>a.tries===3&&a.prompt==='Password for glitch on this host (sudo)'));
  assert.deepEqual(h.asked.map(a=>a.error),[null,'sudo refused the password (1 of 3).','sudo refused the password (2 of 3).']);
  assert.deepEqual(h.checked,[WRONG,`${WRONG}-2`,`${WRONG}-3`]);
  assertNoSecret(h,WRONG);
});

test('5b. password host: the password asked at Continue is held for the whole run, as an option only',async()=>{
  const h=harness({world:{sudo:'password'},answers:[WRONG,SECRET],checkPassword:secret=>secret===SECRET});
  const state=await connectRun(h);
  assert.equal(state.step,'connected');
  assert.equal(h.asked.length,2,'asked at Continue only, never again at Connect');
  const connectAt=h.events.indexOf('state:connecting');
  assert.ok(h.events.lastIndexOf('askPassword')<h.events.indexOf('run:roots'),'the password comes before discover');
  assert.ok(h.events.lastIndexOf('askPassword')<connectAt);
  assert.ok(h.calls.length>0);
  for(const call of h.calls)assert.equal(call.options.password,SECRET,`${call.kind} carries the held password`);
  assertNoSecret(h,SECRET,WRONG);
  assertRootSafe(h);assertBundleRemoved(h);
});

test('5c. password host: dismissing the password box cancels with nothing run',async()=>{
  const h=harness({world:{sudo:'password'},answers:[undefined]});
  const state=await h.drive(OPEN,{type:'continue'});
  assert.equal(state.step,'cancelled');
  assert.deepEqual(h.calls,[]);
  assert.deepEqual(h.checked,[]);
});

test('5d. password host: cancel while the box is open aborts it and runs nothing',async()=>{
  const box=deferred();
  const h=harness({world:{sudo:'password'},answers:[()=>box.promise]});
  await h.drive(OPEN);
  h.host.dispatch({type:'continue'});
  await until(()=>h.asked.length===1,'the password box');
  const {signal}=h.asked[0];
  h.host.dispatch({type:'cancel'});
  assert.equal(signal.aborted,true,'the open password box is told to close');
  box.resolve(SECRET);
  const state=await h.host.settled();
  assert.equal(state.step,'cancelled');
  assert.deepEqual(h.checked,[],'a late answer is never checked');
  assert.deepEqual(h.calls,[]);
  assertNoSecret(h,SECRET);
});

// Every exit once the bundle is staged: each ends with exactly one rm -r of that bundle, as the last command.
const EXITS={
  'success':{expect:'connected'},
  'cancel at review':{actions:[OPEN,{type:'continue'},{type:'cancel'}],expect:'cancelled'},
  'discover prints garbage':{on:{discover:()=>({code:0,stdout:'not json\n',stderr:''})},actions:[OPEN,{type:'continue'}],expect:'cancelled'},
  'discover throws':{on:{discover:()=>{throw new Error('sudo died');}},actions:[OPEN,{type:'continue'}],expect:'cancelled'},
  'a bundle file fails to stage':{on:{bundleFile:(argv,options,index)=>index===4?{code:1,stdout:'',stderr:''}:OK},actions:[OPEN,{type:'continue'}],expect:'cancelled'},
  'node not on secure_path, then cancel':{on:{node:()=>({code:1,stdout:'',stderr:''})},actions:[OPEN,{type:'continue'},{type:'cancel'}],expect:'cancelled'},
  'session ended before Connect':{detect:()=>({provider:'claude',process:{...PROC,start_ticks:'78'},cliPath:null}),expect:'cancelled'},
  'createFeed throws':{on:{createFeed:()=>{throw new Error('boom');}},expect:'undone'},
  'setup-cli connect throws mid-apply':{on:{connect:()=>{throw new Error('boom');}},expect:'undone'},
  'setup-cli connect reports ok:false':{on:{connect:()=>json({ok:false})},expect:'undone'},
  'the rollback throws too':{world:{descriptorReadable:false},on:{disconnect:()=>{throw new Error('boom');},rmdir:()=>{throw new Error('boom');}},expect:'undone'},
  'onConnected throws':{onConnected:()=>{throw new Error('boom');},expect:'undone'},
};
for(const [name,scenario] of Object.entries(EXITS)) {
  test(`6. the bundle is removed on every exit path: ${name}`,async()=>{
    const h=harness(scenario);
    const state=await h.drive(...(scenario.actions||[OPEN,{type:'continue'},{type:'connect'}]));
    assert.equal(state.step,scenario.expect);
    assertRootSafe(h);assertBundleRemoved(h);
  });
}

test('6b. a thrown connect is treated as maybe-run: the status line is restored and the folder removed',async()=>{
  const h=harness({on:{connect:()=>{throw Object.assign(new Error('sudo: timed out'),{code:'SUDO_TIMEOUT',safeToDisplay:true});}}});
  const state=await connectRun(h);
  assert.equal(state.step,'undone');
  assert.equal(state.error,'sudo: timed out');
  assert.deepEqual(h.kinds().slice(h.kinds().indexOf('connect')),['connect','disconnect','rmdir','rmBundle']);
  assert.deepEqual(state.undone.map(c=>c.id),['status','folder']);
});

test('6c. a rollback step that fails is reported as kept, with a warning, and the next step is still attempted',async()=>{
  const h=harness({world:{descriptorReadable:false},on:{disconnect:()=>{throw new Error('boom');}}});
  const state=await connectRun(h);
  assert.equal(state.step,'undone');
  assert.deepEqual(h.kinds().slice(h.kinds().indexOf('connect')),['connect','disconnect','rmdir','rmBundle']);
  assert.deepEqual(state.undone.map(c=>c.id),['folder']);
  assert.deepEqual(state.kept.map(c=>c.id),['status']);
  assert.match(state.warning,/Still in place: status/);
});

test('6d. a bundle that cannot be removed becomes a warning on the done screen, never a block',async()=>{
  const h=harness({on:{rmBundle:()=>({code:1,stdout:'',stderr:''})}});
  let state=await connectRun(h);
  assert.equal(state.step,'connected');
  assert.equal(state.busy,false);
  assert.equal(state.warning,`The setup bundle could not be removed: ${bundleOf(h)}.`);
  state=await h.drive(OPEN);
  assert.equal(state.step,'detected','a second run opens straight away');
});

test('6e. cancel while discover is in flight, then discover throws: the bundle is still removed, no stray warning',async()=>{
  const gate=deferred();
  const h=harness({on:{discover:()=>gate.promise}});
  await h.drive(OPEN);
  h.host.dispatch({type:'continue'});
  await until(()=>h.kinds().includes('discover'),'discover');
  assert.equal(h.host.dispatch({type:'cancel'}).step,'cancelled');
  gate.reject(new Error('sudo died after the cancel'));
  const state=await h.host.settled();
  assert.equal(state.step,'cancelled');
  assert.equal(state.warning,null,'the dead effect is not a cleanup problem');
  assertRootSafe(h);assertBundleRemoved(h);
});

test('6f. cancel during Connect while an apply step is in flight, then it throws: the rollback still runs',async()=>{
  const gate=deferred();
  let inspects=0;
  const h=harness({deps:{sharedFeed:{...realFeed,precheckReadable:async()=>true,
    inspectFeed:async()=>++inspects===2?gate.promise:{exists:false}}}});
  await toReview(h);
  h.host.dispatch({type:'connect'});
  await until(()=>inspects>=2,'the second inspect');
  assert.equal(h.host.dispatch({type:'cancel'}).step,'undoing');
  gate.reject(new Error('lstat EIO'));
  const state=await h.host.settled();
  assert.equal(state.step,'undone');
  assert.equal(state.error,'You cancelled.');
  assert.ok(!state.log.some(line=>line.startsWith('Rollback failed')),'the rollback was performed, not skipped');
  assert.equal(state.warning,null);
  assert.ok(!h.kinds().includes('createFeed')&&!h.kinds().includes('connect'));
  assertRootSafe(h);assertBundleRemoved(h);
});

test('6g. cancel while setup-cli connect is still running: its late result joins the rollback, status then folder',async()=>{
  const gate=deferred();
  const h=harness({on:{connect:()=>gate.promise}});
  await toReview(h);
  h.host.dispatch({type:'connect'});
  await until(()=>h.kinds().includes('connect'),'setup-cli connect');
  assert.equal(h.host.dispatch({type:'cancel'}).step,'undoing');
  gate.resolve(json({ok:true,connection:descriptor()}));
  const state=await h.host.settled();
  assert.equal(state.step,'undone');
  assert.deepEqual(h.kinds().slice(h.kinds().indexOf('connect')),['connect','disconnect','rmdir','rmBundle']);
  assert.deepEqual(state.undone.map(c=>c.id),['status','folder']);
  assert.equal(h.connected.length,0);
  assertRootSafe(h);assertBundleRemoved(h);
});

test('7. a stale runId result is ignored: open, cancel, open again while the first probe is still pending',async()=>{
  const first=deferred();
  let probes=0;
  const h=harness({probe:()=>++probes===1?first.promise:'passwordless'});
  h.host.dispatch(OPEN);
  await until(()=>probes===1,'the first probe');
  const run1=h.host.getState().runId;
  assert.equal(h.host.dispatch({type:'cancel'}).step,'cancelled');
  const run2=h.host.dispatch(OPEN).runId;
  assert.notEqual(run2,run1);
  const seen=h.states.length;
  first.resolve('none'); // run 1's answer arrives late, and would say this host has no sudo
  const state=await h.host.settled();
  assert.equal(state.runId,run2);
  assert.equal(state.step,'detected');
  assert.equal(state.sudo,'passwordless');
  assert.ok(h.states.slice(seen).every(s=>s.runId===run2&&s.sudo!=='none'),'the stale result never reached state');
  assert.ok(!state.log.some(line=>line.includes('Not possible right now: sudoProbed')),'dropped by runId, not by step');
  assert.equal(probes,2);
});

test('7b. a stale discover is dropped and its orphaned bundle is removed; the new run shows its own review',async()=>{
  const first=deferred();
  let discovers=0;
  const h=harness({on:{discover:()=>++discovers===1?first.promise:json({ok:true,preview:PREVIEW_OUT})}});
  await h.drive(OPEN);
  h.host.dispatch({type:'continue'});
  await until(()=>discovers>0,'discover');
  const bundle1=bundleOf(h);
  h.host.dispatch({type:'cancel'});
  const run2=h.host.dispatch(OPEN).runId;
  first.resolve(json({ok:true,preview:{...PREVIEW_OUT,profilePath:'/home/claudebwai/.stale'}}));
  let state=await h.host.settled();
  assert.equal(state.runId,run2);
  assert.equal(state.step,'detected');
  assert.ok(h.calls.some(call=>call.kind==='rmBundle'&&call.argv[3]===bundle1),'the first run\'s bundle is removed');
  state=await h.drive({type:'continue'});
  assert.equal(state.step,'review');
  assert.equal(state.preview.profilePath,PROFILE);
  assert.ok(!h.states.some(s=>s.preview?.profilePath==='/home/claudebwai/.stale'));
  state=await h.drive({type:'cancel'});
  const bundles=h.calls.filter(call=>call.kind==='bundleDir').map(call=>call.argv[8]);
  assert.equal(bundles.length,2);
  assert.notEqual(bundles[0],bundles[1]);
  assert.deepEqual(h.calls.filter(call=>call.kind==='rmBundle').map(call=>call.argv[3]),bundles,'each bundle removed once');
  assertRootSafe(h);
});

test('8. focus is never read: no activeTerminal anywhere, the process identity from open is the binding',async()=>{
  const source=fs.readFileSync(path.join(__dirname,'../src/wizard-host.cjs'),'utf8');
  assert.ok(!/activeTerminal|require\(['"]vscode['"]\)/.test(source));
  const read=new Set();
  const guard=value=>new Proxy(value,{get(object,key,receiver){
    if(typeof key==='string'){read.add(key);if(/terminal|focus|window/i.test(key)&&key!=='terminalPid')throw new Error(`focus read: ${key}`);}
    return Reflect.get(object,key,receiver);
  }});
  const h=harness();
  const state=await h.drive(guard({...OPEN,target:guard({...OPEN.target,process:{...PROC}})}),{type:'continue'},{type:'connect'});
  assert.equal(state.step,'connected');
  assert.ok(!read.has('activeTerminal'));
  assert.ok(h.detects.length>=2);
  for(const {pid,options} of h.detects) {
    assert.equal(pid,PID,'identity re-read through the terminal pid chosen at open');
    assert.deepEqual(options,{allowForeign:true,topologyOnly:true});
  }
});

test('8b. the same pid with a different start time is another process: Connect writes nothing',async()=>{
  const h=harness();
  await toReview(h);
  h.world.liveProcess={...PROC,start_ticks:'999'};
  const state=await h.drive({type:'connect'});
  assert.equal(state.step,'cancelled');
  assert.match(state.error,/session ended/);
  assert.ok(!h.kinds().some(kind=>['createFeed','connect','disconnect','rmdir'].includes(kind)));
  assertBundleRemoved(h);
});

test('9. disconnect mode: setup-cli disconnect as target, then removeFeedArgv as root',async()=>{
  const h=harness({world:{feedExists:true}});
  let state=await h.drive(OPEN_DISCONNECT,{type:'continue'});
  assert.equal(state.step,'review');
  assert.equal(state.mode,'disconnect');
  assert.deepEqual(state.preview.changes.map(c=>[c.id,c.as]),[['status',USER],['folder','root']]);
  const bundle=bundleOf(h),script=`${bundle}/src/setup-cli.cjs`;
  assert.deepEqual(state.preview.commands,[
    {as:USER,argv:[NODE,script,'disconnect','--connection-id',ID,'--consent','granted','--remove-feed','yes','--result','-']},
    {as:'root',argv:realFeed.removeFeedArgv(ID)}]);
  state=await h.drive({type:'connect'});
  assert.equal(state.step,'connected');
  assert.deepEqual(h.kinds(),['roots','bundleDir',...MANIFEST.map(()=>'bundleFile'),'node','disconnect','rmdir','rmBundle']);
  const disconnect=h.calls.find(call=>call.kind==='disconnect'),rmdir=h.calls.find(call=>call.kind==='rmdir');
  assert.deepEqual(disconnect.argv,state.preview.commands[0].argv);
  assert.equal(disconnect.options.asUser,USER);
  assert.deepEqual(rmdir.argv,realFeed.removeFeedArgv(ID));
  assert.ok(isRoot(rmdir));
  assert.ok(!h.kinds().includes('discover')&&!h.kinds().includes('createFeed'));
  assert.deepEqual(h.disconnected,[[FEED,ID]]);
  assert.equal(h.world.feedExists,false);
  assertRootSafe(h);assertBundleRemoved(h);
});

test('9b. disconnect mode: a feed folder with foreign entries is kept, never rmdir-ed',async()=>{
  const h=harness({world:{feedExists:true},on:{disconnect:()=>json({ok:true,connection:descriptor({connected:false}),feed:{removed:false,code:'FEED_NOT_EMPTY'}})}});
  const state=await h.drive(OPEN_DISCONNECT,{type:'continue'},{type:'connect'});
  assert.equal(state.step,'undone');
  assert.match(state.error,/holds entries Account Usage did not create/);
  assert.ok(!h.kinds().includes('rmdir'));
  assert.deepEqual(state.kept.map(c=>c.id),['folder']);
  assert.deepEqual(h.disconnected,[[FEED,ID]],'the status line was restored, so it is reported disconnected');
  assertRootSafe(h);assertBundleRemoved(h);
});

test('9c. disconnect mode refuses a connection for another provider or account before any sudo call',async()=>{
  const h=harness();
  const state=await h.drive({...OPEN_DISCONNECT,connection:{...CONNECTION,uid:UID+1}});
  assert.equal(state.step,'cancelled');
  assert.deepEqual(h.calls,[]);
  assert.ok(!h.events.includes('probe'));
});

test('a target with no passwd entry is refused before any sudo call',async()=>{
  const h=harness();
  const state=await h.drive({...OPEN,target:{provider:'claude',process:{...PROC,uid:4000}}});
  assert.equal(state.step,'cancelled');
  assert.equal(state.error,GENERIC_ERROR);
  assert.deepEqual(h.calls,[]);
  assert.ok(!h.events.includes('probe'));
});

test('host results and unknown intents from outside are ignored',async()=>{
  const h=harness();
  await toReview(h);
  const before=h.host.getState(),seen=h.states.length;
  for(const type of ['verified','applied','password','cleanedUp','discovered','bogus'])
    h.host.dispatch({type,runId:before.runId,change:{id:'status'},connection:descriptor()});
  h.host.dispatch(null);
  await h.host.settled();
  assert.equal(h.states.length,seen,'no state change');
  assert.deepEqual(h.host.getState(),before);
});

test('close is forwarded to the wizard and never throws',async()=>{
  const h=harness();
  await connectRun(h);
  const seen=h.states.length;
  assert.doesNotThrow(()=>h.host.dispatch({type:'close'}));
  await h.host.settled();
  assert.ok(h.states.length>seen,'the machine saw the close intent');
  const last=h.states.at(-1);
  assert.ok(last.step==='idle'||last.log.at(-1)==='(Not possible right now: close)');
  // While a run is busy, close is still forwarded and still does not throw.
  const busy=harness();
  busy.host.dispatch(OPEN);
  assert.doesNotThrow(()=>busy.host.dispatch({type:'close'}));
  await busy.host.settled();
});

test('retry after an undone run is a fresh run on the same target with its own bundle',async()=>{
  const h=harness({world:{readable:false}});
  let state=await connectRun(h);
  assert.equal(state.step,'undone');
  const run1=state.runId;
  h.world.readable=true;
  state=await h.drive({type:'retry'});
  assert.notEqual(state.runId,run1);
  assert.equal(state.step,'detected');
  state=await h.drive({type:'continue'},{type:'connect'});
  assert.equal(state.step,'connected');
  const bundles=h.calls.filter(call=>call.kind==='bundleDir').map(call=>call.argv[8]);
  assert.equal(bundles.length,2);
  assert.deepEqual(h.calls.filter(call=>call.kind==='rmBundle').map(call=>call.argv[3]),bundles);
  assertRootSafe(h);
});

// ---- Codex review of CP2 (5b1be25): one regression per finding ----
test('R1. setup-cli connect fails after touching the settings: the rollback restores the status line',async()=>{
  const h=harness({on:{connect:()=>json({ok:false,code:'SETUP_FAILED_CHANGED'})}});
  const state=await connectRun(h);
  assert.equal(state.step,'undone');
  assert.deepEqual(h.kinds().slice(h.kinds().indexOf('connect')),['connect','disconnect','rmdir','rmBundle']);
  assert.deepEqual(state.undone.map(c=>c.id),['status','folder']);
  assertRootSafe(h);assertBundleRemoved(h);
});

test('R2. another run claims the feed folder first: this run never re-owns, empties or removes it',async()=>{
  const h=harness({on:{claimFeed:()=>{h.world.feedExists=true;return {code:1,stdout:'',stderr:'File exists'};}}});
  const state=await connectRun(h);
  assert.equal(state.step,'undone');
  assert.match(state.error,/could not be claimed/);
  for(const kind of ['createFeed','connect','disconnect','rmdir'])assert.ok(!h.kinds().includes(kind),`${kind} must not run`);
  assert.equal(h.world.feedExists,true);
  assertRootSafe(h);assertBundleRemoved(h);
});

test('R3. a bundle removal that fails after the run was replaced still reaches the screen',async()=>{
  const gate=deferred();
  const h=harness({on:{rmBundle:()=>gate.promise}});
  h.host.dispatch(OPEN);await h.host.settled();
  h.host.dispatch({type:'cancel'});
  await until(()=>h.kinds().includes('rmBundle')||h.host.getState().pending===null,'cleanup started');
  // cancel before any staging: nothing to remove, so stage one first
  if(!h.kinds().includes('rmBundle')) {
    h.host.dispatch(OPEN);await until(()=>h.host.getState().step==='detected','detected');
    h.host.dispatch({type:'continue'});await until(()=>h.kinds().includes('discover'),'discover');
    await until(()=>h.host.getState().step==='review','review');
    h.host.dispatch({type:'cancel'});
    await until(()=>h.kinds().includes('rmBundle'),'bundle removal started');
  }
  const bundle=bundleOf(h);
  h.host.dispatch(OPEN); // replaces the run while rm -r is still running
  gate.resolve({code:1,stdout:'',stderr:''});
  const state=await h.host.settled();
  assert.notEqual(state.step,'idle');
  assert.equal(state.warning,`The setup bundle could not be removed: ${bundle}.`);
});

test('R5. a cancelled run\'s slow identity re-check never swallows Connect in the next run',async()=>{
  let slow=null;
  const h=harness({detect:(pid,options)=>slow?slow.promise:{provider:'claude',process:{...PROC},cliPath:null}});
  await toReview(h);
  slow=deferred();
  h.host.dispatch({type:'connect'}); // re-check hangs
  h.host.dispatch({type:'cancel'});
  const hung=slow;slow=null;
  // settled() would wait on the hung re-check, so wait for the cancelled run to finish its cleanup instead
  await until(()=>h.host.getState().step==='cancelled'&&h.host.getState().pending===null,'first run cancelled and cleaned up');
  h.host.dispatch(OPEN);await until(()=>h.host.getState().step==='detected','detected');
  h.host.dispatch({type:'continue'});await until(()=>h.host.getState().step==='review','review');
  h.host.dispatch({type:'connect'});
  await until(()=>h.kinds().includes('connect'),'Connect in the new run went ahead');
  hung.resolve({provider:'claude',process:{...PROC},cliPath:null});
  const state=await h.host.settled();
  assert.equal(state.step,'connected');
});

test('R1b. a reconnect whose setup fails before touching the settings leaves the working connection alone',async()=>{
  const h=harness({world:{feedExists:true},on:{connect:()=>json({ok:false,code:'SETUP_FAILED'})}});
  const state=await h.drive({...OPEN,connection:CONNECTION},{type:'continue'},{type:'connect'});
  assert.equal(state.step,'undone');
  assert.match(state.error,/status line was not changed/);
  assert.ok(!h.kinds().includes('disconnect'),'no disconnect: the old connection keeps working');
  assert.ok(!h.kinds().includes('rmdir'));
  assertRootSafe(h);assertBundleRemoved(h);
});

test('R2b. mkdir times out after making the folder: the claim is recorded and the rollback rmdirs it',async()=>{
  const h=harness({on:{claimFeed:()=>{h.world.feedExists=true;h.world.feedUid=0;h.world.feedGid=0;h.world.feedMode=0o700;
    throw Object.assign(new Error('timed out'),{code:'ETIMEDOUT'});}}});
  const state=await connectRun(h);
  assert.equal(state.step,'undone');
  assert.deepEqual(h.kinds().slice(h.kinds().indexOf('claimFeed')),['claimFeed','rmdir','rmBundle']);
  assert.equal(h.world.feedExists,false,'no stranded folder');
  assertRootSafe(h);assertBundleRemoved(h);
});

test('R2c. a timed-out claim that another run has since handed to the target is left for that run, never rmdir-ed',async()=>{
  const h=harness({on:{claimFeed:()=>{
    // our mkdir made nothing; another run's mkdir did (root 0700), then its install -d handed it over before our rollback
    // First inspect after the claim (ours, right away) sees the bare claim; any later one sees it handed to the target.
    const claimAt=h.events.filter(e=>e==='inspect').length;h.world.feedExists=true;h.world.feedGid=0;
    const handed=()=>h.events.filter(e=>e==='inspect').length>claimAt+1;
    Object.defineProperty(h.world,'feedUid',{get:()=>handed()?UID:0,configurable:true});
    Object.defineProperty(h.world,'feedMode',{get:()=>handed()?0o2750:0o700,configurable:true});
    throw Object.assign(new Error('timed out'),{code:'ETIMEDOUT'});}}});
  const state=await connectRun(h);
  assert.equal(state.step,'undone');
  assert.ok(!h.kinds().includes('rmdir'),'the other run\'s folder is not removed');
  assert.equal(h.world.feedExists,true);
  assert.match(state.kept.find(c=>c.id==='folder').reason,/Another setup/);
  assertRootSafe(h);assertBundleRemoved(h);
});

test('R9. a refused profile names its reason from the host\'s own sentences; an unknown code keeps the general text',async()=>{
  const refused=harness({on:{discover:()=>json({ok:false,code:'SETUP_FAILED',reason:'UNSAFE_PATH',message:'x'})}});
  let state=await refused.drive(OPEN,{type:'continue'});
  assert.equal(state.step,'cancelled');
  assert.match(state.error,/^A file in claudebwai's Claude profile has an unsafe owner, link, size or permission mode.* Nothing was changed\.$/);
  const stub=harness({on:{discover:()=>json({ok:false,code:'SETUP_FAILED',reason:'UNSUPPORTED_STATUSLINE',message:'x'})}});
  state=await stub.drive(OPEN,{type:'continue'});
  assert.match(state.error,/^claudebwai's Claude status line is not a command that can be wrapped/);
  for(const reason of ['NOT_A_KNOWN_CODE','constructor','__proto__',undefined]) {
    const h=harness({on:{discover:()=>json({ok:false,code:'SETUP_FAILED',...(reason?{reason}:{}),message:'planted words'})}});
    state=await h.drive(OPEN,{type:'continue'});
    assert.equal(state.error,"claudebwai could not read its Claude profile. Nothing was changed.",String(reason));
  }
  const connect=harness({on:{connect:()=>json({ok:false,code:'SETUP_FAILED',reason:'ALREADY_CONNECTED',message:'x'})}});
  state=await connect.drive(OPEN,{type:'continue'},{type:'connect'});
  assert.equal(state.error,"Setup as claudebwai stopped. claudebwai's Claude already has an Account Usage hook. Its status line was not changed.");
});

// ---- CP3 Task 3.2: the no-sudo road inside the wizard ----
// No sudo is ever called on this road, so every test also asserts elevate.run saw nothing. The handoff is a fake with the
// shape of handoff.cjs's prepareHandoff ({root,command,resultPath,readResult,dispose}); the clock is a fake, so the
// two-minute wait costs nothing.
const {renderWizard}=require('../src/wizard-view.cjs');
const HOME='/home/claudebwai';
const ADMIN_LINE=`sudo install -d -m 2750 -o ${USER} -g ${GID} ${FEED}`;
function fakeClock() {
  let t=0;const queue=[];
  return {now:()=>t,pending:()=>queue.length,
    setTimer:(fn,ms)=>{const entry={at:t+ms,fn};queue.push(entry);return entry;},
    clearTimer:entry=>{const i=queue.indexOf(entry);if(i>=0)queue.splice(i,1);},
    async advance(ms,host) {
      const end=t+ms;
      for(;;) {
        queue.sort((a,b)=>a.at-b.at);
        if(!queue.length||queue[0].at>end)break;
        const entry=queue.shift();t=entry.at;entry.fn();await host.settled();
      }
      t=end;await host.settled();
    }};
}
function fakeHandoffs() {
  const made=[];
  const prepare=async opts=>{
    const i=made.length,root=`/tmp/llm-account-usage-fake${i}`;
    const h={opts,root,command:`node '${root}/src/setup-cli.cjs' ${opts.action} --fake ${i}`,resultPath:`${root}/results/x.json`,
      result:null,reads:0,disposed:0,
      readResult:async()=>{h.reads++;if(h.disposed)throw new Error('read after dispose');return typeof h.result==='function'?h.result():h.result;},
      dispose:async()=>{h.disposed++;return {removed:true};}};
    made.push(h);return h;
  };
  return {made,prepare};
}
function noSudo({world={},deps={},...rest}={}) {
  const clock=fakeClock(),handoffs=fakeHandoffs(),homes=[];
  const h=harness({...rest,world:{sudo:'none',feedExists:true,...world},deps:{prepareHandoff:handoffs.prepare,
    homeOf:async(uid,user)=>{homes.push([uid,user]);return uid===UID&&user===USER?HOME:null;},
    now:clock.now,setTimer:clock.setTimer,clearTimer:clock.clearTimer,...deps}});
  return {...h,clock,handoffs,homes,advance:ms=>clock.advance(ms,h.host)};
}
const intentsOf=html=>[...html.matchAll(/data-intent="([a-z]+)"/g)].map(m=>m[1]);
const textOf=html=>html.replace(/<[^>]+>/g,'').replace(/&#39;/g,"'").replace(/&quot;/g,'"').replace(/&amp;/g,'&');

test('F1. no sudo: Connect shows the one handoff line with --report-dir on the existing feed; the result is verified, then connected',async()=>{
  const h=noSudo();
  let state=await connectRun(h);
  assert.equal(state.step,'fallback');
  assert.equal(h.handoffs.made.length,1);
  const [handoff]=h.handoffs.made;
  assert.deepEqual(handoff.opts,{extensionPath:EXT,provider:'claude',target:{cliPath:null,process:PROC,terminalPid:PID},action:'connect',
    revalidate:handoff.opts.revalidate,runtimeVersion:VERSION,profilePath:PROFILE,reportDir:FEED});
  assert.equal(state.fallbackCommand,handoff.command);
  assert.equal(state.fallbackAdmin,false);
  assert.equal(state.fallbackWaitMs,120000);
  const review=h.states.find(s=>s.step==='review');
  assert.equal(review.preview.id,ID);assert.equal(review.preview.profilePath,PROFILE);assert.equal(review.preview.reportDir,FEED);
  assert.ok(review.preview.changes[0].label.includes(PROFILE)&&review.preview.changes[0].label.includes(FEED));
  assert.match(textOf(renderWizard(review)),/Without sudo nothing can be undone automatically/);
  const html=renderWizard(state);
  assert.ok(html.includes(`<code class="wizard-cmd">${handoff.command.replace(/'/g,'&#39;')}</code>`));
  assert.deepEqual(intentsOf(html),['copy','cancel']);
  assert.match(textOf(html),/It stops waiting after 2 minutes\./);
  // The poll: one read every 250 ms while nothing has come back.
  await h.advance(1000);
  assert.equal(handoff.reads,4);
  assert.equal(h.host.getState().step,'fallback');
  handoff.result={ok:true,connection:descriptor()};
  await h.advance(250);
  state=h.host.getState();
  assert.equal(state.step,'connected');
  assert.deepEqual(state.applied.map(c=>c.id),['status']);
  assert.equal(h.connected.length,1);
  assert.equal(h.connected[0][0],FEED);assert.deepEqual(h.connected[0][1],PROC);assert.equal(h.connected[0][2].id,ID);
  assert.ok(h.events.includes('readConnectionFeeds'),'the same descriptor check as the sudo road');
  assert.equal(handoff.disposed,1);
  assert.equal(h.clock.pending(),0,'no poll left running');
  assert.equal(state.fallbackCommand,undefined);
  assert.deepEqual(h.calls,[],'no sudo call on this road');
  assert.deepEqual(h.homes,[[UID,USER]]);
});

test('F2. no sudo and no feed folder: the admin line first; once the folder exists, the connect line with --report-dir',async()=>{
  const h=noSudo({world:{feedExists:false}});
  let state=await connectRun(h);
  assert.equal(state.step,'fallback');
  assert.equal(state.fallbackAdmin,true);
  assert.equal(state.fallbackCommand,ADMIN_LINE);
  assert.equal(h.handoffs.made.length,0,'nothing is staged before the folder exists');
  const html=renderWizard(state),t=textOf(html);
  assert.ok(t.includes('An admin step first')&&t.includes(`The shared folder ${FEED} does not exist yet`)&&t.includes(ADMIN_LINE));
  assert.deepEqual(intentsOf(html),['copy','cancel']);
  await h.advance(1000);
  assert.equal(h.host.getState().fallbackAdmin,true);
  h.world.feedExists=true;
  await h.advance(250);
  state=h.host.getState();
  assert.equal(h.handoffs.made.length,1);
  assert.equal(h.handoffs.made[0].opts.reportDir,FEED);
  assert.equal(state.fallbackAdmin,false);
  assert.equal(state.fallbackCommand,h.handoffs.made[0].command);
  // The connect line gets its own two minutes from when it was shown (t=1250).
  await h.advance(119000);
  assert.equal(h.host.getState().step,'fallback');
  h.handoffs.made[0].result={ok:true,connection:descriptor()};
  await h.advance(250);
  assert.equal(h.host.getState().step,'connected');
  assert.deepEqual(h.calls,[]);
});

test('F3. no sudo: a feed folder of the wrong shape is refused with its stat, before or while the admin line is shown',async()=>{
  const h=noSudo({world:{feedGid:999}});
  let state=await connectRun(h);
  assert.equal(state.step,'cancelled');
  assert.match(state.error,/group gid 999.*It must be owner uid 1053, group gid 1001, mode 2750/);
  assert.equal(h.handoffs.made.length,0);
  const late=noSudo({world:{feedExists:false}});
  await connectRun(late);
  Object.assign(late.world,{feedExists:true,feedMode:0o2777});
  await late.advance(250);
  state=late.host.getState();
  assert.equal(state.step,'cancelled');
  assert.match(state.error,/mode 2777/);
  assert.equal(late.handoffs.made.length,0);
  assert.equal(late.clock.pending(),0);
});

test('F4. no sudo: two minutes without a result goes to cancelled and disposes the handoff; the admin wait times out too',async()=>{
  const h=noSudo();
  await connectRun(h);
  await h.advance(119750);
  assert.equal(h.host.getState().step,'fallback');
  await h.advance(250);
  const state=h.host.getState();
  assert.equal(state.step,'cancelled');
  assert.match(state.error,/within 2 minutes.*the line no longer works/);
  assert.equal(h.handoffs.made[0].disposed,1);
  // Review 2: no answer is not "nothing ran", so the undo line is offered; its poll is the only timer left.
  assert.equal(state.fallbackUndo,'waiting');
  assert.equal(state.fallbackUnsure,true);
  assert.equal(h.clock.pending(),1);
  const reads=h.handoffs.made[0].reads;
  await h.advance(10000);
  assert.equal(h.handoffs.made[0].reads,reads,'no poll of the connect line after the timeout');
  const admin=noSudo({world:{feedExists:false}});
  await connectRun(admin);
  await admin.advance(120000);
  assert.equal(admin.host.getState().step,'cancelled');
  assert.match(admin.host.getState().error,/did not appear within 2 minutes.*Nothing was changed/);
  assert.equal(admin.clock.pending(),0);
});

test('F5. no sudo: Cancel stops the poll and disposes the handoff; a line that had already run is still read, never "Nothing was changed"',async()=>{
  const h=noSudo();
  await connectRun(h);
  await h.drive({type:'cancel'});
  let state=h.host.getState();
  assert.equal(state.step,'cancelled');
  assert.equal(h.handoffs.made[0].disposed,1);
  // Review 2: the connect line was shown and gave no answer, so it may have run: never "Nothing was changed" (F15).
  assert.equal(h.clock.pending(),1,'only the undo line is polled');
  assert.doesNotMatch(textOf(renderWizard(state)),/Nothing was changed/);
  const ran=noSudo();
  await connectRun(ran);
  ran.handoffs.made[0].result={ok:true,connection:descriptor()}; // it ran; Cancel lands before the next tick
  await ran.drive({type:'cancel'});
  state=ran.host.getState();
  assert.equal(state.step,'cancelled');
  assert.match(state.warning,/had already run as claudebwai/);
  assert.equal(state.fallbackUndo,'waiting');
  assert.equal(ran.handoffs.made[1].opts.action,'disconnect');
  assert.equal(state.fallbackCommand,ran.handoffs.made[1].command);
  assert.ok(!textOf(renderWizard(state)).includes('Nothing was changed'));
  assert.equal(ran.connected.length,0);
  assert.deepEqual(ran.calls,[]);
});

test('F6. no sudo: the line ran but VS Code cannot read the descriptor -> undone, no rollback, the exact disconnect line until it runs',async()=>{
  const h=noSudo({world:{descriptorReadable:false}});
  await connectRun(h);
  h.handoffs.made[0].result={ok:true,connection:descriptor()};
  await h.advance(250);
  let state=h.host.getState();
  assert.equal(state.step,'undone');
  assert.match(state.error,/connection descriptor could not be verified/);
  assert.deepEqual(state.kept.map(c=>c.id),['status']);
  assert.deepEqual(state.undone,[]);
  assert.equal(h.handoffs.made[0].disposed,1);
  const undo=h.handoffs.made[1];
  assert.deepEqual(undo.opts,{extensionPath:EXT,provider:'claude',target:{cliPath:null,process:PROC,terminalPid:PID},action:'disconnect',
    connectionId:ID,revalidate:undo.opts.revalidate});
  assert.equal(state.fallbackUndo,'waiting');
  assert.equal(state.fallbackCommand,undo.command);
  const html=renderWizard(state),t=textOf(html);
  assert.ok(t.includes("Without sudo the wizard can't undo this itself.")&&t.includes(PROFILE)&&t.includes(FEED)&&t.includes(undo.command),t);
  assert.ok(intentsOf(html).includes('copy'));
  assert.equal(h.connected.length,0);
  undo.result={ok:true,connection:descriptor({connected:false})};
  await h.advance(250);
  state=h.host.getState();
  assert.equal(state.fallbackUndo,'done');
  assert.equal(state.fallbackCommand,undefined);
  assert.equal(undo.disposed,1);
  assert.equal(h.clock.pending(),0);
  assert.match(textOf(renderWizard(state)),/The undo line ran as claudebwai: claudebwai's Claude status line is back as it was\./);
  assert.deepEqual(h.calls,[],'no sudo, so no rollback call');
});

test('F7. no sudo: each failed result says what changed; only a line that may have changed something gets the undo line',async()=>{
  const cases=[
    [{ok:false,code:'SETUP_FAILED',message:'Target-user setup could not finish.'},/its status line was not changed/,false],
    [{ok:false,code:'SETUP_FAILED',reason:'UNSAFE_PATH',message:'Target-user setup could not finish.'},/its status line was not changed\. A file in claudebwai's Claude profile has an unsafe owner/,false],
    [{ok:false,code:'SETUP_FAILED',reason:'NOT_A_KNOWN_CODE',message:'Target-user setup could not finish.'},/its status line was not changed\.$/,false],
    [{ok:false,code:'CANCELLED',message:'Setup cancelled.'},/cancelled as claudebwai\. Nothing was changed/,false],
    [{ok:false,code:'SETUP_FAILED_CHANGED',message:'Target-user setup could not finish.'},/stopped after it had changed the status line/,true],
    [()=>{throw new Error('unverified');},/its result could not be verified/,true],
  ];
  for(const [out,error,undo] of cases) {
    const h=noSudo();
    await connectRun(h);
    h.handoffs.made[0].result=out;
    await h.advance(250);
    const state=h.host.getState();
    assert.equal(state.step,'undone');
    assert.match(state.error,error);
    assert.equal(h.handoffs.made[0].disposed,1);
    assert.equal(h.handoffs.made.length,undo?2:1,String(error));
    assert.equal(state.fallbackUndo,undo?'waiting':undefined);
    if(undo)assert.equal(state.fallbackCommand,h.handoffs.made[1].command);
    assert.deepEqual(h.calls,[]);
  }
  // An undo line that fails says so, and the line goes away (its dropbox is spent).
  const h=noSudo();
  await connectRun(h);
  h.handoffs.made[0].result={ok:false,code:'SETUP_FAILED_CHANGED',message:'x'};
  await h.advance(250);
  h.handoffs.made[1].result={ok:false,code:'SETUP_FAILED',message:'x'};
  await h.advance(250);
  const state=h.host.getState();
  assert.equal(state.fallbackUndo,'failed');
  assert.equal(state.fallbackCommand,undefined);
  assert.match(textOf(renderWizard(state)),/could not finish, so claudebwai's Claude status line has to be put back by hand/);
});

test('F8. the undo line ends with the wizard: Close, a new run and Start again each dispose it and stop its poll',async()=>{
  const failed=async()=>{
    const h=noSudo({world:{descriptorReadable:false}});
    await connectRun(h);
    h.handoffs.made[0].result={ok:true,connection:descriptor()};
    await h.advance(250);
    assert.equal(h.host.getState().fallbackUndo,'waiting');
    return h;
  };
  for(const action of [{type:'close'},OPEN,{type:'retry'}]) {
    const h=await failed();
    await h.drive(action);
    assert.equal(h.handoffs.made[1].disposed,1,action.type);
    const reads=h.handoffs.made[1].reads;
    await h.advance(1000);
    assert.equal(h.handoffs.made[1].reads,reads,`${action.type}: no poll after release`);
    assert.equal(h.host.getState().fallbackUndo,undefined);
  }
});

test('F9. finding 6 on the no-sudo road: focus changes are never actions and never re-read the session',async()=>{
  const h=noSudo();
  const before=await connectRun(h);
  const detects=h.detects.length;
  for(const action of [{type:'focus'},{type:'activeTerminal',terminal:{processId:9999}},{type:'select',pid:9999}]) {
    h.host.dispatch(action);
    await h.advance(250);
  }
  const during=h.host.getState();
  assert.equal(during.step,'fallback');
  assert.equal(during.fallbackCommand,before.fallbackCommand);
  assert.equal(h.detects.length,detects,'no session re-read from a focus change');
  h.handoffs.made[0].result={ok:true,connection:descriptor()};
  await h.advance(250);
  assert.equal(h.host.getState().step,'connected');
  assert.ok(h.detects.slice(detects).every(d=>d.pid===PID),'the re-check reads the terminal chosen at open');
});

test('F10. no-sudo disconnect: the disconnect line, onDisconnected on its result, and the shared folder stays with a warning',async()=>{
  const h=noSudo();
  let state=await h.drive(OPEN_DISCONNECT,{type:'continue'},{type:'connect'});
  assert.equal(state.step,'fallback');
  const [handoff]=h.handoffs.made;
  assert.equal(handoff.opts.action,'disconnect');
  assert.equal(handoff.opts.connectionId,ID);
  assert.equal(handoff.opts.reportDir,undefined);
  assert.equal(state.fallbackCommand,handoff.command);
  assert.equal(h.homes.length,0,'the saved connection names the profile');
  handoff.result={ok:true,connection:descriptor({connected:false})};
  await h.advance(250);
  state=h.host.getState();
  assert.equal(state.step,'connected');
  assert.deepEqual(h.disconnected,[[FEED,ID]]);
  assert.match(state.warning,/stays: removing it needs an admin/);
  assert.equal(handoff.disposed,1);
  assert.deepEqual(h.calls,[]);
});

test('F11. no sudo: a reconnect uses its saved profile; an unknown home stops before anything is shown',async()=>{
  const h=noSudo({deps:{homeOf:async()=>{throw new Error('no passwd');}}});
  const state=await h.drive({...OPEN,connection:CONNECTION},{type:'continue'},{type:'connect'});
  assert.equal(state.step,'fallback');
  assert.equal(h.handoffs.made[0].opts.profilePath,PROFILE);
  assert.equal(h.handoffs.made[0].opts.reportDir,FEED);
  const lost=noSudo({deps:{homeOf:async()=>null}});
  const out=await lost.drive(OPEN,{type:'continue'});
  assert.equal(out.step,'cancelled');
  assert.equal(out.error,"claudebwai's home folder could not be read from /etc/passwd, so the wizard cannot name its Claude profile. Nothing was changed.");
  assert.equal(lost.handoffs.made.length,0);
});

test('F12. dispose() (extension deactivate) stops the poll and disposes the handoff',async()=>{
  const h=noSudo();
  await connectRun(h);
  await h.host.dispose();
  assert.equal(h.handoffs.made[0].disposed,1);
  assert.equal(h.clock.pending(),0);
});

test('F13. the no-sudo screens escape every value they show',()=>{
  const EVIL='<img src=x onerror=alert(1)>';
  const base={mode:'connect',target:{provider:'claude',user:EVIL,uid:1,pid:1,process:{}},sudo:'none',busy:false,runId:'r',pending:null,
    applied:[],undone:[],kept:[{id:'status'}],preview:{profilePath:`/p/${EVIL}`,reportDir:`/f/${EVIL}`,changes:[{id:'status'}]},error:EVIL,warning:null,log:[]};
  const screens=[{...base,step:'fallback',busy:true,fallbackAdmin:true,fallbackCommand:EVIL,fallbackWaitMs:120000},
    ...['waiting','failed','done'].flatMap(u=>[{...base,step:'undone',fallbackUndo:u,fallbackCommand:EVIL},{...base,step:'cancelled',fallbackUndo:u,fallbackCommand:EVIL}]),
    ...['connect','disconnect'].flatMap(mode=>[{...base,mode,step:'cancelled',fallbackUnsure:true},{...base,mode,step:'cancelled',fallbackUnsure:true,fallbackUndo:'failed'}])];
  for(const s of screens) {
    const html=renderWizard(s);
    assert.ok(html.length>0);
    assert.ok(!html.includes('<img'),`${s.step}/${s.fallbackUndo||'admin'}`);
  }
  assert.ok(textOf(renderWizard(screens[0])).includes('An admin step first'));
  assert.ok(textOf(renderWizard(screens[1])).includes("can't undo this itself"));
});

// ---- CP3 Codex review (25 Sep): each test below reproduces a finding and failed on c2e868c ----
test('F14. review 1: dispose() between Connect and the fallback effect starts nothing: no handoff, no poll, no timer',async()=>{
  // dispose lands inside the Connect commit, before the pump's microtask reaches startFallback: r.fb does not exist yet.
  let disposing=null,h=null;
  h=noSudo({deps:{onState:s=>{if(s.step==='fallback'&&!disposing)disposing=h.host.dispose();}}});
  await h.drive(OPEN,{type:'continue'},{type:'connect'});
  assert.ok(disposing,'dispose ran inside the Connect commit');
  await disposing;
  await h.advance(5000);
  assert.ok(h.handoffs.made.every(made=>made.disposed===1),'every handoff made after dispose is disposed');
  assert.ok(h.handoffs.made.every(made=>made.reads===0),'no poll ever read a result');
  assert.equal(h.clock.pending(),0,'no timer outlives dispose');
  // An intent after dispose starts no new run.
  const before=h.host.getState();
  assert.deepEqual(h.host.dispatch(OPEN),before);
  await h.host.settled();
  assert.equal(h.host.getState().runId,before.runId);
  assert.deepEqual(h.calls,[]);
});
test('F14b. review 1: dispose() while the handoff is being prepared waits for it and disposes it before resolving',async()=>{
  const gate=deferred();
  const slow=noSudo({deps:{prepareHandoff:async opts=>{await gate.promise;return fakeHandoffs().prepare(opts).then(made=>{slow.late=made;return made;});}}});
  slow.host.dispatch(OPEN);await slow.host.settled();
  slow.host.dispatch({type:'continue'});await slow.host.settled();
  slow.host.dispatch({type:'connect'});
  await until(()=>slow.host.getState().step==='fallback','fallback shown');
  let done=false;
  const p=slow.host.dispose().then(()=>{done=true;});
  for(let i=0;i<20;i++)await new Promise(setImmediate);
  assert.equal(done,false,'dispose waits for the handoff being prepared');
  gate.resolve();await p;
  assert.equal(slow.late.disposed,1,'the late handoff was disposed before dispose resolved');
  assert.equal(slow.clock.pending(),0);
  assert.equal(slow.host.dispose(),slow.host.dispose(),'dispose is one promise, however often it is called');
});

const MAYBE=/If the line was run as claudebwai, it may have changed claudebwai's Claude status line\./;
test('F15. review 2: Cancel or timeout with the connect line shown and no result never says "Nothing was changed"; the disconnect line is offered',async()=>{
  for(const end of ['cancel','timeout']) {
    const h=noSudo();
    await connectRun(h);
    if(end==='cancel')await h.drive({type:'cancel'});else await h.advance(120000);
    const state=h.host.getState();
    assert.equal(state.step,'cancelled',end);
    for(const seen of h.states.filter(s=>s.step==='cancelled'))
      assert.ok(!textOf(renderWizard(seen)).includes('Nothing was changed'),`${end}: no screen claims nothing changed`);
    const html=renderWizard(state),t=textOf(html);
    assert.match(t,MAYBE,end);
    assert.equal(h.handoffs.made[0].disposed,1,end);
    assert.equal(h.handoffs.made.length,2,`${end}: the undo line is prepared`);
    assert.equal(h.handoffs.made[1].opts.action,'disconnect');
    assert.equal(h.handoffs.made[1].opts.connectionId,ID);
    assert.equal(state.fallbackUndo,'waiting');
    assert.equal(state.fallbackCommand,h.handoffs.made[1].command);
    assert.ok(t.includes(h.handoffs.made[1].command)&&intentsOf(html).includes('copy'),end);
    assert.deepEqual(h.calls,[]);
  }
  // A result that shows nothing changed keeps the plain wording.
  for(const out of [{ok:false,code:'CANCELLED',message:'Setup cancelled.'},{ok:false,code:'SETUP_FAILED',message:'x'}]) {
    const h=noSudo();
    await connectRun(h);
    h.handoffs.made[0].result=out; // it answered; Cancel lands before the next tick
    await h.drive({type:'cancel'});
    const state=h.host.getState();
    assert.match(textOf(renderWizard(state)),/Cancelled\. Nothing was changed\./,out.code);
    assert.doesNotMatch(textOf(renderWizard(state)),MAYBE);
    assert.equal(h.handoffs.made.length,1,`${out.code}: no undo line`);
  }
  // The admin line ran nothing as the target: still "Nothing was changed".
  const admin=noSudo({world:{feedExists:false}});
  await connectRun(admin);
  await admin.drive({type:'cancel'});
  assert.match(textOf(renderWizard(admin.host.getState())),/Cancelled\. Nothing was changed\./);
  // A cancelled disconnect line says its own honest equivalent, and offers no connect-side undo.
  const off=noSudo();
  await off.drive(OPEN_DISCONNECT,{type:'continue'},{type:'connect'});
  await off.drive({type:'cancel'});
  const t=textOf(renderWizard(off.host.getState()));
  assert.ok(!t.includes('Nothing was changed'),t);
  assert.match(t,/If the line was run as claudebwai, it may already have disconnected claudebwai's Claude status line from VS Code\./);
  assert.equal(off.handoffs.made.length,1);
});

test('F16. review 3: the no-sudo road refuses a feed folder VS Code cannot read, before any line and when the admin folder appears',async()=>{
  const h=noSudo({world:{readable:false}});
  let state=await connectRun(h);
  assert.equal(state.step,'cancelled');
  assert.match(state.error,/VS Code can't read the shared folder .*Nothing was run as claudebwai/);
  assert.equal(h.handoffs.made.length,0,'no line is shown');
  assert.ok(h.events.includes('precheck'));
  const late=noSudo({world:{feedExists:false,readable:false}});
  await connectRun(late);
  assert.equal(late.host.getState().fallbackAdmin,true);
  late.world.feedExists=true;
  await late.advance(250);
  state=late.host.getState();
  assert.equal(state.step,'cancelled');
  assert.match(state.error,/VS Code can't read the shared folder /);
  assert.equal(late.handoffs.made.length,0);
  assert.equal(late.clock.pending(),0);
});

test('F17. review 4: an undo line that ran calls onDisconnected with the same shape as the no-sudo disconnect',async()=>{
  const h=noSudo({world:{descriptorReadable:false}});
  await connectRun(h);
  h.handoffs.made[0].result={ok:true,connection:descriptor()};
  await h.advance(250);
  assert.equal(h.host.getState().fallbackUndo,'waiting');
  h.handoffs.made[1].result={ok:true,connection:descriptor({connected:false})};
  await h.advance(250);
  assert.equal(h.host.getState().fallbackUndo,'done');
  assert.deepEqual(h.disconnected,[[FEED,ID]]);
  // A failed undo line disconnected nothing.
  const bad=noSudo({world:{descriptorReadable:false}});
  await connectRun(bad);
  bad.handoffs.made[0].result={ok:true,connection:descriptor()};
  await bad.advance(250);
  bad.handoffs.made[1].result={ok:false,code:'SETUP_FAILED',message:'x'};
  await bad.advance(250);
  assert.equal(bad.host.getState().fallbackUndo,'failed');
  assert.deepEqual(bad.disconnected,[]);
});
