'use strict';
const fs=require('node:fs/promises');
const {constants}=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {readProcess,matchReports}=require('./core.cjs');
const MAX_PROCESSES=8192,MAX_CANDIDATES=32;
const same=(a,b)=>!!a&&!!b&&['pid','uid','start_ticks','boot_id'].every(key=>a[key]===b[key]);
const sameForeground=(a,b)=>same(a,b)&&['pgrp','tty_nr','tpgid'].every(key=>a[key]===b[key]);
async function* processIds() {
 const directory=await fs.opendir('/proc');
 for await(const entry of directory)if(/^\d+$/.test(entry.name))yield Number(entry.name);
}
async function getExecutable(pid) {
 try{return await fs.readlink(`/proc/${pid}/exe`);}catch{return null;}
}
async function inspectCommand(lookup) {
 let file;
 try {
  const real=await fs.realpath(lookup);
  file=await fs.open(real,constants.O_RDONLY|constants.O_NONBLOCK|constants.O_NOFOLLOW);
  const info=await file.stat();
  if(!info.isFile() || !(info.mode&0o111))return null;
  const header=Buffer.alloc(4),{bytesRead}=await file.read(header,0,4,0);
  return {real,native:bytesRead===4 && header.equals(Buffer.from([0x7f,0x45,0x4c,0x46]))};
 } catch {return null;} finally {await file?.close();}
}
async function resolveExecutable(lookup) {const command=await inspectCommand(lookup);return command?.native?command.real:null;}
async function resolveCommand(lookup) {return (await inspectCommand(lookup))?.real||null;}
async function knownProviders(env,home,resolveNative,resolveInstalled) {
 const directories=String(env.PATH||'').split(path.delimiter).filter(directory=>path.isAbsolute(directory));
 if(typeof home==='string' && path.isAbsolute(home))directories.push(path.join(home,'.local','bin'));
 const known=new Map(),wrapped=new Map();
 for(const directory of new Set(directories.map(directory=>path.resolve(directory)))) {
  for(const [provider,command] of [['claude','claude'],['codex','codex'],['antigravity','agy']]) {
   const cliPath=path.join(directory,command),executable=await resolveNative(cliPath);
   if(typeof executable==='string' && path.isAbsolute(executable)) {
    if(!known.has(executable))known.set(executable,{provider,cliPath});
    else if(known.get(executable)?.provider!==provider)known.set(executable,null);
   } else if(!wrapped.has(command)) {
    const launcher=await resolveInstalled(cliPath);
    if(typeof launcher==='string' && path.isAbsolute(launcher))wrapped.set(command,{provider,cliPath});
   }
  }
 }
 return {known,wrapped};
}
async function identifyExecutable(executable,{known,wrapped},resolveNative) {
 if(known.has(executable))return known.get(executable);
 const launcher=typeof executable==='string'?wrapped.get(path.basename(executable)):null;
 return launcher && await resolveNative(executable)===executable?{provider:launcher.provider,cliPath:executable}:null;
}
// Runs as the target user. No command execution, credentials or settings reads.
async function verifyTargetProcess(target,{uid=process.getuid?.(),env=process.env,home=os.homedir(),
 getProcess=readProcess,getExecutable:readExecutable=getExecutable,
 resolveExecutable:resolveNative=resolveExecutable,resolveCommand:resolveInstalled=resolveCommand}={}) {
 try {
  if(!target || target.process?.uid!==uid || !['claude','codex','antigravity'].includes(target.provider))return null;
  const current=await getProcess(target.process.pid);
  if(!same(current,target.process)||!current.tty_nr||current.tpgid<=0||current.pgrp!==current.tpgid)return null;
  const executable=await readExecutable(current.pid);
  const found=await identifyExecutable(executable,await knownProviders(env,home,resolveNative,resolveInstalled),resolveNative);
  if(!found || found.provider!==target.provider || (target.cliPath&&target.cliPath!==found.cliPath) ||
    await resolveNative(found.cliPath)!==executable || await readExecutable(current.pid)!==executable ||
    !sameForeground(current,await getProcess(current.pid)))return null;
  return {...found,process:{...target.process}};
 } catch {return null;}
}

// Read-only UI discovery, not authorization to run a CLI or change its profile.
// Connect Provider separately validates executable ownership and settings safety.
function createProviderDetector({platform=process.platform,uid=process.getuid?.(),
 env=process.env,home=os.homedir(),processIds:listProcesses=processIds,
 getProcess=readProcess,getExecutable:readExecutable=getExecutable,
 resolveExecutable:resolveNative=resolveExecutable,resolveCommand:resolveInstalled=resolveCommand}={}) {
 const automatic=async function(terminalPid) {
  if(platform!=='linux')return null;
  try {
   const terminal=await getProcess(terminalPid);
   if(!terminal || terminal.uid!==uid || !terminal.tty_nr || terminal.tpgid<=0)return null;
   const {known,wrapped}=await knownProviders(env,home,resolveNative,resolveInstalled);
   if(!known.size && !wrapped.size)return null;
   const candidates=[];let inspected=0;
   for await(const pid of listProcesses()) {
    if(++inspected>MAX_PROCESSES)return null;
    const current=await getProcess(pid);
    if(!current)continue;
    const executable=await readExecutable(pid);
    const provider=await identifyExecutable(executable,{known,wrapped},resolveNative);
    if(!provider && !known.has(executable))continue;
    if((await matchReports(terminalPid,[{process:current}],getProcess)).status!=='ready')continue;
    if(!provider || candidates.length>=MAX_CANDIDATES)return null;
    candidates.push({...provider,executable,process:current});
   }
   const matched=await matchReports(terminalPid,candidates,getProcess);
   if(matched.status!=='ready')return null;
   const candidate=matched.report;
   // Re-resolve the stable link as well: native auto-updates can replace it while
   // an earlier version still runs. A later observation can retry safely.
   if(await resolveNative(candidate.cliPath)!==candidate.executable ||
      await readExecutable(candidate.process.pid)!==candidate.executable ||
      !sameForeground(candidate.process,await getProcess(candidate.process.pid)) ||
      !sameForeground(terminal,await getProcess(terminalPid)))return null;
   const {pid,uid:owner,start_ticks,boot_id}=candidate.process;
   return {provider:candidate.provider,cliPath:candidate.cliPath,process:{pid,uid:owner,start_ticks,boot_id}};
  } catch {return null;}
 };
 return async function detectProvider(terminalPid,{allowForeign=false,topologyOnly=false}={}) {
  if(!topologyOnly) {const found=await automatic(terminalPid);if(found || !allowForeign)return found;}
  // An explicit picker may defer vendor proof to the target UID. This path
  // proves topology only and must never authorize host-user profile discovery.
  const unavailable={provider:null,unavailable:true};
  if(platform!=='linux')return unavailable;
  try {
   const checked=async pid=>{const value=await getProcess(pid);if(!value)throw new Error('unreadable-topology');return value;};
   const terminal=await checked(terminalPid);
   if(terminal.uid!==uid || !terminal.tty_nr || terminal.tpgid<=0)return unavailable;
   const candidates=[];let inspected=0;
   for await(const pid of listProcesses()) {
    if(++inspected>MAX_PROCESSES)return unavailable;
    const current=await checked(pid);
    if(current.uid===uid || !current.tty_nr || current.tpgid<=0 || current.pgrp!==current.tpgid)continue;
    if((await matchReports(terminalPid,[{process:current}],checked)).status==='ready') {
     candidates.push({process:current});if(candidates.length>1)return unavailable;
    }
   }
   if(!sameForeground(terminal,await checked(terminalPid)))return unavailable;
   if(!candidates.length)return null;
   const matched=await matchReports(terminalPid,candidates,checked);
   if(matched.status!=='ready'||!sameForeground(terminal,await checked(terminalPid)))return unavailable;
   const {pid,uid:owner,start_ticks,boot_id}=matched.report.process;
   return {provider:null,cliPath:null,process:{pid,uid:owner,start_ticks,boot_id}};
  } catch {return unavailable;}
 };
}
module.exports={detectProvider:createProviderDetector(),createProviderDetector,verifyTargetProcess};
