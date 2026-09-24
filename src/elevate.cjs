'use strict';
// The one road to another Linux account: /usr/bin/sudo with argv arrays, never a shell.
// A password is written to sudo's stdin for the call in hand and is never put in argv, logged, or kept.
const childProcess=require('node:child_process');
const {publicPath}=require('./connection.cjs');
const SUDO_PATH='/usr/bin/sudo',GETENT_PATH='/usr/bin/getent';
const USER_PATTERN=/^[a-z_][a-z0-9_-]{0,31}$/;
const MAX_BUFFER=64*1024,PROBE_TIMEOUT=5000,CHECK_TIMEOUT=15000,MAX_TIMEOUT=600000,MAX_ARGS=64;
const safeError=(code,message)=>Object.assign(new Error(message),{code,safeToDisplay:true});
const validUser=value=>typeof value==='string'&&USER_PATTERN.test(value);
const validPassword=value=>typeof value==='string'&&value.length<=4096&&!/[\0\r\n]/.test(value);
// execFile has no `input` option; stdin is written to the child, then always closed so no command waits on it.
function invoke(execFile,file,args,options,chunks=[]) {
  return new Promise(resolve=>{
    let child;
    try {child=execFile(file,args,options,(error,stdout,stderr)=>resolve({error,stdout:String(stdout??''),stderr:String(stderr??'')}));}
    catch(error) {resolve({error,stdout:'',stderr:''});return;}
    const pipe=child?.stdin;if(!pipe)return;
    if(typeof pipe.on==='function')pipe.on('error',()=>{});
    try {for(const chunk of chunks)pipe.write(chunk);pipe.end();} catch {}
  });
}
function outcome({error,stdout,stderr}) {
  if(!error)return {code:0,stdout,stderr};
  if(Number.isSafeInteger(error.code))return {code:error.code,stdout,stderr};
  if(error.code==='ENOENT')throw safeError('SUDO_UNAVAILABLE','sudo is not available on this host.');
  if(error.code==='ERR_CHILD_PROCESS_STDIO_MAXBUFFER')throw safeError('SUDO_OUTPUT_TOO_LARGE','The elevated command printed more than 64 KiB.');
  if(error.killed)throw safeError('SUDO_TIMEOUT','The elevated command did not finish in time.');
  throw safeError('SUDO_FAILED','The elevated command could not be run.');
}
function createElevate({execFile=childProcess.execFile,sudoPath=SUDO_PATH}={}) {
  if(typeof execFile!=='function'||!publicPath(sudoPath))throw safeError('INVALID_SUDO','The sudo path must be absolute.');
  const options=timeout=>({timeout,maxBuffer:MAX_BUFFER,encoding:'utf8',windowsHide:true});
  async function probe() {
    // C locale so sudo's own message is the English one the rule reads.
    const {error,stderr}=await invoke(execFile,sudoPath,['-n','true'],{...options(PROBE_TIMEOUT),env:{...process.env,LC_ALL:'C',LANG:'C'}});
    if(!error)return 'passwordless';
    return Number.isSafeInteger(error.code)&&error.code!==0&&/password is required|a password is required/i.test(stderr)?'password':'none';
  }
  async function checkPassword(password) {
    if(!validPassword(password))throw safeError('INVALID_PASSWORD','The password cannot contain line breaks.');
    return outcome(await invoke(execFile,sudoPath,['-S','-k','-p','','-v'],options(CHECK_TIMEOUT),[password+'\n'])).code===0;
  }
  async function run(argv,{asUser,password,input,timeoutMs=60000}={}) {
    if(!Array.isArray(argv)||!argv.length||argv.length>MAX_ARGS||!publicPath(argv[0])||
      !argv.every(value=>typeof value==='string'&&!value.includes('\0')))throw safeError('INVALID_COMMAND','The elevated command must start with an absolute program path.');
    // Only an absent asUser means root; null or an empty name never falls back to root.
    if(asUser!==undefined&&!validUser(asUser))throw safeError('INVALID_USER','The Linux account name cannot be used safely.');
    if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>MAX_TIMEOUT)throw safeError('INVALID_TIMEOUT','The elevated command timeout is out of range.');
    if(input!==undefined&&typeof input!=='string'&&!Buffer.isBuffer(input))throw safeError('INVALID_INPUT','The elevated command input must be text.');
    const held=password!==undefined&&password!==null;
    if(held&&!validPassword(password))throw safeError('INVALID_PASSWORD','The password cannot contain line breaks.');
    // DEVIATION (flagged, not in the plan): -k on the password road. With a cached sudo timestamp, sudo -S does not read
    // stdin, so the password line would pass through to the command, a process of the target account. -k makes sudo
    // ignore the cache and consume the line itself; with a command it neither updates nor removes the timestamp.
    const args=[...(held?['-S','-k','-p','']:['-n']),...(asUser===undefined?[]:['-H','-u',asUser]),'--',...argv];
    const chunks=[...(held?[password+'\n']:[]),...(input===undefined?[]:[input])];
    return outcome(await invoke(execFile,sudoPath,args,options(timeoutMs),chunks));
  }
  return Object.freeze({probe,checkPassword,run});
}
async function resolveUser(uid,{execFile=childProcess.execFile}={}) {
  if(!Number.isSafeInteger(uid)||uid<0||uid>4294967294)throw safeError('INVALID_USER','The session’s Linux account id is not valid.');
  const {error,stdout}=await invoke(execFile,GETENT_PATH,['passwd',String(uid)],{timeout:PROBE_TIMEOUT,maxBuffer:MAX_BUFFER,encoding:'utf8',windowsHide:true});
  if(error?.code===2)throw safeError('USER_NOT_FOUND','The session’s Linux account has no passwd entry.');
  if(error)throw safeError('USER_UNRESOLVED','The session’s Linux account could not be looked up.');
  const lines=stdout.split('\n').filter(Boolean),fields=lines.length===1?lines[0].split(':'):[];
  if(fields.length!==7||fields[2]!==String(uid)||!validUser(fields[0]))throw safeError('INVALID_USER','The Linux account name cannot be used safely.');
  return fields[0];
}
module.exports={createElevate,resolveUser,USER_PATTERN,SUDO_PATH};
