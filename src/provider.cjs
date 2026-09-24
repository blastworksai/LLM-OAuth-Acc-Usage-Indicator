'use strict';
const fs=require('node:fs/promises');
const {constants}=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {readProcess,matchReports}=require('./core.cjs');
const MAX_PROCESSES=8192,MAX_CANDIDATES=32;
// Kernel process names of the tools that switch user and run a command below them.
const USER_SWITCHERS=new Set(['sudo','sudo-rs','su','doas','runuser']);
const same=(a,b)=>!!a&&!!b&&['pid','uid','start_ticks','boot_id'].every(key=>a[key]===b[key]);
const sameForeground=(a,b)=>same(a,b)&&['pgrp','tty_nr','tpgid'].every(key=>a[key]===b[key]);
async function* processIds() {
 const directory=await fs.opendir('/proc');
 for await(const entry of directory)if(/^\d+$/.test(entry.name))yield Number(entry.name);
}
// A pid listed but no longer readable is only skippable when it provably holds no
// live process: it exited, or it is a zombie. Anything else fails closed.
async function processGone(pid,readFile=fs.readFile) {
 try {
  const raw=await readFile(`/proc/${pid}/stat`,'utf8');
  return /^[ZX]$/.test(raw.slice(raw.lastIndexOf(')')+2).split(' ',1)[0]);
 } catch(error) {return error?.code==='ENOENT'||error?.code==='ESRCH';}
}
// Readable for another user's process, unlike /proc/<pid>/exe.
async function getCommandLine(pid) {
 try{return (await fs.readFile(`/proc/${pid}/cmdline`,'utf8')).split('\0').filter(Boolean);}catch{return null;}
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
 resolveExecutable:resolveNative=resolveExecutable,resolveCommand:resolveInstalled=resolveCommand,
 processGone:isGone=processGone,getCommandLine:readCommandLine=getCommandLine}={}) {
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
    const current=await getProcess(pid);
    if(!current) {if(await isGone(pid))continue;throw new Error('unreadable-topology');}
    if(current.uid===uid || !current.tty_nr || current.tpgid<=0 || current.pgrp!==current.tpgid)continue;
    const stableCandidate=async observedPid=>{
     const next=await checked(observedPid);
     if(observedPid===current.pid && (!sameForeground(current,next)||current.ppid!==next.ppid))
      throw new Error('changed-foreign-topology');
     return next;
    };
    if((await matchReports(terminalPid,[{process:current}],stableCandidate)).status==='ready') {
     candidates.push({process:current});if(candidates.length>MAX_CANDIDATES)return unavailable;
    }
   }
   // A user-switching wrapper (`sudo -u`, `su`, `runuser`) keeps its own process in
   // the terminal's foreground group while the CLI runs below it on a pty of its own;
   // both match. Drop a candidate only when it is established as such a wrapper:
   // root-owned (switching user needs root), named as a known user switcher, AND
   // another candidate's ancestor. Any other ancestor may itself be a CLI that
   // launched another, even as root, and stays: that, like siblings, is ambiguous.
   const ancestors=[];
   for(const candidate of candidates) {
    let current=await checked(candidate.process.ppid);
    for(let depth=0;depth<64 && !same(current,terminal);depth++) {
     ancestors.push(current);
     if(current.ppid<=1)break;
     current=await checked(current.ppid);
    }
   }
   const wrapper=c=>c.process.uid===0 && USER_SWITCHERS.has(c.process.comm) && ancestors.some(a=>same(a,c.process));
   // An npm install puts a script launcher on PATH (`node /usr/bin/codex`) that
   // spawns the native CLI as its direct child in the same foreground group; both
   // match. Drop the parent only when it is that: same UID, same group and tty,
   // parent of another kept candidate, and its script resolves to a provider
   // launcher on PATH. Any other parent/child pair stays ambiguous.
   // The child must carry the launcher's own command name, so a launcher running a
   // different program below it stays ambiguous. Launchers only on the target
   // user's PATH are not recognised and fail closed.
   const launchers=new Map();
   for(const [command,{cliPath}] of (await knownProviders(env,home,resolveNative,resolveInstalled)).wrapped) {
    const real=await resolveInstalled(cliPath);if(typeof real==='string')launchers.set(real,command);
   }
   const launcher=async c=>{
    if(!launchers.size)return false;
    const argv=await readCommandLine(c.process.pid);
    if(!Array.isArray(argv) || argv.length<2 || !path.isAbsolute(argv[1]))return false;
    const command=launchers.get(await resolveInstalled(argv[1]));
    const child=!!command && candidates.some(d=>!wrapper(d) && d.process.ppid===c.process.pid && d.process.uid===c.process.uid &&
      d.process.pgrp===c.process.pgrp && d.process.tty_nr===c.process.tty_nr && d.process.comm===command);
    return child && sameForeground(c.process,await checked(c.process.pid));
   };
   const innermost=[];
   for(const c of candidates)if(!wrapper(c) && !await launcher(c))innermost.push(c);
   if(innermost.length>1)return unavailable;
   if(!sameForeground(terminal,await checked(terminalPid)))return unavailable;
   if(!innermost.length)return null;
   const matched=await matchReports(terminalPid,innermost,checked);
   if(matched.status!=='ready'||!sameForeground(terminal,await checked(terminalPid)))return unavailable;
   const {pid,uid:owner,start_ticks,boot_id}=matched.report.process;
   return {provider:null,cliPath:null,process:{pid,uid:owner,start_ticks,boot_id}};
  } catch {return unavailable;}
 };
}
module.exports={detectProvider:createProviderDetector(),createProviderDetector,verifyTargetProcess,processGone};
