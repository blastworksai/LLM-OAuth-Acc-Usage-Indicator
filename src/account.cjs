'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {readProcess}=require('./core.cjs');
const MAX_ENV_BYTES=65536,MAX_STDOUT_BYTES=32768,MAX_STDERR_BYTES=8192,TIMEOUT_MS=3000;
const same=(a,b)=>!!a&&!!b&&['pid','uid','start_ticks','boot_id'].every(key=>a[key]===b[key]);
const executablePath=value=>typeof value==='string'?value.replace(/ \(deleted\)$/,''):null;
const safePath=value=>typeof value==='string' && value.length>0 && value.length<=4096 &&
  !/[\x00-\x1f\x7f]/.test(value) && path.isAbsolute(value) && path.normalize(value)===value;
const validEmail=value=>typeof value==='string' && value.length<=254 &&
  /^[^\s<>\x00-\x1f\x7f@]+@[^\s<>\x00-\x1f\x7f@]+$/u.test(value);
const credentialOverride=key=>/^(?:OPENAI|AZURE_OPENAI)_/.test(key) ||
  /^CODEX_.*(?:KEY|TOKEN|AUTH|CREDENTIAL|BASE_URL|ENDPOINT)/.test(key);

// Inspect names first. Only HOME/CODEX_HOME values are decoded or returned;
// credential overrides cause refusal, never copying or logging their values.
function parseProfileEnvironment(buffer) {
  if(!Buffer.isBuffer(buffer) || !buffer.length || buffer.length>MAX_ENV_BYTES || buffer.at(-1)!==0)return null;
  const profile={};
  for(let start=0;start<buffer.length;) {
    const end=buffer.indexOf(0,start),equals=buffer.indexOf(61,start);
    if(end<0 || equals<=start || equals>=end)return null;
    const key=buffer.toString('utf8',start,equals);
    if(credentialOverride(key))return null;
    // Exported shell functions can have names such as BASH_FUNC_which%%.
    // Ignore unrelated names; only the two explicit profile paths are copied.
    if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)){start=end+1;continue;}
    if(key==='HOME' || key==='CODEX_HOME') {
      if(Object.hasOwn(profile,key))return null;
      const value=buffer.toString('utf8',equals+1,end);
      if(!safePath(value) || !Buffer.from(value).equals(buffer.subarray(equals+1,end)))return null;
      profile[key]=value;
    }
    start=end+1;
  }
  return profile.HOME?profile:null;
}

async function readProfileContext(pid,{open=fs.open}={}) {
  if(!Number.isSafeInteger(pid) || pid<=0)return null;
  let file;
  try {
    file=await open(`/proc/${pid}/environ`,'r');
    const buffer=Buffer.alloc(MAX_ENV_BYTES+1);let length=0;
    while(length<buffer.length) {
      const {bytesRead}=await file.read(buffer,length,buffer.length-length,null);
      if(!bytesRead)break;
      length+=bytesRead;
    }
    return parseProfileEnvironment(buffer.subarray(0,length));
  } catch {return null;} finally {try{await file?.close();}catch{}}
}

async function getExecutable(pid) {
  try{return await fs.readlink(`/proc/${pid}/exe`);}catch{return null;}
}

function queryAccount(pid,profile,{spawnProcess,timeoutMs}) {
  return new Promise(resolve=>{
    let child,settled=false,stage=0,stdoutBytes=0,stderrBytes=0,pending=Buffer.alloc(0);
    const finish=email=>{
      if(settled)return;
      settled=true;clearTimeout(timer);
      // This handle belongs only to our short-lived metadata query. Never signal
      // the selected terminal, its Codex process, or their process group.
      try{child?.stdin?.destroy();}catch{}
      try{child?.kill('SIGKILL');}catch{}
      resolve(validEmail(email)?email:null);
    };
    const timer=setTimeout(()=>finish(null),timeoutMs);
    const send=message=>{
      try{child.stdin.write(JSON.stringify(message)+'\n');}catch{finish(null);}
    };
    try {
      const env={HOME:profile.HOME,PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8',LC_ALL:'C.UTF-8'};
      if(profile.CODEX_HOME)env.CODEX_HOME=profile.CODEX_HOME;
      // /proc pins execution to the selected process's binary rather than a
      // potentially replaced file at the installation pathname.
      child=spawnProcess(`/proc/${pid}/exe`,['app-server'],{
        env,cwd:profile.HOME,stdio:['pipe','pipe','pipe'],shell:false,windowsHide:true
      });
      child.on('error',()=>finish(null));
      child.on('close',()=>finish(null));
      child.stdin.on('error',()=>finish(null));
      child.stdout.on('error',()=>finish(null));
      child.stderr.on('error',()=>finish(null));
      child.stderr.on('data',chunk=>{
        stderrBytes+=Buffer.byteLength(chunk);
        if(stderrBytes>MAX_STDERR_BYTES)finish(null);
      });
      child.stdout.on('data',chunk=>{
        if(settled)return;
        stdoutBytes+=Buffer.byteLength(chunk);
        if(stdoutBytes>MAX_STDOUT_BYTES){finish(null);return;}
        pending=Buffer.concat([pending,Buffer.from(chunk)]);
        let end;
        while(!settled && (end=pending.indexOf(10))>=0) {
          const line=pending.subarray(0,end);pending=pending.subarray(end+1);
          if(!line.length)continue;
          let message;
          try{message=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(line));}
          catch{finish(null);return;}
          if(!message || typeof message!=='object' || Array.isArray(message)){finish(null);return;}
          if(stage===0 && message.id===1) {
            if(message.error || !message.result || typeof message.result!=='object'){finish(null);return;}
            stage=1;send({method:'initialized'});
            send({id:2,method:'account/read',params:{refreshToken:false}});
          } else if(stage===1 && message.id===2) {
            const account=message.error?null:message.result?.account;
            finish(account?.type==='chatgpt'?account.email:null);
          }
        }
      });
      send({id:1,method:'initialize',params:{clientInfo:{name:'account_usage',title:'Account Usage',version:'1'}}});
    } catch {finish(null);}
  });
}

async function readAccount({process:identity,executable}={}, {
  uid=process.getuid?.(),getProcess=readProcess,getExecutable:readExecutable=getExecutable,
  getProfileContext=readProfileContext,spawnProcess=spawn,timeoutMs=TIMEOUT_MS
}={}) {
  try {
    if(!identity || !Number.isSafeInteger(identity.pid) || identity.pid<1 || identity.uid!==uid ||
      !safePath(executable) || path.basename(executable)!=='codex')return null;
    if(!same(identity,await getProcess(identity.pid)) || executablePath(await readExecutable(identity.pid))!==executable)return null;
    const profile=await getProfileContext(identity.pid);
    if(!profile || !safePath(profile.HOME) || (profile.CODEX_HOME!==undefined && !safePath(profile.CODEX_HOME)))return null;
    if(!same(identity,await getProcess(identity.pid)) || executablePath(await readExecutable(identity.pid))!==executable)return null;
    const email=await queryAccount(identity.pid,profile,{spawnProcess,
      timeoutMs:Number.isFinite(timeoutMs)?Math.max(1,Math.min(TIMEOUT_MS,timeoutMs)):TIMEOUT_MS});
    if(!same(identity,await getProcess(identity.pid)) || executablePath(await readExecutable(identity.pid))!==executable)return null;
    return email;
  } catch {
    // OS and child-process errors can contain credentials, paths or raw output.
    return null;
  }
}

module.exports={readAccount,readProfileContext,parseProfileEnvironment,validEmail};
