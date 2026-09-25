'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {renderWizard,INTENTS}=require('../src/wizard-view.cjs');
const {initial,step,STEPS}=require('../src/wizard.cjs');

const PROCESS={pid:1954197,uid:1053,start_ticks:'77',boot_id:'boot'};
const TARGET={provider:'claude',uid:1053,user:'claudebwai',pid:1954197,process:PROCESS};
const FEED='/var/lib/llm-account-usage/feeds/v2-edac862ca9874d8cb3e72c43e39a693b';
const FOLDER={id:'folder',as:'root',label:'Shared feed folder',path:FEED,argv:['/usr/bin/install','-d','-m','2750','-o','1053','-g','1000',FEED]};
const STATUS={id:'status',as:'claudebwai',label:'Claude status line reports usage to the feed',command:'node …/setup-cli.cjs connect --consent granted'};
const PREVIEW={profilePath:'/home/claudebwai/.claude',reportDir:FEED,changes:[FOLDER,STATUS],sharedDirectories:[],hasExistingStatusLine:true};
const CONTEXT={user:'glitch',host:'dev-blastworks'};

const state=(extra={})=>({...initial(),target:TARGET,sudo:'passwordless',busy:true,runId:'r1',...extra});
const intents=html=>[...html.matchAll(/data-intent="([^"]*)"/g)].map(m=>m[1]);
const crumbOn=html=>html.match(/<li class="wizard-crumb on"[^>]*>([^<]*)</)?.[1]??null;
const text=html=>html.replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').replace(/&(#39|quot|lt|gt|amp);/g,(m,e)=>({'#39':"'",quot:'"',lt:'<',gt:'>',amp:'&'})[e]);

// ---- One assertion per step ----
test('idle renders nothing: the account card owns it',()=>{
  assert.equal(renderWizard(initial()),'');
});
test('detecting (finding the session) sits on Session and can be cancelled',()=>{
  const html=renderWizard(state({step:'detecting',pending:{effect:'probe'}}));
  assert.ok(html.includes('Finding the Claude session…')&&crumbOn(html)==='Session'&&intents(html).join()==='cancel');
});
test('detecting (discover) says it is reading what will change, on Review',()=>{
  const html=renderWizard(state({step:'detecting',pending:{effect:'discover'}}));
  assert.ok(html.includes('Reading what will change…')&&crumbOn(html)==='Review'&&intents(html).join()==='cancel');
});
test('detected asks to connect this session, with the target facts, Continue and Cancel',()=>{
  const html=renderWizard(state({step:'detected'}),CONTEXT);
  assert.ok(html.includes('Connect this Claude session?')&&text(html).includes('Claude Code, pid 1954197')&&text(html).includes('claudebwai (uid 1053)')
    &&text(html).includes('You are glitch')&&intents(html).join()==='continue,cancel'&&crumbOn(html)==='Session');
});
test('detected on a password host says the password comes after Continue, before the review',()=>{
  const html=renderWizard(state({step:'detected',sudo:'password'}));
  assert.match(text(html),/sudo needs your password before the wizard can read what will change\. VS Code asks for it after Continue\./);
});
test('review lists every change with who makes it, the exact commands, and Connect',()=>{
  const html=renderWizard(state({step:'review',preview:PREVIEW}));
  const t=text(html);
  assert.ok(t.includes('What will change')&&t.includes('as root, once Shared feed folder')&&t.includes('as claudebwai Claude status line')
    &&html.includes('<summary>Show the exact commands</summary>')&&t.includes(`/usr/bin/install -d -m 2750 -o 1053 -g 1000 ${FEED}`)
    &&t.includes('node …/setup-cli.cjs connect --consent granted')&&intents(html).join()==='connect,cancel'&&crumbOn(html)==='Review');
});
test('review shows the host-shaped preview.commands in the commands block',()=>{
  const plain={...PREVIEW,changes:PREVIEW.changes.map(({argv,command,...c})=>c),
    commands:[{as:'root',argv:FOLDER.argv},{as:'claudebwai',argv:['/usr/bin/node','/var/lib/llm-account-usage/bundles/b/src/setup-cli.cjs','connect']}]};
  const t=text(renderWizard(state({step:'review',preview:plain})));
  assert.ok(t.includes('Show the exact commands')&&t.includes(`/usr/bin/install -d -m 2750 -o 1053 -g 1000 ${FEED}`)
    &&t.includes('/usr/bin/node /var/lib/llm-account-usage/bundles/b/src/setup-cli.cjs connect'));
});
test('review without argv or command omits the commands block',()=>{
  const html=renderWizard(state({step:'review',preview:{...PREVIEW,changes:[{id:'status',as:'claudebwai',label:'Status line'}]}}));
  assert.ok(!html.includes('<details'));
});
test('review on a password host says Connect will not ask again',()=>{
  assert.match(text(renderWizard(state({step:'review',sudo:'password',preview:PREVIEW}))),/Connect uses the password you already gave; it won't ask again\./);
});
test('review lists shared directories verbatim with the trust line',()=>{
  const html=renderWizard(state({step:'review',preview:{...PREVIEW,sharedDirectories:[{kind:'profile parent',path:'/srv/shared',uid:0,gid:1001,mode:0o2775}]}}));
  assert.ok(text(html).includes('profile parent: /srv/shared (owner UID 0, group GID 1001, mode 2775)')&&text(html).includes('Connecting trusts the listed owners'));
});
test('password before review: reading what will change, box is VS Code’s, only Cancel',()=>{
  const html=renderWizard(state({step:'password',sudo:'password',tries:1,error:'sudo refused the password (1 of 3).'}),CONTEXT);
  const t=text(html);
  assert.ok(t.includes('sudo needs your password to read what will change')&&t.includes('sudo refused the password (1 of 3).')
    &&t.includes('Password for glitch on dev-blastworks (sudo).')&&t.includes("VS Code's password box is open")
    &&crumbOn(html)==='Review'&&intents(html).join()==='cancel'&&!/<input/i.test(html));
});
test('password with a preview already shown words it as making the changes, on Connect',()=>{
  const html=renderWizard(state({step:'password',sudo:'password',preview:PREVIEW}));
  assert.ok(text(html).includes('sudo needs your password to make these changes')&&crumbOn(html)==='Connect');
});
test('fallback shows the one line, Copy and Cancel',()=>{
  const html=renderWizard(state({step:'fallback',sudo:'none',preview:PREVIEW}),{fallbackCommand:'node /tmp/x/setup-cli.cjs connect'});
  assert.ok(text(html).includes("This VS Code account can't act as claudebwai.")&&html.includes('<code class="wizard-cmd">node /tmp/x/setup-cli.cjs connect</code>')
    &&intents(html).join()==='copy,cancel');
});
test('connecting shows progress and can be cancelled in connect mode',()=>{
  const html=renderWizard(state({step:'connecting',preview:PREVIEW}));
  assert.ok(html.includes('<h2>Connecting…</h2>')&&intents(html).join()==='cancel'&&crumbOn(html)==='Connect');
});
test('disconnecting cannot be cancelled mid-apply and the crumb says Disconnect',()=>{
  const html=renderWizard(state({mode:'disconnect',step:'connecting',preview:PREVIEW}));
  assert.ok(html.includes('<h2>Disconnecting…</h2>')&&intents(html).length===0&&crumbOn(html)==='Disconnect');
});
test('verifying says it is checking the new connection',()=>{
  assert.ok(renderWizard(state({step:'verifying',preview:PREVIEW})).includes('<h2>Checking the new connection…</h2>'));
});
test('undoing is transient: the reason, no buttons',()=>{
  const html=renderWizard(state({step:'undoing',error:'VS Code could not read the feed folder.',pending:{effect:'rollback',undo:[],keep:[]}}));
  assert.ok(html.includes('<h2>Undoing changes…</h2>')&&text(html).includes('VS Code could not read the feed folder.')&&intents(html).length===0);
});
test('connected (connect mode) says what was checked, when usage appears, and lists what was done, with Close',()=>{
  // Review follow-up: the host checks the connection descriptor, not a report, so the screen must not claim a report was read.
  const html=renderWizard(state({step:'connected',busy:false,preview:PREVIEW,applied:[{id:'folder',created:true},{id:'status',as:'claudebwai'}]}));
  const t=text(html);
  assert.ok(t.includes("Connected. Usage for this Claude account appears on the card after the session's next turn. Restart the session first if it was already running."),t);
  assert.ok(t.includes('checked VS Code can read the new connection'),t);
  assert.ok(!t.includes('first report')&&!t.includes('now shows'),t);
  assert.ok(t.includes('done Shared feed folder')&&t.includes('done Claude status line')&&intents(html).join()==='close'&&crumbOn(html)==='Done');
});
test('connected in disconnect mode is worded Disconnected',()=>{
  const html=renderWizard(state({mode:'disconnect',step:'connected',busy:false,applied:[{id:'status',label:'Status line restored'}]}));
  assert.ok(text(html).includes('Disconnected.')&&!text(html).includes('Connected.')&&!text(html).includes('checked'));
});
test('undone lists undone and kept items from state, with Try again and Close',()=>{
  const html=renderWizard(state({step:'undone',busy:false,preview:PREVIEW,error:'VS Code could not read the feed folder.',
    undone:[{id:'status',as:'claudebwai'}],kept:[{id:'folder',created:false}],warning:'The setup bundle could not be removed.'}));
  const t=text(html);
  assert.ok(t.includes('Not connected. VS Code could not read the feed folder.')&&t.includes('undone Claude status line')
    &&t.includes(`kept Shared feed folder ${FEED}`)&&t.includes('The setup bundle could not be removed.')&&intents(html).join()==='retry,close');
});
test('cancelled says nothing was changed and offers Start again and Close',()=>{
  const html=renderWizard(state({step:'cancelled',busy:false}));
  assert.ok(text(html).includes('Cancelled. Nothing was changed.')&&html.includes('>Start again<')&&intents(html).join()==='retry,close');
});

// ---- Invariant sweep ----
const EVIL='<script>alert("x")</script>\'"><img src=x onerror=alert(1)>';
const TAGS=new Set(['article','ol','li','h2','dl','dt','dd','p','div','button','ul','span','code','details','summary']);
const ATTRS=new Set(['class','aria-label','aria-current','data-step','data-mode','role','type','data-action','data-intent']);
function evilState(stepName,mode) {
  const change=(id,as)=>({id,as,label:`${id} ${EVIL}`,path:`/var/${EVIL}/${id}`,argv:['/usr/bin/x',EVIL],command:`echo ${EVIL}`});
  const preview={profilePath:`/home/${EVIL}`,reportDir:`/feeds/${EVIL}`,changes:[change('folder','root'),change('status',EVIL)],
    sharedDirectories:[{kind:EVIL,path:`/srv/${EVIL}`,uid:EVIL,gid:EVIL,mode:0o755},EVIL],hasExistingStatusLine:true};
  const terminal=['connected','undone','cancelled'].includes(stepName);
  return {...initial(),mode,step:stepName,target:{provider:EVIL,uid:EVIL,user:EVIL,pid:EVIL,process:PROCESS},sudo:'password',sudoReason:EVIL,
    preview,applied:[change('folder','root'),change('status',EVIL)],undone:[change('status',EVIL)],kept:[change('folder','root')],
    tries:2,error:EVIL,warning:EVIL,busy:!terminal,runId:'r1',log:[EVIL],pending:stepName==='detecting'?{effect:'discover'}:null,fallbackCommand:EVIL};
}
test('invariant: every step × mode renders data escaped, only allowlisted tags/attributes/intents, never a password input',()=>{
  const context={user:EVIL,host:EVIL,fallbackCommand:EVIL};
  let rendered=0;
  for(const mode of ['connect','disconnect'])for(const stepName of STEPS)for(const variant of [evilState(stepName,mode),{...evilState(stepName,mode),preview:null}]){
    const html=renderWizard(variant,context);
    if(stepName==='idle'){assert.equal(html,'');continue;}
    rendered++;
    const where=`${mode}/${stepName}`;
    for(const [,close,tag,attrs] of html.matchAll(/<(\/?)([a-zA-Z0-9-]+)([^>]*)>/g)){
      assert.ok(TAGS.has(tag),`${where}: tag <${close}${tag}>`);
      const rest=attrs.replace(/\s([a-z-]+)="[^"<>]*"/g,(m,attr)=>{assert.ok(ATTRS.has(attr),`${where}: attribute ${attr}`);return '';});
      assert.equal(rest.trim(),'',`${where}: stray attribute text ${rest}`);
    }
    // Every '<' in the output starts an allowlisted tag, so none came from data.
    assert.equal((html.match(/</g)||[]).length,[...html.matchAll(/<(\/?)([a-zA-Z0-9-]+)([^>]*)>/g)].length,`${where}: raw <`);
    assert.ok(!/<script|<img|<input|type="password"/i.test(html),where);
    assert.ok(intents(html).every(i=>INTENTS.includes(i)),where);
    assert.ok(!/\son[a-z]+="/i.test(html),`${where}: inline handler`);
  }
  assert.equal(rendered,(STEPS.length-1)*4);
  // The payload does reach the screen, escaped.
  const review=renderWizard(evilState('review','connect'));
  assert.ok(review.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&#39;&quot;&gt;&lt;img'));
});
test('invariant: no rendered step anywhere contains a password field',()=>{
  for(const mode of ['connect','disconnect'])for(const stepName of STEPS)
    assert.ok(!/<input|<textarea|contenteditable|type="password"/i.test(renderWizard(state({mode,step:stepName,preview:PREVIEW,sudo:'password'}),CONTEXT)),`${mode}/${stepName}`);
});
test('every state the machine produces on a real run renders its own step',()=>{
  // einh's order (24 Sep): on a password host the password comes after Continue and before the review.
  const actions=[{type:'open',runId:'r1',mode:'connect',target:TARGET},{type:'sudoProbed',runId:'r1',sudo:'password'},{type:'continue'},
    {type:'wrongPassword',runId:'r1'},{type:'password',runId:'r1'},{type:'discovered',runId:'r1',preview:PREVIEW},{type:'connect'},
    {type:'applied',runId:'r1',change:{id:'folder',created:true}},{type:'failed',runId:'r1',error:'VS Code could not read the feed folder.'},
    {type:'rolledBack',runId:'r1',undone:['folder'],kept:[]},{type:'cleanedUp',runId:'r1'}];
  let s=initial();
  const seen=[];
  for(const a of actions){s=step(s,a);seen.push(s.step);assert.match(renderWizard(s),new RegExp(`data-step="${s.step}"`),a.type);}
  assert.deepEqual(seen,['detecting','detected','password','password','detecting','review','connecting','connecting','undoing','undone','undone']);
  const pw=step(step(step(initial(),actions[0]),actions[1]),actions[2]);
  assert.ok(text(renderWizard(pw)).includes('sudo needs your password to read what will change')&&crumbOn(renderWizard(pw))==='Review');
});

// ---- The webview script ----
function element(tag,attrs,document) {
  const el={tag,attrs,getAttribute:n=>Object.hasOwn(attrs,n)?attrs[n]:null,
    matches:selector=>{
      const m=selector.match(/^([a-z]+)((?:\[[\w-]+="[^"]*"\])*)$/);
      if(!m||m[1]!==tag)return false;
      return [...m[2].matchAll(/\[([\w-]+)="([^"]*)"\]/g)].every(([,k,v])=>attrs[k]===v);
    },
    closest:selector=>el.matches(selector)?el:null,
    focus:()=>{document.activeElement=el;}};
  return el;
}
function openWebview(initialHtml) {
  const events={},messages=[];
  let html='',nodes=[];
  const document={activeElement:null,hidden:false,
    addEventListener:(name,handler)=>{events[`document:${name}`]=handler;},
    getElementById:id=>id==='account-usage'?container:null,
    querySelector:selector=>container.querySelector(selector)};
  const container={
    get innerHTML(){return html;},
    set innerHTML(value){html=value;nodes=[...value.matchAll(/<button([^>]*)>/g)].map(([,a])=>element('button',Object.fromEntries([...a.matchAll(/([\w-]+)="([^"]*)"/g)].map(m=>[m[1],m[2]])),document));},
    querySelectorAll:()=>[],
    querySelector:selector=>nodes.find(n=>n.matches(selector))||null};
  container.innerHTML=initialHtml;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../media/account-usage.js'),'utf8'),{
    document,Intl,Date,
    window:{scrollY:0,scrollTo:()=>{},addEventListener:(name,handler)=>{events[name]=handler;}},
    acquireVsCodeApi:()=>({getState:()=>null,setState:()=>{},postMessage:message=>messages.push(JSON.parse(JSON.stringify(message)))})});
  return {events,messages,document,button:intent=>container.querySelector(`button[data-action="wizard"][data-intent="${intent}"]`),
    render:value=>events.message({data:{type:'render',html:value}})};
}
test('webview: a wizard button posts {type:"wizard",intent}; an unknown intent posts nothing',()=>{
  const view=openWebview(renderWizard(state({step:'detected'})));
  view.events['document:click']({target:view.button('continue')});
  view.events['document:click']({target:view.button('cancel')});
  view.events['document:click']({target:element('button',{'data-action':'wizard','data-intent':'rm -rf'},view.document)});
  assert.deepEqual(view.messages,[{type:'ready'},{type:'wizard',intent:'continue'},{type:'wizard',intent:'cancel'}]);
});
test('webview: a re-render keeps focus on the same intent, else the screen\'s first wizard button',()=>{
  const view=openWebview(renderWizard(state({step:'detected'})));
  view.button('cancel').focus();
  view.render(renderWizard(state({step:'review',preview:PREVIEW})));
  assert.equal(view.document.activeElement,view.button('cancel'));
  view.button('connect').focus();
  view.render(renderWizard(state({step:'connected',busy:false,preview:PREVIEW,applied:[]})));
  assert.equal(view.document.activeElement,view.button('close'));
});
test('webview: the card\'s Connect button still posts connect',()=>{
  const view=openWebview('<button type="button" data-action="connect">Connect Claude</button>');
  view.events['document:click']({target:element('button',{'data-action':'connect'},view.document)});
  assert.deepEqual(view.messages,[{type:'ready'},{type:'connect'}]);
});
