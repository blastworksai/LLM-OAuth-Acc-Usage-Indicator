'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {codexFdReport}=require('../collectors/passive.cjs');
const {readProcess,matchReports,validateReport,planLabel}=require('./core.cjs');
const {readAccount:readNativeAccount,validEmail}=require('./account.cjs');
const MAX_PROCESSES=8192,MAX_CANDIDATES=32,MAX_BYTES=32768,MAX_SESSIONS=64;
const same=(a,b)=>!!a&&!!b&&['pid','uid','start_ticks','boot_id'].every(key=>a[key]===b[key]);
const sameForeground=(a,b)=>same(a,b)&&['pgrp','tty_nr','tpgid'].every(key=>a[key]===b[key]);
const executable=value=>typeof value==='string'?value.replace(/ \(deleted\)$/,''):null;
const unavailable=reason=>({status:'unavailable',reason});

async function* processIds() {
  const directory=await fs.opendir('/proc');
  for await(const entry of directory)if(/^\d+$/.test(entry.name))yield Number(entry.name);
}
async function getExecutable(pid) {
  try{return await fs.readlink(`/proc/${pid}/exe`);}catch{return null;}
}

// Account metadata is sampled only when observing a new usage event. This cache
// lives in the collector, never on disk, and never reconstructs login history.
// Dependencies are injectable for process-race and native-protocol tests.
function createCollector({platform=process.platform,uid=process.getuid?.(),
  processIds:listProcesses=processIds,getProcess=readProcess,getExecutable:readExecutable=getExecutable,
  readCodex=codexFdReport,readAccount=readNativeAccount,now=Date.now}={}) {
  const startedAt=now(),sessions=new Map();
  let evictedThrough=-Infinity;
  async function accountFor(report,exe) {
    if(!planLabel(report))return null;
    const event=report.source.source_event_at,eventMs=Date.parse(event);
    if(!Number.isFinite(eventMs))return null;
    const p=report.process,key=JSON.stringify([p.pid,p.uid,p.start_ticks,p.boot_id,report.session_id]);
    const previous=sessions.get(key);
    if(previous && eventMs<=previous.eventMs)return event===previous.event?await previous.account:null;
    const entry={event,eventMs,account:Promise.resolve(null)};
    // Save the entry before awaiting so overlapping refreshes share one sample.
    sessions.delete(key);sessions.set(key,entry);
    while(sessions.size>MAX_SESSIONS) {
      const oldest=sessions.keys().next().value;
      evictedThrough=Math.max(evictedThrough,sessions.get(oldest).eventMs);
      sessions.delete(oldest);
    }
    // Once bounded history is evicted, conservatively baseline older unseen
    // events instead of resampling a login for a previously observed snapshot.
    if(!previous && (eventMs<startedAt || eventMs<=evictedThrough))return null;
    entry.account=(async()=>{
      try {
        const email=await readAccount({process:p,executable:exe});
        return validEmail(email)?{email,source:'codex-account-read',usage_event_at:event,observed_at:new Date(now()).toISOString()}:null;
      } catch {return null;}
    })();
    return await entry.account;
  }
  return async function collectTerminal(terminalPid) {
    if(platform!=='linux')return null;
    try {
      const terminal=await getProcess(terminalPid);
      if(!terminal || terminal.uid!==uid || !terminal.tty_nr || terminal.tpgid<=0)return null;
      const candidates=[],executables=new Map();
      let inspected=0;
      for await(const pid of listProcesses()) {
        if(++inspected>MAX_PROCESSES)return null;
        const current=await getProcess(pid);
        if(!current || current.uid!==uid)continue;
        const exe=executable(await readExecutable(pid));
        if(!exe || !path.isAbsolute(exe) || path.basename(exe)!=='codex')continue;
        // Only the selected terminal's foreground sessions consume its candidate
        // budget. Unrelated Codex processes must not suppress other report sources.
        if((await matchReports(terminalPid,[{process:current}],getProcess)).status!=='ready')continue;
        if(candidates.length>=MAX_CANDIDATES)return unavailable('Too many Codex processes to identify this session safely.');
        // The existing matcher enforces live ancestry and the terminal's foreground job.
        candidates.push({process:current});
        executables.set(pid,exe);
      }
      const matched=await matchReports(terminalPid,candidates,getProcess);
      if(matched.status==='ambiguous')return matched;
      if(matched.status!=='ready')return null;
      const identity=matched.report.process,exe=executables.get(identity.pid);
      if(!sameForeground(terminal,await getProcess(terminalPid)) || !same(identity,await getProcess(identity.pid)) ||
        executable(await readExecutable(identity.pid))!==exe)return unavailable('The selected Codex process changed before collection.');
      // Read with the extension's bundled Node runtime. The module pins Linux
      // descriptors and bounds every source; no external interpreter is needed.
      let report=await readCodex(identity.pid,exe,new Date(now()).toISOString());
      const encoded=JSON.stringify(report);
      if(typeof encoded!=='string' || Buffer.byteLength(encoded)>MAX_BYTES)return unavailable('The passive collector returned an invalid report.');
      report=JSON.parse(encoded);
      if(!validateReport(report,uid) || report.provider!=='codex' || !same(report.process,identity))
        return unavailable('The passive collector returned an invalid report.');
      // Only this in-memory, event-bound sample can provide account metadata.
      // A passive report cannot supply or carry forward a previous identity.
      delete report.account;
      const account=await accountFor(report,exe);
      if(account)report.account=account;
      if(!sameForeground(terminal,await getProcess(terminalPid)) || executable(await readExecutable(identity.pid))!==exe)
        return unavailable('The selected Codex process changed during collection.');
      // Collection cannot revive a dead/reused PID or a job moved out of the foreground.
      return await matchReports(terminalPid,[report],getProcess);
    } catch {
      // Child-process errors may contain argv, paths or stdout. Never forward them.
      return unavailable('This Codex session has no readable passive usage report.');
    }
  };
}

module.exports={collectTerminal:createCollector(),createCollector};
