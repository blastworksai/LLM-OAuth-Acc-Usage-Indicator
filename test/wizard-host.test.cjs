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
