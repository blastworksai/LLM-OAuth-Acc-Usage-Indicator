'use strict';
// Connect wizard host (0.4, Task 2.1). Performs the effect wizard.cjs says is due (state.pending read with state.step)
// and answers with a result action carrying the run's runId. Effects run one at a time, in order: a user intent that
// arrives while an effect is in flight changes the state, and the next effect is read from that new state.
// The run is bound to the session's process identity (pid, uid, start_ticks, boot_id) chosen at open; terminal focus is
// never read (finding 6). busy lives in the machine and clears on a terminal step; cleanup problems become `warning`
// state, never an awaited notification (finding 1).
// The sudo password (password hosts: asked at Continue, einh's ruling of 24 Sep 2026) is held in the run's closure only,
// handed to elevate.run as an option, and set to null when the run is cleaned up. It never enters state, argv or errors.
// Root is used for: /var/lib/llm-account-usage roots, the root-owned setup bundle, creating an ABSENT feed folder, and
// rmdir of a feed folder this run created (or the disconnect road removes). An existing folder is never chowned.
// The no-sudo road (CP3, Task 3.2): sudo:'none' → Connect → `fallback`. No root is ever used on it. The host prepares a
// handoff (handoff.cjs) whose one line the member runs as the target, and polls its dropbox every POLL_MS for WAIT_MS.
// --report-dir names the shared feed only when that folder already exists with the sudo road's shape; otherwise the
// screen first shows the one admin line that makes it, and the handoff is prepared once the folder is there. A result
// goes through the same descriptor check as the sudo road. Nothing can be rolled back without sudo, so a run that may
// have changed the status line ends with a second handoff: the exact disconnect line, kept until Close or a new run.
// What the screen shows beyond the machine's state rides on the emitted copy only: fallbackCommand (the one line to run
// now), fallbackAdmin, fallbackWaitMs, fallbackUndo ('waiting'|'done'|'failed'), fallbackUnsure (a target line was shown
// and no result came back, so it may have run). The machine never sees them.
// After dispose() (the extension's deactivate) nothing new starts on this road: no handoff, no poll, no undo line.
const fsp=require('node:fs/promises');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const wizard=require('./wizard.cjs');
const {sameProcess,validatePublicConnection,publicPath,connectionIdentity}=require('./connection.cjs');
const {MANIFEST}=require('./handoff.cjs');
const POLL_MS=250,WAIT_MS=2*60*1000;
const PROFILE_DIRS={claude:'.claude',codex:'.codex',antigravity:'.gemini/antigravity-cli'}; // setup.cjs's defaults
// The target's home from /etc/passwd (world-readable), matched on uid AND name so a duplicate uid never picks a stranger.
async function passwdHome(uid,user,io=fsp) {
  for(const line of String(await io.readFile('/etc/passwd','utf8')).split('\n')) {
    const f=line.split(':');
    if(f.length>=7&&f[0]===user&&f[2]===String(uid))return f[5];
  }
  return null;
}
const PROVIDERS=['claude','codex','antigravity'];
const NAMES={claude:'Claude',codex:'Codex',antigravity:'Antigravity'};
const INTENTS=new Set(['open','retry','continue','connect','cancel','close']);
const CONNECTION_ID=/^v2-[a-f0-9]{32}$/;
const GENERIC='Setup stopped on an unexpected error.';
const safeError=(code,message)=>Object.assign(new Error(message),{code,safeToDisplay:true});
const message=error=>error?.safeToDisplay===true&&typeof error.message==='string'&&error.message?error.message:GENERIC;
// A failed setup-cli result names its reason as a code from setup.cjs; the sentence is the host's own. An unknown code falls
// back to the general sentence, so the target account can never put its own words on this screen.
const REASONS={
  UNSAFE_PATH:(u,n)=>`a file in ${u}'s ${n} profile has an unsafe owner, link, size or permission mode: it is writable by everyone, owned by another account, or hard-linked.`,
  UNSUPPORTED_STATUSLINE:(u,n)=>`${u}'s ${n} status line is not a command that can be wrapped, or it is switched off.`,
  UNSUPPORTED_HOOKS:u=>`${u}'s Codex hooks file has a shape setup does not recognise.`,
  INVALID_SETTINGS:(u,n)=>`${u}'s ${n} settings file is not a JSON object.`,
  PROFILE_REQUIRED:(u,n)=>`${u}'s ${n} profile folder was not found, or a profile override is set.`,
  CLI_NOT_FOUND:(u,n)=>`the ${n} program was not found on ${u}'s PATH.`,
  UNSUPPORTED_CLI:(u,n)=>`the ${n} program ${u} runs is not a native Linux binary setup can trust.`,
  UNSUPPORTED_RUNTIME:u=>`node, as ${u} runs it, is not a binary setup can trust.`,
  DIRECTORY_TRUST_REQUIRED:()=>'a shared folder on the profile path was not approved on the review screen.',
  ALREADY_CONNECTED:(u,n)=>`${u}'s ${n} already has an Account Usage hook.`,
  SETTINGS_CHANGED:(u,n)=>`${u}'s ${n} settings changed while setup was reading them.`,
  UNSAFE_REPORT_DIRECTORY:u=>`the report folder for ${u} is not safe to use.`,
  FEED_ALREADY_CLAIMED:u=>`the report folder for ${u} belongs to a different profile.`,
  SETUP_BUSY:u=>`another setup for ${u} is still running.`,
  UNVERIFIED_SESSION:(u,n)=>`the ${n} session could not be confirmed as ${u}'s. It may have restarted.`};
const reasonText=(out,user,name)=>{const f=out?.ok===false&&Object.hasOwn(REASONS,out.reason??'')?REASONS[out.reason]:null;
  if(!f)return null;const s=f(user,name);return s.startsWith(user)?s:s[0].toUpperCase()+s.slice(1);}; // an account name keeps its case
const processOf=p=>({pid:p.pid,uid:p.uid,start_ticks:p.start_ticks,boot_id:p.boot_id});

// The one copy of the setup-result check (was extension.cjs:128-140). Used by the wizard host, the no-sudo fallback
// (CP3) and extension.cjs (Task 2.3). Returns the verified descriptor; throws a safeToDisplay error otherwise.
// requireDescriptor:false is the disconnect --remove-feed road, where the target deleted .connection.json itself.
async function verifyDescriptor(value,{provider,uid,action='connect',connection=null,runtimeVersion,revalidate,readFeeds,readConnectionFeeds,
  requireDescriptor=true}={}) {
  if(!validatePublicConnection(value)||value.provider!==provider||value.uid!==uid||value.connected!==(action==='connect')||
    (connection&&value.id!==connection.id)||(action==='disconnect'&&value.reportDir!==connection?.reportDir)||
    (action==='connect'&&value.runtimeVersion!==runtimeVersion)||(revalidate&&!await revalidate()))
    throw safeError('UNVERIFIED_SETUP_RESULT','The target-user setup result could not be verified.');
  if(action==='connect') {
    const probe=await (readFeeds||require('./core.cjs').readFeeds)([value.reportDir]);
    if(probe.rejected)throw safeError('SHARED_FEED_UNREADABLE','The target-user report feed is not safely readable by this VS Code host. Configure a shared Linux group directory and connect again.');
  }
  if(!requireDescriptor)return value;
  const descriptors=await (readConnectionFeeds||require('./connection-feed.cjs').readConnectionFeeds)([value.reportDir]);
  if(descriptors.rejected||descriptors.connections.length!==1||!validatePublicConnection(descriptors.connections[0])||
    !Object.keys(value).every(key=>descriptors.connections[0][key]===value[key]))
    throw safeError('CONNECTION_FEED_UNREADABLE','The target-user connection descriptor could not be verified.');
  return descriptors.connections[0];
}

// deps: elevate {probe,checkPassword,run}; sharedFeed (shared-feed.cjs); detectProvider(pid,{allowForeign,topologyOnly});
// readConnectionFeeds; readFeeds; resolveUser(uid); askPassword({attempt,tries,prompt,error,signal}) -> string | undefined
// (the extension shows showInputBox({password:true,prompt,ignoreFocusOut:true}); undefined = dismissed = cancel);
// onState(state) after every change; onConnected(reportDir,process,descriptor); onDisconnected(reportDir,connectionId).
// No-sudo road: prepareHandoff (handoff.cjs); homeOf(uid,user) -> the target's home or null; now/setTimer/clearTimer
// (injectable so tests never wait two real minutes).
function createWizardHost({elevate,sharedFeed=require('./shared-feed.cjs'),detectProvider,readConnectionFeeds,readFeeds,resolveUser,askPassword,
  extensionPath,runtimeVersion,getgid=()=>process.getgid(),getuid=()=>process.getuid(),uuid=randomUUID,fs:io=fsp,manifest=MANIFEST,
  prepareHandoff=(...args)=>require('./handoff.cjs').prepareHandoff(...args),homeOf=passwdHome,
  now=()=>Date.now(),setTimer=(fn,ms)=>setTimeout(fn,ms),clearTimer=timer=>clearTimeout(timer),
  onState=()=>{},onConnected=()=>{},onDisconnected=()=>{}}={}) {
  if(!elevate||![elevate.probe,elevate.checkPassword,elevate.run,detectProvider,readConnectionFeeds,readFeeds,resolveUser,askPassword,
    prepareHandoff,homeOf,now,setTimer,clearTimer].every(value=>typeof value==='function')||!publicPath(extensionPath)||typeof runtimeVersion!=='string')
    throw new TypeError('createWizardHost: missing dependency');
  let state=wizard.initial(),run=null,inflight=null,checking=null,asking=null,disposed=false,disposing=null;
  const orphans=[],handled=new WeakSet(),ticking=new Set(),opening=new Set();
  // A fallback start, an undo offer or a fallback teardown in flight: dispose() waits for each, and each sees `disposed`.
  const track=promise=>{opening.add(promise);const done=()=>{opening.delete(promise);};promise.then(done,done);return promise;};
  // The state as the screen sees it: the machine's state plus the no-sudo road's line for the current run.
  function snapshot() {
    const s=structuredClone(state),r=run;
    if(!r||s.runId!==r.runId)return s;
    if(s.step==='fallback'&&r.fb?.command)Object.assign(s,{fallbackCommand:r.fb.command,fallbackAdmin:r.fb.phase==='folder',fallbackWaitMs:WAIT_MS});
    else if(['undone','cancelled'].includes(s.step)) {
      if(r.fb?.unsure)s.fallbackUnsure=true;
      if(r.fb&&isReconnect(r))s.fallbackReconnect=true;
      if(r.undo) {
        s.fallbackUndo=r.undo.status;
        if(r.undo.status==='waiting')s.fallbackCommand=r.undo.command;
      }
    }
    return s;
  }
  const emit=()=>{try {onState(snapshot());}catch {}};
  const commit=action=>{
    const next=wizard.step(state,action);
    if(next!==state){state=next;emit();}
    if(asking&&(state.runId!==asking.runId||state.step!=='password'))asking.controller.abort();
    kick();
    return state;
  };
  const result=(r,action)=>commit({...action,runId:r.runId});
  const live=(r,step)=>state.runId===r.runId&&state.step===step;
  const due=()=>orphans.length>0||(!!state.pending&&!handled.has(state.pending));
  // The pump starts on a microtask so `inflight` is set before any effect can dispatch: one pump, effects strictly in order.
  function kick() {if(!inflight)inflight=Promise.resolve().then(pump).finally(()=>{inflight=null;if(due())kick();});}
  async function pump() {
    for(;;) {
      if(orphans.length){const warning=await finish(orphans.shift());if(warning)commit({type:'earlierCleanup',warning});continue;}
      const pending=state.pending,r=run;
      if(!pending||handled.has(pending)||!r||state.runId!==r.runId)return;
      handled.add(pending);
      try {await perform(r,pending);}
      catch(error) {
        // Only the effect still due may report its failure. After a cancel the machine has moved on (cleanup, rollback),
        // and that next effect must still run: reporting the old error would skip it and leave the bundle behind.
        if(state.runId!==r.runId||state.pending!==pending)continue;
        if(pending.effect==='cleanup')commit({type:'cleanedUp',runId:r.runId,warning:message(error)});
        else commit({type:'failed',runId:r.runId,error:message(error)});
      }
    }
  }
  function perform(r,pending) {
    switch(pending.effect) {
      case 'detect':return detect(r);
      case 'probe':return elevate.probe().then(sudo=>result(r,{type:'sudoProbed',sudo}));
      case 'discover':return discover(r);
      case 'askPassword':return ask(r,pending.attempt);
      case 'fallback':return track(startFallback(r));
      case 'apply':return applyChange(r,pending.changes[0]);
      case 'verify':return r.raw.mode==='disconnect'?verifyDisconnect(r):verifyConnect(r);
      case 'rollback':return rollback(r,pending);
      case 'cleanup':return finish(r,state.step).then(warning=>{
        if(state.runId===r.runId)result(r,{type:'cleanedUp',...(warning?{warning}:{})});
        else if(warning)commit({type:'earlierCleanup',warning}); // replaced while rm -r ran: never lost unseen
      });
    }
  }
  // ---- elevated calls: the password is an option to elevate.run, never an argument ----
  const asRoot=(r,argv)=>elevate.run(argv,{password:r.password});
  const asTarget=(r,argv,timeoutMs=120000)=>elevate.run(argv,{asUser:r.target.user,password:r.password,timeoutMs});
  async function rootOk(r,argv,code,text) {if((await asRoot(r,argv)).code!==0)throw safeError(code,text);}
  function parseResult(out) {
    const lines=String(out?.stdout??'').split('\n').filter(Boolean);
    if(lines.length!==1)return null;
    try {const value=JSON.parse(lines[0]);return value&&typeof value==='object'&&!Array.isArray(value)?value:null;} catch {return null;}
  }
  const script=r=>`${sharedFeed.bundlePath(r.bundleId)}/src/setup-cli.cjs`;
  const targetJson=r=>JSON.stringify({provider:r.target.provider,process:processOf(r.target.process)});
  const cliArgs=r=>publicPath(r.raw.target.cliPath)?['--cli',r.raw.target.cliPath]:[];
  const connectArgv=r=>[r.node,script(r),'connect','--provider',r.target.provider,...cliArgs(r),'--profile',r.preview.profilePath,
    '--report-dir',r.feed,'--runtime-version',runtimeVersion,'--target',targetJson(r),'--consent','granted','--result','-'];
  // --remove-feed only where the folder is ours to empty: the disconnect road, or a rollback over a folder this run created.
  const disconnectArgv=(r,removeFeed=true)=>[r.node,script(r),'disconnect','--connection-id',r.connectionId,'--consent','granted',
    ...(removeFeed?['--remove-feed','yes']:[]),'--result','-'];
  // A reconnect names its saved profile; discover must read that one, never the account's default.
  const savedProfile=r=>r.raw.mode!=='disconnect'&&publicPath(r.raw.connection?.profilePath)?r.raw.connection.profilePath:null;
  const createArgv=r=>sharedFeed.createFeedArgv({connectionId:r.connectionId,uid:r.target.uid,gid:getgid()});
  // ---- identity: the process chosen at open, re-read through the terminal it was found in ----
  async function recheck(r) {
    const cli=r.raw.target.cliPath??null;
    const current=await detectProvider(r.raw.terminalPid??r.target.process.pid,{allowForeign:true,topologyOnly:cli===null});
    return !!current&&!current.unavailable&&sameProcess(current.process,r.target.process)&&
      (cli===null?current.provider===null||current.provider===r.target.provider:current.provider===r.target.provider&&current.cliPath===cli);
  }
  // ---- effects ----
  async function detect(r) {
    const {target:raw,connection}=r.raw,p=raw?.process;
    const provider=[raw?.provider,r.raw.provider,connection?.provider].find(value=>PROVIDERS.includes(value));
    if(!p||typeof p!=='object'||!Number.isSafeInteger(p.pid)||p.pid<=0||!Number.isSafeInteger(p.uid)||p.uid<0||
      typeof p.start_ticks!=='string'||typeof p.boot_id!=='string'||!provider||(raw.cliPath!=null&&!publicPath(raw.cliPath)))
      throw safeError('INVALID_TARGET','The session could not be identified. Select its terminal and try again.');
    if(connection&&(connection.provider!==provider||connection.uid!==p.uid))
      throw safeError('PROVIDER_MISMATCH','Choose the same provider and account as the profile being changed.');
    const user=await resolveUser(p.uid); // refuses a uid with no passwd entry or an unsafe name, before any sudo call
    r.target={provider,uid:p.uid,user,pid:p.pid,process:processOf(p)};
    result(r,{type:'detected',target:r.target});
  }
  async function stage(r) {
    if(r.staged)return;
    for(const name of manifest) {
      const info=await io.lstat(path.join(extensionPath,name)).catch(()=>null);
      if(!info||info.isSymbolicLink()||!info.isFile()||info.size>1024*1024)
        throw safeError('BUNDLE_SOURCE_UNSAFE','An extension file to stage is not a regular file. Nothing was changed.');
    }
    const bundleId=uuid(),argvs=sharedFeed.stageBundleArgv({bundleId,files:[...manifest],extensionPath});
    await rootOk(r,sharedFeed.ensureRootsArgv(),'ROOTS_FAILED','The Account Usage folders under /var/lib/llm-account-usage could not be made.');
    r.bundleId=bundleId;r.staged=true; // from here on, cleanup removes the bundle whatever happens
    for(const argv of argvs) {
      if(!live(r,'detecting'))return;
      await rootOk(r,argv,'BUNDLE_FAILED','The setup files could not be staged.');
    }
  }
  // The no-sudo review. Nothing runs as the target before Connect, so the profile is the saved one (reconnect,
  // disconnect) or setup.cjs's default under the target's home; the line pins it with --profile, which fixes the
  // connection id and therefore the shared feed folder's name.
  async function noSudoPreview(r) {
    const name=NAMES[r.target.provider],user=r.target.user,c=r.raw.connection;
    if(r.raw.mode==='disconnect') {
      if(!c||!CONNECTION_ID.test(c.id||'')||!publicPath(c.reportDir)||!publicPath(c.profilePath))
        throw safeError('INVALID_CONNECTION','The saved connection could not be read. Nothing was changed.');
      r.connectionId=c.id;r.feed=c.reportDir;r.profile=c.profilePath;
    } else {
      const saved=savedProfile(r);
      if(saved&&CONNECTION_ID.test(c?.id||''))r.profile=saved;
      else {
        const home=await Promise.resolve(homeOf(r.target.uid,user)).catch(()=>null);
        if(!publicPath(home))throw safeError('HOME_UNKNOWN',`${user}'s home folder could not be read from /etc/passwd, so the wizard cannot name its ${name} profile. Nothing was changed.`);
        r.profile=path.join(home,PROFILE_DIRS[r.target.provider]);
      }
      r.connectionId=connectionIdentity({provider:r.target.provider,uid:r.target.uid,
        settingsPath:path.join(r.profile,r.target.provider==='codex'?'hooks.json':'settings.json')}).id;
      r.feed=sharedFeed.feedPath(r.connectionId);
    }
    if(!live(r,'detecting'))return;
    const change=r.raw.mode==='disconnect'
      ?{id:'status',as:user,label:`Restore the ${name} status line in ${r.profile}, by one line you run as ${user}`}
      :{id:'status',as:user,label:`${name} status line in ${r.profile} reports usage to ${r.feed}, set up by one line you run as ${user}`};
    result(r,{type:'discovered',preview:{id:r.connectionId,provider:r.target.provider,profilePath:r.profile,reportDir:r.feed,sharedDirectories:[],
      hasExistingStatusLine:false,commands:[],changes:[change]}});
  }
  // ---- the no-sudo road: one line, a dropbox, a poll ----
  const handoffTarget=r=>({cliPath:publicPath(r.raw.target?.cliPath)?r.raw.target.cliPath:null,process:processOf(r.target.process),
    ...(r.raw.terminalPid?{terminalPid:r.raw.terminalPid}:{})});
  const handoffRecheck=r=>{const cli=handoffTarget(r).cliPath;
    return ()=>detectProvider(r.raw.terminalPid??r.target.process.pid,{allowForeign:true,topologyOnly:cli===null});};
  const adminLine=r=>`sudo install -d -m 2750 -o ${r.target.user} -g ${getgid()} ${r.feed}`;
  const feedShapeError=(r,info)=>safeError('FEED_FOLDER_UNSAFE',`The feed folder ${r.feed} already exists as ${info.directory?'a folder':'something other than a folder'} with owner uid ${info.uid}, `+
    `group gid ${info.gid}, mode ${(info.mode??0).toString(8)}. It must be owner uid ${r.target.uid}, group gid ${getgid()}, mode 2750. It was not changed, and nothing else was.`);
  const feedShaped=(r,info)=>info.directory&&info.uid===r.target.uid&&info.gid===getgid()&&info.mode===0o2750;
  // Review 3: the sudo road's readability precheck, on this road too, before any line runs as the target.
  const unreadableError=(r,admin)=>safeError('FEED_FOLDER_UNREADABLE',`VS Code can't read the shared folder ${r.feed}, so it could never show the usage reported there. `+
    `Nothing was run as ${r.target.user}${admin?'; the folder the admin made stays':' and nothing was changed'}.`);
  // A reconnect keeps its connection id and never rewrites the status line (CP2 round 3), so a disconnect line would
  // remove a working connection: a reconnect is never offered one (review round 2).
  const isReconnect=r=>r.raw.mode!=='disconnect'&&CONNECTION_ID.test(r.raw.connection?.id||'');
  async function startFallback(r) {
    if(disposed||!live(r,'fallback'))return;
    // unsure: a target line is on screen and has not answered; it may have run, so no screen may say nothing changed.
    r.fb={phase:null,command:null,handoff:null,deadline:0,timer:null,stopped:false,changed:false,settled:false,unsure:false};
    if(r.raw.mode!=='disconnect') {
      const info=await sharedFeed.inspectFeed(r.feed);
      if(disposed||!live(r,'fallback'))return;
      if(info.exists&&!feedShaped(r,info))throw feedShapeError(r,info);
      if(info.exists&&!await sharedFeed.precheckReadable(r.feed))throw unreadableError(r,false);
      if(disposed||!live(r,'fallback'))return;
      if(!info.exists) {
        // Without root the folder cannot be made here: the one line to show is the admin's. The poll watches for it.
        Object.assign(r.fb,{phase:'folder',command:adminLine(r)});
        arm(r);emit();return;
      }
    }
    await openHandoff(r);
  }
  async function openHandoff(r) {
    const disconnect=r.raw.mode==='disconnect';
    const handoff=await prepareHandoff({extensionPath,provider:r.target.provider,target:handoffTarget(r),action:disconnect?'disconnect':'connect',
      revalidate:handoffRecheck(r),...(disconnect?{connectionId:r.connectionId}:{runtimeVersion,profilePath:r.profile,reportDir:r.feed})});
    if(disposed||r.fb.stopped||!live(r,'fallback')){await handoff.dispose().catch(()=>{});return;}
    Object.assign(r.fb,{phase:'result',handoff,command:handoff.command,unsure:true});
    arm(r);emit();
  }
  // Each line gets its own two minutes from the moment it is shown.
  function arm(r) {r.fb.deadline=now()+WAIT_MS;schedule(r,r.fb,()=>fallbackTick(r));}
  function schedule(r,watch,fn) {
    if(watch.stopped||disposed)return;
    watch.timer=setTimer(()=>{
      watch.timer=null;
      if(watch.stopped||disposed)return;
      const p=Promise.resolve().then(fn).catch(()=>{}).finally(()=>{ticking.delete(p);watch.busy=null;});
      watch.busy=p;ticking.add(p);
    },POLL_MS);
  }
  async function fallbackTick(r) {
    const fb=r.fb;
    if(fb.stopped||!live(r,'fallback'))return;
    try {
      if(fb.phase==='folder') {
        const info=await sharedFeed.inspectFeed(r.feed);
        if(fb.stopped||!live(r,'fallback'))return;
        if(info.exists) {
          if(!feedShaped(r,info))return result(r,{type:'failed',error:feedShapeError(r,info).message});
          const readable=await sharedFeed.precheckReadable(r.feed);
          if(fb.stopped||!live(r,'fallback'))return;
          if(!readable)return result(r,{type:'failed',error:unreadableError(r,true).message});
          return await openHandoff(r);
        }
        if(now()>=fb.deadline)return result(r,{type:'failed',error:`The shared folder ${r.feed} did not appear within 2 minutes, so the wizard stopped waiting. Nothing was changed. Once an admin has made it, press Start again.`});
        return schedule(r,fb,()=>fallbackTick(r));
      }
      let out;
      try {out=await fb.handoff.readResult();}
      catch {
        if(fb.stopped||!live(r,'fallback'))return;
        fb.settled=true;fb.unsure=r.raw.mode==='disconnect';fb.changed=r.raw.mode!=='disconnect';
        return result(r,{type:'fallbackResult',ok:false,error:`The line ran as ${r.target.user}, but its result could not be verified.`});
      }
      if(fb.stopped||!live(r,'fallback'))return;
      if(out==null) {
        if(now()>=fb.deadline)return result(r,{type:'failed',error:'Nothing came back from the line within 2 minutes, so the wizard stopped waiting and the line no longer works. Press Start again for a new one.'});
        return schedule(r,fb,()=>fallbackTick(r));
      }
      fb.settled=true;fb.unsure=false;
      if(out.ok===true) {
        r.connection=out.connection;
        if(r.raw.mode!=='disconnect'){fb.changed=true;r.connectionId=out.connection.id;}
        return result(r,{type:'fallbackResult',ok:true,change:{id:'status',as:r.target.user}});
      }
      const user=r.target.user,why=reasonText(out,user,NAMES[r.target.provider]);
      if(out.code==='SETUP_FAILED_CHANGED'&&r.raw.mode!=='disconnect')fb.changed=true;
      const error=out.code==='CANCELLED'?`The line was cancelled as ${user}. Nothing was changed.`
        :fb.changed&&!isReconnect(r)?`Setup as ${user} stopped after it had changed the status line.`
        :r.raw.mode==='disconnect'?`Disconnect as ${user} could not finish. Nothing was removed.`
        :`Setup as ${user} could not finish; its status line was not changed.`;
      result(r,{type:'fallbackResult',ok:false,error:why&&out.code!=='CANCELLED'?`${error} ${why}`:error});
    } catch(error) {
      if(!fb.stopped&&live(r,'fallback'))result(r,{type:'failed',error:message(error)});
    }
  }
  // Ends the fallback watch and disposes its handoff. A line that ran just before Cancel or the timeout is still read,
  // so the screen never says "Nothing was changed" over a change. A line that gives no answer may still be running, or
  // may have run without publishing yet (review 2): it stays unsure, and a connect line is treated as maybe-changed, so
  // the undo line is offered. Returns a warning or null.
  async function endFallback(r) {
    const fb=r.fb,connect=r.raw.mode!=='disconnect',warnings=[];
    fb.stopped=true;
    if(fb.timer){clearTimer(fb.timer);fb.timer=null;}
    if(fb.busy)await fb.busy;
    if(fb.phase==='folder'&&connect) {
      const info=await sharedFeed.inspectFeed(r.feed).catch(()=>null);
      if(info?.exists)warnings.push(`Nothing was run as ${r.target.user}. The shared folder ${r.feed} the admin made stays; an admin can remove it.`);
    }
    if(fb.handoff) {
      if(!fb.settled) {
        let out=null,bad=false;
        try {out=await fb.handoff.readResult();} catch {bad=true;}
        if(bad||out!=null)fb.unsure=false; // it answered, one way or the other
        if(fb.unsure&&connect)fb.changed=true;
        if(bad||out?.ok===true||(out?.code==='SETUP_FAILED_CHANGED')) {
          if(connect){fb.changed=true;if(out?.ok===true){r.connection=out.connection;r.connectionId=out.connection.id;}
            warnings.push(`The line had already run as ${r.target.user} before the wizard stopped, so its status line was changed.`);}
          else if(out?.ok===true) {
            await Promise.resolve(onDisconnected(r.raw.connection.reportDir,r.raw.connection.id)).catch(()=>{});
            warnings.push(`The line had already run as ${r.target.user} before the wizard stopped: it is disconnected.`);
          }
        }
      }
      const done=await fb.handoff.dispose().catch(()=>({removed:false}));
      if(done?.removed!==true)warnings.push(typeof done?.warning==='string'&&done.warning?done.warning:'The fallback setup files could not all be removed.');
      fb.handoff=null;
    }
    return warnings.join(' ')||null;
  }
  // No rollback runs without sudo: a run that may have changed the status line gets the exact disconnect line instead.
  async function offerUndo(r) {
    if(disposed)return null;
    try {
      const handoff=await prepareHandoff({extensionPath,provider:r.target.provider,target:handoffTarget(r),action:'disconnect',
        connectionId:r.connectionId,revalidate:handoffRecheck(r)});
      if(disposed||r.released||run!==r){await handoff.dispose().catch(()=>{});return null;} // replaced, closed or disposed meanwhile
      r.undo={handoff,command:handoff.command,status:'waiting',stopped:false,timer:null,busy:null};
      schedule(r,r.undo,()=>undoTick(r));
      return null;
    } catch {
      return `The undo line could not be prepared. ${r.target.user}'s ${NAMES[r.target.provider]} status line in ${r.profile} has to be put back by hand.`;
    }
  }
  async function undoTick(r) {
    const u=r.undo;
    if(!u||u.stopped)return;
    let out;
    try {out=await u.handoff.readResult();} catch {out={ok:false};}
    if(u.stopped)return;
    if(out==null)return schedule(r,u,()=>undoTick(r));
    u.status=out.ok===true?'done':'failed';
    // Review 4: the undo line disconnected it, so the editor forgets the feed, the same call the no-sudo disconnect makes.
    if(out.ok===true)await Promise.resolve(onDisconnected(out.connection.reportDir,out.connection.id)).catch(()=>{});
    await releaseUndo(r,false);
    if(run===r)emit();
  }
  async function releaseUndo(r,wait=true) {
    if(r&&wait)r.released=true;
    const u=r?.undo;
    if(!u||u.stopped)return;
    u.stopped=true;
    if(u.timer){clearTimer(u.timer);u.timer=null;}
    if(wait&&u.busy)await u.busy;
    await u.handoff.dispose().catch(()=>{});
  }
  async function discover(r) {
    if(state.sudo==='none')return noSudoPreview(r);
    await stage(r);
    if(!live(r,'detecting'))return;
    const found=await asTarget(r,['/bin/sh','-c','command -v node'],15000),node=found.stdout.trim();
    if(!live(r,'detecting'))return;
    if(found.code!==0||!publicPath(node)) {
      result(r,{type:'sudoProbed',sudo:'none',reason:`node is not on sudo’s secure_path for ${r.target.user}.`});
      return noSudoPreview(r);
    }
    r.node=node;
    const name=NAMES[r.target.provider],user=r.target.user;
    if(r.raw.mode==='disconnect') {
      const c=r.raw.connection;
      if(!c||!CONNECTION_ID.test(c.id||'')||!publicPath(c.reportDir)||!publicPath(c.profilePath))
        throw safeError('INVALID_CONNECTION','The saved connection could not be read. Nothing was changed.');
      r.connectionId=c.id;r.feed=c.reportDir;r.feedRoad=c.reportDir===sharedFeed.feedPath(c.id);r.preview={profilePath:c.profilePath};
      const changes=[{id:'status',as:user,label:`Restore the ${name} status line in ${c.profilePath} (as ${user})`},
        ...(r.feedRoad?[{id:'folder',as:'root',path:r.feed,label:`Remove the shared folder ${r.feed} (as root)`}]:[])];
      return result(r,{type:'discovered',preview:{id:c.id,provider:r.target.provider,profilePath:c.profilePath,reportDir:c.reportDir,changes,
        sharedDirectories:[],hasExistingStatusLine:false,
        commands:[{as:user,argv:disconnectArgv(r)},...(r.feedRoad?[{as:'root',argv:sharedFeed.removeFeedArgv(c.id)}]:[])]}});
    }
    const saved=savedProfile(r);
    const out=parseResult(await asTarget(r,[node,script(r),'discover','--provider',r.target.provider,...cliArgs(r),...(saved?['--profile',saved]:[]),
      '--target',targetJson(r),'--result','-']));
    const p=out?.ok===true?out.preview:null;
    if(!p||typeof p!=='object'||!CONNECTION_ID.test(p.id||'')||p.provider!==r.target.provider||!publicPath(p.profilePath)||(saved&&p.profilePath!==saved))
      throw safeError('DISCOVER_FAILED',out?.ok===false&&reasonText(out,user,name)?`${reasonText(out,user,name)} Nothing was changed.`
        :`${user} could not read its ${name} profile. Nothing was changed.`);
    if(!live(r,'detecting'))return;
    r.connectionId=p.id;r.feed=sharedFeed.feedPath(p.id);r.preview={profilePath:p.profilePath};
    const gid=getgid(),info=await sharedFeed.inspectFeed(r.feed);
    if(info.exists&&(!info.directory||info.uid!==r.target.uid||info.gid!==gid||info.mode!==0o2750))
      throw safeError('FEED_FOLDER_UNSAFE',`The feed folder ${r.feed} already exists as ${info.directory?'a folder':'something other than a folder'} with owner uid ${info.uid}, `+
        `group gid ${info.gid}, mode ${(info.mode??0).toString(8)}. It must be owner uid ${r.target.uid}, group gid ${gid}, mode 2750. It was not changed, and nothing else was.`);
    r.createFolder=!info.exists;
    const changes=[...(r.createFolder?[{id:'folder',as:'root',path:r.feed,label:`Create the shared feed folder ${r.feed}: owner ${user}, group ${gid}, mode 2750 (as root)`}]:[]),
      {id:'status',as:user,label:`${name} status line in ${p.profilePath} reports usage to ${r.feed} (as ${user})`}];
    result(r,{type:'discovered',preview:{id:p.id,provider:r.target.provider,profilePath:p.profilePath,settingsPath:p.settingsPath,reportDir:r.feed,
      previousReportDir:p.reportDir!==r.feed&&publicPath(p.reportDir)?p.reportDir:null,changes,
      sharedDirectories:Array.isArray(p.sharedDirectories)?p.sharedDirectories:[],hasExistingStatusLine:p.hasExistingStatusLine===true,
      hasExistingHooks:p.hasExistingHooks===true,commands:[...(r.createFolder?[{as:'root',argv:sharedFeed.claimFeedArgv(r.connectionId)},{as:'root',argv:createArgv(r)}]:[]),{as:user,argv:connectArgv(r)}]}});
  }
  async function ask(r,attempt) {
    if(!live(r,'password'))return;
    const who=await resolveUser(getuid()).catch(()=>null);
    const controller=new AbortController();asking={runId:r.runId,controller};
    let secret;
    try {
      secret=await askPassword({attempt,tries:3,prompt:`Password for ${who||'your account'} on this host (sudo)`,error:state.error,signal:controller.signal});
      if(!live(r,'password'))return;
      if(typeof secret!=='string')return commit({type:'cancel'}); // the box was dismissed
      let ok=false;
      try {ok=await elevate.checkPassword(secret);} catch(error) {if(error?.code!=='INVALID_PASSWORD')throw error;}
      if(!live(r,'password'))return;
      if(ok)r.password=secret;
      result(r,{type:ok?'password':'wrongPassword'});
    } finally {secret=null;if(asking?.controller===controller)asking=null;}
  }
  async function applyChange(r,change) {
    if(!live(r,'connecting')||!change)return;
    const connect=r.raw.mode!=='disconnect';
    if(connect&&change.id==='folder')return createFolder(r);
    if(connect&&change.id==='status')return connectStatus(r);
    if(change.id==='status')return disconnectStatus(r);
    if(change.id==='folder')return removeFolder(r);
    throw safeError('UNKNOWN_CHANGE','The wizard does not know how to make that change.');
  }
  async function createFolder(r) {
    if((await sharedFeed.inspectFeed(r.feed)).exists)
      throw safeError('FEED_FOLDER_APPEARED','The feed folder appeared after the review. Nothing was changed; press Retry to review it again.');
    // The claim is atomic: only a run whose mkdir succeeded owns the folder, so a second window racing on the same
    // profile can never empty or remove this one's folder, and install -d never re-owns a folder it did not claim.
    let claimed=null;
    try {claimed=(await asRoot(r,sharedFeed.claimFeedArgv(r.connectionId))).code;} catch {}
    if(claimed===null) {
      // mkdir gave no answer (timeout): a root-owned 0700 folder is the claim's own shape, so record it and let the
      // rollback rmdir it (empty, so harmless) rather than strand a folder the next review would refuse.
      const after=await sharedFeed.inspectFeed(r.feed).catch(()=>null);
      if(after?.exists&&after.directory&&after.uid===0&&after.mode===0o700)
        result(r,{type:'applied',change:{id:'folder',as:'root',path:r.feed,created:true,uncertain:true}});
    }
    if(claimed!==0) {
      if(live(r,'connecting'))result(r,{type:'failed',error:`The shared feed folder ${r.feed} could not be claimed: another setup may have made it first. Press Retry to review it again.`});
      return;
    }
    result(r,{type:'applied',change:{id:'folder',as:'root',path:r.feed,created:true}});
    let code=null;
    try {code=(await asRoot(r,createArgv(r))).code;} catch {}
    const readable=code===0&&await sharedFeed.precheckReadable(r.feed);
    // Finding 4: the host proves it can read the folder before the target account is touched at all.
    if(!readable&&(live(r,'connecting')||live(r,'verifying')))
      result(r,{type:'failed',error:code===0?'VS Code could not read the feed folder.':'Creating the shared feed folder failed.'});
  }
  async function connectStatus(r) {
    const change={id:'status',as:r.target.user};
    let out,thrown=null;
    try {out=parseResult(await asTarget(r,connectArgv(r)));} catch(error) {thrown=error;}
    if(out?.ok===true&&out.connection){r.connection=out.connection;return result(r,{type:'applied',change});}
    // A failure before setup-cli touched the provider settings changed nothing: undoing it would disconnect a profile
    // that was already working (a reconnect). SETUP_FAILED_CHANGED, or no readable result, may have changed the status
    // line, so that is recorded as uncertain and the rollback restores it.
    if(out?.ok===false&&out.code!=='SETUP_FAILED_CHANGED') {
      const why=reasonText(out,r.target.user,NAMES[r.target.provider]);
      if(live(r,'connecting'))result(r,{type:'failed',error:why?`Setup as ${r.target.user} stopped. ${why} Its status line was not changed.`
        :`Setup as ${r.target.user} could not finish; its status line was not changed. Review the selected profile, executable and report-directory permissions.`});
      return;
    }
    result(r,{type:'applied',change:{...change,uncertain:true}});
    const undoWhy=reasonText(out,r.target.user,NAMES[r.target.provider]);
    if(live(r,'verifying'))result(r,{type:'failed',error:out?.ok===false?(undoWhy?`Setup as ${r.target.user} stopped, so it is being undone. ${undoWhy}`
      :`Setup as ${r.target.user} could not finish, so it is being undone. Review the selected profile, executable and report-directory permissions.`)
      :thrown?message(thrown):`Setup as ${r.target.user} gave no readable result, so it is being undone.`});
  }
  async function verifyConnect(r) {
    let descriptor;
    try {
      descriptor=await verifyDescriptor(r.connection,{provider:r.target.provider,uid:r.target.uid,action:'connect',runtimeVersion,
        revalidate:()=>recheck(r),readFeeds,readConnectionFeeds});
      if(descriptor.reportDir!==r.feed||descriptor.id!==r.connectionId)throw safeError('UNVERIFIED_SETUP_RESULT','The target-user setup result could not be verified.');
      if(!live(r,'verifying'))return;
      await onConnected(r.feed,{...r.target.process},descriptor);
    } catch(error) {if(live(r,'verifying'))result(r,{type:'failed',error:message(error)});return;}
    result(r,{type:'verified',connection:descriptor});
  }
  async function disconnectStatus(r) {
    const out=parseResult(await asTarget(r,disconnectArgv(r)));
    if(out?.ok!==true)throw safeError('DISCONNECT_FAILED',`Disconnect as ${r.target.user} could not finish. Nothing was removed.`);
    const value=await verifyDescriptor(out.connection,{provider:r.target.provider,uid:r.target.uid,action:'disconnect',connection:r.raw.connection,
      readFeeds,readConnectionFeeds,requireDescriptor:false});
    r.connection=value;r.feedRemoved=out.feed?.removed===true;
    await onDisconnected(value.reportDir,value.id); // it is disconnected now, whatever happens to the folder
    result(r,{type:'applied',change:{id:'status',as:r.target.user}});
  }
  async function removeFolder(r) {
    if(!r.feedRemoved)throw safeError('FEED_NOT_EMPTY',`The shared folder ${r.feed} holds entries Account Usage did not create, so it was kept.`);
    if((await asRoot(r,sharedFeed.removeFeedArgv(r.connectionId))).code!==0)throw safeError('FEED_REMOVE_FAILED',`rmdir refused: the shared folder ${r.feed} was kept.`);
    result(r,{type:'applied',change:{id:'folder',as:'root',path:r.feed}});
  }
  async function verifyDisconnect(r) {
    if(r.fb) {
      // The no-sudo road: the line disconnected as the target; the folder stays, since removing it needs root.
      const value=await verifyDescriptor(r.connection,{provider:r.target.provider,uid:r.target.uid,action:'disconnect',connection:r.raw.connection,
        readFeeds,readConnectionFeeds,requireDescriptor:false});
      if(!live(r,'verifying'))return;
      await onDisconnected(value.reportDir,value.id);
      const kept=value.reportDir===sharedFeed.feedPath(value.id);
      return result(r,{type:'verified',connection:value,
        ...(kept?{warning:`The shared folder ${value.reportDir} stays: removing it needs an admin (sudo rmdir after its files are gone).`}:{})});
    }
    if(r.feedRoad&&(await sharedFeed.inspectFeed(r.feed)).exists)throw safeError('FEED_FOLDER_LEFT',`The shared folder ${r.feed} is still there.`);
    result(r,{type:'verified',connection:r.connection});
  }
  async function rollback(r,{undo,keep}) {
    const undone=[],kept=[...keep];
    for(const change of undo) { // already in reverse order; every step is attempted
      try {
        if(change.id==='status') {
          const out=parseResult(await asTarget(r,disconnectArgv(r,r.createFolder===true)));
          if(out?.ok===true)undone.push(change);else kept.push({...change,reason:'The status line could not be restored automatically.'});
        } else if(change.id==='folder'&&change.created===true) {
          // A claim whose mkdir gave no answer is only ours while it still has the bare claim's shape: once another run's
          // install -d has handed it to the target, it is that run's folder and stays.
          const now=change.uncertain===true?await sharedFeed.inspectFeed(r.feed).catch(()=>null):null;
          if(change.uncertain===true&&!(now?.exists&&now.directory&&now.uid===0&&now.mode===0o700))
            kept.push({...change,reason:'Another setup took this folder over, so it was left for that setup.'});
          else if((await asRoot(r,sharedFeed.removeFeedArgv(r.connectionId))).code===0)undone.push(change);
          else kept.push({...change,reason:'rmdir refused: the folder is not empty.'});
        } else kept.push({...change,reason:'Not undone automatically.'});
      } catch(error) {kept.push({...change,reason:message(error)});}
    }
    const left=kept.filter(change=>change.reason);
    result(r,{type:'rolledBack',undone,kept,...(left.length?{warning:`Still in place: ${left.map(change=>change.path||change.id).join(', ')}.`}:{})});
  }
  // ended: the step the run finished on, when it is still the current run (null for a replaced one, which nobody sees).
  async function finish(r,ended=null) {
    if(r.finished)return null;
    r.finished=true;
    const warnings=[];
    try {
      if(r.fb) {
        const warning=await track(endFallback(r));
        if(warning)warnings.push(warning);
        if(r.fb.changed&&r.raw.mode!=='disconnect'&&!isReconnect(r)&&['undone','cancelled'].includes(ended)&&run===r) {
          const failed=await track(offerUndo(r));
          if(failed)warnings.push(failed);
        }
      }
      if(r.staged) {
        let removed=false;
        try {removed=(await asRoot(r,sharedFeed.removeBundleArgv(r.bundleId))).code===0;} catch {}
        if(!removed)warnings.push(`The setup bundle could not be removed: ${sharedFeed.bundlePath(r.bundleId)}.`);
      }
      return warnings.join(' ')||null;
    } finally {r.password=null;}
  }
  // ---- intents ----
  function open({mode='connect',target,terminalPid,connection=null,provider}={}) {
    if(!wizard.can.open(state))return commit({type:'open'});
    const runId=uuid(),before=run;
    if(before&&!before.finished)orphans.push(before);
    if(before)void releaseUndo(before); // a new run ends the previous run's undo line
    run={runId,raw:{mode,target,terminalPid:Number.isSafeInteger(terminalPid)&&terminalPid>0?terminalPid:undefined,connection,provider},password:null};
    commit({type:'open',runId,mode,target:null,connection:connection&&typeof connection==='object'?
      {id:connection.id,provider:connection.provider,uid:connection.uid,profilePath:connection.profilePath,reportDir:connection.reportDir}:null});
    return state;
  }
  function retry() {
    if(!wizard.can.retry(state)||!run?.target)return commit({type:'retry'});
    const before=run,runId=uuid();
    if(!before.finished)orphans.push(before);
    void releaseUndo(before);
    run={runId,raw:before.raw,target:before.target,password:null};
    return commit({type:'retry',runId});
  }
  function connect() {
    if(checking&&checking.runId===state.runId)return state; // one re-check per run; a cancelled run's never blocks the next
    if(!wizard.can.connect(state))return commit({type:'connect'});
    const r=run;
    // Re-check the process identity before anything is written; focus is never consulted.
    const mine={runId:r.runId};
    mine.promise=recheck(r).catch(()=>false).then(alive=>{
      if(!live(r,'review'))return;
      if(alive)commit({type:'connect'});else result(r,{type:'sessionEnded'});
    }).finally(()=>{if(checking===mine)checking=null;});
    checking=mine;
    return state;
  }
  function dispatch(action) {
    const type=action?.type;
    if(disposed||!INTENTS.has(type))return state; // host results never come from outside; after dispose nothing new starts
    if(type==='open')return open(action);
    if(type==='retry')return retry();
    if(type==='connect')return connect();
    const before=run;
    const next=commit({type});
    if(type==='close'&&next.step==='idle'&&before)void releaseUndo(before); // Close ends the undo line with the wizard
    return next;
  }
  // Waits for effects, the Connect re-check and any poll tick in flight; a waiting fallback itself is not awaited.
  async function settled() {
    while(inflight||checking||ticking.size)await (inflight||checking?.promise||[...ticking][0]);
    return snapshot();
  }
  // For the extension's deactivate: stops every poll and disposes every handoff this host still holds. It marks the host
  // disposed first, so a fallback effect still queued behind a microtask, a poll tick or an undo offer starts nothing
  // (review 1), then waits for whatever is already in flight, which sees the mark and disposes what it made. One promise.
  function dispose() {
    if(disposing)return disposing;
    disposed=true;
    disposing=(async()=>{
      while(opening.size||ticking.size)await Promise.allSettled([...opening,...ticking]);
      const r=run;
      if(!r)return;
      await releaseUndo(r);
      if(r.fb&&!r.fb.stopped)await endFallback(r).catch(()=>{});
    })();
    return disposing;
  }
  return {dispatch,getState:snapshot,settled,dispose};
}
module.exports={createWizardHost,verifyDescriptor};
