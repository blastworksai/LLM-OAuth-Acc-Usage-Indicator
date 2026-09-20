'use strict';
const fs = require('node:fs/promises');
const constants = require('node:fs').constants;
const path = require('node:path');
const os = require('node:os');
const {createHash}=require('node:crypto');
const MAX_BYTES = 32768;
const MAX_FILES = 128;
const MAX_DIRS = 16;
const STALE_MS = 15 * 60 * 1000;
const text = (v, max=256) => typeof v==='string' && v.length>0 && v.length<=max && !/[\x00-\x1f\x7f]/.test(v);
const object = v => !!v && typeof v==='object' && !Array.isArray(v);
const keys = (v, allowed) => object(v) && Object.keys(v).every(k=>allowed.includes(k));
const time = v => v===null || (typeof v==='string' && /^\d{4}-\d\d-\d\dT/.test(v) && v.length<=40 && Number.isFinite(Date.parse(v)));
const integer = v => Number.isSafeInteger(v) && v>=0;
// Native Codex PlanType enum; no arbitrary provider strings reach the account card.
const CODEX_PLAN_LABELS = Object.freeze({
  free:'Free',go:'Go',plus:'Plus',pro:'Pro',prolite:'Pro Lite',team:'Team',
  self_serve_business_prolite:'Self-serve Business Pro Lite',
  self_serve_business_usage_based:'Self-serve Business (usage based)',business:'Business',
  ent26:'Ent26',enterprise_cbp_automation:'Enterprise CBP Automation',
  enterprise_cbp_usage_based:'Enterprise CBP (usage based)',enterprise:'Enterprise',
  edu:'Education',edu_plus:'Education Plus',edu_pro:'Education Pro'
});
const CLAUDE_PLAN_LABELS=Object.freeze({free:'Free',pro:'Pro',max:'Max',team:'Team',enterprise:'Enterprise'});
const AGY_PLAN_LABELS=Object.freeze({free:'Free',pro:'Pro',ultra:'Ultra'});
const SOURCE_KINDS=Object.freeze({claude:'claude-statusline',codex:'codex-session-event',antigravity:'antigravity-statusline'});
const sourceAllowed=(provider,kind)=>SOURCE_KINDS[provider]===kind ||
  (provider==='antigravity' && kind==='antigravity-native-usage');
function planLabel(r) {
  if(r.provider==='antigravity')return sourceAllowed(r.provider,r.source?.kind) &&
    r.source.captured_at!==null && time(r.source.captured_at) &&
    typeof r.plan_type==='string' && Object.hasOwn(AGY_PLAN_LABELS,r.plan_type)
    ? AGY_PLAN_LABELS[r.plan_type] : null;
  if(r.provider==='claude')return r.source?.kind==='claude-statusline' &&
    r.source.captured_at!==null && time(r.source.captured_at) &&
    typeof r.plan_type==='string' && Object.hasOwn(CLAUDE_PLAN_LABELS,r.plan_type)
    ? CLAUDE_PLAN_LABELS[r.plan_type] : null;
  return r.provider==='codex' && r.source?.kind==='codex-session-event' &&
    r.source.source_event_at!==null && time(r.source.source_event_at) &&
    typeof r.plan_type==='string' && Object.hasOwn(CODEX_PLAN_LABELS,r.plan_type)
    ? CODEX_PLAN_LABELS[r.plan_type] : null;
}
function accountEmail(r) {
  const a=r.account;
  const codex=r.provider==='codex' && planLabel(r) && a?.source==='codex-account-read' && a.usage_event_at===r.source.source_event_at;
  const claude=r.provider==='claude' && r.source?.kind==='claude-statusline' &&
    r.source.captured_at!==null && time(r.source.captured_at) &&
    a?.source==='claude-auth-status' && a.usage_event_at===r.source.captured_at;
  const antigravity=r.provider==='antigravity' && sourceAllowed(r.provider,r.source?.kind) &&
    r.source.captured_at!==null && time(r.source.captured_at) &&
    a?.source==='antigravity-statusline' && a.usage_event_at===r.source.captured_at;
  return (codex || claude || antigravity) && keys(a,['email','source','usage_event_at','observed_at']) &&
    text(a.email,254) && /^[^\s<>@]+@[^\s<>@]+$/.test(a.email) &&
    a.observed_at!==null && time(a.observed_at) ? a.email : null;
}

function validateReport(r, owner) {
  if(!keys(r,['schema_version','provider','session_id','process','model','source','windows','coverage','plan_type','account']) || r.schema_version!==1 || typeof r.provider!=='string' || !Object.hasOwn(SOURCE_KINDS,r.provider) || !text(r.session_id)) return false;
  const p=r.process, s=r.source;
  if(!keys(p,['pid','start_ticks','uid','boot_id']) || !integer(p.pid) || p.pid<1 || !integer(p.uid) || p.uid!==owner || typeof p.start_ticks!=='string' || !/^\d{1,30}$/.test(p.start_ticks) || !text(p.boot_id,64)) return false;
  if(r.model!==null && !text(r.model,128)) return false;
  if(!keys(s,['kind','source_event_at','captured_at','provider_observed_at']) || !sourceAllowed(r.provider,s.kind) || !time(s.source_event_at) || s.captured_at===null || !time(s.captured_at) || !time(s.provider_observed_at)) return false;
  if(Object.hasOwn(r,'plan_type') && r.plan_type!==null && !planLabel(r)) return false;
  if(Object.hasOwn(r,'account') && !accountEmail(r)) return false;
  if(!text(r.coverage,512) || !Array.isArray(r.windows) || r.windows.length>32) return false;
  const seen=new Set();
  return r.windows.every(w=> {
    if(!keys(w,['pool_id','window_id','duration_minutes','used_percent','resets_at']) || !text(w.pool_id,128) || !text(w.window_id,128) || !(w.duration_minutes===null || (integer(w.duration_minutes) && w.duration_minutes>0 && w.duration_minutes<=525600)) || !(w.used_percent===null || (Number.isFinite(w.used_percent) && w.used_percent>=0 && w.used_percent<=100)) || !time(w.resets_at)) return false;
    const id=JSON.stringify([w.pool_id,w.window_id]); if(seen.has(id))return false;seen.add(id);return true;
  });
}

async function readProcess(pid) {
  if(process.platform!=='linux' || !integer(pid) || pid<1) return null;
  try {
    const dir=`/proc/${pid}`;
    const [raw,st,boot] = await Promise.all([fs.readFile(`${dir}/stat`,'utf8'),fs.stat(dir),fs.readFile('/proc/sys/kernel/random/boot_id','utf8')]);
    const fields=raw.slice(raw.lastIndexOf(')')+2).trim().split(/\s+/);
    if(fields[0]==='Z' || !fields[19]) return null;
    return {pid, ppid:Number(fields[1]),uid:st.uid,start_ticks:fields[19],boot_id:boot.trim(),pgrp:Number(fields[2]),tty_nr:Number(fields[4]),tpgid:Number(fields[5])};
  } catch { return null; }
}
const same = (a,b) => !!a && !!b && ['pid','uid','start_ticks','boot_id'].every(k=>a[k]===b[k]);
const sameForeground = (a,b) => same(a,b) && ['pgrp','tty_nr','tpgid'].every(k=>a[k]===b[k]);
const foreground = p => !!p && p.tty_nr!==0 && p.tpgid>0 && p.pgrp===p.tpgid;

async function matchReports(terminalPid, reports, getProcess=readProcess) {
  const terminal = await getProcess(terminalPid);
  const unavailable={status:'unavailable',reason:'No live session report matches this terminal.'};
  if(!terminal || !terminal.tty_nr || terminal.tpgid<=0) return unavailable;
  const matches=[];
  for(const report of reports) {
    let current=await getProcess(report.process.pid);
    if(!same(current,report.process) || !foreground(current)) continue;
    const publisher=current;
    const visited=new Set();let matched=false,outerForeground=false;
    for(let depth=0;current && depth<64;depth++) {
      if(current.tty_nr===terminal.tty_nr && current.pgrp===terminal.tpgid)outerForeground=true;
      if(same(current,terminal)){matched=true;break;}
      if(visited.has(current.pid) || current.ppid<=1)break;
      visited.add(current.pid);current=await getProcess(current.ppid);
    }
    // Recheck the publisher after walking ancestry; it may have exited mid-read.
    if(matched && outerForeground && sameForeground(await getProcess(report.process.pid),publisher)) matches.push({report,publisher});
  }
  if(!sameForeground(await getProcess(terminalPid),terminal))return unavailable;
  // Only identical duplicate snapshots can collapse. Different snapshots of the
  // same session in configured directories are a conflict, not last-dir-wins.
  const unique=[...new Map(matches.map(m=>[JSON.stringify(m.report),m])).values()];
  if(unique.length>1)return {status:'ambiguous',reason:'Several live sessions are inside this terminal. No quota selected.'};
  if(unique.length!==1 || !sameForeground(await getProcess(unique[0].report.process.pid),unique[0].publisher))return unavailable;
  return {status:'ready',report:unique[0].report};
}

async function readFeeds(directories) {
  const reports=[];let rejected=0;
  for(const input of directories.slice(0,MAX_DIRS)) {
    if(typeof input!=='string') {rejected++;continue;}
    const dir=path.resolve(input.startsWith('~/')?path.join(os.homedir(),input.slice(2)):input);
    let directory;
    try {
      const info=await fs.lstat(dir);
      if(!info.isDirectory() || ((info.mode & 0o7777) & ~0o2750) || await fs.realpath(dir)!==dir) {rejected++;continue;}
      directory=await fs.open(dir,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
      const pinned=await directory.stat();
      if(pinned.ino!==info.ino || pinned.dev!==info.dev || pinned.uid!==info.uid || ((pinned.mode & 0o7777) & ~0o2750) || await fs.realpath(dir)!==dir){rejected++;continue;}
      // A Linux descriptor anchor pins the checked directory even if its path
      // is replaced. O_NOFOLLOW below then protects the final report component.
      const anchor=`/proc/self/fd/${directory.fd}`;
      // Bounded directory iteration; a noisy publisher cannot trigger unbounded reads.
      const entries=[];const handle=await fs.opendir(anchor);let inspected=0;
      for await (const entry of handle) {
        if(++inspected>MAX_FILES)break;
        if(/^(claude|codex|antigravity)-[a-f0-9]{24}\.json$/.test(entry.name))entries.push(entry.name);
      }
      if(inspected>MAX_FILES){rejected++;continue;}
      for(const name of entries) {
        let file;
        try {
          // O_NONBLOCK prevents a crafted fifo hanging the extension before fstat.
          file=await fs.open(path.join(anchor,name),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
          const st=await file.stat();
          if(!st.isFile() || st.uid!==info.uid || ((st.mode & 0o7777) & ~0o640) || st.size>MAX_BYTES){rejected++;continue;}
          const buffer=Buffer.alloc(MAX_BYTES+1);const {bytesRead}=await file.read(buffer,0,buffer.length,0);
          if(bytesRead>MAX_BYTES){rejected++;continue;}
          const report=JSON.parse(buffer.toString('utf8',0,bytesRead));
          if(!validateReport(report,st.uid) || name!==reportFilename(report)){rejected++;continue;}
          reports.push(report);
        } catch {rejected++;} finally {await file?.close();}
      }
    } catch {rejected++;} finally {await directory?.close();}
  }
  return {reports,rejected};
}
function reportFilename(report){return `${report.provider}-${createHash('sha256').update(report.session_id).digest('hex').slice(0,24)}.json`;}

function duration(minutes) {
  if(minutes===null)return 'Unknown duration';
  if(minutes%1440===0)return `${minutes/1440} ${minutes===1440?'day':'days'}`;
  if(minutes%60===0)return `${minutes/60} ${minutes===60?'hour':'hours'}`;
  return `${minutes} minutes`;
}
function age(iso,now) {
  if(!iso)return 'time unknown';
  const mins=Math.max(0,Math.floor((now-Date.parse(iso))/60000));
  return mins<1?'less than a minute ago':mins<60?`${mins}m ago`:mins<1440?`${Math.floor(mins/60)}h ago`:`${Math.floor(mins/1440)}d ago`;
}
function buildRows(state,now=Date.now()) {
  const rows=[{label:state.terminalName || 'Select a terminal',description:'Following active terminal',icon:'terminal'}];
  if(state.status!=='ready') {
    rows.push({label:({loading:'Matching session…','no-terminal':'No terminal selected',unsupported:'Linux terminal host required',ambiguous:'Session match is ambiguous',unavailable:'Usage unavailable'})[state.status]||'Usage unavailable',detail:state.reason||'No passive report from a supported session. Existing uninstrumented terminals stay unknown.',icon:state.status==='loading'?'sync':'info'});
    rows.push({label:'Claude, Codex and Antigravity',description:'Other tools unsupported',icon:'info'});
    return rows;
  }
  const r=state.report;
  rows.push({label:({claude:'Claude',codex:'Codex',antigravity:'Antigravity'})[r.provider],description:'Account quota',icon:'hubot'});
  rows.push({label:accountEmail(r)||'Account not identified',description:accountEmail(r)?'Login at last usage update':`Local UID ${r.process.uid}`,detail:accountEmail(r)?'Current CLI login sampled when this usage update was observed.':'Account identity is unavailable for this usage update.',icon:'account'});
  rows.push({label:`Session ${r.session_id.slice(0,12)}`,description:'Matched to terminal',icon:'link'});
  for(const w of r.windows) {
    const reset=w.resets_at && Date.parse(w.resets_at)<=now;
    const percentage=w.used_percent===null?'Usage not reported':`${Math.round(w.used_percent*10)/10}% used`;
    const date=w.resets_at ? new Date(w.resets_at).toLocaleString() : 'not reported';
    rows.push({label:duration(w.duration_minutes),description:reset?'Reset passed — awaiting report':percentage,detail:`Pool: ${w.pool_id}; window: ${w.window_id}. Reset: ${date}. This session may not report every pool.`,icon:reset?'history':'pie-chart'});
    rows.push({label:reset?'Awaiting a new quota report':`Resets ${date}`,description:w.pool_id,icon:'clock'});
  }
  if(!r.windows.length)rows.push({label:'No quota windows reported',description:'Awaiting session data',icon:'info'});
  const event=r.source.source_event_at;
  const clockAhead=Date.parse(r.source.captured_at)>now+60000 || (event && Date.parse(event)>now+60000);
  const stale=now-Date.parse(event || r.source.captured_at)>STALE_MS;
  rows.push({label:event?`Session report: ${age(event,now)}`:`Captured: ${age(r.source.captured_at,now)}`,description:clockAhead?'Clock mismatch':stale?'Stale report':'Passive snapshot',detail:`Captured ${r.source.captured_at}. Provider measurement time ${r.source.provider_observed_at || 'unknown'}. A capture is not a new provider measurement.`,icon:stale||clockAhead?'warning':'history'});
  rows.push({label:'Only reported account limits shown',detail:r.coverage,icon:'info'});
  return rows;
}

class SelectionController {
  constructor(resolve,notify){this.resolve=resolve;this.notify=notify;this.generation=0;this.disposed=false;this.state={status:'no-terminal'};}
  publish(state){this.state=state;this.notify(state);}
  async select(terminal,{quiet=false}={}) {
    if(this.disposed)return;
    const generation=++this.generation;
    if(!quiet)this.publish({status:terminal?'loading':'no-terminal',terminalName:terminal?.name});
    try {
      const next=terminal ? await this.resolve(terminal) : {status:'no-terminal'};
      if(!this.disposed && generation===this.generation)this.publish({...next,terminalName:terminal?.name});
    } catch {
      if(!this.disposed && generation===this.generation)this.publish({status:'unavailable',terminalName:terminal?.name,reason:'Local session report could not be read.'});
    }
  }
  dispose(){this.disposed=true;this.generation++;}
}
module.exports={validateReport,readProcess,matchReports,readFeeds,buildRows,SelectionController,reportFilename,planLabel,accountEmail};
