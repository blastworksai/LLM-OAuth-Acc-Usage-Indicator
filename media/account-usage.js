'use strict';
const vscode=acquireVsCodeApi();
const container=document.getElementById('account-usage');
let html=container.innerHTML;
function localizeTimes() {
  // This script runs in VS Code's local UI, even with a remote extension host.
  // Recreate the formatter so a changed OS timezone is picked up on focus/update.
  const clock=new Intl.DateTimeFormat('en-GB',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:false});
  for(const node of container.querySelectorAll('time[datetime]')) {
    const date=new Date(node.dateTime);
    if(!Number.isFinite(date.getTime())){node.textContent='Not reported';continue;}
    const p=Object.fromEntries(clock.formatToParts(date).map(part=>[part.type,part.value]));
    node.textContent=`${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
    node.title=node.textContent;
  }
  const caption=document.getElementById('timezone-label');
  const zone=clock.resolvedOptions().timeZone;
  if(caption)caption.textContent=zone?`All times ${zone}`:'All times local to this computer';
}
localizeTimes();
window.addEventListener('focus',localizeTimes);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)localizeTimes();});
function restoreDetails(open) { const details=document.getElementById('report-details');if(details)details.open=!!open; }
restoreDetails(vscode.getState()?.detailsOpen);
document.addEventListener('toggle',event=> {
  if(event.target.id==='report-details')vscode.setState({detailsOpen:event.target.open});
},true);
document.addEventListener('click',event=> {
  if(event.target?.closest?.('button[data-action="connect"]'))vscode.postMessage({type:'connect'});
});
window.addEventListener('message',event=> {
  if(event.data?.type!=='render' || typeof event.data.html!=='string' || event.data.html===html)return;
  const open=document.getElementById('report-details')?.open;
  const summaryFocused=document.activeElement?.matches('#report-details > summary');
  const connectFocused=document.activeElement?.matches('button[data-action="connect"]');
  const position=window.scrollY;
  // Only escaped, allowlisted presentation markup arrives from the extension.
  html=event.data.html;container.innerHTML=html;
  localizeTimes();
  restoreDetails(open ?? vscode.getState()?.detailsOpen);
  if(summaryFocused)document.querySelector('#report-details > summary')?.focus({preventScroll:true});
  if(connectFocused)container.querySelector('button[data-action="connect"]')?.focus({preventScroll:true});
  window.scrollTo(0,position);
});
vscode.postMessage({type:'ready'});
