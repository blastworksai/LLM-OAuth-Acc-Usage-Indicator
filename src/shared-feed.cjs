'use strict';
// Root-side argv builders for the shared feed and the root-staged setup bundle.
// Pure: nothing here runs a command. The host hands each argv to elevate.run.
const fs=require('node:fs/promises');
const {constants}=require('node:fs');
const path=require('node:path');
const {publicPath}=require('./connection.cjs');
const ROOT='/var/lib/llm-account-usage',FEEDS=ROOT+'/feeds',BUNDLES=ROOT+'/bundles';
const INSTALL='/usr/bin/install',RMDIR='/usr/bin/rmdir',RM='/usr/bin/rm';
const CONNECTION_ID=/^v2-[a-f0-9]{32}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BUNDLE_FILE=/^(src|collectors)\/[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const refuse=code=>Object.assign(new Error('Invalid shared feed argument.'),{code});
const id=value=>{if(typeof value!=='string'||!CONNECTION_ID.test(value))throw refuse('INVALID_CONNECTION_ID');return value;};
const uuid=value=>{if(typeof value!=='string'||!UUID.test(value))throw refuse('INVALID_BUNDLE_ID');return value;};
const numeric=(value,code)=>{if(!Number.isSafeInteger(value)||value<0||value>0xfffffffe)throw refuse(code);return String(value);};
const feedPath=connectionId=>`${FEEDS}/${id(connectionId)}`;
const bundlePath=bundleId=>`${BUNDLES}/${uuid(bundleId)}`;
const ensureRootsArgv=()=>[INSTALL,'-d','-m','0755','-o','root','-g','root',ROOT,FEEDS,BUNDLES];
const createFeedArgv=({connectionId,uid,gid}={})=>{
  const target=feedPath(connectionId);
  return [INSTALL,'-d','-m','2750','-o',numeric(uid,'INVALID_UID'),'-g',numeric(gid,'INVALID_GID'),target];
};
// rmdir refuses a non-empty folder, so root never deletes target-owned content.
const removeFeedArgv=connectionId=>[RMDIR,'--',feedPath(connectionId)];
// files: the bundle manifest as relative names ('src/setup-cli.cjs'), the same list handoff.cjs stages.
function stageBundleArgv({bundleId,files,extensionPath}={}) {
  const bundle=bundlePath(bundleId);
  if(!publicPath(extensionPath))throw refuse('INVALID_EXTENSION_PATH');
  if(!Array.isArray(files)||!files.length||files.length>64||new Set(files).size!==files.length||
    !files.every(name=>typeof name==='string'&&BUNDLE_FILE.test(name)&&!name.includes('..')))throw refuse('INVALID_BUNDLE_MANIFEST');
  return [[INSTALL,'-d','-m','0755','-o','root','-g','root',bundle,`${bundle}/src`,`${bundle}/collectors`],
    ...files.map(name=>{
      const source=path.join(extensionPath,name),dest=`${bundle}/${name}`;
      if(!publicPath(source)||!source.startsWith(extensionPath+'/')||path.dirname(path.dirname(dest))!==bundle)throw refuse('INVALID_BUNDLE_MANIFEST');
      return [INSTALL,'-m',name.startsWith('collectors/')?'0444':'0555','-o','root','-g','root',source,dest];
    })];
}
// rm -r only ever reaches a root-owned tree under BUNDLES.
const removeBundleArgv=bundleId=>[RM,'-r','--',bundlePath(bundleId)];
async function inspectFeed(target,{fs:io=fs}={}) {
  if(!publicPath(target))throw refuse('INVALID_FEED_PATH');
  let info;
  try {info=await io.lstat(target);}
  catch(error) {if(error.code==='ENOENT')return {exists:false};throw error;}
  return {exists:true,directory:info.isDirectory(),uid:info.uid,gid:info.gid,mode:info.mode&0o7777};
}
// Proves the running host can list the folder through its group before the target is touched.
async function precheckReadable(target,{fs:io=fs}={}) {
  if(!publicPath(target))return false;
  let handle;
  try {
    const before=await io.lstat(target);
    if(!before.isDirectory())return false;
    handle=await io.open(target,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
    const pinned=await handle.stat();
    if(!pinned.isDirectory()||pinned.ino!==before.ino||pinned.dev!==before.dev||pinned.uid!==before.uid)return false;
    await io.readdir(`/proc/self/fd/${handle.fd}`);
    return true;
  } catch {return false;} finally {await handle?.close();}
}
module.exports={ROOT,FEEDS,BUNDLES,feedPath,bundlePath,ensureRootsArgv,createFeedArgv,removeFeedArgv,stageBundleArgv,removeBundleArgv,
  inspectFeed,precheckReadable};
