'use strict';
const path=require('node:path');
const {createHash}=require('node:crypto');
const PROVIDERS=new Set(['claude','codex','antigravity']);

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
module.exports={connectionIdentity,sameProcess,connectionForTarget};
