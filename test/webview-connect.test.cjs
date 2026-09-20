'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

// Run the shipped webview script against its DOM/message boundary. Rendering
// replaces the button object, as a live terminal switch replaces the card.
function openCard() {
 const events={},messages=[];
 let button,html='';
 const document={activeElement:null,hidden:false,
  addEventListener:(name,handler)=>{events[`document:${name}`]=handler;},
  getElementById:id=>id==='account-usage'?container:null,
  querySelector:selector=>container.querySelector(selector)
 };
 const selector='button[data-action="connect"]';
 const container={
  get innerHTML(){return html;},
  set innerHTML(value){
   html=value;
   button={matches:query=>query===selector,closest:query=>query===selector?button:null,
    focus:()=>{document.activeElement=button;}};
  },
  querySelectorAll:()=>[],
  querySelector:query=>query===selector?button:null
 };
 container.innerHTML='<button type="button" data-action="connect">Connect Provider</button>';
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../media/account-usage.js'),'utf8'),{
  document,Intl,Date,
  window:{scrollY:0,scrollTo:()=>{},addEventListener:(name,handler)=>{events[name]=handler;}},
  acquireVsCodeApi:()=>({getState:()=>null,setState:()=>{},postMessage:message=>messages.push(JSON.parse(JSON.stringify(message)))})
 });
 return {events,messages,document,get button(){return button;}};
}

test('Connect Provider sends one setup request and remains usable after card replacement',()=>{
 const card=openCard();
 card.events['document:click']?.({target:card.button});
 assert.deepEqual(card.messages,[{type:'ready'},{type:'connect'}]);
 const original=card.button;
 card.events.message({data:{type:'render',html:'<article>Updated account</article><button type="button" data-action="connect">Connect Provider</button>'}});
 assert.notEqual(card.button,original);
 card.events['document:click']?.({target:card.button});
 card.events['document:click']?.({target:{closest:()=>null}});
 assert.deepEqual(card.messages,[{type:'ready'},{type:'connect'},{type:'connect'}]);
});

test('a live quota refresh keeps keyboard focus on Connect Provider',()=>{
 const card=openCard();
 card.button.focus();
 card.events.message({data:{type:'render',html:'<article>New quota</article><button type="button" data-action="connect">Connect Provider</button>'}});
 assert.equal(card.document.activeElement,card.button);
 assert.deepEqual(card.messages,[{type:'ready'}]);
});
