'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { validateReport, matchReports, readFeeds, readProcess, buildRows, SelectionController,reportFilename } = require('../src/core.cjs');

const stamp = '2026-09-19T12:00:00Z';
const proc = (pid, ppid, uid = 1000, ticks = String(pid)) => ({pid, ppid, uid, start_ticks: ticks, boot_id: 'boot',tty_nr:1,pgrp:pid===10?10:20,tpgid:20});
const report = (pid = 20, session = 'session-a') => ({
  schema_version: 1, provider: 'codex', session_id: session,
  process: {pid, uid: 1000, start_ticks: String(pid), boot_id: 'boot'}, model: null,
  source: {kind:'codex-session-event', source_event_at: stamp, captured_at: stamp, provider_observed_at:null},
  windows:[{pool_id:'codex', window_id:'primary', duration_minutes:10080, used_percent:42, resets_at:'2026-09-23T12:00:00Z'}],
  coverage:'Other account limits may be unavailable.'
});
const table = (...entries) => async pid => entries.find(p => p?.pid === pid) || null;

test('matches exact live ancestry through a different Unix user; ignores title/provider guesses', async () => {
  const r = report(); r.process.uid = 2000;
  const result = await matchReports(10, [r, report(40,'other')], table(proc(10,1),proc(15,10),proc(20,15,2000),proc(40,1)));
  assert.equal(result.status, 'ready'); assert.equal(result.report.session_id, 'session-a');
});
test('PID reuse, reboot, process exit and non-descendant never reuse a quota', async () => {
  for (const current of [null, proc(20,10,1000,'new'), {...proc(20,10),boot_id:'other'}, proc(20,1)]) {
    assert.equal((await matchReports(10,[report()],table(proc(10,1),current).bind(null))).status,'unavailable');
  }
});
test('two simultaneous descendants are ambiguous even if same provider/percentage', async () => {
  assert.equal((await matchReports(10,[report(),report(30,'b')],table(proc(10,1),proc(20,10),proc(30,10)))).status,'ambiguous');
});
test('terminal shell identity changing during resolution fails closed', async () => {
  let calls=0;
  const read = async pid => pid===10 ? proc(10,1,1000,++calls===1?'old':'new') : proc(20,10);
  assert.equal((await matchReports(10,[report()],read)).status,'unavailable');
});
test('conflicting snapshots for the same session do not choose by directory order', async () => {
  const a=report(),b=report();b.windows[0].used_percent=99;
  for(const reports of [[a,b],[b,a]])assert.equal((await matchReports(10,reports,table(proc(10,1),proc(20,10)))).status,'ambiguous');
});
test('a publisher exiting while other candidates are scanned cannot survive final selection', async () => {
  let exited=false;
  const read=async pid=>{if(pid===30){exited=true;return null;}return pid===20&&exited?null:table(proc(10,1),proc(20,10))(pid);};
  assert.equal((await matchReports(10,[report(),report(30,'later')],read)).status,'unavailable');
});
test('background and stopped jobs never look like the foreground shell quota', async () => {
  const background={...proc(20,10),pgrp:20,tpgid:10};
  assert.equal((await matchReports(10,[report()],table({...proc(10,1),tpgid:10},background))).status,'unavailable');
});
test('foreground nested sudo PTY matches through foreground outer ancestor', async () => {
  const leaf={...proc(20,15,2000),tty_nr:2,tpgid:20,pgrp:20};
  const r=report();r.process.uid=2000;
  assert.equal((await matchReports(10,[r],table({...proc(10,1),tpgid:15},{...proc(15,10),pgrp:15,tpgid:15},leaf))).status,'ready');
});
test('foreground change during selection invalidates otherwise identical PID/birth', async () => {
  let reads=0;
  const read=async pid=>pid===10?{...proc(10,1),tpgid:++reads===1?20:10}:proc(20,10);
  assert.equal((await matchReports(10,[report()],read)).status,'unavailable');
});
test('wrong owner, non-finite percent, oversize labels and extra sensitive fields are invalid', () => {
  assert.equal(validateReport(report(),1000),true);
  assert.equal(validateReport(report(),2000),false);
  for(const mutate of [r=>r.windows[0].used_percent=101,r=>r.windows[0].used_percent=NaN,r=>r.session_id='x'.repeat(257),r=>r.raw='private',r=>r.process.pid=-1]) {
    const r=report(); mutate(r); assert.equal(validateReport(r,1000),false);
  }
});
test('optional plan metadata accepts legacy reports and only closed native Codex tiers', () => {
  assert.equal(validateReport(report(),1000),true);
  for(const plan of [null,'free','go','plus','pro','prolite','team','self_serve_business_prolite','self_serve_business_usage_based','business','ent26','enterprise_cbp_automation','enterprise_cbp_usage_based','enterprise','edu','edu_plus','edu_pro']) {
    assert.equal(validateReport({...report(),plan_type:plan},1000),true,`supported tier ${plan}`);
  }
  for(const plan of ['unknown','future-tier','sk-'+'private'.repeat(20),'PRO','pro\n','',true,5,[],{},'constructor','__proto__']) {
    assert.equal(validateReport({...report(),plan_type:plan},1000),false);
  }
  const r={...report(),plan_type:'pro'};
  r.provider='claude';r.source.kind='claude-statusline';r.plan_type='prolite';assert.equal(validateReport(r,1000),false);
  r.provider='codex';assert.equal(validateReport(r,1000),false);
  r.source.kind='codex-session-event';r.source.source_event_at=null;assert.equal(validateReport(r,1000),false);
});
test('Claude native metadata stays paired with its statusline capture without inventing event time',()=>{
 const r=report();r.provider='claude';r.source.kind='claude-statusline';r.source.source_event_at=null;r.plan_type='max';
 r.account={email:'reader@example.test',source:'claude-auth-status',usage_event_at:r.source.captured_at,observed_at:'2026-09-19T12:00:01Z'};
 assert.equal(validateReport(r,1000),true);
 for(const mutate of [x=>x.account.source='codex-account-read',x=>x.account.usage_event_at=null,x=>x.plan_type='prolite',x=>x.account.email='bad']) {
  const next=structuredClone(r);mutate(next);assert.equal(validateReport(next,1000),false);
 }
 delete r.plan_type;assert.equal(validateReport(r,1000),true);
});
test('Antigravity native identity uses its own statusline capture and closed subscription tiers',()=>{
 const r=report();r.provider='antigravity';r.source.kind='antigravity-statusline';r.source.source_event_at=null;r.plan_type='ultra';
 r.account={email:'reader@example.test',source:'antigravity-statusline',usage_event_at:r.source.captured_at,observed_at:r.source.captured_at};
 assert.equal(validateReport(r,1000),true);
 assert.match(reportFilename(r),/^antigravity-[a-f0-9]{24}\.json$/);
 for(const mutate of [x=>x.source.kind='claude-statusline',x=>x.account.source='claude-auth-status',x=>x.account.usage_event_at=null,x=>x.plan_type='max']) {
  const next=structuredClone(r);mutate(next);assert.equal(validateReport(next,1000),false);
 }
 delete r.plan_type;assert.equal(validateReport(r,1000),true);
});
test('Antigravity full native usage keeps statusline identity paired with the same capture',()=>{
 const r=report();r.provider='antigravity';r.source.kind='antigravity-native-usage';r.source.source_event_at=null;r.plan_type='pro';
 r.account={email:'reader@example.test',source:'antigravity-statusline',usage_event_at:r.source.captured_at,observed_at:r.source.captured_at};
 assert.equal(validateReport(r,1000),true);
 const wrong=structuredClone(r);wrong.account.usage_event_at='2026-09-18T00:00:00Z';assert.equal(validateReport(wrong,1000),false);
 const invented=structuredClone(r);invented.source.kind='antigravity-unknown';assert.equal(validateReport(invented,1000),false);
});
test('native Antigravity publication is readable and disappears when account metadata is absent',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'usage-agy-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const r=report();r.provider='antigravity';r.process.uid=process.getuid();r.source.kind='antigravity-statusline';r.source.source_event_at=null;
 r.account={email:'reader@example.test',source:'antigravity-statusline',usage_event_at:r.source.captured_at,observed_at:r.source.captured_at};
 const file=path.join(dir,reportFilename(r));await fs.writeFile(file,JSON.stringify(r),{mode:0o600});
 assert.equal((await readFeeds([dir])).reports[0]?.account.email,'reader@example.test');
 delete r.account;await fs.writeFile(file,JSON.stringify(r));
 assert.equal((await readFeeds([dir])).reports[0]?.account,undefined);
});
test('account email is accepted only with native provenance for this exact usage event', () => {
  const valid=()=>({...report(),plan_type:'pro',account:{email:'reader@example.test',source:'codex-account-read',usage_event_at:stamp,observed_at:'2026-09-19T12:00:01Z'}});
  assert.equal(validateReport(valid(),1000),true);
  assert.ok(buildRows({status:'ready',report:valid()},Date.parse(stamp)).some(row=>row.label==='reader@example.test'));
  for(const mutate of [
    r=>r.account=null,r=>r.account.extra='private',r=>r.account.source='profile-file',
    r=>r.account.usage_event_at='2026-09-19T11:59:00Z',r=>r.account.observed_at=null,
    r=>r.account.observed_at='yesterday',r=>delete r.plan_type,
    r=>{r.provider='claude';r.source.kind='claude-statusline';delete r.plan_type;},
    ...['not-an-email','<reader>@example.test','reader\n@example.test','reader @example.test','a'.repeat(250)+'@example.test'].map(email=>r=>r.account.email=email)
  ]) {const r=valid();mutate(r);assert.equal(validateReport(r,1000),false);}
});
test('a replacement legacy feed cannot inherit a previously reported plan', async t => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'usage-plan-feed-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const r={...report(),plan_type:'pro'};r.process.uid=process.getuid();
  const file=path.join(dir,reportFilename(r));
  await fs.writeFile(file,JSON.stringify(r),{mode:0o600});
  assert.equal((await readFeeds([dir])).reports[0].plan_type,'pro');
  delete r.plan_type;r.source.source_event_at='2026-09-19T12:01:00Z';
  await fs.writeFile(file,JSON.stringify(r));
  assert.equal((await readFeeds([dir])).reports[0].plan_type,undefined);
});
test('real process identity is read without command lines or environment', async () => {
  const p=await readProcess(process.pid); assert.equal(p.pid,process.pid); assert.equal(p.uid,process.getuid());
  assert.match(p.start_ticks,/^\d+$/); assert.equal('command' in p,false);
});
test('feed reader rejects symlinks, group-writable files and mismatched owner; accepts private report', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'usage-feed-test-')); t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const r=report();r.process.uid=process.getuid();
  const file=path.join(dir,reportFilename(r));
  await fs.writeFile(file,JSON.stringify(r),{mode:0o600});
  assert.equal((await readFeeds([dir])).reports.length,1);
  await fs.chmod(file,0o660);
  assert.equal((await readFeeds([dir])).reports.length,0);
  await fs.chmod(file,0o644);
  assert.equal((await readFeeds([dir])).reports.length,0);
  await fs.chmod(file,0o600);
  await fs.symlink(file,path.join(dir,'codex-000000000000000000000000.json'));
  assert.equal((await readFeeds([dir])).reports.length,1);
  await fs.chmod(dir,0o755);assert.equal((await readFeeds([dir])).reports.length,0);
  await fs.chmod(dir,0o770); assert.equal((await readFeeds([dir])).reports.length,0);
});
test('window labels use duration; reset expiry never becomes measured zero', () => {
  const s={status:'ready',terminalName:'Claude-looking wrapper',report:report()};
  const rows=buildRows(s,Date.parse(stamp));
  assert.ok(rows.some(r=>r.label.includes('7 days') && r.description.includes('42%')));
  assert.ok(rows.some(r=>r.label.includes('Account not identified')));
  const expired=buildRows(s,Date.parse('2026-09-24T12:00:00Z'));
  assert.ok(expired.some(r=>r.description?.includes('Reset passed')));
  assert.equal(expired.some(r=>r.description?.includes('0% used')),false);
});
test('missing windows and unsupported terminals cannot retain old values', () => {
  const r=report();r.windows=[];
  assert.ok(buildRows({status:'ready',report:r},Date.parse(stamp)).some(row=>row.label.includes('No quota windows')));
  assert.equal(buildRows({status:'unavailable',terminalName:'shell'}).some(row=>row.description?.includes('%')),false);
});
test('late async result for terminal A cannot replace selected B or disposed view', async () => {
  const pending = new Map();const states=[];
  const c=new SelectionController(t=>new Promise(resolve=>pending.set(t,resolve)),s=>states.push(s));
  const a=c.select('A');const b=c.select('B');
  pending.get('B')({status:'ready',report:report(30,'B')});await b;
  pending.get('A')({status:'ready',report:report(20,'A')});await a;
  assert.equal(states.at(-1).report.session_id,'B');
  const d=c.select('C');c.dispose();pending.get('C')({status:'ready',report:report(40,'C')});await d;
  assert.equal(states.at(-1).status,'loading');
});
