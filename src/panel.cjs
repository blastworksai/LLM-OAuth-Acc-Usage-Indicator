'use strict';
const {planLabel,accountEmail}=require('./core.cjs');

// Account cards render only validated usage reports.
const escape = value => String(value ?? '').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function stamp(value) {
  // The extension may run remotely. Only the local webview formats instants.
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}
function label(minutes) {
  if(minutes===300)return '5-hour window';
  if(minutes===10080)return 'Weekly window (7 days)';
  if(minutes===null)return 'Duration not reported';
  if(minutes%1440===0)return `${minutes/1440}-day window`;
  if(minutes%60===0)return `${minutes/60}-hour window`;
  return `${minutes}-minute window`;
}
function buildViewModel(state,now=Date.now()) {
  const vm={status:state.status,terminal:state.terminalName||'No terminal selected',windows:[],headline:null};
  const offered=state.status==='unavailable' && state.setupTarget
    ? ['claude','codex','antigravity'].includes(state.setupTarget.provider)
      ? state.setupTarget.provider
      : state.setupTarget.provider===null?'generic':null
    : null;
  if(state.status!=='ready')return {...vm,
    setupProvider:offered,
    title:({'no-terminal':'Select a terminal',loading:'Finding the active account',unavailable:'No account reading yet',ambiguous:'More than one session',unsupported:'Usage unavailable on this host'})[state.status]||'No account reading yet',
    message:({
      'no-terminal':'Your account card follows the terminal you select.',
      loading:'Matching this terminal to its session report.',
      unavailable:'This terminal has no matching account usage report. Select a connected Claude, Codex or Antigravity session to see its usage.',
      ambiguous:'Several sessions are active in this terminal. Usage will appear when one session can be identified.',
      unsupported:'Account matching is currently available on Linux terminal hosts.'
    })[state.status]||state.reason,
    reason:state.reason||null
  };
  const r=state.report;
  const windows=r.windows.map(w=> {
    const expired=!!w.resets_at && Date.parse(w.resets_at)<=now;
    const used=expired?null:w.used_percent;
    return {label:label(w.duration_minutes),shortLabel:w.duration_minutes===300?'5-hour window':w.duration_minutes===10080?'Weekly · 7 days':label(w.duration_minutes),pool:w.pool_id,id:w.window_id,used,
      percent:used===null?null:Math.trunc(used),expired,
      tone:used===null?'unmeasured':used>=100?'exhausted':used>=90?'warn':'normal',
      reset:stamp(w.resets_at),hasReset:!!w.resets_at};
  });
  const measured=windows.filter(w=>w.used!==null);
  const tightest=measured.reduce((a,b)=>!a||b.used>a.used?b:a,null);
  const event=r.source.source_event_at;
  const reported=event||r.source.captured_at;
  const stale=now-Date.parse(reported)>15*60*1000;
  return {...vm,windows,provider:({claude:'Claude',codex:'ChatGPT',antigravity:'Antigravity'})[r.provider],providerKey:r.provider,
    account:accountEmail(r)||'Account not identified',accountIdentified:!!accountEmail(r),
    accountObserved:accountEmail(r)?stamp(r.account.observed_at):null,
    tool:({claude:'Claude Code',codex:'Codex',antigravity:'AGY'})[r.provider],plan:planLabel(r),
    headline:tightest?`${tightest.percent}% used · ${tightest.label}`:null,
    compactHeadline:tightest?`${tightest.percent}% used · ${tightest.shortLabel.split(' · ')[0]}`:null,
    stale,reported:stamp(reported),reportLabel:event?'Usage reported':'Captured',
    providerObserved:stamp(r.source.provider_observed_at),captured:stamp(r.source.captured_at),
    session:r.session_id,uid:r.process.uid,coverage:r.coverage,
    nativeAgyUsage:r.provider==='antigravity' && r.source.kind==='antigravity-native-usage',
    missingPools:r.provider==='antigravity' ? [['Gemini Models','Gemini'],['Claude and GPT models','GPT/Claude']]
      .filter(([pool])=>!windows.some(w=>w.pool===pool)).map(([,name])=>`${name} pool not reported`) : []
  };
}
function fact(name,value) {return `<dt>${escape(name)}</dt><dd title="${escape(value)}">${escape(value)}</dd>`;}
function localTime(value) {
  const instant=stamp(value);
  return instant?`<time datetime="${escape(instant)}">…</time>`:'Not reported';
}
function timeFact(name,value) {return `<dt>${escape(name)}</dt><dd>${localTime(value)}</dd>`;}
function windowHtml(w) {
  const numeric=w.used!==null;
  const reading=numeric?`<strong class="window-percent">${w.percent}% used</strong>`:'<span class="window-unmeasured">Awaiting report</span>';
  const bar=numeric?`<progress class="usage-bar" role="progressbar" max="100" value="${w.used}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${w.used}" aria-label="${escape(w.label)} — ${w.percent}% used">${w.percent}%</progress>`:'<div class="usage-track-empty" role="img" aria-label="No current measurement"></div>';
  let note=w.expired?'Reset passed — awaiting report.':!numeric?'No figure reported for this window.':w.tone==='exhausted'?'Exhausted':w.tone==='warn'?'Nearly used':'';
  const reset=w.hasReset&&!w.expired?`<p class="window-reset">Resets ${localTime(w.reset)}</p>`:'';
  return `<section class="usage-window" data-state="${w.tone}"><div class="window-heading"><h3 title="${escape(w.label)}">${escape(w.shortLabel)}</h3>${reading}</div>${bar}${note?`<p class="window-note">${escape(note)}</p>`:''}${reset}</section>`;
}
function renderContent(vm,assets={}) {
  const follow=`<div class="terminal-context"><span class="eyebrow">Following terminal</span><span class="terminal-name" title="${escape(vm.terminal)}">${escape(vm.terminal)}</span></div>`;
  const setupLabel={claude:'Claude',codex:'Codex',antigravity:'Antigravity',generic:'Provider'}[vm.setupProvider];
  const connect=setupLabel?`<div class="card-actions"><button class="connect-provider" type="button" data-action="connect">Connect ${setupLabel}</button></div>`:'';
  if(vm.status!=='ready')return `${follow}<article class="account-card empty-card" aria-label="Account Usage"><span class="eyebrow">Account Usage</span><h2>${escape(vm.title)}</h2><p>${escape(vm.message)}</p>${connect}${vm.reason?`<details class="report-details"><summary>Details</summary><p>${escape(vm.reason)}</p></details>`:''}</article><p class="coverage-note">Claude, Codex and Antigravity · other tools not yet supported</p>`;
  const logo=assets[vm.providerKey];
  const mark=logo?`<span class="provider-mark"><img src="${escape(logo)}" alt="" aria-hidden="true"></span>`:'';
  const pools=[...new Set(vm.windows.map(w=>w.pool))];
  const usage=pools.length?pools.map(pool=>`<div class="quota-pool">${pools.length>1||vm.providerKey==='antigravity'?`<p class="pool-title eyebrow">${escape(pool)}</p>`:''}${vm.windows.filter(w=>w.pool===pool).map(windowHtml).join('')}</div>`).join(''):'<p class="window-note">No quota windows reported yet.</p>';
  const planSource=({claude:'Subscription type comes from the native Claude login checked with this statusline report.',codex:'Subscription type comes from this Codex session’s usage event.',antigravity:'Account identity and subscription type come from this Antigravity statusline report.'})[vm.providerKey];
  return `${follow}<article class="account-card" aria-label="${escape(vm.provider)} account usage">
    <header class="account-header">${mark}<div class="account-identity"><span class="provider-name eyebrow">${escape(vm.provider)}</span><h2>${escape(vm.account)}</h2><p class="account-handle">${escape(vm.tool)} session</p></div></header>
    ${vm.headline?`<p class="usage-headline" title="${escape(vm.headline)}">${escape(vm.compactHeadline)}</p>`:''}
    <div class="usage-windows">${usage}</div>
    <dl class="account-facts">${fact('Subscription type',vm.plan||'Not reported')}${timeFact(vm.reportLabel,vm.reported)}</dl>
  </article>
  <div class="card-caption">${vm.stale?'<p class="stale-notice">Last reported values · awaiting an update</p>':''}<p id="timezone-label">All times local to this computer</p><p>Only reported account limits shown</p>${vm.missingPools.map(note=>`<p class="stale-notice">${escape(note)}</p>`).join('')}</div>
  <details id="report-details" class="report-details"><summary>Report details</summary><p>The terminal selects the source of this account quota reading. Usage may include other sessions; readings must not be added together. ${vm.accountIdentified?'The email comes from the current CLI login when this usage update was observed.':'Account identity is unavailable for this usage update.'}</p><dl>${fact('Session',vm.session)}${fact('Local user',vm.uid)}${timeFact('Captured',vm.captured)}${vm.accountIdentified?timeFact('Account checked',vm.accountObserved):''}${timeFact('Provider time',vm.providerObserved)}${fact('Reported pools',pools.join(', ')||'None')}</dl><p>${vm.plan?escape(planSource):'Subscription type has not been reported.'} Subscription end dates, login expiry and quota resets are separate facts.</p>${vm.nativeAgyUsage?'<p>Quota windows come from AGY’s built-in /usage command.</p>':''}<p>${escape(vm.coverage)}</p></details>`;
}
function renderDocument({css,script,cspSource},content) {
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${escape(cspSource)}; img-src ${escape(cspSource)}; script-src ${escape(cspSource)}; base-uri 'none'; form-action 'none'"><link rel="stylesheet" href="${escape(css)}"><title>Account Usage</title></head><body><main id="account-usage">${content}</main><script src="${escape(script)}"></script></body></html>`;
}
module.exports={buildViewModel,renderContent,renderDocument};
