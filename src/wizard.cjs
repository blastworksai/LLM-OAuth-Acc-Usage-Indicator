'use strict';
// Connect wizard state machine (0.4). Lifted from the approved board, prototypes/connect-wizard.prototype.html
// (Wizard). Pure: no I/O, no clock, no randomness; step(state,action) returns a new state and never mutates.
// The host (wizard-host.cjs) performs effects. What is due is state.pending, read together with state.step:
//   detecting  {effect:'detect'}                resolve the target process (only when open came without one) -> detected
//   detecting  {effect:'probe'}                 probe sudo -> sudoProbed
//   detecting  {effect:'discover'}              read-only discover as the target -> discovered
//   password   {effect:'askPassword',attempt}   show the VS Code password box, check it -> password | wrongPassword
//              (password host only, reached from Continue: the accepted password is held by the host for the whole run,
//               so discover runs with it, Review lists the real changes and Connect writes without asking again;
//               einh's ruling of 24 Sep 2026, "Password at Continue")
//   fallback   {effect:'fallback'}              show the one line, poll the dropbox -> fallbackResult
//   connecting {effect:'apply',changes}         apply the remaining changes in order, one applied per change
//   verifying  {effect:'verify'}                read the connection descriptor, re-check the process -> verified | failed
//   undoing    {effect:'rollback',undo,keep}    undo `undo` in the listed (reverse) order, leave `keep` -> rolledBack
//   connected|undone|cancelled {effect:'cleanup'}  remove the bundle / dispose the handoff -> cleanedUp
// User intents (webview, through the host; no runId):
//   {type:'open',runId,mode:'connect'|'disconnect',target:{provider,uid,user,pid,process}|null,connection?}
//   {type:'retry',runId}  (undone|cancelled: a fresh run on the same target)
//   {type:'continue'} {type:'connect'} {type:'cancel'}
//   {type:'close'}  (connected|undone|cancelled, once cleanup has settled: back to initial(), the card shows again)
// Host results (all carry the current runId; a stale runId returns the state unchanged):
//   {type:'detected',runId,target}            {type:'sudoProbed',runId,sudo:'passwordless'|'password'|'none',reason?}
//   {type:'discovered',runId,preview:{profilePath,reportDir,changes:[{id,as,label,...}],sharedDirectories,hasExistingStatusLine}}
//   {type:'password',runId}  (sudo accepted it; the password itself is never an action field the machine reads)
//   {type:'wrongPassword',runId}
//   {type:'applied',runId,change:{id,created?,as?,label?,path?}}  (folder: created:true only if this run made it)
//   {type:'verified',runId,connection?,warning?}   {type:'failed',runId,error,warning?}
//   {type:'rolledBack',runId,undone:[id|change],kept:[id|change],warning?}
//   {type:'sessionEnded',runId}   {type:'fallbackResult',runId,ok,change?,error?,warning?}   {type:'cleanedUp',runId,warning?}
//   {type:'earlierCleanup',warning}  a replaced run's bundle could not be removed: shown on whatever run is current
// Every entry of preview.changes must be reported by `applied`; the last one moves the run to verifying.
// Focus is not an action: the run is bound to target.process from open (finding 6). busy is the only lock and
// clears on a terminal step, before cleanup; cleanup problems land in `warning`, never block (finding 1).
// `undoing` is added to the plan's step set: the machine has to say a rollback is due and wait for its result.
// `connected` is the successful end in both modes; the view words it by `mode`.
const STEPS=Object.freeze(['idle','detecting','detected','review','password','fallback','connecting','verifying','undoing','connected','undone','cancelled']);
const TERMINAL=new Set(['connected','undone','cancelled']);
const BEFORE_CONNECT=new Set(['detecting','detected','review','password','fallback']);
const APPLYING=new Set(['connecting','verifying']);
const SUDO=new Set(['passwordless','password','none']);
const RESULTS=new Set(['detected','sudoProbed','discovered','password','wrongPassword','applied','verified','failed','rolledBack','sessionEnded','fallbackResult','cleanedUp']);
const NAMES={claude:'Claude',codex:'Codex',antigravity:'Antigravity'};
const LOG_MAX=50;
const initial=()=>({mode:'connect',step:'idle',target:null,connection:null,sudo:'unknown',sudoReason:null,preview:null,
  applied:[],undone:[],kept:[],tries:0,error:null,warning:null,busy:false,runId:null,pending:null,log:[]});
const log=(s,m)=>({...s,log:[...s.log,m].slice(-LOG_MAX)});
const name=s=>NAMES[s.target?.provider]||'AI';
const text=(value,fallback)=>typeof value==='string'&&value?value:fallback;
const warn=(s,w)=>typeof w==='string'&&w?[s.warning,w].filter(Boolean).join(' '):s.warning;
const fresh=(s,a)=>typeof a?.runId==='string'&&a.runId.length>0&&a.runId!==s.runId;
const change=c=>c&&typeof c==='object'&&!Array.isArray(c)&&typeof c.id==='string'&&c.id?{...c}:null;
const pending=(s,effect)=>s.pending?.effect===effect;
function target(t) {
  if(!t||typeof t!=='object'||!t.process||typeof t.process!=='object')return null;
  return {provider:t.provider??null,uid:t.uid??t.process.uid??null,user:t.user??null,pid:t.pid??t.process.pid??null,process:{...t.process}};
}
function preview(p) {
  if(!p||typeof p!=='object'||!Array.isArray(p.changes))return null;
  const changes=p.changes.map(change);
  if(changes.some(c=>!c)||new Set(changes.map(c=>c.id)).size!==changes.length)return null;
  return {...p,changes,sharedDirectories:Array.isArray(p.sharedDirectories)?[...p.sharedDirectories]:[],hasExistingStatusLine:!!p.hasExistingStatusLine};
}
const remaining=s=>(s.preview?.changes||[]).filter(c=>!s.applied.some(a=>a.id===c.id));
const finish=(s,step,extra={})=>({...s,...extra,step,busy:false,pending:{effect:'cleanup'}});
const labels=list=>list.length?list.map(c=>c.id).join(', '):'nothing';
function list(value,s) {
  if(!Array.isArray(value))return null;
  return value.map(v=>typeof v==='string'?{...(s.applied.find(c=>c.id===v)||{id:v})}:change(v)).filter(Boolean);
}
function start(s,a,t,mode,connection) {
  const run={...initial(),mode,target:t,connection:connection&&typeof connection==='object'?{...connection}:null,
    busy:true,runId:a.runId,step:'detecting',pending:{effect:t?'probe':'detect'},log:s.log};
  return log(run,t?`Wizard opened on the ${name(run)} session (pid ${t.pid}, runs as ${t.user}).`:'Wizard opened; finding the session.');
}
function apply(s) {
  const changes=remaining(s);
  if(!changes.length)return {...s,step:'verifying',pending:{effect:'verify'}};
  return {...s,step:'connecting',pending:{effect:'apply',changes}};
}
function rollback(s,why) {
  if(s.mode==='disconnect') {
    // Every change was made and only the final check failed: it is disconnected, with the check's problem as a warning.
    if(!remaining(s).length)return log(finish(s,'connected',{error:null,warning:warn(s,why)}),`Disconnected; the final check reported: ${why}`);
    return log(finish(s,'undone',{error:why,undone:[],kept:remaining(s)}),`${why} Nothing was undone; still in place: ${labels(remaining(s))}.`);
  }
  const done=[...s.applied].reverse();
  if(s.sudo==='none')return log(finish(s,'undone',{error:why,undone:[],kept:done}),`${why} No sudo here, so these stay until undone by hand: ${labels(done)}.`);
  const undo=done.filter(c=>c.id!=='folder'||c.created===true), keep=done.filter(c=>c.id==='folder'&&c.created!==true);
  return log({...s,step:'undoing',error:why,pending:{effect:'rollback',undo,keep}},`${why} Undoing: ${labels(undo)}.`);
}

const can={
  open:(s,a)=>!s.busy&&(!a||fresh(s,a)&&[undefined,'connect','disconnect'].includes(a.mode)&&(a.target==null||!!target(a.target))),
  retry:(s,a)=>!s.busy&&['undone','cancelled'].includes(s.step)&&!!s.target&&(!a||fresh(s,a)),
  continue:s=>s.step==='detected',
  connect:s=>s.step==='review'&&SUDO.has(s.sudo),
  cancel:s=>s.busy&&s.step!=='undoing'&&!(s.mode==='disconnect'&&APPLYING.has(s.step)),
  close:s=>!s.busy&&TERMINAL.has(s.step)&&s.pending===null,
  detected:(s,a)=>s.step==='detecting'&&pending(s,'detect')&&(!a||!!target(a.target)),
  sudoProbed:(s,a)=>s.step==='detecting'&&(pending(s,'probe')||pending(s,'discover'))&&(!a||SUDO.has(a.sudo)),
  discovered:s=>s.step==='detecting'&&pending(s,'discover'),
  password:s=>s.step==='password',
  wrongPassword:s=>s.step==='password',
  applied:(s,a)=>(s.step==='connecting'||s.step==='undoing')&&(!a||!!change(a.change)&&!s.applied.some(c=>c.id===a.change.id)),
  verified:s=>s.step==='verifying',
  failed:s=>['detecting','password','fallback','connecting','verifying','undoing'].includes(s.step),
  rolledBack:s=>s.step==='undoing',
  sessionEnded:s=>BEFORE_CONNECT.has(s.step)||APPLYING.has(s.step),
  fallbackResult:s=>s.step==='fallback',
  cleanedUp:s=>TERMINAL.has(s.step)&&pending(s,'cleanup'),
  earlierCleanup:(s,a)=>!!a&&typeof a.warning==='string'&&!!a.warning,
};

function step(s,a) {
  if(!a||typeof a!=='object'||typeof a.type!=='string')return s;
  if(RESULTS.has(a.type)&&a.runId!==s.runId)return s;
  if(!Object.hasOwn(can,a.type)||!can[a.type](s,a))return log(s,`(Not possible right now: ${a.type})`);
  switch(a.type) {
    case 'open':return start(s,a,a.target==null?null:target(a.target),a.mode||'connect',a.connection);
    case 'retry':return start(s,a,s.target,s.mode,s.connection);
    case 'detected':{
      const run={...s,target:target(a.target),pending:{effect:'probe'}};
      return log(run,`Wizard opened on the ${name(run)} session (pid ${run.target.pid}, runs as ${run.target.user}).`);
    }
    case 'sudoProbed':{
      const run={...s,sudo:a.sudo,sudoReason:text(a.reason,null)};
      return pending(s,'probe')?{...run,step:'detected',pending:null}:run;
    }
    case 'continue':
      if(s.sudo==='password')return log({...s,step:'password',error:null,pending:{effect:'askPassword',attempt:1}},'sudo needs a password: VS Code password box shown. Nothing is written until you press Connect.');
      return {...s,step:'detecting',pending:{effect:'discover'}};
    case 'discovered':{
      const p=preview(a.preview);
      if(!p)return log(finish(s,'cancelled',{error:'The setup preview could not be read. Nothing was changed.'}),'Discover returned no usable preview.');
      return log({...s,step:'review',preview:p,pending:null},'Showing exactly what will change. Nothing written yet.');
    }
    case 'connect':
      if(s.sudo==='passwordless')return apply(log(s,'You pressed Connect: that is the consent. sudo needs no password here.'));
      if(s.sudo==='password')return apply(log(s,'You pressed Connect: that is the consent. sudo uses the password you gave at Continue; it is not asked again.'));
      return log({...s,step:'fallback',pending:{effect:'fallback'}},'This VS Code account has no sudo: showing the one-line fallback.');
    case 'password':return log({...s,error:null,step:'detecting',pending:{effect:'discover'}},'Password accepted by sudo (VS Code never stores it). Reading what would change.');
    case 'wrongPassword':{
      const tries=s.tries+1;
      if(tries>=3)return log(finish(s,'cancelled',{tries,error:'Three wrong passwords. Nothing was changed.'}),'sudo refused three times; wizard closed, nothing changed.');
      return log({...s,tries,error:`sudo refused the password (${tries} of 3).`,pending:{effect:'askPassword',attempt:tries+1}},`Wrong password, try ${tries} of 3.`);
    }
    case 'fallbackResult':
      if(a.ok!==true)return log(finish(s,'undone',{error:text(a.error,'The setup line reported a failure.'),warning:warn(s,a.warning)}),'The fallback line reported a failure.');
      return log({...s,applied:[change(a.change)||{id:'status',as:s.target?.user??null}],warning:warn(s,a.warning),step:'verifying',pending:{effect:'verify'}},
        `The fallback command ran as ${s.target?.user}. Consent came from your Connect click, so it asked nothing.`);
    case 'applied':{
      const c=change(a.change);
      if(s.step==='undoing'){
        const due=c.id!=='folder'||c.created===true, {undo,keep}=s.pending;
        return log({...s,applied:[...s.applied,c],pending:{effect:'rollback',undo:due?[c,...undo]:undo,keep:due?keep:[c,...keep]}},`Late change ${c.id} joins the rollback.`);
      }
      const run=log({...s,applied:[...s.applied,c]},`Applied ${c.id}${c.as?` (as ${c.as})`:''}.`);
      return remaining(run).length?{...run,pending:{effect:'apply',changes:remaining(run)}}:apply(run);
    }
    case 'verified':
      return log(finish(s,'connected',{error:null,warning:warn(s,a.warning),connection:a.connection&&typeof a.connection==='object'?{...a.connection}:s.connection}),
        s.mode==='disconnect'?'Disconnected and checked.':`VS Code read the connection descriptor and checked it came from process ${s.target?.pid}.`);
    case 'failed':{
      const why=text(a.error,'Setup stopped.'), run={...s,warning:warn(s,a.warning)};
      if(s.step==='undoing')return log(finish(run,'undone',{undone:[],kept:[...s.pending.undo,...s.pending.keep],warning:warn(run,why)}),`Rollback failed: ${why}`);
      if(BEFORE_CONNECT.has(s.step))return log(finish(run,'cancelled',{error:why}),`${why} Nothing was written.`);
      return rollback(run,why);
    }
    case 'rolledBack':
      return log(finish(s,'undone',{undone:list(a.undone,s)??s.pending.undo,kept:list(a.kept,s)??s.pending.keep,warning:warn(s,a.warning)}),
        `Rollback finished. Undid: ${labels(list(a.undone,s)??s.pending.undo)}.`);
    case 'sessionEnded':
      if(BEFORE_CONNECT.has(s.step))return log(finish(s,'cancelled',{error:`The ${name(s)} session ended. Nothing was changed.`}),'Session ended before Connect: wizard closed.');
      if(s.mode==='disconnect')return log(s,`The ${name(s)} session ended; the disconnect carries on.`);
      return rollback(s,`The ${name(s)} session ended during setup.`);
    case 'cancel':
      if(BEFORE_CONNECT.has(s.step))return log(finish(s,'cancelled',{error:null}),'Cancelled before anything was written. Ready to start again straight away.');
      return rollback(s,'You cancelled.');
    case 'cleanedUp':return {...s,pending:null,warning:warn(s,a.warning)};
    case 'earlierCleanup':return log({...s,warning:warn(s,a.warning)},`An earlier run left something behind: ${a.warning}`);
    case 'close':return initial();
  }
  return s;
}
module.exports={initial,step,can,STEPS};
