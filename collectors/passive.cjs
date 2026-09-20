'use strict';
// Dependency-free Linux collector. No credentials, terminal scraping, newest-file
// selection, direct HTTP requests, or runtime dependency on Python.
const fs=require('node:fs/promises');
const {constants:C}=require('node:fs');
const {Readable}=require('node:stream');
const path=require('node:path');
const os=require('node:os');
const {createHash,randomBytes}=require('node:crypto');
const {spawn}=require('node:child_process');
const MAX_REPORT=32768,MAX_NATIVE_STDERR=8192,MAX_INPUT=1048576,MAX_HEAD=524288,MAX_TAIL=262144,MAX_FDS=512,MAX_TRANSCRIPTS=32;
const MAX_PRUNE_ENTRIES=1024,MAX_PUBLISHED_ENTRIES=120;
const COVERAGE='Only windows supplied by this session. Other account limits may be unavailable.';
const CODEX_PLANS=new Set(['free','go','plus','pro','prolite','team','self_serve_business_prolite','self_serve_business_usage_based','business','ent26','enterprise_cbp_automation','enterprise_cbp_usage_based','enterprise','edu','edu_plus','edu_pro']);
const CLAUDE_PLANS=new Set(['free','pro','max','team','enterprise']);
const AGY_PLANS=new Map([['Free','free'],['free','free'],['Pro','pro'],['pro','pro'],['Ultra','ultra'],['ultra','ultra'],['Google AI Pro','pro']]);
const AGY_BUCKETS=new Map([['gemini-5h',['Gemini Models','5-hour',300]],['gemini-weekly',['Gemini Models','weekly',10080]]]);
const AGY_POOLS=new Set(['Gemini Models','Claude and GPT models']);
const AGY_WINDOWS=new Map([['Weekly Limit Remaining',['weekly',10080]],['Five Hour Limit Remaining',['5-hour',300]]]);
class CollectorError extends Error {}
const fail=code=>{throw new CollectorError(code);};
const object=v=>!!v && typeof v==='object' && !Array.isArray(v);
const smallString=(v,max=256)=>typeof v==='string' && v.length>0 && v.length<=max && !/[\x00-\x1f\x7f]/.test(v)?v:null;
const validEmail=v=>typeof v==='string' && v.length<=254 && /^[^\s<>@\p{Cc}\p{Cf}\p{Cs}]+@[^\s<>@\p{Cc}\p{Cf}\p{Cs}]+$/u.test(v);
const number=(v,min=0,max=100)=>typeof v==='number' && Number.isFinite(v) && v>=min && v<=max?v:null;
const same=(a,b)=>!!a&&!!b&&['pid','uid','start_ticks','boot_id'].every(k=>a[k]===b[k]);
const utcNow=()=>new Date().toISOString();
const decode=buffer=>new TextDecoder('utf-8',{fatal:true}).decode(buffer);
function timestamp(value) {
 if(typeof value!=='string' || value.length>64 || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/.test(value))return null;
 const [year,month,day,hour,minute,second]=value.match(/^\d{4}|\d\d/g).slice(0,6).map(Number);
 const leap=year%4===0 && (year%100!==0 || year%400===0),days=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
 if(year<1 || month<1 || month>12 || day<1 || day>days[month-1] || hour>23 || minute>59 || second>59)return null;
 const ms=Date.parse(value);if(!Number.isFinite(ms))return null;
 const iso=new Date(ms).toISOString();if(!/^\d{4}-/.test(iso) || iso.startsWith('0000'))return null;
 const fraction=(value.match(/\.(\d{1,6})/)?.[1]||'').padEnd(6,'0');
 return iso.replace(/\.\d{3}Z$/,fraction==='000000'?'Z':`.${fraction}Z`);
}
function epochTime(value) {
 if(number(value,0,253402300799)===null)return null;
 let seconds=Math.floor(value);const fractional=(value-seconds)*1000000,lower=Math.floor(fractional);
 let micros=fractional-lower===0.5?lower+(lower%2):Math.round(fractional);
 if(micros===1000000){seconds++;micros=0;}
 const iso=new Date(seconds*1000).toISOString();
 return iso.replace(/\.000Z$/,micros?`.${String(micros).padStart(6,'0')}Z`:'Z');
}
const orderedTime=value=>value.includes('.')?value:value.replace(/Z$/,'.000000Z');
async function readBounded(file,limit,position=0) {
 const buffer=Buffer.alloc(limit);let length=0;
 while(length<limit) {const {bytesRead}=await file.read(buffer,length,limit-length,position+length);if(!bytesRead)break;length+=bytesRead;}
 return buffer.subarray(0,length);
}
async function processRecord(pid,{proc='/proc',uid=process.getuid?.()}={}) {
 if(!Number.isSafeInteger(pid) || pid<=0)fail('invalid-process');
 try {
  const dir=path.join(proc,String(pid));
  const [raw,info,boot,exe]=await Promise.all([fs.readFile(path.join(dir,'stat'),'utf8'),fs.stat(dir),fs.readFile(path.join(proc,'sys/kernel/random/boot_id'),'utf8'),fs.readlink(path.join(dir,'exe'))]);
  const fields=raw.slice(raw.lastIndexOf(')')+2).trim().split(/\s+/);
  if(['Z','X'].includes(fields[0]) || info.uid!==uid)fail('process-unavailable-or-other-owner');
  if(!/^[a-fA-F0-9-]{36}$/.test(boot.trim()))fail('unsupported-boot-identity');
  if(!/^\d{1,30}$/.test(fields[19]||'') || !/^\d+$/.test(fields[1]||''))fail('process-unavailable');
  return {identity:{pid,start_ticks:fields[19],uid:info.uid,boot_id:boot.trim()},parent:Number(fields[1]),executable:exe.replace(/ \(deleted\)$/,'')};
 } catch(error) {if(error instanceof CollectorError)throw error;fail('process-unavailable');}
}
async function resolvedExecutable(executable) {
 if(typeof executable!=='string' || !path.isAbsolute(executable))fail('absolute-cli-executable-required');
 try{return await fs.realpath(executable);}catch(error){if(error.code==='ENOENT')return path.resolve(executable);throw error;}
}
async function executablePaths(executable,lookupPath) {
 const expected=new Set([await resolvedExecutable(executable)]);
 if(lookupPath!==undefined) {
  if(typeof lookupPath!=='string' || !path.isAbsolute(lookupPath))fail('absolute-cli-lookup-path-required');
  try{expected.add(await fs.realpath(lookupPath));}catch(error){if(error.code!=='ENOENT')throw error;}
 }
 return expected;
}
async function checkedProcess(pid,executable,options={}) {
 const expected=options.executablePaths||await executablePaths(executable,options.cliLookupPath),record=await processRecord(pid,options);
 if(!expected.has(record.executable))fail('cli-executable-mismatch');return record.identity;
}
async function findCliAncestor(startPid,executable,options={}) {
 const expected=options.executablePaths||await executablePaths(executable,options.cliLookupPath),seen=new Set(),candidates=[];
 options={...options,executablePaths:expected};
 let pid=startPid,depth=0;
 for(;depth<64;depth++) {
  if(pid<=1 || seen.has(pid))break;seen.add(pid);
  let record;
  try{record=await processRecord(pid,options);}catch(error){if(candidates.length)break;throw error;}
  if(expected.has(record.executable))candidates.push(record.identity);pid=record.parent;
 }
 if(depth===64)fail('ancestor-budget-exceeded');
 if(candidates.length!==1)fail('cli-ancestor-unavailable-or-ambiguous');
 if(!same(candidates[0],await checkedProcess(candidates[0].pid,executable,options)))fail('process-changed');return candidates[0];
}
// Node has no openat API. A retained Linux descriptor is the directory anchor;
// every real path component and final file is opened with O_NOFOLLOW.
async function openDirectory(directory,ancestry=[]) {
 let handle;
 try {
  handle=await fs.open('/',C.O_RDONLY|C.O_DIRECTORY);
  for(const component of path.resolve(directory).split('/').filter(Boolean)) {
   const next=await fs.open(`/proc/self/fd/${handle.fd}/${component}`,C.O_RDONLY|C.O_DIRECTORY|C.O_NOFOLLOW);
   await handle.close();handle=next;ancestry.push(await handle.stat());
  }
  return handle;
 } catch {await handle?.close();fail('unsafe-or-unavailable-directory');}
}
async function openTranscript(filename) {
 if(typeof filename!=='string' || !path.isAbsolute(filename))fail('absolute-transcript-required');
 let directory,file;
 try {
  const ancestry=[];directory=await openDirectory(path.dirname(filename),ancestry);
  file=await fs.open(`/proc/self/fd/${directory.fd}/${path.basename(filename)}`,C.O_RDONLY|C.O_NOFOLLOW|C.O_NONBLOCK);
  const info=await file.stat();let privateParent=false;
  for(const parent of ancestry) {if(parent.uid!==process.getuid())privateParent=false;else if(!(parent.mode&0o077))privateParent=true;}
  if(!info.isFile() || info.uid!==process.getuid() || ((info.mode&0o022) && !(privateParent && info.nlink===1)))fail('unsafe-transcript');
  const result=file;file=null;return result;
 } catch(error) {if(error instanceof CollectorError)throw error;fail('transcript-unavailable');}
 finally {await file?.close();await directory?.close();}
}
async function readMeta(source) {
 const bytes=await readBounded(source,MAX_HEAD+1),end=bytes.indexOf(10);
 if(end<0 || end+1>MAX_HEAD)fail('unsupported-transcript-header');
 try {
  const row=JSON.parse(decode(bytes.subarray(0,end)));
  if(!object(row) || row.type!=='session_meta' || !object(row.payload) || !smallString(row.payload.id))fail('unsupported-transcript-header');
  return row.payload;
 } catch {fail('unsupported-transcript-header');}
}
async function latestQuota(source) {
 const info=await source.stat(),offset=Math.max(0,info.size-MAX_TAIL),data=await readBounded(source,MAX_TAIL,offset);
 let start=offset?data.indexOf(10)+1:0,latest=null;
 if(offset && start===0)return null;
 for(let end;(end=data.indexOf(10,start))>=0;start=end+1) {
  const line=data.subarray(start,end);if(!line.includes(Buffer.from('"token_count"')))continue;
  try {const row=JSON.parse(decode(line));if(object(row) && row.type==='event_msg' && object(row.payload) && row.payload.type==='token_count')latest=row;}catch{}
 }
 return latest;
}
function baseReport(provider,session,identity,capturedAt,model=null) {
 if(!smallString(session))fail('missing-session-id');if(!timestamp(capturedAt))fail('invalid-capture-time');
 return {schema_version:1,provider,session_id:session,process:{pid:identity.pid,uid:identity.uid,start_ticks:identity.start_ticks,boot_id:identity.boot_id},model:smallString(model,128),source:{kind:{claude:'claude-statusline',antigravity:'antigravity-statusline',codex:'codex-session-event'}[provider],source_event_at:null,captured_at:capturedAt,provider_observed_at:null},windows:[],coverage:COVERAGE};
}
const windowValue=(pool,name,value,duration,key)=>({pool_id:pool,window_id:name,duration_minutes:duration,used_percent:number(value[key]),resets_at:epochTime(value.resets_at)});
function claudeReport(data,identity,capturedAt) {
 if(!object(data))fail('invalid-statusline-input');
 const report=baseReport('claude',data.session_id,identity,capturedAt,object(data.model)?data.model.id:null);
 for(const [name,duration] of [['five_hour',300],['seven_day',10080]])if(object(data.rate_limits?.[name]))report.windows.push(windowValue('claude',name,data.rate_limits[name],duration,'used_percentage'));
 return report;
}
function antigravityReport(data,identity,capturedAt) {
 if(!object(data) || data.product!=='antigravity')fail('invalid-antigravity-statusline-input');
 if(Object.hasOwn(data,'conversation_id') && Object.hasOwn(data,'session_id') && data.conversation_id!==data.session_id)fail('statusline-session-mismatch');
 const report=baseReport('antigravity',Object.hasOwn(data,'conversation_id')?data.conversation_id:data.session_id,identity,capturedAt,object(data.model)?data.model.id:null);
 if(AGY_PLANS.has(data.plan_tier))report.plan_type=AGY_PLANS.get(data.plan_tier);
 if(validEmail(data.email))report.account={email:data.email,source:'antigravity-statusline',usage_event_at:capturedAt,observed_at:capturedAt};
 if(object(data.quota))for(const [bucket,value] of Object.entries(data.quota)) {
  if(!AGY_BUCKETS.has(bucket)){report.coverage=COVERAGE+' Unrecognized quota buckets omitted.';continue;}
  if(!object(value))continue;const [pool,name,duration]=AGY_BUCKETS.get(bucket),remaining=number(value.remaining_fraction,0,1);
  report.windows.push({pool_id:pool,window_id:name,duration_minutes:duration,used_percent:remaining===null?null:Number(((1-remaining)*100).toFixed(6)),resets_at:timestamp(value.reset_time)});
 }
 return report;
}
function parseAntigravityUsage(output) {
 if(!Buffer.isBuffer(output) || output.length>MAX_REPORT)return null;
 let lines;try{lines=decode(output).split(/\r\n|\n|\r/);}catch{return null;}
 const windows=[],seen=new Set();let unknown=false;
 for(const line of lines) {
  if(!line)continue;const fields=line.split('\t'),[pool,label,percent,reset]=fields;
  if(!AGY_POOLS.has(pool) || !AGY_WINDOWS.has(label)){unknown=true;continue;}
  const key=JSON.stringify([pool,label]);if(fields.length!==4 || seen.has(key))return null;seen.add(key);
  const remaining=/^[0-9]+(?:\.[0-9]+)?%$/.test(percent)?number(Number(percent.slice(0,-1))):null,[name,duration]=AGY_WINDOWS.get(label);
  windows.push({pool_id:pool,window_id:name,duration_minutes:duration,used_percent:remaining===null?null:Number((100-remaining).toFixed(6)),resets_at:timestamp(reset)});
 }
 return windows.length?{windows,coverage:COVERAGE+(unknown?' Unrecognized native usage rows omitted.':'')}:null;
}
// Resolve only after exit/reaping, discard stderr, bound stdout and elapsed time,
// and kill only the child created here. Never signal the existing CLI or group.
function boundedNative(command,args,{timeoutMs=3000,maxBytes=MAX_REPORT,spawnProcess=spawn}={}) {
 return new Promise(resolve=>{
  let child,failed=false,settled=false,total=0;const chunks=[];
  const done=output=>{if(settled)return;settled=true;clearTimeout(timer);resolve(output);};
  const stop=()=>{failed=true;try{child?.stdout?.destroy();child?.kill('SIGKILL');}catch{};};
  const timer=setTimeout(stop,timeoutMs);
  try {
   const env={...process.env,ACCOUNT_USAGE_NATIVE_QUERY:'1'};delete env.ELECTRON_RUN_AS_NODE;
   child=spawnProcess(command,args,{stdio:['ignore','pipe','ignore'],shell:false,windowsHide:true,env});
   child.on('error',()=>{failed=true;done(null);});
   child.stdout.on('error',stop);
   child.stdout.on('data',chunk=>{if(failed)return;total+=chunk.length;if(total>maxBytes){stop();return;}chunks.push(chunk);});
   child.on('close',code=>done(!failed && code===0?Buffer.concat(chunks,total):null));
  } catch {stop();done(null);}
 });
}
async function antigravityNativeUsage(identity,executable,options={}) {
 try {
  if(!same(identity,await checkedProcess(identity.pid,executable,options)))return null;
  const output=await boundedNative(path.join(options.proc||'/proc',String(identity.pid),'exe'),['--print','/usage'],{...options,timeoutMs:Math.min(options.timeoutMs||6000,6000)});
  if(!same(identity,await checkedProcess(identity.pid,executable,options)))return null;
  return parseAntigravityUsage(output);
 } catch{return null;}
}
async function claudeAuthMetadata(identity,executable,capturedAt,options={}) {
 try {
  if(!same(identity,await checkedProcess(identity.pid,executable,options)))return {};
  const output=await boundedNative(path.join(options.proc||'/proc',String(identity.pid),'exe'),['auth','status'],{...options,timeoutMs:Math.min(options.timeoutMs||3000,3000)});
  if(!output || !same(identity,await checkedProcess(identity.pid,executable,options)))return {};
  const data=JSON.parse(decode(output));if(!object(data) || data.loggedIn!==true || data.authMethod!=='claude.ai')return {};
  const metadata={};if(CLAUDE_PLANS.has(data.subscriptionType))metadata.plan_type=data.subscriptionType;
  if(validEmail(data.email))metadata.account={email:data.email,source:'claude-auth-status',usage_event_at:capturedAt,observed_at:(options.now||utcNow)()};return metadata;
 } catch{return {};}
}
const safeAbsolutePath=value=>typeof value==='string' && value.length>0 && value.length<=4096 &&
 !/[\x00-\x1f\x7f]/.test(value) && path.isAbsolute(value) && path.normalize(value)===value;
function codexProfileEnvironment(source=process.env) {
 if(!object(source) || !safeAbsolutePath(source.HOME) || (source.CODEX_HOME!==undefined && !safeAbsolutePath(source.CODEX_HOME)))fail('unsafe-codex-profile');
 const env={HOME:source.HOME};if(source.CODEX_HOME)env.CODEX_HOME=source.CODEX_HOME;
 Object.assign(env,{PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8',LC_ALL:'C.UTF-8'});return env;
}
// Codex app-server speaks newline-delimited JSON. This observation is deliberately
// narrower than a general client: initialize once, issue two read-only account
// requests, retain only their structured results, and stop our child.
function codexAppServerObservation(identity,profile,options={}) {
 return new Promise(resolve=>{
  let child,settled=false,invalid=false,initialized=false,stdoutBytes=0,stderrBytes=0,pending=Buffer.alloc(0),forceTimer;
  const replies={account:null,rateLimits:null},received=new Set();
  const finish=()=>{if(settled)return;settled=true;clearTimeout(timer);clearTimeout(forceTimer);resolve(invalid?{account:null,rateLimits:null}:replies);};
  const stop=bad=>{invalid=invalid||bad;try{child?.stdin?.destroy();child?.kill('SIGKILL');}catch{};if(!child)finish();};
  const send=message=>{try{child.stdin.write(JSON.stringify(message)+'\n');}catch{stop(true);}};
  const complete=()=>{
   if(received.size!==2)return;
   try{child.stdin.end();}catch{}
   forceTimer=setTimeout(()=>{try{child?.kill('SIGKILL');}catch{};},100);
  };
  const message=line=>{
   let value;try{value=JSON.parse(decode(line));}catch{stop(true);return;}
   if(!object(value)){stop(true);return;}
   if(!initialized && value.id===1) {
    if(value.error || !object(value.result)){stop(true);return;}
    initialized=true;send({method:'initialized'});send({id:2,method:'account/read',params:{refreshToken:false}});send({id:3,method:'account/rateLimits/read',params:{}});return;
   }
   if(!initialized || ![2,3].includes(value.id) || received.has(value.id))return;
   received.add(value.id);
   if(!value.error && object(value.result))replies[value.id===2?'account':'rateLimits']=value.result;
   complete();
  };
  const timer=setTimeout(()=>stop(false),Math.min(Number.isFinite(options.timeoutMs)?Math.max(1,options.timeoutMs):6000,6000));
  try {
   child=(options.spawnProcess||spawn)(path.join(options.proc||'/proc',String(identity.pid),'exe'),['app-server'],{
    env:profile,cwd:profile.HOME,stdio:['pipe','pipe','pipe'],shell:false,windowsHide:true
   });
   child.on('error',()=>stop(true));child.on('close',finish);child.stdin.on('error',()=>stop(true));child.stdout.on('error',()=>stop(true));child.stderr.on('error',()=>stop(true));
   child.stderr.on('data',chunk=>{stderrBytes+=Buffer.byteLength(chunk);if(stderrBytes>MAX_NATIVE_STDERR)stop(true);});
   child.stdout.on('data',chunk=>{
    if(settled)return;stdoutBytes+=Buffer.byteLength(chunk);if(stdoutBytes>MAX_REPORT){stop(true);return;}
    pending=Buffer.concat([pending,Buffer.from(chunk)]);let end;
    while(!settled && (end=pending.indexOf(10))>=0){const line=pending.subarray(0,end);pending=pending.subarray(end+1);if(line.length)message(line);}
   });
   send({id:1,method:'initialize',params:{clientInfo:{name:'account_usage',title:'Account Usage',version:'1'}}});
  } catch {stop(true);}
 });
}
function codexWindow(pool,name,value) {
 let duration=number(value.windowDurationMins,1,525600);if(!Number.isSafeInteger(duration))duration=null;
 return {pool_id:pool,window_id:name,duration_minutes:duration,used_percent:number(value.usedPercent),resets_at:epochTime(value.resetsAt)};
}
async function codexNativeReport(data,identity,executable,capturedAt,options={}) {
 if(!object(data) || data.hook_event_name!=='Stop')fail('unsupported-hook-event');
 const report=baseReport('codex',data.session_id,identity,capturedAt,data.model),profile=codexProfileEnvironment(options.env||process.env);
 report.source.source_event_at=capturedAt;
 if(!same(identity,await checkedProcess(identity.pid,executable,options)))fail('process-changed');
 const observation=await codexAppServerObservation(identity,profile,options);
 if(!same(identity,await checkedProcess(identity.pid,executable,options)))fail('process-changed');
 report.source.provider_observed_at=timestamp((options.now||utcNow)())||capturedAt;
 const account=observation.account?.account,accountPlan=object(account)&&CODEX_PLANS.has(account.planType)?account.planType:null;
 const accountIdentityAvailable=object(account) && account.type==='chatgpt' && validEmail(account.email);
 const plans=new Set(),buckets=[];
 if(object(observation.rateLimits?.rateLimitsByLimitId) && Object.keys(observation.rateLimits.rateLimitsByLimitId).length) {
  const entries=Object.entries(observation.rateLimits.rateLimitsByLimitId);
  if(entries.length<=32)for(const [key,value] of entries)if(object(value) && smallString(key,128) && value.limitId===key)buckets.push(value);
 } else if(object(observation.rateLimits?.rateLimits))buckets.push(observation.rateLimits.rateLimits);
 for(const bucket of buckets) {
  const pool=smallString(bucket.limitId,128);if(!pool)continue;
  if(CODEX_PLANS.has(bucket.planType))plans.add(bucket.planType);
  for(const name of ['primary','secondary'])if(object(bucket[name]))report.windows.push(codexWindow(pool,name,bucket[name]));
 }
 if(accountPlan)report.plan_type=accountPlan;else if(plans.size===1)report.plan_type=plans.values().next().value;
 const accountAvailable=accountIdentityAvailable && report.plan_type!==undefined;
 if(accountAvailable)report.account={email:account.email,source:'codex-account-read',usage_event_at:capturedAt,observed_at:report.source.provider_observed_at};
 if(!accountAvailable)report.coverage+=' Native account metadata unavailable.';
 if(!report.windows.length)report.coverage+=' Native rate-limit metadata unavailable.';
 return report;
}
async function codexFromStream(source,session,identity,capturedAt,model=null) {
 const meta=await readMeta(source);if(meta.id!==session || meta.source!=='cli')fail('transcript-session-or-root-mismatch');
 const report=baseReport('codex',session,identity,capturedAt,model),event=await latestQuota(source);
 if(!event){report.coverage='No quota event in the bounded transcript tail. Other account limits may be unavailable.';return report;}
 report.source.source_event_at=timestamp(event.timestamp);
 if(!report.source.source_event_at){report.coverage='Quota event lacks a usable source timestamp. Other account limits may be unavailable.';return report;}
 const limits=event.payload.rate_limits;
 if(object(limits)) {
  if(meta.model_provider==='openai' && CODEX_PLANS.has(limits.plan_type))report.plan_type=limits.plan_type;
  const pool=smallString(limits.limit_id,128);if(!pool){report.coverage='Quota event lacks a named pool. Other account limits may be unavailable.';return report;}
  for(const name of ['primary','secondary'])if(object(limits[name])) {
   let duration=number(limits[name].window_minutes,1,525600);if(!Number.isSafeInteger(duration))duration=null;
   report.windows.push(windowValue(pool,name,limits[name],duration,'used_percent'));
  }
 }
 return report;
}
async function codexReport(filename,session,identity,capturedAt,model=null) {
 const file=await openTranscript(filename);try{return await codexFromStream(file,session,identity,capturedAt,model);}finally{await file.close();}
}
async function codexFdReport(pid,executable,capturedAt=utcNow(),options={}) {
 if((options.platform||process.platform)!=='linux')fail('unsupported-platform');
 const identity=await checkedProcess(pid,executable,options),candidates=new Map();let count=0,transcripts=0;
 try {
  const directory=await fs.opendir(path.join(options.proc||'/proc',String(pid),'fd'));
  for await(const entry of directory) {
   if(++count>MAX_FDS)fail('process-fd-budget-exceeded');
   const fd=path.join(options.proc||'/proc',String(pid),'fd',entry.name),target=await fs.readlink(fd);if(!target.endsWith('.jsonl'))continue;
   if(++transcripts>MAX_TRANSCRIPTS)fail('transcript-budget-exceeded');
   const source=await openTranscript(target);
   try {
    const info=await source.stat(),held=await fs.stat(fd);
    if(info.dev!==held.dev || info.ino!==held.ino)fail('transcript-fd-changed');
    const meta=await readMeta(source);if(meta.source!=='cli')continue;
    const report=await codexFromStream(source,meta.id,identity,capturedAt),after=await fs.stat(fd);
    if(info.dev!==after.dev || info.ino!==after.ino)fail('transcript-fd-changed');candidates.set(`${info.dev}:${info.ino}`,report);
   } finally {await source.close();}
  }
 } catch(error) {if(error instanceof CollectorError)throw error;fail('process-fd-changed-or-unavailable');}
 if(!same(identity,await checkedProcess(pid,executable,options)))fail('process-changed');
 if(candidates.size!==1)fail('root-transcript-unavailable-or-ambiguous');return candidates.values().next().value;
}
function reportBytes(report) {
 const data=Buffer.from(JSON.stringify(report)+'\n');if(data.length>MAX_REPORT)fail('report-too-large');return data;
}
async function reclaimDeadLock(anchor,lock) {
 let directory,file;
 try {
  directory=await fs.open(`${anchor}/${lock}`,C.O_RDONLY|C.O_DIRECTORY|C.O_NOFOLLOW);
  const info=await directory.stat();if(info.uid!==process.getuid() || (info.mode&0o5777)!==0o700)fail('unsafe-report-lock');
  const pinned=`/proc/self/fd/${directory.fd}`,entries=[];const iterator=await fs.opendir(pinned);
  for await(const entry of iterator) {entries.push(entry.name);if(entries.length>1)fail('unsafe-report-lock');}
  // An empty lock is already being released; acquisition can retry atomically.
  if(!entries.length)return;
  const name=entries[0];if(!/^owner-[a-f0-9]{32}\.json$/.test(name))fail('unsafe-report-lock');
  file=await fs.open(`${pinned}/${name}`,C.O_RDONLY|C.O_NOFOLLOW|C.O_NONBLOCK);
  const st=await file.stat();if(!st.isFile() || st.uid!==process.getuid() || st.size>512 || (st.mode&0o7777)!==0o600)fail('unsafe-report-lock');
  let owner;try{owner=JSON.parse(decode(await readBounded(file,513)));}catch{fail('unsafe-report-lock');}
  if(!object(owner) || !Number.isSafeInteger(owner.pid) || owner.pid<=0 || owner.uid!==process.getuid() || !/^\d{1,30}$/.test(owner.start_ticks) || !/^[a-fA-F0-9-]{36}$/.test(owner.boot_id))fail('unsafe-report-lock');
  let dead=false;
  try{dead=!same(owner,(await processRecord(owner.pid)).identity);}catch {
   try{await fs.stat(`/proc/${owner.pid}`);}catch(error){if(error.code==='ENOENT')dead=true;}
  }
  if(dead) {
   // This unique marker cannot name a newer owner's lock. A concurrent reaper
   // that loses the unlink must not remove any directory.
   await fs.unlink(`${pinned}/${name}`);
   try{await fs.rmdir(`${anchor}/${lock}`);}catch(error){if(!['ENOTEMPTY','ENOENT'].includes(error.code))throw error;}
  }
 } catch(error) {if(error.code==='ENOENT')return;if(error instanceof CollectorError)throw error;fail('unsafe-report-lock');}
 finally{await file?.close();await directory?.close();}
}
async function acquireLock(anchor,{lock='.collector-lock',attempts=50,pauseMs=20,busyCode='report-directory-busy'}={}) {
 const unique=randomBytes(16).toString('hex'),prepared=`.lock-${unique}`,marker=`owner-${unique}.json`;
 const owner=(await processRecord(process.pid)).identity;
 await fs.mkdir(`${anchor}/${prepared}`,{mode:0o700});
 let acquired=false;
 try {
  await fs.writeFile(`${anchor}/${prepared}/${marker}`,JSON.stringify(owner),{flag:'wx',mode:0o600});
  for(let attempt=0;attempt<attempts;attempt++) {
   try{await fs.rename(`${anchor}/${prepared}`,`${anchor}/${lock}`);acquired=true;break;}
   catch(error){if(!['EEXIST','ENOTEMPTY'].includes(error.code))fail('unsafe-report-lock');}
   await reclaimDeadLock(anchor,lock);if(pauseMs)await new Promise(resolve=>setTimeout(resolve,pauseMs));
  }
  if(!acquired)fail(busyCode);
  return async()=>{try{await fs.unlink(`${anchor}/${lock}/${marker}`);await fs.rmdir(`${anchor}/${lock}`);}catch(error){if(!['ENOENT','ENOTEMPTY'].includes(error.code))throw error;}};
 } finally {if(!acquired){await fs.unlink(`${anchor}/${prepared}/${marker}`).catch(()=>{});await fs.rmdir(`${anchor}/${prepared}`).catch(()=>{});}}
}
const reportFilename=report=>`${report.provider}-${createHash('sha256').update(report.session_id).digest('hex').slice(0,24)}.json`;
const closedKeys=(value,allowed)=>object(value) && Object.keys(value).every(key=>allowed.includes(key));
const nullableTime=value=>value===null || timestamp(value)!==null;
// Cleanup is more conservative than reading: only our complete, closed report
// schema with a filename bound to its session may ever become a deletion target.
function validStoredReport(report) {
 if(!closedKeys(report,['schema_version','provider','session_id','process','model','source','windows','coverage','plan_type','account']) || report.schema_version!==1 || !smallString(report.session_id))return false;
 const plans={codex:CODEX_PLANS,claude:CLAUDE_PLANS,antigravity:new Set(['free','pro','ultra'])};
 if(!Object.hasOwn(plans,report.provider))return false;
 const identity=report.process,source=report.source;
 if(!closedKeys(identity,['pid','uid','start_ticks','boot_id']) || !Number.isSafeInteger(identity.pid) || identity.pid<=0 || identity.uid!==process.getuid() || typeof identity.start_ticks!=='string' || !/^\d{1,30}$/.test(identity.start_ticks) || typeof identity.boot_id!=='string' || !/^[a-fA-F0-9-]{36}$/.test(identity.boot_id))return false;
 if(report.model!==null && !smallString(report.model,128))return false;
 if(!closedKeys(source,['kind','source_event_at','captured_at','provider_observed_at']) || !timestamp(source.captured_at) || !nullableTime(source.source_event_at) || !nullableTime(source.provider_observed_at))return false;
 const kinds={codex:['codex-session-event'],claude:['claude-statusline'],antigravity:['antigravity-statusline','antigravity-native-usage']};
 if(!kinds[report.provider].includes(source.kind) || !smallString(report.coverage,512))return false;
 if(report.plan_type!==undefined && report.plan_type!==null && (!plans[report.provider].has(report.plan_type) || (report.provider==='codex' && !source.source_event_at)))return false;
 if(report.account!==undefined) {
  const account=report.account,kind={codex:'codex-account-read',claude:'claude-auth-status',antigravity:'antigravity-statusline'}[report.provider];
  if(!closedKeys(account,['email','source','usage_event_at','observed_at']) || !validEmail(account.email) || account.source!==kind || !timestamp(account.observed_at) || account.usage_event_at!==(report.provider==='codex'?source.source_event_at:source.captured_at) || (report.provider==='codex' && !plans.codex.has(report.plan_type)))return false;
 }
 if(!Array.isArray(report.windows) || report.windows.length>32)return false;
 const seen=new Set();
 return report.windows.every(window=>{
  if(!closedKeys(window,['pool_id','window_id','duration_minutes','used_percent','resets_at']) || !smallString(window.pool_id,128) || !smallString(window.window_id,128) || !nullableTime(window.resets_at))return false;
  if(window.used_percent!==null && number(window.used_percent)===null)return false;
  if(window.duration_minutes!==null && (!Number.isSafeInteger(window.duration_minutes) || number(window.duration_minutes,1,525600)===null))return false;
  const key=JSON.stringify([window.pool_id,window.window_id]);if(seen.has(key))return false;seen.add(key);return true;
 });
}
async function processDefinitelyGone(identity,{proc='/proc'}={}) {
 const directory=path.join(proc,String(identity.pid));let info;
 try{info=await fs.stat(directory);}catch(error){return error.code==='ENOENT';}
 if(info.uid!==identity.uid)return true;
 try {
  const [raw,boot]=await Promise.all([fs.readFile(path.join(directory,'stat'),'utf8'),fs.readFile(path.join(proc,'sys/kernel/random/boot_id'),'utf8')]);
  const fields=raw.slice(raw.lastIndexOf(')')+2).trim().split(/\s+/);
  if(!/^[a-fA-F0-9-]{36}$/.test(boot.trim()) || !/^\d{1,30}$/.test(fields[19]||''))return false;
  return ['Z','X'].includes(fields[0]) || boot.trim()!==identity.boot_id || fields[19]!==identity.start_ticks;
 } catch {
  // A denied or malformed read proves nothing. Only disappearance of the
  // actual process directory can turn that failed read into a death proof.
  try{await fs.stat(directory);return false;}catch(error){return error.code==='ENOENT';}
 }
}
async function planReportPruning(anchor,report,filename,options) {
 const entries=[],iterator=await fs.opendir(anchor);
 for await(const entry of iterator){entries.push(entry.name);if(entries.length>MAX_PRUNE_ENTRIES)fail('report-directory-scan-limit');}
 const removals=[];let newer=null;
 for(const name of entries) {
  if(name===filename || !/^(claude|codex|antigravity)-[a-f0-9]{24}\.json$/.test(name))continue;
  let file;
  try {
   file=await fs.open(`${anchor}/${name}`,C.O_RDONLY|C.O_NOFOLLOW|C.O_NONBLOCK);
   const info=await file.stat();if(!info.isFile() || info.uid!==process.getuid() || info.nlink!==1 || ((info.mode&0o7777)&~0o640) || info.size>MAX_REPORT)continue;
   const bytes=await readBounded(file,MAX_REPORT+1);if(bytes.length>MAX_REPORT)continue;
   let old;try{old=JSON.parse(decode(bytes));}catch{continue;}
   if(!validStoredReport(old) || name!==reportFilename(old))continue;
   if(old.provider===report.provider && same(old.process,report.process)) {
    const oldTime=orderedTime(timestamp(old.source.captured_at)),newTime=orderedTime(timestamp(report.source.captured_at));
    if(oldTime===newTime)fail('session-order-ambiguous');
    if(oldTime>newTime){if(!newer || oldTime>newer.time)newer={name,time:oldTime};continue;}
    removals.push({name,info});
   } else if(await processDefinitelyGone(old.process,options))removals.push({name,info});
  } catch(error){if(error instanceof CollectorError)throw error;}
  finally{await file?.close();}
 }
 if(newer)return {newer:newer.name,removals:[]};
 // Leave headroom below the reader's 128-entry cap for the publisher lock,
 // atomic staging, and overlapping producers. Unknown files count but survive.
 if(entries.length-removals.length+(entries.includes(filename)?0:1)>MAX_PUBLISHED_ENTRIES)fail('report-directory-capacity-exceeded');
 return {newer:null,removals};
}
async function applyReportPruning(anchor,removals) {
 for(const {name,info} of removals) {
  let current;try{current=await fs.lstat(`${anchor}/${name}`);}catch(error){if(error.code==='ENOENT')continue;throw error;}
  if(!current.isFile() || current.uid!==info.uid || current.dev!==info.dev || current.ino!==info.ino || current.nlink!==1 || ((current.mode&0o7777)&~0o640))fail('report-changed-before-pruning');
  await fs.unlink(`${anchor}/${name}`);
 }
}
async function publishReport(directory,report,options={}) {
 if(report.process?.uid!==process.getuid())fail('report-owner-mismatch');
 if(!['codex','claude','antigravity'].includes(report.provider) || !smallString(report.session_id))fail('invalid-report-identity');
 const data=reportBytes(report),filename=reportFilename(report);
 const parent=await openDirectory(directory);let release,temporary,output,oldFile;
 try {
  const info=await parent.stat();if(info.uid!==process.getuid() || ((info.mode&0o7777)&~0o2750))fail('unsafe-report-directory');
  const anchor=`/proc/self/fd/${parent.fd}`;release=await acquireLock(anchor);
  try{oldFile=await fs.open(`${anchor}/${filename}`,C.O_RDONLY|C.O_NOFOLLOW|C.O_NONBLOCK);}catch(error){if(error.code!=='ENOENT')fail('unsafe-existing-report');}
  if(oldFile) {
   const oldInfo=await oldFile.stat();if(!oldInfo.isFile() || oldInfo.uid!==process.getuid() || ((oldInfo.mode&0o7777)&~0o640))fail('unsafe-existing-report');
   try {
    const old=JSON.parse(decode(await readBounded(oldFile,MAX_REPORT+1)));
    const field=report.source.source_event_at && old.source?.source_event_at?'source_event_at':'captured_at';
    let oldTime=timestamp(old.source?.[field]),newTime=timestamp(report.source[field]);
    if(oldTime===newTime){oldTime=timestamp(old.source?.captured_at);newTime=timestamp(report.source.captured_at);}
    if(same(old.process,report.process) && oldTime && newTime && orderedTime(oldTime)>orderedTime(newTime))return path.join(directory,filename);
   } catch{}
  }
  const pruning=await planReportPruning(anchor,report,filename,options);
  if(pruning.newer)return path.join(directory,pruning.newer);
  temporary=`${anchor}/.pending-${randomBytes(12).toString('hex')}`;
  output=await fs.open(temporary,C.O_WRONLY|C.O_CREAT|C.O_EXCL|C.O_NOFOLLOW,0o600);
  await output.writeFile(data);await output.chmod(0o640);await output.sync();await output.close();output=null;
  // Stage and sync first. Remove superseded reports before exposing the new
  // session, so a reader cannot match two sessions to this one publisher.
  await applyReportPruning(anchor,pruning.removals);
  await fs.rename(temporary,`${anchor}/${filename}`);temporary=null;await parent.sync();return path.join(directory,filename);
 } finally {await oldFile?.close();await output?.close();if(temporary)await fs.unlink(temporary).catch(()=>{});try{await release?.();}finally{await parent.close();}}
}
async function guardedNativeQuery(directory,provider,identity,query) {
 let parent,locks,release;
 try {
  parent=await openDirectory(directory);const parentInfo=await parent.stat();
  if(parentInfo.uid!==process.getuid() || ((parentInfo.mode&0o7777)&~0o2750))fail('unsafe-report-directory');
  const location=`/proc/self/fd/${parent.fd}/.native-queries`;
  try{await fs.mkdir(location,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
  locks=await fs.open(location,C.O_RDONLY|C.O_DIRECTORY|C.O_NOFOLLOW);
  const info=await locks.stat();if(info.uid!==process.getuid() || (info.mode&0o5777)!==0o700)fail('unsafe-native-query-directory');
  const key=createHash('sha256').update(JSON.stringify([provider,identity.pid,identity.uid,identity.start_ticks,identity.boot_id])).digest('hex').slice(0,32);
  release=await acquireLock(`/proc/self/fd/${locks.fd}`,{lock:`query-${key}`,attempts:2,pauseMs:0,busyCode:'native-query-busy'});
  return {busy:false,value:await query()};
 } catch(error) {return {busy:error instanceof CollectorError && error.message==='native-query-busy',value:null};}
 finally{try{await release?.();}finally{await locks?.close();await parent?.close();}}
}
async function runCollection(args,raw,capturedAt=utcNow(),options={}) {
 if((options.platform||process.platform)!=='linux')fail('unsupported-platform');
 // A native usage query may itself run a statusline. Its observation-only hook
 // is suppressed so there can be no recursive query or replacement snapshot.
 if(!['codex-read','codex-fd'].includes(args.mode) && process.env.ACCOUNT_USAGE_NATIVE_QUERY==='1')return null;
 let report;
 if(['codex-fd','codex-read'].includes(args.mode))report=await codexFdReport(args.pid,args.cliExecutable,capturedAt,options);
 else {
  if(raw.length>MAX_INPUT)fail('input-too-large');let data;try{data=JSON.parse(decode(raw));}catch{fail('invalid-json-input');}
  if(args.mode==='antigravity-statusline' && args.agyFullUsage && (!object(data) || data.agent_state!=='idle'))return null;
  // Freeze both trusted native targets once. A self-updater may move the stable
  // lookup between invocations; it cannot change this invocation's binding.
  options={...options,executablePaths:await executablePaths(args.cliExecutable,args.cliLookupPath)};
  const identity=await findCliAncestor(options.startPid||process.pid,args.cliExecutable,options);
  if(args.mode==='claude-statusline') {
   report=claudeReport(data,identity,capturedAt);
   if(args.claudeAuthStatus) {
    const query=await guardedNativeQuery(args.reportDir,'claude',identity,()=>claudeAuthMetadata(identity,args.cliExecutable,capturedAt,options));
    if(query.value)Object.assign(report,query.value);
    if(query.busy)report.coverage+=' Native account metadata query already in progress. Account and subscription metadata are unavailable.';
    else if(!query.value)report.coverage+=' Native account metadata unavailable.';
   }
  } else if(args.mode==='antigravity-statusline') {
   report=antigravityReport(data,identity,capturedAt);
   if(args.agyFullUsage) {
    const query=await guardedNativeQuery(args.reportDir,'antigravity',identity,()=>antigravityNativeUsage(identity,args.cliExecutable,options));
    if(query.value){Object.assign(report,query.value);report.source.kind='antigravity-native-usage';}
    else report.coverage+=query.busy?' Full native usage query already in progress. GPT/Claude pool may be missing.':' Full native usage read failed. GPT/Claude pool may be missing.';
   }
  } else if(args.mode==='codex-hook')report=await codexNativeReport(data,identity,args.cliExecutable,capturedAt,options);
  else fail('invalid-mode');
  if(!same(identity,await checkedProcess(identity.pid,args.cliExecutable,options)))fail('process-changed');
 }
 if(args.mode==='codex-read'){reportBytes(report);return report;}
 await publishReport(args.reportDir,report,options);return report;
}
function parseArgs(argv) {
 const args={mode:argv[0]},valueFlags={'--report-dir':'reportDir','--cli-executable':'cliExecutable','--cli-lookup-path':'cliLookupPath','--pid':'pid','--original-argv-json':'originalArgvJson'},booleanFlags={'--claude-auth-status':'claudeAuthStatus','--claude-account':'claudeAuthStatus','--agy-full-usage':'agyFullUsage'};
 if(!['claude-statusline','antigravity-statusline','codex-hook','codex-fd','codex-read'].includes(args.mode))fail('invalid-mode');
 for(let i=1;i<argv.length;i++) {
  const flag=argv[i];if(Object.hasOwn(booleanFlags,flag))args[booleanFlags[flag]]=true;
  else if(Object.hasOwn(valueFlags,flag) && i+1<argv.length && !Object.hasOwn(args,valueFlags[flag]))args[valueFlags[flag]]=argv[++i];
  else fail('invalid-arguments');
 }
 if(args.claudeAuthStatus && args.mode!=='claude-statusline')fail('claude-auth-status-requires-statusline');
 if(args.agyFullUsage && args.mode!=='antigravity-statusline')fail('agy-full-usage-requires-antigravity-statusline');
 if(typeof args.cliExecutable!=='string' || !path.isAbsolute(args.cliExecutable))fail('absolute-cli-executable-required');
 if(args.cliLookupPath!==undefined && (typeof args.cliLookupPath!=='string' || !path.isAbsolute(args.cliLookupPath)))fail('absolute-cli-lookup-path-required');
 if(args.mode!=='codex-read' && (typeof args.reportDir!=='string' || !path.isAbsolute(args.reportDir)))fail('report-directory-required');
 if(['codex-fd','codex-read'].includes(args.mode)){if(!/^[1-9]\d*$/.test(args.pid||''))fail('invalid-process');args.pid=Number(args.pid);if(!Number.isSafeInteger(args.pid))fail('invalid-process');}
 if(args.originalArgvJson!==undefined) {
  try{args.original=JSON.parse(args.originalArgvJson);}catch{fail('invalid-original-argv');}
  if(!['claude-statusline','antigravity-statusline'].includes(args.mode) || !Array.isArray(args.original) || !args.original.length || !args.original.every(arg=>typeof arg==='string' && !arg.includes('\0')) || !path.isAbsolute(args.original[0]))fail('invalid-original-argv');
 }
 return args;
}
async function runOriginal(argv,saved) {
 return new Promise(resolve=>{
  let child,source;
  try {
   const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
   child=spawn(argv[0],argv.slice(1),{stdio:['pipe','inherit','inherit'],shell:false,env});
   source=Readable.from((async function*(){
    let position=0;
    for(;;){const bytes=await readBounded(saved,65536,position);if(!bytes.length)break;position+=bytes.length;yield bytes;}
   })());
   source.on('error',()=>child.stdin.destroy());child.stdin.on('error',()=>source.destroy());
   child.on('error',()=>{source.destroy();process.stderr.write('usage-collector: original-command-unavailable\n');resolve(1);});
   child.on('close',(code,signal)=>{source.destroy();resolve(code??(128+(os.constants.signals[signal]||1)));});source.pipe(child.stdin);
  } catch {source?.destroy();process.stderr.write('usage-collector: original-command-unavailable\n');resolve(1);}
 });
}
async function main(argv=process.argv.slice(2)) {
 let args;try{args=parseArgs(argv);}catch(error){process.stderr.write(`usage-collector: ${error instanceof CollectorError?error.message:'invalid-arguments'}\n`);return 1;}
 const capturedAt=utcNow();let saved,tempDir,code=0;
 try {
  if(args.original) {
   tempDir=await fs.mkdtemp(path.join(os.tmpdir(),'account-usage-'));await fs.chmod(tempDir,0o700);
   const filename=path.join(tempDir,'stdin');saved=await fs.open(filename,'wx+',0o600);await fs.unlink(filename);await fs.rmdir(tempDir);tempDir=null;
  }
  const chunks=[];let length=0,position=0;
  if(!['codex-fd','codex-read'].includes(args.mode))for await(const chunk of process.stdin) {
   if(saved){let written=0;while(written<chunk.length){const result=await saved.write(chunk,written,chunk.length-written,position+written);written+=result.bytesWritten;}position+=chunk.length;}
   if(length<=MAX_INPUT){const keep=chunk.subarray(0,MAX_INPUT+1-length);chunks.push(keep);length+=keep.length;}
  }
  // Forward the original display before starting any bounded metadata query.
  // Both jobs finish before exit, but native reads cannot delay its stdout.
  const originalRun=args.original?runOriginal(args.original,saved):null;
  try {
   const report=await runCollection(args,Buffer.concat(chunks,length),capturedAt);
   if(args.mode==='codex-read')process.stdout.write(reportBytes(report));
  } catch(error){process.stderr.write(`usage-collector: ${error instanceof CollectorError?error.message:'collection-unavailable'}\n`);code=1;}
  if(originalRun)return await originalRun;
  return ['codex-fd','codex-read'].includes(args.mode)?code:0;
 } catch {process.stderr.write('usage-collector: collection-unavailable\n');return ['codex-fd','codex-read'].includes(args.mode)?1:0;}
 finally{await saved?.close();if(tempDir)await fs.rmdir(tempDir).catch(()=>{});}
}
module.exports={CollectorError,processRecord,checkedProcess,findCliAncestor,openDirectory,openTranscript,readMeta,latestQuota,baseReport,claudeReport,antigravityReport,parseAntigravityUsage,boundedNative,antigravityNativeUsage,claudeAuthMetadata,codexProfileEnvironment,codexAppServerObservation,codexNativeReport,codexFromStream,codexReport,codexFdReport,publishReport,runCollection,parseArgs,timestamp,number,validEmail,main};
if(require.main===module)main().then(code=>{process.exitCode=code;}).catch(()=>{process.stderr.write('usage-collector: collection-unavailable\n');process.exitCode=1;});
