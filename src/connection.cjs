'use strict';
const path=require('node:path');
const {createHash}=require('node:crypto');
const PROVIDERS=new Set(['claude','codex','antigravity']);
const publicKeys=['id','provider','uid','profilePath','settingsPath','connected','cliLookupPath','reportDir','launcherPath','backupPath','runtimeVersion'];
const publicPath=value=>typeof value==='string' && value.length<=4096 && path.isAbsolute(value) &&
  path.resolve(value)===value && !/[\x00-\x1f\x7f]/.test(value);
function runtimeVersion(value) {
  if(typeof value!=='string'||value.length>128||/[\x00-\x20\x7f]/.test(value))return false;
  const match=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  return !!match && (!match[4] || match[4].split('.').every(part=>!/^0\d+$/.test(part)));
}
function validatePublicConnection(value) {
  if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).length!==publicKeys.length ||
    !publicKeys.every(key=>Object.hasOwn(value,key)) || !runtimeVersion(value.runtimeVersion) || typeof value.connected!=='boolean')return false;
  if(!['profilePath','settingsPath','cliLookupPath','reportDir','launcherPath','backupPath'].every(key=>publicPath(value[key])))return false;
  try {return connectionIdentity(value).id===value.id && value.settingsPath===path.join(value.profilePath,value.provider==='codex'?'hooks.json':'settings.json');}
  catch {return false;}
}

function connectionIdentity({provider,uid,settingsPath}) {
  if(!PROVIDERS.has(provider) || !Number.isSafeInteger(uid) || uid<0 ||
    typeof settingsPath!=='string' || !path.isAbsolute(settingsPath))throw new TypeError('invalid-connection-identity');
  const canonical=path.resolve(settingsPath);
  const digest=createHash('sha256').update(JSON.stringify(['profile-v2',provider,uid,canonical])).digest('hex').slice(0,32);
  return {id:`v2-${digest}`,provider,uid,settingsPath:canonical};
}
function sameProcess(a,b) {
  return !!a&&!!b&&['pid','uid','start_ticks','boot_id'].every(key=>a[key]===b[key]);
}
function connectionForTarget(connections,target) {
  if(!target || !Array.isArray(connections))return null;
  const matches=connections.filter(value=>value?.provider===target.provider &&
    value.uid===target.process?.uid && sameProcess(value.pendingProcess,target.process));
  return matches.length===1?matches[0]:null;
}
module.exports={connectionIdentity,sameProcess,connectionForTarget,validatePublicConnection,publicPath,runtimeVersion};
