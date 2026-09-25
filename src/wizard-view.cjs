'use strict';
// Connect wizard screens (0.4). renderWizard(state, context) turns a wizard.cjs state into the webview's HTML.
// Copy comes from the approved board, prototypes/connect-wizard.prototype.html (wizScreen); the styling lives in
// media/account-usage.css. Every dynamic value goes through escape(); the markup carries no inline handlers
// (the webview CSP forbids them), only buttons with data-action="wizard" data-intent=<one of INTENTS>, which
// media/account-usage.js turns into {type:'wizard',intent}. The extension checks the intent against INTENTS again.
// There is never a password field here: VS Code's own input box takes the password (the host shows it).
// context (optional): {user, host, fallbackCommand} — the VS Code account, the host name, and the one-line
// fallback command when the extension has one to show. Absent fields are left out, never invented.
// The no-sudo road's host adds to the state it emits (wizard-host.cjs): fallbackCommand (the one line to run now),
// fallbackAdmin (that line is the admin's folder line), fallbackWaitMs (how long the wizard waits for it) and
// fallbackUndo ('waiting' with the disconnect line in fallbackCommand, 'done', 'failed') on the screens after a run
// that may have changed the status line without sudo to undo it, and fallbackUnsure (a line was shown to run as the
// target and no result came back): such a screen never says "Nothing was changed".
// `idle` renders nothing: the account card owns that state.
const {can}=require('./wizard.cjs');

// Identical to panel.cjs's escape (not exported there).
const escape = value => String(value ?? '').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const INTENTS=Object.freeze(['continue','connect','cancel','retry','copy','close']);
const NAMES={claude:'Claude',codex:'Codex',antigravity:'Antigravity'};
const TOOLS={claude:'Claude Code',codex:'Codex',antigravity:'Antigravity'};
const SAFE_WORD=/^[A-Za-z0-9_@%+=:,./-]+$/;

const str=value=>typeof value==='string'?value:value==null?'':String(value);
const name=s=>NAMES[s.target?.provider]||'AI';
const tool=s=>TOOLS[s.target?.provider]||'AI';
const who=s=>str(s.target?.user)||'the other account';
const disconnecting=s=>s.mode==='disconnect';
const verb=s=>disconnecting(s)?'Disconnect':'Connect';

function button(intent,label,primary=false) {
  return `<button type="button" class="wizard-button${primary?' primary':''}" data-action="wizard" data-intent="${intent}">${escape(label)}</button>`;
}
const cancelButton=s=>can.cancel(s)?button('cancel','Cancel'):'';
const row=(...buttons)=>{const inner=buttons.filter(Boolean).join('');return inner?`<div class="wizard-row">${inner}</div>`:'';};
const banner=(tone,text)=>text?`<div class="wizard-banner b-${tone}" role="${tone==='bad'?'alert':'status'}">${escape(text)}</div>`:'';
const note=text=>`<p class="wizard-note">${text}</p>`;
const heading=text=>`<h2>${escape(text)}</h2>`;
const kv=pairs=>{
  const shown=pairs.filter(([,value])=>value!=null&&value!=='');
  return shown.length?`<dl class="wizard-kv">${shown.map(([k,v])=>`<dt>${escape(k)}</dt><dd>${escape(v)}</dd>`).join('')}</dl>`:'';
};

// Where the run sits on Session · Review · Connect · Done. The password step sits before Review when it comes
// to read what will change (no preview yet), and under Connect when it comes to make the changes.
function position(s) {
  switch(s.step) {
    case 'detecting':return s.pending?.effect==='discover'?1:0;
    case 'detected':return 0;
    case 'review':return 1;
    case 'password':return s.preview?2:1;
    case 'fallback':case 'connecting':case 'verifying':case 'undoing':return 2;
    case 'connected':case 'undone':case 'cancelled':return 3;
    default:return -1;
  }
}
function crumbs(s) {
  const at=position(s);
  const items=['Session','Review',verb(s),'Done'].map((label,i)=>{
    const state=i===at?' on':i<at?' done':'';
    return `<li class="wizard-crumb${state}"${i===at?' aria-current="step"':''}>${escape(label)}</li>`;
  });
  return `<ol class="wizard-crumbs" aria-label="Progress">${items.join('')}</ol>`;
}

function asLabel(c,s) {
  if(c.as==='root')return !disconnecting(s)&&c.id==='folder'?'as root, once':'as root';
  return c.as?`as ${str(c.as)}`:'';
}
function pill(tone,text) {return text?`<span class="wizard-pill p-${tone}">${escape(text)}</span>`:'';}
function changeLabel(c,s) {
  const known=(s.preview?.changes||[]).find(p=>p.id===c.id)||{};
  return str(c.label||known.label||c.id);
}
function changePath(c,s) {
  const known=(s.preview?.changes||[]).find(p=>p.id===c.id)||{};
  return str(c.path||known.path);
}
function itemList(items,s,tone,word) {
  return items.map(c=>{
    const where=changePath(c,s);
    return `<li>${pill(tone,word)}<span>${escape(changeLabel(c,s))}${where?` <code>${escape(where)}</code>`:''}</span></li>`;
  }).join('');
}
function changesList(s) {
  const changes=s.preview?.changes||[];
  if(!changes.length)return note('Nothing to change.');
  return `<ul class="wizard-changes">${changes.map(c=>{
    const where=str(c.path);
    return `<li>${pill(c.as==='root'?'root':'user',asLabel(c,s))}<span>${escape(changeLabel(c,s))}${where?` <code>${escape(where)}</code>`:''}</span></li>`;
  }).join('')}</ul>`;
}
function sharedList(s) {
  const shared=(s.preview?.sharedDirectories||[]).filter(d=>d!=null);
  if(!shared.length)return '';
  const line=d=>{
    if(typeof d!=='object')return `<li><code>${escape(d)}</code></li>`;
    const facts=[d.uid!=null?`owner UID ${d.uid}`:'',d.gid!=null?`group GID ${d.gid}`:'',
      Number.isInteger(d.mode)?`mode ${(d.mode&0o7777).toString(8)}`:''].filter(Boolean).join(', ');
    return `<li>${d.kind?`${escape(d.kind)}: `:''}<code>${escape(d.path)}</code>${facts?` (${escape(facts)})`:''}</li>`;
  };
  return `<ul class="wizard-shared">${shared.map(line).join('')}</ul>${note(`${escape(verb(s))}ing trusts the listed owners and everyone who can write through these groups.`)}`;
}

// Shell-style display of an argv array; display only, nothing here is ever executed.
const quote=word=>{const w=str(word);return SAFE_WORD.test(w)?w:`'${w.replace(/'/g,`'\\''`)}'`;};
function commands(s) {
  // The host puts the reviewed commands on preview.commands; a change may also carry its own.
  const listed=Array.isArray(s.preview?.commands)?s.preview.commands:[];
  const lines=[...listed,...(s.preview?.changes||[])].map(c=>Array.isArray(c.argv)&&c.argv.length?c.argv.map(quote).join(' ')
    :typeof c.command==='string'&&c.command?c.command:null).filter(Boolean);
  if(!lines.length)return '';
  return `<details class="wizard-commands"><summary>Show the exact commands</summary><code class="wizard-cmd">${escape(lines.join('\n'))}</code></details>`;
}

function detectedScreen(s,context) {
  const t=s.target||{};
  const session=[tool(s),t.pid!=null?`pid ${t.pid}`:''].filter(Boolean).join(', ');
  const runsAs=t.user?`${t.user}${t.uid!=null?` (uid ${t.uid})`:''}`:t.uid!=null?`uid ${t.uid}`:'';
  const sudo=s.sudo==='password'?note(`sudo needs your password before the wizard can read what will change. VS Code asks for it after Continue.`)
    :s.sudo==='none'?note(`This VS Code account can't use sudo, so ${escape(verb(s).toLowerCase())}ing ends with one line to run as ${escape(who(s))}.`):'';
  return `${crumbs(s)}${heading(`${verb(s)} this ${name(s)} session?`)}
    ${kv([['Session',session],['Runs as',runsAs],['You are',str(context.user)]])}
    ${note(disconnecting(s)
      ?'This session belongs to another account. The wizard will undo the changes as that account, and asks you first.'
      :'This session belongs to another account. The wizard will make the changes as that account, and asks you first.')}
    ${sudo}${s.sudoReason?note(escape(s.sudoReason)):''}
    ${row(can.continue(s)&&button('continue','Continue',true),cancelButton(s))}`;
}
function reviewScreen(s) {
  const p=s.preview||{};
  const profile=p.profilePath?`Profile <code>${escape(p.profilePath)}</code>. `:'';
  const body=disconnecting(s)
    ?`${profile}Disconnect puts the status line back as it was and removes the shared folder when it is empty.`
    :s.sudo==='none'
      ?`${profile}Nothing inside the ${escape(who(s))} home folder is opened to other accounts. Without sudo nothing can be undone automatically: if VS Code can't read the new connection, the wizard shows the line that puts the status line back.`
      :`${profile}Nothing inside the ${escape(who(s))} home folder is opened to other accounts. If VS Code can't read the new connection, every change is undone; a shared folder that was already there stays.`;
  const existing=!disconnecting(s)&&p.hasExistingStatusLine?note('Your existing status line keeps running; the usage report wraps it.'):'';
  const asked=s.sudo==='password'?note(`${escape(verb(s))} uses the password you already gave; it won't ask again.`):'';
  return `${crumbs(s)}${heading('What will change')}${changesList(s)}${sharedList(s)}${note(body)}${existing}${asked}${commands(s)}
    ${row(can.connect(s)&&button('connect',verb(s),true),cancelButton(s))}`;
}
function passwordScreen(s,context) {
  const purpose=s.preview?`to ${disconnecting(s)?'undo':'make'} these changes`:'to read what will change';
  const forWhom=context.user?`Password for ${str(context.user)}${context.host?` on ${str(context.host)}`:''} (sudo). `:'';
  return `${crumbs(s)}${heading(`sudo needs your password ${purpose}`)}${banner('bad',s.error)}
    ${note(`${escape(forWhom)}VS Code's password box is open at the top of the window. Type it there; this panel never sees it, and nothing is changed yet.`)}
    ${row(cancelButton(s))}`;
}
const waitNote=s=>Number.isInteger(s.fallbackWaitMs)&&s.fallbackWaitMs>0?` It stops waiting after ${Math.round(s.fallbackWaitMs/60000)} minutes.`:'';
const commandBlock=line=>line?`<code class="wizard-cmd">${escape(line)}</code>`:'';
function fallbackScreen(s,context) {
  const line=str(context.fallbackCommand||s.fallbackCommand);
  if(s.fallbackAdmin===true) {
    const feed=str(s.preview?.reportDir)||'the shared feed folder';
    return `${crumbs(s)}${heading('An admin step first')}
    ${banner('warn',`The shared folder ${feed} does not exist yet, and making it needs sudo, which this VS Code account can't use. Ask an admin to run this line once. The wizard then shows the line to run as ${who(s)}.`)}
    ${commandBlock(line)}
    ${row(button('copy','Copy'),cancelButton(s))}
    ${note(`The wizard waits here for the folder.${escape(waitNote(s))}`)}`;
  }
  return `${crumbs(s)}${heading('One step outside VS Code')}
    ${banner('warn',`This VS Code account can't act as ${who(s)}. Run this once in any shell logged in as ${who(s)}. It won't ask you anything; you already agreed by pressing ${verb(s)}.`)}
    ${line?`<code class="wizard-cmd">${escape(line)}</code>`:''}
    ${row(button('copy','Copy'),cancelButton(s))}
    ${note(`The wizard waits here and finishes on its own when the line runs.${escape(waitNote(s))}`)}`;
}
// A line shown to run as the target gave no answer before the wizard stopped: say plainly what it may have done.
function unsureBanner(s) {
  if(s.fallbackUnsure!==true||s.fallbackUndo==='done')return '';
  const status=`${who(s)}'s ${name(s)} status line`;
  return banner('warn',disconnecting(s)
    ?`If the line was run as ${who(s)}, it may already have disconnected ${status} from VS Code.`
    :`If the line was run as ${who(s)}, it may have changed ${status}.`);
}
// After a no-sudo run that may have changed the status line: what is left to undo, and the one line that undoes it.
function undoBlock(s) {
  const status=`${who(s)}'s ${name(s)} status line`;
  if(s.fallbackUndo==='done')return banner('good',`The undo line ran as ${who(s)}: ${status} is back as it was.`);
  const where=[s.preview?.profilePath?` in <code>${escape(s.preview.profilePath)}</code>`:'',
    s.preview?.reportDir?` may now report usage to <code>${escape(s.preview.reportDir)}</code>`:' may have been changed'].join('');
  if(s.fallbackUndo==='failed')return banner('bad',s.fallbackUnsure===true
    ?`The undo line ran as ${who(s)} but could not finish. If the first line never ran, there is nothing to put back; if it did, ${status} has to be put back by hand.`
    :`The undo line ran as ${who(s)} but could not finish, so ${status} has to be put back by hand.`)
    +note(`${escape(status)}${where}.`);
  if(s.fallbackUndo!=='waiting')return '';
  const line=str(s.fallbackCommand);
  return `${note(`Without sudo the wizard can't undo this itself. ${escape(status)}${where}. To put it back, run this once in any shell logged in as ${escape(who(s))}:`)}
    ${commandBlock(line)}${line?row(button('copy','Copy')):''}`;
}
function progressScreen(s,title) {
  return `${crumbs(s)}${heading(title)}${banner('bad',s.step==='undoing'?s.error:null)}${row(cancelButton(s))}`;
}
function connectedScreen(s) {
  const done=disconnecting(s)
    ?`Disconnected. The ${name(s)} status line no longer reports usage to VS Code.`
    :`Connected. Usage for this ${name(s)} account appears on the card after the session's next turn. Restart the session first if it was already running.`;
  // What the host checked is the connection descriptor, not a report: no report exists until the session's next turn.
  const checked=disconnecting(s)?'':`<li>${pill('good','checked')}<span>VS Code can read the new connection</span></li>`;
  return `${crumbs(s)}${banner('good',done)}${banner('warn',s.warning)}
    <ul class="wizard-steps">${itemList(s.applied,s,'good','done')}${checked}</ul>
    ${row(button('close','Close',true))}`;
}
function undoneScreen(s) {
  const lead=disconnecting(s)?'Not disconnected.':'Not connected.';
  return `${crumbs(s)}${banner('bad',[lead,str(s.error)].filter(Boolean).join(' '))}${unsureBanner(s)}${banner('warn',s.warning)}
    <ul class="wizard-steps">${itemList(s.undone,s,'warn','undone')}${itemList(s.kept,s,'user','kept')}</ul>${undoBlock(s)}
    ${row(can.retry(s)&&button('retry','Try again',true),button('close','Close'))}`;
}
function cancelledScreen(s) {
  const fallback=s.fallbackUndo||s.fallbackUnsure===true?'Cancelled.':'Cancelled. Nothing was changed.';
  return `${crumbs(s)}${banner('warn',str(s.error)||fallback)}${unsureBanner(s)}${banner('warn',s.warning)}${undoBlock(s)}
    ${row(can.retry(s)&&button('retry','Start again',true),button('close','Close'))}`;
}

function screen(s,context) {
  switch(s.step) {
    case 'detecting':return s.pending?.effect==='discover'
      ?progressScreen(s,'Reading what will change…')
      :progressScreen(s,`Finding the ${name(s)} session…`);
    case 'detected':return detectedScreen(s,context);
    case 'review':return reviewScreen(s);
    case 'password':return passwordScreen(s,context);
    case 'fallback':return fallbackScreen(s,context);
    case 'connecting':return progressScreen(s,disconnecting(s)?'Disconnecting…':'Connecting…');
    case 'verifying':return progressScreen(s,disconnecting(s)?'Checking the status line…':'Checking the new connection…');
    case 'undoing':return progressScreen(s,'Undoing changes…');
    case 'connected':return connectedScreen(s);
    case 'undone':return undoneScreen(s);
    case 'cancelled':return cancelledScreen(s);
    default:return null;
  }
}
function renderWizard(state,context={}) {
  const s=state&&typeof state==='object'?state:{step:'idle'};
  const ctx=context&&typeof context==='object'?context:{};
  const inner=screen({applied:[],undone:[],kept:[],...s},ctx);
  if(inner==null)return '';
  const label=`${verb(s)} ${name(s)} wizard`;
  return `<article class="account-card wizard-card" aria-label="${escape(label)}" data-step="${escape(s.step)}" data-mode="${disconnecting(s)?'disconnect':'connect'}">${inner}</article>`;
}
module.exports={renderWizard,INTENTS,escape};
