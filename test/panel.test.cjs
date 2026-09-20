'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {buildViewModel,renderContent}=require('../src/panel.cjs');
const now=Date.parse('2026-09-19T15:00:00Z');
const state=()=>({status:'ready',terminalName:'Codex',report:{provider:'codex',session_id:'session-a',process:{uid:1000,pid:123},model:'gpt-5.4',source:{kind:'codex-session-event',source_event_at:'2026-09-19T14:59:00Z',captured_at:'2026-09-19T14:59:01Z',provider_observed_at:null},windows:[{pool_id:'codex',window_id:'primary',duration_minutes:10080,used_percent:42,resets_at:'2026-09-25T15:00:00Z'},{pool_id:'codex',window_id:'secondary',duration_minutes:300,used_percent:17,resets_at:'2026-09-19T17:00:00Z'}],coverage:'Other account limits may be unavailable.'}});
test('reported native tier is human readable without implying known account or expiry',()=>{
 const s=state();s.report.plan_type='pro';
 const vm=buildViewModel(s,now),html=renderContent(vm);
 assert.equal(vm.plan,'Pro');assert.equal(vm.account,'Account not identified');
 assert.match(html,/<dt>Subscription type<\/dt><dd title="Pro">Pro<\/dd>/);
 assert.match(html,/Codex session.*usage event/);
 assert.doesNotMatch(html,/has not connected account or subscription metadata|<dt>Subscription ends<\/dt>|<dt>Model<\/dt>/);
 s.report.plan_type='self_serve_business_usage_based';
 assert.equal(buildViewModel(s,now).plan,'Self-serve Business (usage based)');
});
test('card shows the login paired with its usage event and clears it with a replacement report',()=>{
 const s=state();s.report.plan_type='pro';
 s.report.account={email:'reader@example.test',source:'codex-account-read',usage_event_at:s.report.source.source_event_at,observed_at:'2026-09-19T14:59:02Z'};
 let vm=buildViewModel(s,now),html=renderContent(vm);
 assert.equal(vm.account,'reader@example.test');assert.match(html,/<h2>reader@example.test<\/h2>/);
 assert.match(html,/current CLI login when this usage update was observed/);
 assert.doesNotMatch(html,/has not yet been identified|Account identity.*not reported/);
 for(const mutate of [r=>delete r.account,r=>r.account.usage_event_at='2026-09-19T14:58:00Z',r=>r.account.email='<script>@example.test']) {
  const next=structuredClone(s);mutate(next.report);vm=buildViewModel(next,now);html=renderContent(vm);
  assert.equal(vm.account,'Account not identified');assert.doesNotMatch(html,/reader@example.test|<script>/);
 }
});
test('missing invalid or unrelated plan metadata never retains or guesses a tier',()=>{
 const s=state();s.report.plan_type='pro';assert.equal(buildViewModel(s,now).plan,'Pro');
 for(const tier of [undefined,null,'unknown','future-tier','sk-'+'private'.repeat(20),'constructor','__proto__']) {
  s.report.plan_type=tier;const html=renderContent(buildViewModel(s,now));
  assert.match(html,/<dt>Subscription type<\/dt><dd title="Not reported">Not reported<\/dd>/);
  assert.doesNotMatch(html,/private|title="Pro"/);
 }
 s.report.plan_type='prolite';s.report.provider='claude';s.report.source.kind='claude-statusline';
 assert.equal(buildViewModel(s,now).plan,null);
 s.report.provider='codex';assert.equal(buildViewModel(s,now).plan,null);
 s.report.source.kind='codex-session-event';s.report.source.source_event_at=null;
 assert.equal(buildViewModel(s,now).plan,null);
});
test('Claude card shows native login and Max tier with captured-time provenance',()=>{
 const s=state();s.report.provider='claude';s.report.source.kind='claude-statusline';s.report.source.source_event_at=null;s.report.plan_type='max';
 s.report.account={email:'reader@example.test',source:'claude-auth-status',usage_event_at:s.report.source.captured_at,observed_at:'2026-09-19T14:59:02Z'};
 const vm=buildViewModel(s,now),html=renderContent(vm);
 assert.equal(vm.provider,'Claude');assert.equal(vm.plan,'Max');assert.equal(vm.account,'reader@example.test');assert.equal(vm.reportLabel,'Captured');
 assert.match(html,/native Claude login/);assert.doesNotMatch(html,/Codex session|Account not identified/);
});
test('Antigravity card names the provider and reported quota family without exposing active model',()=>{
 const s=state();s.report.provider='antigravity';s.report.source.kind='antigravity-statusline';s.report.source.source_event_at=null;s.report.plan_type='ultra';
 s.report.windows=s.report.windows.slice(0,1);s.report.windows[0].pool_id='Gemini Models';
 s.report.account={email:'reader@example.test',source:'antigravity-statusline',usage_event_at:s.report.source.captured_at,observed_at:s.report.source.captured_at};
 const vm=buildViewModel(s,now),html=renderContent(vm,{antigravity:'safe-asset.svg'});
 assert.equal(vm.provider,'Antigravity');assert.equal(vm.tool,'AGY');assert.equal(vm.plan,'Ultra');assert.equal(vm.account,'reader@example.test');
 assert.match(html,/Gemini Models/);assert.match(html,/Antigravity statusline/);assert.match(html,/safe-asset.svg/);
 assert.doesNotMatch(html,/ChatGPT|Codex session|Claude Code session|gpt-5\.4/);
 assert.match(html,/GPT\/Claude pool not reported/);
});
test('full AGY account card separates Gemini and GPT/Claude pools with all four bars',()=>{
 const s=state();s.report.provider='antigravity';s.report.source.kind='antigravity-native-usage';s.report.source.source_event_at=null;s.report.plan_type='pro';
 s.report.account={email:'reader@example.test',source:'antigravity-statusline',usage_event_at:s.report.source.captured_at,observed_at:s.report.source.captured_at};
 const pair=s.report.windows.map(w=>({...w,pool_id:'Gemini Models'}));
 s.report.windows=[...pair,...pair.map(w=>({...w,pool_id:'Claude and GPT models',used_percent:33}))];
 const vm=buildViewModel(s,now),html=renderContent(vm);
 assert.equal(vm.account,'reader@example.test');assert.equal(vm.plan,'Pro');
 assert.equal((html.match(/role="progressbar"/g)||[]).length,4);
 assert.equal((html.match(/class="quota-pool"/g)||[]).length,2);
 assert.match(html,/Gemini Models/);assert.match(html,/Claude and GPT models/);assert.match(html,/built-in \/usage/);
 assert.doesNotMatch(html,/pool not reported|Account not identified/);
});
test('account card keeps supplied windows and their duration/pool identities',()=>{
 const vm=buildViewModel(state(),now);const html=renderContent(vm);
 assert.equal(vm.provider,'ChatGPT');assert.equal(vm.account,'Account not identified');
 assert.equal(vm.windows[0].label,'Weekly window (7 days)');assert.equal(vm.windows[1].label,'5-hour window');
 assert.equal((html.match(/role="progressbar"/g)||[]).length,2);
 assert.match(html,/aria-valuenow="42"/);assert.match(html,/aria-valuenow="17"/);
 assert.match(html,/42% used/);assert.match(html,/<time datetime="2026-09-25T15:00:00\.000Z">/);
 assert.doesNotMatch(html,/Local UID|<dt>Subscription ends<\/dt>/);
});
test('unknown and passed-reset windows never draw a measured zero or previous value',()=>{
 const s=state();s.report.windows[0].used_percent=null;s.report.windows[1].resets_at='2026-09-19T14:00:00Z';
 const vm=buildViewModel(s,now),html=renderContent(vm);
 assert.equal(vm.headline,null);assert.ok(vm.windows.every(w=>w.used===null));
 assert.doesNotMatch(html,/role="progressbar"|0% used|17% used/);assert.match(html,/Awaiting report/);
});
test('warning and exhaustion use text as well as color',()=>{
 const s=state();s.report.windows[0].used_percent=90;s.report.windows[1].used_percent=100;
 const vm=buildViewModel(s,now);assert.equal(vm.windows[0].tone,'warn');assert.equal(vm.windows[1].tone,'exhausted');
 const html=renderContent(vm);assert.match(html,/Nearly used/);assert.match(html,/Exhausted/);
});
test('untrusted report text cannot inject markup and active model is not an account fact',()=>{
 const s=state();s.terminalName='<img src=x onerror=alert(1)>';s.report.model='unused-active-model';s.report.session_id='<script>alert(1)</script>';s.report.windows[0].pool_id='" onclick="alert(1)';
 const html=renderContent(buildViewModel(s,now));assert.doesNotMatch(html,/<script>|<img src=x/);assert.match(html,/&lt;script&gt;/);
 assert.doesNotMatch(html,/unused-active-model|<dt>Model<\/dt>|Session window|Expected expiry/);
 assert.match(html,/Usage may include other sessions/);
});
test('all non-ready states remove quota card percentages and data',()=>{
 for(const status of ['loading','unavailable','ambiguous','unsupported','no-terminal']) {
  const html=renderContent(buildViewModel({...state(),status},now));assert.doesNotMatch(html,/role="progressbar"|42%|17%/);
 }
});
test('provider setup is shown only for a detected session that needs connecting',()=>{
 for(const status of ['ready','loading','unavailable','ambiguous','unsupported','no-terminal']) {
  const html=renderContent(buildViewModel({...state(),status},now));
  assert.doesNotMatch(html,/<button\b/);
 }
 for(const provider of ['claude','antigravity']) {
  const html=renderContent(buildViewModel({status:'unavailable',setupTarget:{provider}},now));
  const buttons=[...html.matchAll(/<button\b([^>]*)>([^<]*)<\/button>/g)];
  assert.equal(buttons.length,1,`${provider} must offer one provider connection action`);
  assert.match(buttons[0][1],/type="button"/);
  assert.match(buttons[0][1],/data-action="connect"/);
  assert.equal(buttons[0][2],provider==='claude'?'Connect Claude':'Connect Antigravity');
  assert.doesNotMatch(buttons[0][1],/disabled|tabindex="-1"/);
 }
});
