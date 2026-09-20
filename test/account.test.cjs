'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {parseProfileEnvironment,readProfileContext,readAccount}=require('../src/account.cjs');
const native='/opt/native/codex';
const identity={pid:20,uid:1000,start_ticks:'20',boot_id:'boot'};
const request={process:identity,executable:native};
const profile={HOME:'/profiles/user',CODEX_HOME:'/profiles/codex'};
const bytes=entries=>Buffer.from(entries.join('\0')+'\0');

test('profile parsing returns only approved paths, never raw environment or unrelated secrets',()=>{
 const raw=bytes(['HOME=/profiles/user','CODEX_HOME=/profiles/codex','PATH=/untrusted/bin',
  'NODE_OPTIONS=--require=/secret/module','LD_PRELOAD=/secret/library','UNRELATED_SECRET=secret-value']);
 assert.deepEqual(parseProfileEnvironment(raw),profile);
 assert.doesNotMatch(JSON.stringify(parseProfileEnvironment(raw)),/SECRET|secret|PATH|NODE_OPTIONS|LD_PRELOAD/);
 assert.deepEqual(parseProfileEnvironment(bytes(['HOME=/profiles/user'])),{HOME:'/profiles/user'});
});

test('explicit provider credential or endpoint overrides refuse account identity',()=>{
 for(const key of ['OPENAI_API_KEY','CODEX_API_KEY','OPENAI_ACCESS_TOKEN','CODEX_AUTH_TOKEN',
  'OPENAI_BASE_URL','OPENAI_ORGANIZATION','OPENAI_PROJECT_ID','CODEX_API_KEY_FILE','AZURE_OPENAI_API_KEY']) {
  assert.equal(parseProfileEnvironment(bytes(['HOME=/profiles/user',`${key}=do-not-return-me`])),null,key);
 }
});

test('exported shell function names do not hide the current account or enter its environment',()=>{
 const input=bytes(['HOME=/profiles/user','BASH_FUNC_which%%=() { fixture; }','CODEX_HOME=/profiles/codex']);
 assert.deepEqual(parseProfileEnvironment(input),profile);
 assert.equal(parseProfileEnvironment(bytes(['HOME=/profiles/user','OPENAI_API_KEY%%=blocked'])),null);
});

test('missing, ambiguous, invalid and oversized profile environments are refused',()=>{
 for(const raw of [Buffer.alloc(65537),bytes(['CODEX_HOME=/profiles/codex']),
  bytes(['HOME=relative']),bytes(['HOME=/profiles/../other']),bytes(['HOME=/profiles/user\nother']),
  bytes(['HOME=/profiles/user','HOME=/profiles/other']),bytes(['HOME=/profiles/user','CODEX_HOME=relative']),
  Buffer.from('HOME=/profiles/user'),bytes(['HOME=/profiles/user','BROKEN'])]) {
  assert.equal(parseProfileEnvironment(raw),null);
 }
});

test('profile reads are bounded and never open credential files',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'usage-profile-'));
 try {
  const file=path.join(directory,'environ');await fs.writeFile(file,bytes(['HOME=/profiles/user','TOKEN=private']));
  const open=async target=>{assert.equal(target,'/proc/20/environ');return fs.open(file,'r');};
  assert.deepEqual(await readProfileContext(20,{open}),{HOME:'/profiles/user'});
  await fs.writeFile(file,Buffer.alloc(65537,65));
  assert.equal(await readProfileContext(20,{open}),null);
  assert.equal(await readProfileContext(0,{open}),null);
 } finally {await fs.rm(directory,{recursive:true,force:true});}
});

// The real child runs only a synthetic JSONL server. No Codex profile, login,
// credential file, network request, or user process is touched by these tests.
function serverScript(mode) {
 return `const readline=require('node:readline');
 const mode=${JSON.stringify(mode)};
 const answer=value=>process.stdout.write(JSON.stringify(value)+'\\n');
 if(mode==='hang'){setInterval(()=>{},1000);}
 else if(mode==='stderr'){process.stderr.write('private '.repeat(10000));setInterval(()=>{},1000);}
 else if(mode==='stdout'){process.stdout.write('x'.repeat(40000));setInterval(()=>{},1000);}
 else if(mode==='exit'){process.exit(0);}
 else {
  let stage=0;
  readline.createInterface({input:process.stdin}).on('line',line=>{
   const message=JSON.parse(line);
   if(stage===0){
    if(message.id!==1||message.method!=='initialize'||!message.params.clientInfo.name||!message.params.clientInfo.version)
     return answer({id:1,error:{message:'bad initialize'}});
    if(mode==='init-error')return answer({id:1,error:{message:'private init error'}});
    if(mode==='malformed')return process.stdout.write('private invalid json\\n');
    stage=1;return answer({id:1,result:{userAgent:'fixture'}});
   }
   if(stage===1){
    if(message.method!=='initialized'||message.id!==undefined)return process.exit(2);
    stage=2;return;
   }
   if(message.id!==2||message.method!=='account/read'||JSON.stringify(message.params)!=='{"refreshToken":false}')
    return answer({id:2,error:{message:'wrong query'}});
   if(JSON.stringify(Object.keys(process.env).sort())!=='["CODEX_HOME","HOME","LANG","LC_ALL","PATH"]'||
     process.env.HOME!=='/profiles/user'||process.env.CODEX_HOME!=='/profiles/codex'||process.env.PATH!=='/usr/local/bin:/usr/bin:/bin')
    return answer({id:2,error:{message:'unsafe environment'}});
   if(mode==='query-error')return answer({id:2,error:{message:'private account error'}});
   const account=mode==='null'?null:mode==='apikey'?{type:'apiKey'}:
    {type:'chatgpt',email:mode==='invalid-email'?'<invalid@example.test>':'person@example.test',planType:'pro',accessToken:'never-return-this'};
   answer({id:2,result:{account,requiresOpenaiAuth:true}});
  });
 }`;
}

function fixture(mode='success',changes={}) {
 const children=[];
 const deps={uid:1000,getProcess:async()=>({...identity}),getExecutable:async()=>native,
  getProfileContext:async()=>({...profile}),
  spawnProcess:(file,args,options)=>{
   assert.equal(file,'/proc/20/exe');assert.deepEqual(args,['app-server']);
   assert.equal(options.shell,false);assert.equal(options.cwd,profile.HOME);
   const child=spawn(process.execPath,['-e',serverScript(mode)],{...options,cwd:os.tmpdir()});
   children.push(child);return child;
  },...changes};
 return {read:()=>readAccount(request,deps),children};
}

test('native JSONL initialization and no-refresh account read return only a validated email',async()=>{
 const f=fixture();assert.equal(await f.read(),'person@example.test');
 assert.equal(f.children.length,1);assert.equal(f.children[0].killed,true,'only the query child is terminated');
});

test('a running deleted installation binary is read through its live proc executable',async()=>{
 const f=fixture('success',{getExecutable:async()=>native+' (deleted)'});
 assert.equal(await f.read(),'person@example.test');
});

test('native protocol errors, missing ChatGPT account and unsafe email return no identity',async()=>{
 for(const mode of ['init-error','query-error','malformed','null','apikey','invalid-email','exit']) {
  const f=fixture(mode);assert.equal(await f.read(),null,mode);
 }
});

test('native child timeout and stdout/stderr limits terminate only the spawned child',async()=>{
 for(const mode of ['hang','stdout','stderr']) {
  const f=fixture(mode,{timeoutMs:mode==='hang'?150:3000});const started=Date.now();
  assert.equal(await f.read(),null,mode);assert.ok(Date.now()-started<1500,mode);
  assert.equal(f.children[0].killed,true,mode);
 }
});

test('foreign ownership, changed process, different binary and unsafe profile prevent spawn',async()=>{
 for(const changes of [{uid:2000},{getProcess:async()=>({...identity,start_ticks:'21'})},
  {getExecutable:async()=>'/different/codex'},{getProfileContext:async()=>null},
  {getProfileContext:async()=>({HOME:'relative'})},
  {getProfileContext:async()=>{throw new Error('SECRET');}}]) {
  const f=fixture('success',changes);assert.equal(await f.read(),null);assert.equal(f.children.length,0);
 }
 let changed=false;
 const f=fixture('success',{getProcess:async()=>({...identity,start_ticks:changed?'21':'20'}),
  getProfileContext:async()=>{changed=true;return profile;}});
 assert.equal(await f.read(),null);assert.equal(f.children.length,0);
});

test('spawn errors are sanitized and a process replaced during the query cannot label usage',async()=>{
 const failed=fixture('success',{spawnProcess:()=>{throw new Error('SECRET /private/profile');}});
 assert.equal(await failed.read(),null);
 let reads=0;
 const changed=fixture('success',{getProcess:async()=>({...identity,start_ticks:++reads>2?'21':'20'})});
 assert.equal(await changed.read(),null);
});
