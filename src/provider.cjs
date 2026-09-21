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

// Read-only UI discovery, not authorization to run a CLI or change its profile.
// Connect Provider separately validates executable ownership and settings safety.
function createProviderDetector({platform=process.platform,uid=process.getuid?.(),
 env=process.env,home=os.homedir(),processIds:listProcesses=processIds,
 getProcess=readProcess,getExecutable:readExecutable=getExecutable,
 resolveExecutable:resolveNative=resolveExecutable,resolveCommand:resolveInstalled=resolveCommand}={}) {
 return async function detectProvider(terminalPid) {
  if(platform!=='linux')return null;
  try {
   const terminal=await getProcess(terminalPid);
   if(!terminal || terminal.uid!==uid || !terminal.tty_nr || terminal.tpgid<=0)return null;
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
   if(!known.size && !wrapped.size)return null;
   const candidates=[];let inspected=0;
   for await(const pid of listProcesses()) {
    if(++inspected>MAX_PROCESSES)return null;
    const current=await getProcess(pid);
    if(!current)continue;
    const executable=await readExecutable(pid);
    let provider=known.get(executable);
    if(!known.has(executable)) {
     const launcher=typeof executable==='string'?wrapped.get(path.basename(executable)):null;
     if(!launcher || await resolveNative(executable)!==executable)continue;
     provider={provider:launcher.provider,cliPath:executable};
    }
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
}
module.exports={detectProvider:createProviderDetector(),createProviderDetector};
