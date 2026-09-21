'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {spawn,execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {createHash}=require('node:crypto');
const execute=promisify(execFile);
const p=require('../collectors/passive.cjs');
const stamp='2026-09-19T12:00:00Z';
const boot='12345678-1234-1234-1234-123456789abc';
const identity={pid:10,start_ticks:'900',uid:process.getuid(),boot_id:boot};
const quota=(limits,time=stamp)=>({timestamp:time,type:'event_msg',payload:{type:'token_count',rate_limits:limits}});
const limits={limit_id:'codex',plan_type:'pro',primary:{used_percent:41,window_minutes:300,resets_at:1790421918}};
const agy=()=>({product:'antigravity',conversation_id:'agy-a',session_id:'agy-a',agent_state:'idle',model:{id:'Gemini 3.5 Flash'},plan_tier:'Google AI Pro',email:'member@example.test',quota:{'gemini-weekly':{remaining_fraction:.9378,reset_time:'2026-09-26T07:50:32Z'}}});
const tsv=()=>['Gemini Models\tWeekly Limit Remaining\t80%\t2026-09-26T07:50:32Z','Gemini Models\tFive Hour Limit Remaining\t60%\t2026-09-19T17:01:00Z','Claude and GPT models\tWeekly Limit Remaining\t25%\t2026-09-25T12:00:00Z','Claude and GPT models\tFive Hour Limit Remaining\t100%\t2026-09-19T17:01:00Z'].join('\n')+'\n';
async function fixture(t) {
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'usage-collector-'));
 t.after(()=>fs.rm(base,{recursive:true,force:true}));
 const proc=path.join(base,'proc'),exe=path.join(base,'codex'),reports=path.join(base,'reports');
 await fs.mkdir(path.join(proc,'sys/kernel/random'),{recursive:true});await fs.writeFile(path.join(proc,'sys/kernel/random/boot_id'),boot+'\n');
 await fs.writeFile(exe,'',{mode:0o700});await fs.mkdir(reports,{mode:0o700});
 async function processFile(pid,parent,executable,start=String(890+pid),comm='native') {
  const dir=path.join(proc,String(pid));await fs.mkdir(path.join(dir,'fd'),{recursive:true});
  await fs.writeFile(path.join(dir,'stat'),`${pid} (${comm}) S ${parent} ${Array(17).fill('0').join(' ')} ${start} 0\n`);
  await fs.symlink(executable,path.join(dir,'exe'));
 }
 await processFile(10,1,exe);await processFile(20,10,path.join(base,'bash'));await processFile(30,20,process.execPath);
 async function transcript(rows=[],meta={id:'session-a',source:'cli',model_provider:'openai'},name='rollout.jsonl') {
  const file=path.join(base,name);await fs.writeFile(file,[{type:'session_meta',payload:meta},...rows].map(JSON.stringify).join('\n')+'\n',{mode:0o600});return file;
 }
 async function held(file,name='1') {await fs.symlink(file,path.join(proc,'10/fd',name));}
 return {base,proc,exe,reports,processFile,transcript,held,options:{proc,startPid:30}};
}
test('runtime CLI trust requires exact reviewed metadata and rejects world-writable paths',async t=>{
 const f=await fixture(t);await fs.chmod(f.base,0o770);await fs.chmod(f.exe,0o770);
 const reviewed=[];
 for(const [file,kind] of [[f.base,'directory'],[f.exe,'executable']]) {
  const info=await fs.stat(file);reviewed.push({path:file,kind,uid:info.uid,gid:info.gid,mode:info.mode&0o7777});
 }
 assert.deepEqual([...await p.trustedExecutablePaths(f.exe,undefined,JSON.stringify(reviewed))],[f.exe]);
 await fs.chmod(f.exe,0o750);
 await assert.rejects(p.trustedExecutablePaths(f.exe,undefined,JSON.stringify(reviewed)),/cli-trust-review-required/);
 await fs.chmod(f.exe,0o770);
 await fs.chmod(f.base,0o775);
 await assert.rejects(p.trustedExecutablePaths(f.exe,undefined,JSON.stringify(reviewed)),/cli-trust-review-required/);
 let queries=0;
 await assert.rejects(p.runCollection({mode:'claude-statusline',cliExecutable:f.exe,reportDir:f.reports,claudeAuthStatus:true,trustedCliPathsJson:JSON.stringify(reviewed)},Buffer.from('{}'),stamp,{...f.options,spawnProcess:()=>{queries++;throw Error('must not spawn');}}),/cli-trust-review-required/);
 assert.equal(queries,0);
 reviewed[0].mode=0o775;await fs.chmod(f.exe,0o777);
 await assert.rejects(p.trustedExecutablePaths(f.exe,undefined,JSON.stringify(reviewed)),/unsafe-cli-path/);
 await assert.rejects(p.trustedExecutablePaths(f.exe,undefined,'{}'),/invalid-cli-trust/);
});
test('closed native statusline normalization pairs current account and omits private fields',()=>{
 const report=p.antigravityReport({...agy(),secret:'PRIVATE',quota:{...agy().quota,PRIVATE:{remaining_fraction:.1}}},identity,stamp);
 assert.equal(report.windows[0].used_percent,6.22);assert.equal(report.plan_type,'pro');
 assert.equal(report.account.usage_event_at,stamp);assert.equal(report.account.email,'member@example.test');
 assert.match(report.coverage,/Unrecognized/);assert.doesNotMatch(JSON.stringify(report),/PRIVATE/);
 const claude=p.claudeReport({session_id:'a',email:'PRIVATE',rate_limits:{five_hour:{used_percentage:17,resets_at:1790421918}}},identity,stamp);
 assert.equal(claude.windows[0].used_percent,17);assert.equal(claude.account,undefined);
});
test('Codex exact held root supplies last complete quota event',async t=>{
 const f=await fixture(t),file=await f.transcript([quota(limits),quota({...limits,primary:{...limits.primary,used_percent:12}},'2026-09-19T12:01:00Z')]);await f.held(file);
 const report=await p.codexFdReport(10,f.exe,stamp,f.options);
 assert.equal(report.windows[0].used_percent,12);assert.equal(report.plan_type,'pro');assert.equal(report.source.source_event_at,'2026-09-19T12:01:00Z');
 assert.equal(report.account,undefined);
});
test('full native usage contains both pools and converts remaining once',()=>{
 const report=p.parseAntigravityUsage(Buffer.from(tsv()));
 assert.deepEqual(report.windows.map(x=>x.used_percent),[20,40,75,0]);
 assert.deepEqual(report.windows.map(x=>x.duration_minutes),[10080,300,10080,300]);
});

test('percentages reject booleans, overflow, nonfinite numbers and out of range values',()=>{
 for(const value of [true,false,'30',-1,101,NaN,Infinity,1e300,{},null]) {
  const claude=p.claudeReport({session_id:'a',rate_limits:{five_hour:{used_percentage:value,resets_at:value}}},identity,stamp);
  assert.equal(claude.windows[0].used_percent,null);
  const report=p.antigravityReport({...agy(),quota:{'gemini-weekly':{remaining_fraction:value}}},identity,stamp);
  assert.equal(report.windows[0].used_percent,null);
 }
 for(const [value,used] of [[0,100],[1,0],[.123456789,87.654321]])assert.equal(p.antigravityReport({...agy(),quota:{'gemini-weekly':{remaining_fraction:value}}},identity,stamp).windows[0].used_percent,used);
});
test('statusline provider/session assertions and explicit absent values fail closed',()=>{
 for(const data of [null,[],{}, {...agy(),product:'other'}, {...agy(),session_id:'different'}, {...agy(),conversation_id:null}])assert.throws(()=>p.antigravityReport(data,identity,stamp),p.CollectorError);
 const report=p.antigravityReport({product:'antigravity',session_id:'s',plan_tier:'PRIVATE',email:'x\u202e@y',quota:{}},identity,stamp);
 assert.equal(report.plan_type,undefined);assert.equal(report.account,undefined);assert.deepEqual(report.windows,[]);assert.equal(report.model,null);
 for(const email of ['a@@b','a b@c','<a>@b','a@b\u007f','a@\ud800b'])assert.equal(p.validEmail(email),false);
});
test('timestamps require real calendar dates, timezone and finite supported year',()=>{
 for(const value of ['2026-09-26T07:50:32','2026-02-30T00:00:00Z','0001-01-01T00:00:00+01:00','2026-01-01T24:00:00Z','2026-01-01T00:00:60Z','2026-01-01T00:00:00+24:00','0000-01-01T00:00:00Z',1790421918,{},null])assert.equal(p.timestamp(value),null,JSON.stringify(value));
 assert.equal(p.timestamp('2026-09-19T14:00:00+02:00'),stamp);
 assert.equal(p.timestamp('2026-09-19T14:00:00.123456+02:00'),'2026-09-19T12:00:00.123456Z');
 assert.equal(p.claudeReport({session_id:'s',rate_limits:{five_hour:{resets_at:.000001}}},identity,stamp).windows[0].resets_at,'1970-01-01T00:00:00.000001Z');
 assert.equal(p.claudeReport({session_id:'s',rate_limits:{five_hour:{resets_at:.0000005}}},identity,stamp).windows[0].resets_at,'1970-01-01T00:00:00Z');
});
test('native usage accepts only exact pools/window labels and suppresses unknown rows',()=>{
 for(const [percent,used] of [['0%',100],['100%',0],['87.654321%',12.345679],['-1%',null],['101%',null],['NaN%',null],['Infinity%',null],[' 75%',null],['0.5',null],['true',null]]) {
  const report=p.parseAntigravityUsage(Buffer.from(`Gemini Models\tWeekly Limit Remaining\t${percent}\t2026-09-26T07:50:32Z\nPRIVATE\tWeekly Limit Remaining\t1%\tbad\nClaude and GPT models\tPRIVATE\t1%\tbad\n`));
  assert.equal(report.windows.length,1);assert.equal(report.windows[0].used_percent,used);assert.match(report.coverage,/Unrecognized/);assert.doesNotMatch(JSON.stringify(report),/PRIVATE/);
 }
});
test('native usage rejects duplicate known rows, invalid UTF-8, wrong shape and oversize',()=>{
 for(const bytes of [Buffer.from(tsv()+tsv().split('\n')[0]),Buffer.concat([Buffer.from(tsv()),Buffer.from([255])]),Buffer.from(''),Buffer.from('PRIVATE_ERROR'),Buffer.from('Gemini Models\tWeekly Limit Remaining\t50%\n'),Buffer.from('Gemini Models\tWeekly Limit Remaining\t50%\tdate\textra\n'),Buffer.from(tsv().padEnd(32769,'\n'))])assert.equal(p.parseAntigravityUsage(bytes),null);
 assert.equal(p.parseAntigravityUsage(Buffer.from(tsv().padEnd(32768,'\n'))).windows.length,4);
});
test('latest complete Codex event clears removed limits and never reuses old plan',async t=>{
 const f=await fixture(t);
 for(const [last,expected] of [[quota(null),0],[quota({limit_id:'codex'}),0],[quota({...limits,plan_type:null}),1],[quota(limits,'bad'),0]]) {
  const file=await f.transcript([quota(limits),last]);const report=await p.codexReport(file,'session-a',identity,stamp);
  assert.equal(report.windows.length,expected);assert.equal(report.plan_type,undefined);
 }
});
test('Codex plan is native-only, allowlisted, and requires a source timestamp',async t=>{
 const f=await fixture(t);
 for(const provider of ['other',null,undefined]) {
  const file=await f.transcript([quota(limits)],{id:'session-a',source:'cli',model_provider:provider});
  assert.equal((await p.codexReport(file,'session-a',identity,stamp)).plan_type,undefined);
 }
 for(const plan of ['PRIVATE',true,{},[],1,null,'PRO']) {
  const file=await f.transcript([quota({...limits,plan_type:plan})]);assert.equal((await p.codexReport(file,'session-a',identity,stamp)).plan_type,undefined);
 }
});
test('Codex pool and durations are validated independently without quota guessing',async t=>{
 const f=await fixture(t);
 for(const value of [null,true,0,1.1,525601,1e300,'300']) {
  const file=await f.transcript([quota({...limits,primary:{used_percent:12,window_minutes:value}})]);
  const report=await p.codexReport(file,'session-a',identity,stamp);assert.equal(report.windows[0].duration_minutes,null);assert.equal(report.windows[0].used_percent,12);
 }
 const file=await f.transcript([quota({...limits,limit_id:null})]);assert.equal((await p.codexReport(file,'session-a',identity,stamp)).windows.length,0);
});
test('Codex malformed or truncated headers and wrong-session/subagent transcripts are rejected',async t=>{
 const f=await fixture(t);
 for(const raw of ['','{}\n','[]\n','{"type":"session_meta","payload":null}\n','{"type":"session_meta","payload":{"id":"s"}}','x'.repeat(524289)+'\n']) {
  const file=path.join(f.base,'bad.jsonl');await fs.writeFile(file,raw,{mode:0o600});await assert.rejects(p.codexReport(file,'s',identity,stamp),/unsupported-transcript-header/);
 }
 for(const meta of [{id:'wrong',source:'cli'},{id:'session-a',source:{subagent:'review'}},{id:'session-a',source:'other'}]) {
  const file=await f.transcript([],meta);await assert.rejects(p.codexReport(file,'session-a',identity,stamp),/transcript-session-or-root-mismatch/);
 }
});
test('bounded tail ignores partial and malformed rows and never forwards transcript content',async t=>{
 const f=await fixture(t),file=await f.transcript([quota(limits)]);
 await fs.appendFile(file,'PRIVATE '.repeat(40000)+'\n{"type":"event_msg","payload":{"type":"token_count" BAD}\n'+JSON.stringify(quota({...limits,primary:{used_percent:18}}))+'\n'+JSON.stringify(quota({...limits,primary:{used_percent:99}})));
 const report=await p.codexReport(file,'session-a',identity,stamp);assert.equal(report.windows[0].used_percent,18);assert.doesNotMatch(JSON.stringify(report),/PRIVATE|BAD/);
 await fs.appendFile(file,'x'.repeat(300000));const absent=await p.codexReport(file,'session-a',identity,stamp);assert.equal(absent.windows.length,0);assert.match(absent.coverage,/bounded transcript tail/);
});
test('nonregular files, symlink transcript and symlink ancestor cannot be read',async t=>{
 const f=await fixture(t),file=await f.transcript([quota(limits)]),link=path.join(f.base,'link.jsonl');await fs.symlink(file,link);
 await assert.rejects(p.codexReport(link,'session-a',identity,stamp),/transcript-unavailable/);
 const dirLink=path.join(f.base,'linked');await fs.symlink(f.base,dirLink);
 await assert.rejects(p.codexReport(path.join(dirLink,'rollout.jsonl'),'session-a',identity,stamp),/unsafe-or-unavailable-directory/);
 await assert.rejects(p.codexReport(f.base,'session-a',identity,stamp),/unsafe-transcript/);
 const fifo=path.join(f.base,'fifo.jsonl');await execute('mkfifo',[fifo]);const start=Date.now();await assert.rejects(p.codexReport(fifo,'session-a',identity,stamp),/unsafe-transcript/);assert.ok(Date.now()-start<1000);
});
test('group-writable transcript requires private same-owner ancestry and one link',async t=>{
 const f=await fixture(t),file=await f.transcript([quota(limits)]);await fs.chmod(file,0o660);
 assert.equal((await p.codexReport(file,'session-a',identity,stamp)).windows.length,1);
 const hard=path.join(f.base,'hard.jsonl');await fs.link(file,hard);await assert.rejects(p.codexReport(file,'session-a',identity,stamp),/unsafe-transcript/);await fs.unlink(hard);
 await fs.chmod(f.base,0o755);await assert.rejects(p.codexReport(file,'session-a',identity,stamp),/unsafe-transcript/);
});
test('process identity parses closing parentheses and deleted binary suffix safely',async t=>{
 const f=await fixture(t);await f.processFile(40,10,f.exe+' (deleted)','1234','a tricky ) name');
 const record=await p.processRecord(40,f.options);assert.equal(record.parent,10);assert.equal(record.identity.start_ticks,'1234');assert.equal(record.executable,f.exe);
 for(const pid of [null,0,-1,1.5,'10'])await assert.rejects(p.processRecord(pid,f.options),/invalid-process/);
});
test('ancestry skips hook shells and rejects distinct native ancestors',async t=>{
 const f=await fixture(t);assert.deepEqual(await p.findCliAncestor(30,f.exe,f.options),identity);
 await assert.rejects(p.findCliAncestor(30,path.join(f.base,'elsewhere','codex'),f.options),/cli-ancestor-unavailable-or-ambiguous/);
 await fs.unlink(path.join(f.proc,'20/exe'));await fs.symlink(f.exe,path.join(f.proc,'20/exe'));
 await assert.rejects(p.findCliAncestor(30,f.exe,f.options),/cli-ancestor-unavailable-or-ambiguous/);
});
test('dead, malformed, foreign-owner and unsupported-boot process records fail closed',async t=>{
 const f=await fixture(t),stat=path.join(f.proc,'10/stat'),raw=await fs.readFile(stat,'utf8');
 for(const state of ['Z','X']){await fs.writeFile(stat,raw.replace(') S ',`) ${state} `));await assert.rejects(p.checkedProcess(10,f.exe,f.options),/process-unavailable/);}
 await fs.writeFile(stat,raw);await assert.rejects(p.checkedProcess(10,f.exe,{...f.options,uid:process.getuid()+1}),/other-owner/);
 await fs.writeFile(path.join(f.proc,'sys/kernel/random/boot_id'),'bad');await assert.rejects(p.checkedProcess(10,f.exe,f.options),/unsupported-boot-identity/);
});
test('FD discovery deduplicates held inode, skips subagent, rejects multiple roots',async t=>{
 const f=await fixture(t),file=await f.transcript([quota(limits)]);await f.held(file);await f.held(file,'2');
 const child=await f.transcript([quota(limits)],{id:'child',source:{subagent:'review'}},'child.jsonl');await f.held(child,'3');
 assert.equal((await p.codexFdReport(10,f.exe,stamp,f.options)).session_id,'session-a');
 const other=await f.transcript([quota(limits)],{id:'other',source:'cli'},'other.jsonl');await f.held(other,'4');await assert.rejects(p.codexFdReport(10,f.exe,stamp,f.options),/ambiguous/);
});
test('unreadable transcript candidate invalidates uniqueness rather than guessing root',async t=>{
 const f=await fixture(t),file=await f.transcript([quota(limits)]);await f.held(file);await f.held(path.join(f.base,'missing.jsonl'),'2');
 await assert.rejects(p.codexFdReport(10,f.exe,stamp,f.options),/transcript-unavailable/);
});
test('Codex inode changes and PID reuse during transcript collection invalidate the snapshot',async t=>{
 const f=await fixture(t),file=await f.transcript([quota(limits)]),other=await f.transcript([quota(limits)],{id:'other',source:'cli'},'other.jsonl');await f.held(file);
 const fd=path.join(f.proc,'10/fd/1'),stat=path.join(f.proc,'10/stat'),body=await fs.readFile(stat,'utf8'),original=fs.stat;
 for(const change of ['inode','birth']) {
  let reads=0;
  fs.stat=async(...args)=>{const result=await original(...args);if(args[0]===fd && ++reads===1){if(change==='inode'){await fs.unlink(fd);await fs.symlink(other,fd);}else await fs.writeFile(stat,body.replace('900','999'));}return result;};
  try{await assert.rejects(p.codexFdReport(10,f.exe,stamp,f.options),change==='inode'?/transcript-fd-changed/:/process-changed/);}
  finally{fs.stat=original;await fs.writeFile(stat,body);await fs.unlink(fd);await fs.symlink(file,fd);}
 }
});
test('FD and transcript candidate caps reject incomplete discovery',async t=>{
 const f=await fixture(t),file=await f.transcript([quota(limits)]);
 for(let i=0;i<33;i++)await f.held(file,String(i));await assert.rejects(p.codexFdReport(10,f.exe,stamp,f.options),/transcript-budget-exceeded/);
 await fs.rm(path.join(f.proc,'10/fd'),{recursive:true});await fs.mkdir(path.join(f.proc,'10/fd'));
 for(let i=0;i<513;i++)await f.held('/dev/null',String(i));await assert.rejects(p.codexFdReport(10,f.exe,stamp,f.options),/process-fd-budget-exceeded/);
});
test('publication preserves newer source events and capture order including missing observations',async t=>{
 const f=await fixture(t);const report=p.baseReport('codex','s',identity,stamp);report.source.source_event_at=stamp;report.plan_type='pro';
 const filename=await p.publishReport(f.reports,report);
 const newer={...report,plan_type:null,source:{...report.source,source_event_at:'2026-09-19T12:02:00Z',captured_at:'2026-09-19T12:02:00Z'}};
 await p.publishReport(f.reports,newer);await p.publishReport(f.reports,{...report,source:{...report.source,captured_at:'2026-09-19T12:03:00Z'}});
 assert.deepEqual(JSON.parse(await fs.readFile(filename,'utf8')),newer);
 const missing={...report,source:{...report.source,source_event_at:null,captured_at:'2026-09-19T12:04:00Z'},windows:[],coverage:'Session ended.'};delete missing.plan_type;
 await p.publishReport(f.reports,missing);await p.publishReport(f.reports,newer);assert.deepEqual(JSON.parse(await fs.readFile(filename,'utf8')),missing);
 const end={...newer,source:{...newer.source,captured_at:'2026-09-19T12:05:00Z'},coverage:'Session ended.'};
 await p.publishReport(f.reports,end);await p.publishReport(f.reports,newer);assert.deepEqual(JSON.parse(await fs.readFile(filename,'utf8')),end);
 assert.equal((await fs.stat(filename)).mode&0o7777,0o640);
});
test('atomic publication refuses unsafe directories, symlinks, modes and oversized reports',async t=>{
 const f=await fixture(t),report=p.baseReport('claude','s',identity,stamp);
 await fs.chmod(f.reports,0o777);await assert.rejects(p.publishReport(f.reports,report),/unsafe-report-directory/);await fs.chmod(f.reports,0o700);
 await assert.rejects(p.publishReport(f.reports,{...report,coverage:'x'.repeat(32768)}),/report-too-large/);
 const filename=await p.publishReport(f.reports,report);await fs.chmod(filename,0o666);await assert.rejects(p.publishReport(f.reports,report),/unsafe-existing-report/);
 await fs.unlink(filename);const target=path.join(f.base,'target');await fs.writeFile(target,'untouched');await fs.symlink(target,filename);
 await assert.rejects(p.publishReport(f.reports,report),/unsafe-existing-report/);assert.equal(await fs.readFile(target,'utf8'),'untouched');
 await assert.rejects(p.publishReport(f.reports,{...report,process:{...identity,uid:identity.uid+1}}),/report-owner-mismatch/);
});
test('publication preserves microsecond source and capture ordering',async t=>{
 const f=await fixture(t),report=p.baseReport('codex','s',identity,stamp);
 const latest={...report,source:{...report.source,source_event_at:'2026-09-19T12:00:00.123456Z',captured_at:'2026-09-19T12:01:00.000002Z'}};
 const filename=await p.publishReport(f.reports,latest);
 await p.publishReport(f.reports,{...report,source:{...report.source,source_event_at:'2026-09-19T12:00:00.123455Z',captured_at:'2026-09-19T12:02:00Z'}});
 assert.deepEqual(JSON.parse(await fs.readFile(filename,'utf8')),latest);
 await p.publishReport(f.reports,{...latest,source:{...latest.source,captured_at:'2026-09-19T12:01:00.000001Z'}});
 assert.deepEqual(JSON.parse(await fs.readFile(filename,'utf8')),latest);
});
test('parallel publication serializes replacements and keeps the latest observation',async t=>{
 const f=await fixture(t),report=p.baseReport('claude','s',identity,stamp);
 const times=['12:05:00','12:02:00','12:07:00','12:04:00','12:01:00','12:06:00'];
 const files=await Promise.all(times.map(time=>p.publishReport(f.reports,{...report,source:{...report.source,captured_at:`2026-09-19T${time}Z`}})));
 const latest=JSON.parse(await fs.readFile(files[0],'utf8'));assert.equal(latest.source.captured_at,'2026-09-19T12:07:00Z');
 assert.equal((await fs.readdir(f.reports)).length,1);
});
test('crash lock can be reclaimed only with proven dead or reused process identity',async t=>{
 const f=await fixture(t),lock=path.join(f.reports,'.collector-lock'),marker='owner-'+'a'.repeat(32)+'.json',report=p.baseReport('claude','s',identity,stamp);
 for(const owner of [{...identity,pid:2147483647},{...(await p.processRecord(process.pid)).identity,start_ticks:'0'}]) {
  await fs.mkdir(lock,{mode:0o700});await fs.writeFile(path.join(lock,marker),JSON.stringify(owner),{mode:0o600});
  await p.publishReport(f.reports,report);await assert.rejects(fs.stat(lock),{code:'ENOENT'});
 }
 await fs.mkdir(lock,{mode:0o700});await fs.writeFile(path.join(lock,marker),'{}',{mode:0o600});await assert.rejects(p.publishReport(f.reports,report),/unsafe-report-lock/);assert.equal(await fs.readFile(path.join(lock,marker),'utf8'),'{}');
});
test('a live publication lock is never stolen by age or bounded retry timeout',async t=>{
 const f=await fixture(t),lock=path.join(f.reports,'.collector-lock'),marker='owner-'+'b'.repeat(32)+'.json',owner=(await p.processRecord(process.pid)).identity;
 await fs.mkdir(lock,{mode:0o700});await fs.writeFile(path.join(lock,marker),JSON.stringify(owner),{mode:0o600});await fs.utimes(lock,0,0);
 await assert.rejects(p.publishReport(f.reports,p.baseReport('claude','s',identity,stamp)),/report-directory-busy/);assert.deepEqual(JSON.parse(await fs.readFile(path.join(lock,marker),'utf8')),owner);
});
test('native reads bound stdout, ignore private stderr, use exact argv and mark recursive hooks',async()=>{
 const output=await p.boundedNative(process.execPath,['-e',"if(process.env.ACCOUNT_USAGE_NATIVE_QUERY!=='1')process.exit(9);process.stderr.write('PRIVATE'.repeat(100000));process.stdout.write('x'.repeat(32768));"]);
 assert.equal(output.length,32768);
 const start=Date.now();assert.equal(await p.boundedNative(process.execPath,['-e',"process.stdout.write('x'.repeat(32769));setTimeout(()=>{},30000);"]),null);assert.ok(Date.now()-start<2000);
});
test('native timeout kills and reaps only its own child',async()=>{
 let childPid;const started=Date.now();
 assert.equal(await p.boundedNative(process.execPath,['-e','setTimeout(()=>{},30000)'],{timeoutMs:100,spawnProcess:(...args)=>{const child=spawn(...args);childPid=child.pid;return child;}}),null);
 assert.ok(Date.now()-started<2000);assert.throws(()=>process.kill(childPid,0),{code:'ESRCH'});assert.doesNotThrow(()=>process.kill(process.pid,0));
});
async function native(f,code) {await fs.writeFile(f.exe,`#!${process.execPath}\n${code}\n`);await fs.chmod(f.exe,0o700);}
async function codexServer(f,{account={account:{type:'chatgpt',email:'member@example.test',planType:'pro'},requiresOpenaiAuth:true},rateLimits={rateLimitsByLimitId:{codex:{limitId:'codex',planType:'pro',primary:{usedPercent:24,windowDurationMins:300,resetsAt:1790421918},secondary:{usedPercent:48,windowDurationMins:10080,resetsAt:1791026718}},credits:{limitId:'credits',planType:'pro',primary:{usedPercent:7.5,windowDurationMins:1440,resetsAt:1790508318}}}},accountError=null,rateLimitsError=null,afterInitialize=''}={}) {
 const log=path.join(f.base,'app-server-requests.jsonl');
 const response=(id,result,error)=>error?{id,error}:{id,result};
 await native(f,`
const fs=require('node:fs');
if(JSON.stringify(process.argv.slice(2))!==JSON.stringify(['app-server']))process.exit(9);
const log=${JSON.stringify(log)},responses={2:${JSON.stringify(response(2,account,accountError))},3:${JSON.stringify(response(3,rateLimits,rateLimitsError))}};
let buffered='';
process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>{buffered+=chunk;for(let end;(end=buffered.indexOf('\\n'))>=0;){const line=buffered.slice(0,end);buffered=buffered.slice(end+1);if(!line)continue;const message=JSON.parse(line);fs.appendFileSync(log,JSON.stringify({message,env:process.env})+'\\n');if(message.id===1){process.stdout.write(JSON.stringify({id:1,result:{userAgent:'fake'}})+'\\n');${afterInitialize}}else if(responses[message.id])process.stdout.write(JSON.stringify(responses[message.id])+'\\n');}});
`);
 return log;
}
const codexArgs=f=>({mode:'codex-hook',cliExecutable:f.exe,reportDir:f.reports});
const codexHook=()=>Buffer.from(JSON.stringify({hook_event_name:'Stop',session_id:'codex-session',transcript_path:'/PRIVATE/transcript.jsonl',prompt:'PRIVATE prompt',last_assistant_message:'PRIVATE answer'}));
test('Codex Stop reads account and all rate-limit buckets without a model turn',async t=>{
 const f=await fixture(t),log=await codexServer(f),home=path.join(f.base,'home'),codexHome=path.join(f.base,'profile');
 await fs.mkdir(home);await fs.mkdir(codexHome);
 const report=await p.runCollection(codexArgs(f),codexHook(),stamp,{...f.options,env:{HOME:home,CODEX_HOME:codexHome,OPENAI_API_KEY:'PRIVATE'},now:()=>stamp});
 assert.equal(report.account.email,'member@example.test');assert.equal(report.plan_type,'pro');assert.equal(report.account.usage_event_at,stamp);assert.equal(report.account.observed_at,stamp);
 assert.equal(report.source.source_event_at,stamp);assert.equal(report.source.provider_observed_at,stamp);
 assert.deepEqual(report.windows.map(window=>[window.pool_id,window.window_id,window.duration_minutes,window.used_percent]),[['codex','primary',300,24],['codex','secondary',10080,48],['credits','primary',1440,7.5]]);
 assert.doesNotMatch(JSON.stringify(report),/PRIVATE|transcript|prompt|answer/);
 const requests=(await fs.readFile(log,'utf8')).trim().split('\n').map(JSON.parse),messages=requests.map(row=>row.message);
 assert.deepEqual(messages.find(message=>message.id===2),{id:2,method:'account/read',params:{refreshToken:false}});
 assert.deepEqual(messages.find(message=>message.id===3),{id:3,method:'account/rateLimits/read',params:{}});
 assert.equal(messages.some(message=>message.method==='turn/start'),false);
 assert.deepEqual(requests[0].env,{HOME:home,CODEX_HOME:codexHome,PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8',LC_ALL:'C.UTF-8'});
 const feed=await require('../src/core.cjs').readFeeds([f.reports]);assert.equal(feed.rejected,0);assert.equal(feed.reports.length,1);assert.equal(feed.reports[0].account.email,'member@example.test');
});
test('Codex Stop publishes partial reports instead of stale account or quota data',async t=>{
 const f=await fixture(t),options={...f.options,env:{HOME:path.join(f.base,'home')},now:()=>stamp};
 await fs.mkdir(options.env.HOME);
 await codexServer(f,{rateLimitsError:{code:-32000,message:'PRIVATE quota failure'}});
 const accountOnly=await p.runCollection(codexArgs(f),codexHook(),stamp,options);
 assert.equal(accountOnly.account.email,'member@example.test');assert.deepEqual(accountOnly.windows,[]);assert.match(accountOnly.coverage,/rate-limit metadata unavailable/);assert.doesNotMatch(JSON.stringify(accountOnly),/PRIVATE/);
 await codexServer(f,{accountError:{code:-32000,message:'PRIVATE account failure'}});
 const quotaOnly=await p.runCollection(codexArgs(f),codexHook(),'2026-09-19T12:01:00Z',{...options,now:()=> '2026-09-19T12:01:00Z'});
 assert.equal(quotaOnly.account,undefined);assert.equal(quotaOnly.windows.length,3);assert.equal(quotaOnly.plan_type,'pro');assert.match(quotaOnly.coverage,/account metadata unavailable/);assert.doesNotMatch(JSON.stringify(quotaOnly),/PRIVATE/);
 await codexServer(f,{accountError:{code:-32000,message:'PRIVATE account failure'},rateLimitsError:{code:-32000,message:'PRIVATE quota failure'}});
 const absent=await p.runCollection(codexArgs(f),codexHook(),'2026-09-19T12:02:00Z',{...options,now:()=> '2026-09-19T12:02:00Z'});
 assert.equal(absent.account,undefined);assert.equal(absent.plan_type,undefined);assert.deepEqual(absent.windows,[]);assert.match(absent.coverage,/account metadata unavailable/);assert.match(absent.coverage,/rate-limit metadata unavailable/);assert.doesNotMatch(JSON.stringify(absent),/PRIVATE/);
});
test('Codex Stop process replacement prevents publication',async t=>{
 const f=await fixture(t),stat=path.join(f.proc,'10/stat'),body=(await fs.readFile(stat,'utf8')).replace('900','999');
 await fs.mkdir(path.join(f.base,'home'));
 await codexServer(f,{afterInitialize:`fs.writeFileSync(${JSON.stringify(stat)},${JSON.stringify(body)});`});
 await assert.rejects(p.runCollection(codexArgs(f),codexHook(),stamp,{...f.options,env:{HOME:path.join(f.base,'home')}}),/process-changed/);
 assert.deepEqual((await fs.readdir(f.reports)).filter(name=>name.endsWith('.json')),[]);
});
const agyArgs=f=>({mode:'antigravity-statusline',cliExecutable:f.exe,reportDir:f.reports,agyFullUsage:true});
test('AGY idle full usage publishes both pools with statusline account metadata',async t=>{
 const f=await fixture(t);await native(f,`if(JSON.stringify(process.argv.slice(2))!==JSON.stringify(['--print','/usage']))process.exit(9);process.stdout.write(${JSON.stringify(tsv())});`);
 const report=await p.runCollection(agyArgs(f),Buffer.from(JSON.stringify(agy())),stamp,f.options);
 assert.equal(report.windows.length,4);assert.equal(report.source.kind,'antigravity-native-usage');assert.equal(report.account.email,'member@example.test');assert.equal(report.plan_type,'pro');assert.equal(report.account.usage_event_at,stamp);
});
test('AGY non-idle updates skip both query and publication',async t=>{
 const f=await fixture(t);await native(f,'process.exit(99)');
 for(const state of ['thinking','working','tool_use','initializing',null,'IDLE',true,undefined])assert.equal(await p.runCollection(agyArgs(f),Buffer.from(JSON.stringify({...agy(),agent_state:state})),stamp,{...f.options,spawnProcess:()=>{throw Error('must not spawn');}}),null);
 assert.deepEqual(await fs.readdir(f.reports),[]);
});
test('AGY failed native reads replace old full data and identity with current passive snapshot',async t=>{
 const f=await fixture(t);await native(f,`process.stdout.write(${JSON.stringify(tsv())});`);
 assert.equal((await p.runCollection(agyArgs(f),Buffer.from(JSON.stringify(agy())),stamp,f.options)).windows.length,4);
 for(const code of ["process.exit(4)","process.stdout.write('PRIVATE_ERROR')","process.stdout.write(Buffer.from([255]))","process.stdout.write('')",`process.stdout.write(${JSON.stringify(tsv()+tsv())});`]) {
  await native(f,code);
  const report=await p.runCollection(agyArgs(f),Buffer.from(JSON.stringify({...agy(),email:null,plan_tier:null})),'2026-09-19T12:02:00Z',f.options);
  assert.equal(report.windows.length,1);assert.equal(report.windows[0].used_percent,6.22);assert.equal(report.source.kind,'antigravity-statusline');assert.equal(report.account,undefined);assert.equal(report.plan_type,undefined);assert.match(report.coverage,/Full native usage read failed/);assert.match(report.coverage,/GPT\/Claude/);assert.doesNotMatch(JSON.stringify(report),/PRIVATE/);
 }
});
test('AGY timeout falls back within budget, preserving original process identity',async t=>{
 const f=await fixture(t);await native(f,'setTimeout(()=>{},30000)');
 const report=await p.runCollection(agyArgs(f),Buffer.from(JSON.stringify(agy())),stamp,{...f.options,timeoutMs:100});
 assert.equal(report.windows.length,1);assert.equal(report.source.kind,'antigravity-statusline');assert.deepEqual(await p.checkedProcess(10,f.exe,f.options),identity);
});
test('native queries execute held binary inode even when installation pathname changes',async t=>{
 const f=await fixture(t),pinned=path.join(f.base,'running');await native(f,`process.stdout.write(${JSON.stringify(tsv())});`);await fs.rename(f.exe,pinned);await native(f,'process.exit(9)');
 await fs.unlink(path.join(f.proc,'10/exe'));await fs.symlink(pinned,path.join(f.proc,'10/exe'));
 // Linux readlink reports the original installation path (deleted), while
 // executing /proc/PID/exe still follows the held inode. Model that distinction.
 const original=fs.readlink;fs.readlink=async target=>target===path.join(f.proc,'10/exe')?f.exe+' (deleted)':original(target);
 try{const result=await p.antigravityNativeUsage(identity,f.exe,f.options);assert.equal(result.windows.length,4);}finally{fs.readlink=original;}
});
test('PID reuse during native query invalidates publication, including passive fallback',async t=>{
 const f=await fixture(t),stat=path.join(f.proc,'10/stat'),body=(await fs.readFile(stat,'utf8')).replace('900','999');
 await native(f,`require('node:fs').writeFileSync(${JSON.stringify(stat)},${JSON.stringify(body)});process.stdout.write(${JSON.stringify(tsv())});`);
 await assert.rejects(p.runCollection(agyArgs(f),Buffer.from(JSON.stringify(agy())),stamp,f.options),/process-changed/);
 assert.deepEqual((await fs.readdir(f.reports)).filter(name=>name.endsWith('.json')),[]);assert.deepEqual(await fs.readdir(path.join(f.reports,'.native-queries')),[]);
});
const claudeArgs=f=>({mode:'claude-statusline',cliExecutable:f.exe,reportDir:f.reports,claudeAuthStatus:true});
const claudeRaw=()=>Buffer.from(JSON.stringify({session_id:'c',model:{id:'claude-example'},rate_limits:{five_hour:{used_percentage:41,resets_at:1790421918}}}));
test('private setgid report directories support native identity collection and card reads',async t=>{
 const f=await fixture(t);
 await fs.chmod(f.reports,0o2700);
 await native(f,`process.stdout.write(JSON.stringify({loggedIn:true,authMethod:'claude.ai',email:'member@example.test',subscriptionType:'max'}));`);
 const report=await p.runCollection(claudeArgs(f),claudeRaw(),stamp,f.options);
 assert.equal(report.account?.email,'member@example.test');
 const feed=await require('../src/core.cjs').readFeeds([f.reports]);
 assert.equal(feed.rejected,0);assert.equal(feed.reports.length,1);
 assert.equal(feed.reports[0].windows[0].used_percent,41);
 await fs.chmod(f.reports,0o2770);
 await assert.rejects(p.publishReport(f.reports,report),/unsafe-report-directory/);
 assert.equal((await require('../src/core.cjs').readFeeds([f.reports])).reports.length,0);
});
test('Claude metadata is opt-in, native-managed, bounded and independently allowlisted',async t=>{
 const f=await fixture(t),auth={loggedIn:true,authMethod:'claude.ai',email:'member@example.test',subscriptionType:'max',private:'PRIVATE'};
 await native(f,`if(JSON.stringify(process.argv.slice(2))!==JSON.stringify(['auth','status']))process.exit(9);process.stdout.write(${JSON.stringify(JSON.stringify(auth))});`);
 const plain=await p.runCollection({...claudeArgs(f),claudeAuthStatus:false},claudeRaw(),stamp,{...f.options,spawnProcess:()=>{throw Error('must not spawn');}});assert.equal(plain.account,undefined);
 const full=await p.runCollection(claudeArgs(f),claudeRaw(),stamp,f.options);assert.equal(full.plan_type,'max');assert.equal(full.account.email,auth.email);assert.equal(full.account.usage_event_at,stamp);assert.equal(full.windows[0].used_percent,41);assert.doesNotMatch(JSON.stringify(full),/PRIVATE/);
 for(const [changes,email,plan] of [[{email:'bad'},undefined,'max'],[{subscriptionType:'PRIVATE'},auth.email,undefined],[{loggedIn:1},undefined,undefined],[{authMethod:'api'},undefined,undefined]]) {
  await native(f,`process.stdout.write(${JSON.stringify(JSON.stringify({...auth,...changes}))});`);
  const result=await p.claudeAuthMetadata(identity,f.exe,stamp,f.options);assert.equal(result.account?.email,email);assert.equal(result.plan_type,plan);
 }
});
test('Claude malformed, oversized, nonzero and timeout auth output leave quota anonymous',async t=>{
 const f=await fixture(t);
 for(const code of ["process.stdout.write('PRIVATE_ERROR')","process.stdout.write(Buffer.from([255]))","process.stdout.write('x'.repeat(32769))","process.exit(9)",'setTimeout(()=>{},30000)']) {
  await native(f,code);const report=await p.runCollection(claudeArgs(f),claudeRaw(),stamp,{...f.options,timeoutMs:100});assert.equal(report.windows[0].used_percent,41);assert.equal(report.account,undefined);assert.equal(report.plan_type,undefined);
 }
});
test('input JSON bounds, CLI flag restrictions, missing directories and unsupported hosts fail explicitly',async t=>{
 const f=await fixture(t);
 for(const bytes of [Buffer.from('{'),Buffer.from([255]),Buffer.alloc(1048577,32)])await assert.rejects(p.runCollection(claudeArgs(f),bytes,stamp,f.options),/invalid-json-input|input-too-large/);
 await assert.rejects(p.runCollection(claudeArgs(f),claudeRaw(),stamp,{platform:'darwin'}),/unsupported-platform/);
 for(const argv of [['codex-read','--cli-executable',f.exe,'--pid','10','--agy-full-usage'],['antigravity-statusline','--cli-executable',f.exe,'--report-dir',f.reports,'--claude-auth-status'],['claude-statusline','--cli-executable',f.exe],['codex-read','--cli-executable','relative','--pid','10'],['codex-read','--cli-executable',f.exe,'--pid','10','--original-argv-json','["/bin/cat"]']])assert.throws(()=>p.parseArgs(argv),p.CollectorError);
 assert.equal(p.parseArgs(['claude-statusline','--cli-executable',f.exe,'--report-dir',f.reports,'--claude-account']).claudeAuthStatus,true);
});
test('recursively invoked statusline returns before parsing, querying or publishing',async t=>{
 const f=await fixture(t),previous=process.env.ACCOUNT_USAGE_NATIVE_QUERY;process.env.ACCOUNT_USAGE_NATIVE_QUERY='1';
 try{assert.equal(await p.runCollection(agyArgs(f),Buffer.from('PRIVATE invalid'),stamp,{...f.options,spawnProcess:()=>{throw Error('must not spawn');}}),null);assert.deepEqual(await fs.readdir(f.reports),[]);}
 finally{if(previous===undefined)delete process.env.ACCOUNT_USAGE_NATIVE_QUERY;else process.env.ACCOUNT_USAGE_NATIVE_QUERY=previous;}
});
function cli(argv,input,env={}) {
 return new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[path.join(__dirname,'../collectors/passive.cjs'),...argv],{stdio:['pipe','pipe','pipe'],env:{...process.env,NODE_OPTIONS:'',NODE_NO_WARNINGS:'1',...env}}),out=[],err=[];
  child.stdout.on('data',chunk=>out.push(chunk));child.stderr.on('data',chunk=>err.push(chunk));child.on('error',reject);child.on('close',code=>resolve({code,stdout:Buffer.concat(out),stderr:Buffer.concat(err).toString()}));child.stdin.on('error',()=>{});child.stdin.end(input);
 });
}
test('CLI original statusline preserves bytes, stdout and exit on malformed or oversized input',async t=>{
 const f=await fixture(t),argv=['claude-statusline','--cli-executable',f.exe,'--report-dir',f.reports,'--original-argv-json',JSON.stringify([process.execPath,'-e',"process.stdin.pipe(process.stdout);process.stdin.on('end',()=>{process.exitCode=7;})",'$(not-a-command)','; literal'])];
 for(const raw of [Buffer.from([0,255,10,123]),Buffer.alloc(1048700,97)]) {const result=await cli(argv,raw);assert.equal(result.code,7);assert.deepEqual(result.stdout,raw);assert.match(result.stderr,/usage-collector: (invalid-json-input|input-too-large)/);}
});
test('CLI observation failures do not block native work or expose private paths',async t=>{
 const f=await fixture(t);const result=await cli(['claude-statusline','--cli-executable',f.exe,'--report-dir',f.reports],Buffer.from('{}'));
 assert.equal(result.code,0);assert.equal(result.stdout.length,0);assert.match(result.stderr,/usage-collector:/);assert.ok(!result.stderr.includes(f.base));
 const hook=await cli(['codex-hook','--cli-executable',f.exe,'--report-dir',f.reports],codexHook());assert.equal(hook.code,0);assert.equal(hook.stdout.length,0);assert.doesNotMatch(hook.stderr,/PRIVATE|transcript|prompt|answer/);
 const direct=await cli(['codex-read','--cli-executable',f.exe,'--pid','2147483647'],Buffer.alloc(0));assert.equal(direct.code,1);assert.equal(direct.stdout.length,0);assert.equal(direct.stderr,'usage-collector: process-unavailable\n');
});

test('session clear replaces the old report for exactly the same publisher',async t=>{
 const f=await fixture(t),old=p.baseReport('claude','old',identity,stamp);
 const oldPath=await p.publishReport(f.reports,old,f.options);
 const next=p.baseReport('claude','next',identity,'2026-09-19T12:01:00Z');
 const nextPath=await p.publishReport(f.reports,next,f.options);
 await assert.rejects(fs.stat(oldPath),{code:'ENOENT'});assert.deepEqual(JSON.parse(await fs.readFile(nextPath,'utf8')),next);
 const late=await p.publishReport(f.reports,old,f.options);
 assert.equal(late,nextPath);await assert.rejects(fs.stat(oldPath),{code:'ENOENT'});
});
test('pruning removes proven dead or reused publishers and preserves distinct live processes',async t=>{
 const f=await fixture(t);await f.processFile(40,1,f.exe,'1000');const live={...identity,pid:40,start_ticks:'1000'};
 const keep=await p.publishReport(f.reports,p.baseReport('claude','other-live',live,stamp),f.options);
 const dead=await p.publishReport(f.reports,p.baseReport('claude','exited',{...identity,pid:99,start_ticks:'99'},stamp),f.options);
 const reused=await p.publishReport(f.reports,p.baseReport('claude','reused',{...live,start_ticks:'999'},stamp),f.options);
 await p.publishReport(f.reports,p.baseReport('claude','current',identity,stamp),f.options);
 await fs.stat(keep);await assert.rejects(fs.stat(dead),{code:'ENOENT'});await assert.rejects(fs.stat(reused),{code:'ENOENT'});
});
test('successive conversation clears stay bounded beyond the reader entry limit',async t=>{
 const f=await fixture(t);
 for(let index=0;index<140;index++)await p.publishReport(f.reports,p.baseReport('claude',`session-${index}`,identity,new Date(Date.parse(stamp)+index*1000).toISOString()),f.options);
 const entries=await fs.readdir(f.reports);assert.equal(entries.length,1);assert.equal(JSON.parse(await fs.readFile(path.join(f.reports,entries[0]),'utf8')).session_id,'session-139');
});
test('CLI lookup rollover recognizes old and new native processes and rejects unrelated targets',async t=>{
 const f=await fixture(t),lookup=path.join(f.base,'claude'),updated=path.join(f.base,'native-v2');await fs.writeFile(updated,'',{mode:0o700});await fs.symlink(updated,lookup);
 const args={...claudeArgs(f),claudeAuthStatus:false,cliLookupPath:lookup};
 assert.equal((await p.runCollection(args,claudeRaw(),stamp,f.options)).process.pid,10);
 await fs.unlink(path.join(f.proc,'10/exe'));await fs.symlink(updated,path.join(f.proc,'10/exe'));
 assert.equal((await p.runCollection(args,claudeRaw(),'2026-09-19T12:01:00Z',f.options)).process.pid,10);
 await fs.unlink(path.join(f.proc,'10/exe'));await fs.symlink(path.join(f.base,'unrelated'),path.join(f.proc,'10/exe'));
 await assert.rejects(p.runCollection(args,claudeRaw(),stamp,f.options),/cli-ancestor-unavailable-or-ambiguous/);
 const parsed=p.parseArgs(['claude-statusline','--cli-executable',f.exe,'--cli-lookup-path',lookup,'--report-dir',f.reports]);assert.equal(parsed.cliLookupPath,lookup);
});

const filenameFor=report=>`${report.provider}-${createHash('sha256').update(report.session_id).digest('hex').slice(0,24)}.json`;
async function seedReport(directory,report) {const filename=path.join(directory,filenameFor(report));await fs.writeFile(filename,JSON.stringify(report),{mode:0o600});return filename;}
test('pruning recovers a legacy directory with more than 128 dead reports',async t=>{
 const f=await fixture(t);
 for(let index=0;index<150;index++)await seedReport(f.reports,p.baseReport('claude',`ended-${index}`,{...identity,pid:10000+index},stamp));
 await p.publishReport(f.reports,p.baseReport('claude','current',identity,stamp),f.options);
 assert.equal((await fs.readdir(f.reports)).length,1);
});
test('pruning never deletes unknown, malformed, unsafe, symlinked or unbound files',async t=>{
 const f=await fixture(t),dead={...identity,pid:99999},files=[];
 const malformed=await seedReport(f.reports,p.baseReport('claude','malformed',dead,stamp));await fs.writeFile(malformed,'{');files.push(malformed);
 const unknown=await seedReport(f.reports,{...p.baseReport('claude','unknown',dead,stamp),raw:'PRIVATE'});files.push(unknown);
 const writable=await seedReport(f.reports,p.baseReport('claude','writable',dead,stamp));await fs.chmod(writable,0o666);files.push(writable);
 const foreignMetadata=await seedReport(f.reports,p.baseReport('claude','foreign',{...dead,uid:identity.uid+1},stamp));files.push(foreignMetadata);
 const target=path.join(f.base,'target');await fs.writeFile(target,'untouched');const symlink=path.join(f.reports,filenameFor(p.baseReport('claude','link',dead,stamp)));await fs.symlink(target,symlink);files.push(symlink);
 const hard=await seedReport(f.reports,p.baseReport('claude','hardlink',dead,stamp));await fs.link(hard,path.join(f.base,'held-hardlink'));files.push(hard);
 const unbound=path.join(f.reports,'claude-'+'f'.repeat(24)+'.json');await fs.writeFile(unbound,JSON.stringify(p.baseReport('claude','different-hash',dead,stamp)),{mode:0o600});files.push(unbound);
 const fifo=path.join(f.reports,filenameFor(p.baseReport('claude','fifo',dead,stamp)));await execute('mkfifo',[fifo]);files.push(fifo);
 const arbitrary=path.join(f.reports,'notes.txt');await fs.writeFile(arbitrary,'my file');files.push(arbitrary);
 const safe=await seedReport(f.reports,p.baseReport('claude','safe-dead',dead,stamp));
 await p.publishReport(f.reports,p.baseReport('claude','current',identity,stamp),f.options);
 for(const file of files)await fs.lstat(file);assert.equal(await fs.readFile(target,'utf8'),'untouched');await assert.rejects(fs.stat(safe),{code:'ENOENT'});
});
test('pruning requires death proof and preserves inaccessible or malformed process records',async t=>{
 const f=await fixture(t);await f.processFile(40,1,f.exe,'1000');const live={...identity,pid:40,start_ticks:'1000'};
 const keep=await seedReport(f.reports,p.baseReport('claude','other-live',live,stamp)),stat=path.join(f.proc,'40/stat'),original=fs.readFile;
 fs.readFile=async(...args)=>{if(args[0]===stat)throw Object.assign(new Error('denied'),{code:'EACCES'});return original(...args);};
 try{await p.publishReport(f.reports,p.baseReport('claude','current',identity,stamp),f.options);await fs.stat(keep);}finally{fs.readFile=original;}
 await fs.writeFile(stat,'malformed');await p.publishReport(f.reports,p.baseReport('claude','current',identity,stamp),f.options);await fs.stat(keep);
});
test('new live publishers stop below the reader cap without deleting distinct live sessions',async t=>{
 const f=await fixture(t);
 for(let index=0;index<118;index++){const pid=100+index;await f.processFile(pid,1,f.exe,String(pid));await seedReport(f.reports,p.baseReport('claude',`live-${index}`,{...identity,pid,start_ticks:String(pid)},stamp));}
 await p.publishReport(f.reports,p.baseReport('claude','current',identity,stamp),f.options);assert.equal((await fs.readdir(f.reports)).length,119);
 await f.processFile(300,1,f.exe,'300');
 await assert.rejects(p.publishReport(f.reports,p.baseReport('claude','extra',{...identity,pid:300,start_ticks:'300'},stamp),f.options),/report-directory-capacity-exceeded/);
 assert.equal((await fs.readdir(f.reports)).length,119);
});
test('pruning scan cap refuses an incomplete directory without wiping unknown files',async t=>{
 const f=await fixture(t);for(let index=0;index<1025;index++)await fs.writeFile(path.join(f.reports,`unknown-${index}`),'');
 await assert.rejects(p.publishReport(f.reports,p.baseReport('claude','current',identity,stamp),f.options),/report-directory-scan-limit/);assert.equal((await fs.readdir(f.reports)).length,1025);
});
test('equal capture times for different sessions fail explicitly rather than guessing order',async t=>{
 const f=await fixture(t),first=await p.publishReport(f.reports,p.baseReport('claude','first',identity,stamp),f.options);
 await assert.rejects(p.publishReport(f.reports,p.baseReport('claude','second',identity,stamp),f.options),/session-order-ambiguous/);await fs.stat(first);assert.equal((await fs.readdir(f.reports)).length,1);
});
test('native query lock spans collector processes and fresh Claude fallback cannot regain an old account',async t=>{
 const f=await fixture(t),counter=path.join(f.base,'queries'),release=path.join(f.base,'release');
 await native(f,`const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(counter)},'query\\n');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);process.stdout.write(JSON.stringify({loggedIn:true,authMethod:'claude.ai',email:'old@example.test',subscriptionType:'max'}));}},5);`);
 let firstSpawn;const spawned=new Promise(resolve=>{firstSpawn=resolve;});
 const first=p.runCollection(claudeArgs(f),claudeRaw(),stamp,{...f.options,spawnProcess:(...args)=>{const child=spawn(...args);firstSpawn();return child;}});
 await spawned;
 const code="const p=require(process.argv[1]);const a=JSON.parse(process.argv[2]);p.runCollection(a.args,Buffer.from(a.raw),'2026-09-19T12:01:00Z',a.options).then(r=>process.stdout.write(JSON.stringify(r))).catch(()=>process.exit(9));";
 const nextRaw=JSON.stringify({session_id:'c',rate_limits:{five_hour:{used_percentage:57}}});
 const output=await execute(process.execPath,['-e',code,path.join(__dirname,'../collectors/passive.cjs'),JSON.stringify({args:claudeArgs(f),raw:nextRaw,options:f.options})]);
 const fallback=JSON.parse(output.stdout);assert.equal(fallback.account,undefined);assert.equal(fallback.plan_type,undefined);assert.equal(fallback.windows[0].used_percent,57);assert.match(fallback.coverage,/already in progress/);
 await fs.writeFile(release,'done');
 await first;assert.equal((await fs.readFile(counter,'utf8')).trim().split('\n').length,1);
 const persisted=JSON.parse(await fs.readFile(path.join(f.reports,filenameFor(fallback)),'utf8'));assert.deepEqual(persisted,fallback);
 await native(f,`require('node:fs').appendFileSync(${JSON.stringify(counter)},'query\\n');process.stdout.write(JSON.stringify({loggedIn:true,authMethod:'claude.ai',email:'new@example.test',subscriptionType:'pro'}));`);
 const fresh=await p.runCollection(claudeArgs(f),claudeRaw(),'2026-09-19T12:02:00Z',f.options);assert.equal(fresh.account.email,'new@example.test');assert.equal((await fs.readFile(counter,'utf8')).trim().split('\n').length,2);
});
test('overlapping AGY native reads publish current passive quotas with explicit missing coverage',async t=>{
 const f=await fixture(t);await native(f,`setTimeout(()=>process.stdout.write(${JSON.stringify(tsv())}),300);`);
 let firstSpawn,queries=0;const spawned=new Promise(resolve=>{firstSpawn=resolve;});
 const options={...f.options,spawnProcess:(...args)=>{queries++;const child=spawn(...args);firstSpawn();return child;}};
 const first=p.runCollection(agyArgs(f),Buffer.from(JSON.stringify(agy())),stamp,options);await spawned;
 const data={...agy(),email:'current@example.test',plan_tier:'Ultra',quota:{'gemini-weekly':{remaining_fraction:.2}}};
 const next=await p.runCollection(agyArgs(f),Buffer.from(JSON.stringify(data)),'2026-09-19T12:01:00Z',options);
 assert.equal(queries,1);assert.equal(next.source.kind,'antigravity-statusline');assert.equal(next.windows.length,1);assert.equal(next.windows[0].used_percent,80);assert.equal(next.account.email,'current@example.test');assert.equal(next.plan_type,'ultra');assert.match(next.coverage,/already in progress/);assert.match(next.coverage,/GPT\/Claude/);
 await first;assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.reports,filenameFor(next)),'utf8')),next);
});
test('CLI lookup is frozen per observation while queries still execute the matched inode',async t=>{
 const f=await fixture(t),lookup=path.join(f.base,'claude'),updated=path.join(f.base,'native-v2'),future=path.join(f.base,'native-v3');await fs.writeFile(future,'');await native(f,"process.stdout.write(JSON.stringify({loggedIn:true,authMethod:'claude.ai',email:'member@example.test',subscriptionType:'pro'}));");
 await fs.rename(f.exe,updated);await native(f,'process.exit(9)');await fs.symlink(updated,lookup);await fs.unlink(path.join(f.proc,'10/exe'));await fs.symlink(updated,path.join(f.proc,'10/exe'));
 let command;const result=await p.runCollection({...claudeArgs(f),cliLookupPath:lookup},claudeRaw(),stamp,{...f.options,spawnProcess:(file,args,options)=>{command=file;require('node:fs').unlinkSync(lookup);require('node:fs').symlinkSync(future,lookup);return spawn(file,args,options);}});
 assert.equal(result.account.email,'member@example.test');assert.equal(command,path.join(f.proc,'10/exe'));
 await assert.rejects(p.runCollection({...claudeArgs(f),cliLookupPath:'relative'},claudeRaw(),stamp,f.options),/absolute-cli-lookup-path-required/);
});
test('native query locks recover proven-dead owners and refuse symlinked lock storage',async t=>{
 const f=await fixture(t),lockRoot=path.join(f.reports,'.native-queries'),key=createHash('sha256').update(JSON.stringify(['claude',identity.pid,identity.uid,identity.start_ticks,identity.boot_id])).digest('hex').slice(0,32);
 await fs.mkdir(lockRoot,{mode:0o700});const lock=path.join(lockRoot,`query-${key}`);await fs.mkdir(lock,{mode:0o700});
 await fs.writeFile(path.join(lock,'owner-'+'a'.repeat(32)+'.json'),JSON.stringify({...identity,pid:2147483647}),{mode:0o600});
 await native(f,"process.stdout.write(JSON.stringify({loggedIn:true,authMethod:'claude.ai',email:'member@example.test',subscriptionType:'pro'}));");
 const recovered=await p.runCollection(claudeArgs(f),claudeRaw(),stamp,f.options);assert.equal(recovered.account.email,'member@example.test');assert.deepEqual(await fs.readdir(lockRoot),[]);
 await fs.rmdir(lockRoot);const external=path.join(f.base,'unrelated');await fs.mkdir(external,{mode:0o700});await fs.symlink(external,lockRoot);
 let queries=0;const fallback=await p.runCollection(claudeArgs(f),claudeRaw(),'2026-09-19T12:01:00Z',{...f.options,spawnProcess:()=>{queries++;throw Error('must not spawn');}});
 assert.equal(queries,0);assert.equal(fallback.account,undefined);assert.match(fallback.coverage,/metadata unavailable/);assert.deepEqual(await fs.readdir(external),[]);assert.equal((await fs.lstat(lockRoot)).isSymbolicLink(),true);
});
