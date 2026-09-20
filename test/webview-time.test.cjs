'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {execFileSync}=require('node:child_process');
const {buildViewModel,renderContent}=require('../src/panel.cjs');

function markup(iso) {
  return renderContent(buildViewModel({status:'ready',terminalName:'Example',report:{
    provider:'codex',session_id:'example',process:{uid:1000},model:null,
    source:{kind:'codex-session-event',source_event_at:iso,captured_at:iso,provider_observed_at:null},
    windows:[{pool_id:'codex',window_id:'weekly',duration_minutes:10080,used_percent:25,resets_at:iso}],
    coverage:'Example reading.'
  }},Date.parse(iso)-3600000));
}

// Run the actual webview script with a small DOM boundary. Date/Intl are real;
// the child process represents the viewing machine, independent of this host.
function viewInTimezone(zone,first,second) {
  return JSON.parse(execFileSync(process.execPath,[__filename,'--client'],{
    env:{...process.env,TZ:zone},input:JSON.stringify({first,second}),encoding:'utf8'
  }));
}
if(process.argv.includes('--client')) {
  const input=JSON.parse(fs.readFileSync(0,'utf8'));
  let nodes=[],caption,html='';
  const events={};
  const container={
    get innerHTML(){return html;},
    set innerHTML(value){
      html=value;
      nodes=[...value.matchAll(/<time\b[^>]*datetime="([^"]+)"[^>]*>([^<]*)<\/time>/g)].map(([,dateTime,textContent])=>({dateTime,textContent,title:''}));
      caption=value.includes('id="timezone-label"')?{textContent:''}:null;
    },
    querySelectorAll(selector){assert.equal(selector,'time[datetime]');return nodes;},
    querySelector(selector){return selector==='#timezone-label'?caption:null;}
  };
  container.innerHTML=input.first;
  const document={
    getElementById:id=>id==='account-usage'?container:id==='timezone-label'?caption:null,
    querySelector:()=>null,activeElement:null,hidden:false,
    addEventListener:(name,handler)=>{events['document:'+name]=handler;}
  };
  const context={document,Intl,Date,
    acquireVsCodeApi:()=>({getState:()=>null,setState:()=>{},postMessage:()=>{}}),
    window:{scrollY:0,scrollTo:()=>{},addEventListener:(name,handler)=>{events[name]=handler;}},
    setInterval:()=>0
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../media/account-usage.js'),'utf8'),context);
  const snapshot=()=>({times:nodes.map(n=>n.textContent),caption:caption?.textContent});
  const first=snapshot();
  events.message({data:{type:'render',html:input.second}});
  const second=snapshot();
  process.env.TZ='UTC';
  events.focus?.();
  process.stdout.write(JSON.stringify({first,second,afterTimezoneChange:snapshot()}));
} else {
  test('client timezone controls initial card and updates across daylight-saving offsets',()=>{
    const winter=markup('2026-01-01T01:15:00Z');
    const summer=markup('2026-07-01T01:15:00Z');
    const result=viewInTimezone('America/New_York',winter,summer);
    assert.deepEqual(result.first.times,['31/12/2025 20:15','31/12/2025 20:15','31/12/2025 20:15']);
    assert.equal(result.first.caption,'All times America/New_York');
    assert.deepEqual(result.second.times,['30/06/2026 21:15','30/06/2026 21:15','30/06/2026 21:15']);
    assert.equal(result.second.caption,'All times America/New_York');
    assert.deepEqual(result.afterTimezoneChange.times,['01/07/2026 01:15','01/07/2026 01:15','01/07/2026 01:15']);
    assert.equal(result.afterTimezoneChange.caption,'All times UTC');
  });
  test('fractional-offset client zone formats every date and keeps missing dates unreported',()=>{
    const html=markup('2026-01-01T01:15:00Z');
    const result=viewInTimezone('Asia/Kathmandu',html,html);
    assert.deepEqual(result.first.times,['01/01/2026 07:00','01/01/2026 07:00','01/01/2026 07:00']);
    assert.match(result.first.caption,/^All times Asia\/Kat(h)?mandu$/);
    assert.match(html,/<dt>Provider time<\/dt><dd>Not reported<\/dd>/);
  });
}
