'use strict';
const fs=require('node:fs/promises');
const {constants}=require('node:fs');
const {randomUUID}=require('node:crypto');
const {validatePublicConnection,publicPath}=require('./connection.cjs');
const MAX_BYTES=32768;
const directoryMode=mode=>[0o700,0o750,0o2700,0o2750].includes(mode&0o7777);
async function openDirectory(directory,io) {
  if(!publicPath(directory))throw new Error('invalid-feed-directory');
  const before=await io.lstat(directory);
  if(!before.isDirectory() || !directoryMode(before.mode) || await io.realpath(directory)!==directory)throw new Error('unsafe-feed-directory');
  const handle=await io.open(directory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try {
    const pinned=await handle.stat();
    if(!pinned.isDirectory() || pinned.ino!==before.ino || pinned.dev!==before.dev || pinned.uid!==before.uid ||
      !directoryMode(pinned.mode) || await io.realpath(directory)!==directory)throw new Error('changed-feed-directory');
    return {handle,uid:pinned.uid,anchor:`/proc/self/fd/${handle.fd}`};
  } catch(error) {await handle.close();throw error;}
}
async function readConnectionFeeds(directories,{fs:io=fs}={}) {
  const connections=[];let rejected=0;
  if(!Array.isArray(directories))return {connections,rejected:1};
  for(const input of [...new Set(directories)].slice(0,128)) {
    let directory,file;
    try {
      directory=await openDirectory(input,io);
      file=await io.open(`${directory.anchor}/.connection.json`,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      const st=await file.stat();
      if(!st.isFile() || st.nlink!==1 || st.uid!==directory.uid || ((st.mode&0o7777)&~0o640) || st.size>MAX_BYTES)throw new Error('unsafe-descriptor');
      const bytes=Buffer.alloc(MAX_BYTES+1),{bytesRead}=await file.read(bytes,0,bytes.length,0);
      if(bytesRead>MAX_BYTES)throw new Error('large-descriptor');
      const value=JSON.parse(bytes.toString('utf8',0,bytesRead));
      if(!validatePublicConnection(value)||value.uid!==directory.uid||value.reportDir!==input)throw new Error('invalid-descriptor');
      connections.push(value);
    } catch {rejected++;} finally {await file?.close();await directory?.handle.close();}
  }
  if(directories.length>128)rejected++;
  return {connections,rejected};
}
async function checkConnectionFeed(directory,id,{fs:io=fs}={}) {
  const opened=await openDirectory(directory,io);
  try {
    try {await io.lstat(`${opened.anchor}/.connection.json`);}catch(error) {if(error.code==='ENOENT')return false;throw error;}
    const read=await readConnectionFeeds([directory],{fs:io});
    if(read.rejected || read.connections.length!==1 || read.connections[0].id!==id)throw new Error('feed-already-claimed-or-unverifiable');
    return true;
  } finally {await opened.handle.close();}
}
async function writeConnectionFeed(directory,connection,{fs:io=fs,uid=()=>process.getuid()}={}) {
  if(!validatePublicConnection(connection)||connection.reportDir!==directory)throw new Error('invalid-descriptor');
  const bytes=Buffer.from(JSON.stringify(connection)+'\n');
  if(bytes.length>MAX_BYTES)throw new Error('large-descriptor');
  const opened=await openDirectory(directory,io);
  let temporary,handle;
  try {
    if(opened.uid!==connection.uid||opened.uid!==uid())throw new Error('wrong-feed-owner');
    await checkConnectionFeed(directory,connection.id,{fs:io});
    temporary=`${opened.anchor}/.connection-${randomUUID()}.tmp`;
    handle=await io.open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o640);
    await handle.chmod(0o640);await handle.writeFile(bytes);await handle.sync();await handle.close();handle=null;
    // Initial publication is exclusive: simultaneous connections cannot claim
    // the same feed. An existing descriptor is replaced only for the same ID.
    try {await io.link(temporary,`${opened.anchor}/.connection.json`);}
    catch(error) {
      if(error.code!=='EEXIST')throw error;
      await checkConnectionFeed(directory,connection.id,{fs:io});
      await io.rename(temporary,`${opened.anchor}/.connection.json`);
    }
  } finally {
    await handle?.close();
    if(temporary)await io.unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});
    await opened.handle.close();
  }
}
module.exports={readConnectionFeeds,writeConnectionFeed,checkConnectionFeed};
