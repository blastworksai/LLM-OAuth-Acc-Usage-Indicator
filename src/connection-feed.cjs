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
// Called only while setup holds the exact-ID claim lock. The capability expires
// before that lock is released. The private slot is never a public-temp scan.
async function withClaimedFeedPublication(directory,id,{fs:io=fs,uid,controlHandle},operation) {
  const opened=await openDirectory(directory,io);
  let active=true;
  const same=(a,b)=>a&&b&&a.ino===b.ino&&a.dev===b.dev;
  const missing=error=>{if(error.code!=='ENOENT')throw error;return null;};
  try {
    const control={anchor:`/proc/self/fd/${controlHandle.fd}`},held=await controlHandle.stat(),current=await io.lstat(`${opened.anchor}/.connection-control`);
    if(!same(held,current)||!held.isDirectory()||!current.isDirectory()||opened.uid!==uid||held.uid!==uid||current.uid!==uid||
      ![0o700,0o2700].includes(held.mode&0o7777)||![0o700,0o2700].includes(current.mode&0o7777))throw new Error('unsafe-publication-control');
    const slot=`${control.anchor}/.connection-publication.json`,destination=`${opened.anchor}/.connection.json`;
    async function read(file,{claim=false,links=[1]}={}) {
      const handle=await io.open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK).catch(missing);
      if(!handle)return null;
      try {
        const st=await handle.stat(),limit=claim?512:MAX_BYTES;
        if(!st.isFile()||st.uid!==uid||!links.includes(st.nlink)||(st.mode&0o7777)!==(claim?0o600:0o640)||st.size>limit)
          throw new Error('unsafe-publication-file');
        const bytes=Buffer.alloc(limit+1),{bytesRead}=await handle.read(bytes,0,bytes.length,0);
        if(bytesRead>limit)throw new Error('large-publication-file');
        const value=JSON.parse(bytes.toString('utf8',0,bytesRead));
        if(claim?(!value||Object.keys(value).length!==1||value.connectionId!==id):
          (!validatePublicConnection(value)||value.id!==id||value.uid!==uid||value.reportDir!==directory))throw new Error('wrong-publication-identity');
        const current=await io.lstat(file);
        if(!same(st,current)||current.nlink!==st.nlink)throw new Error('changed-publication-file');
        return {st,value};
      } finally {await handle.close();}
    }
    async function recover() {
      const prepared=await read(slot,{links:[1,2]});
      if(!prepared)return;
      const published=await read(destination,{links:[1,2]});
      if(same(prepared.st,published?.st)) {
        // Exactly two links, both pinned and proven to name the private staged
        // descriptor. Any third/arbitrary link fails closed, without deletion.
        if(prepared.st.nlink!==2||published.st.nlink!==2)throw new Error('unexpected-publication-links');
      } else if(prepared.st.nlink!==1 || (published&&published.st.nlink!==1))throw new Error('unexpected-publication-links');
      const current=await io.lstat(slot);
      if(!same(current,prepared.st)||current.nlink!==prepared.st.nlink)throw new Error('changed-publication-slot');
      await io.unlink(slot);
      if(published)await read(destination);
    }
    if(!await read(`${control.anchor}/claim.json`,{claim:true}))throw new Error('missing-publication-claim');
    await recover();
    await checkConnectionFeed(directory,id,{fs:io});
    return await operation(async connection=>{
      if(!active||!validatePublicConnection(connection)||connection.id!==id||connection.uid!==uid||connection.reportDir!==directory)
        throw new Error('invalid-publication-capability');
      await recover();
      await checkConnectionFeed(directory,id,{fs:io});
      const bytes=Buffer.from(JSON.stringify(connection)+'\n');
      if(bytes.length>MAX_BYTES)throw new Error('large-descriptor');
      const handle=await io.open(slot,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o640);
      try {await handle.chmod(0o640);await handle.writeFile(bytes);await handle.sync();}finally {await handle.close();}
      try {await io.link(slot,destination);}
      catch(error) {
        if(error.code!=='EEXIST')throw error;
        await checkConnectionFeed(directory,id,{fs:io});
        await io.rename(slot,destination);
      }
      // Leave this exact private recovery slot intact if publication is
      // interrupted. The next same-ID claim verifies it before any hook edit.
      await recover();
    });
  } finally {active=false;await opened.handle.close();}
}
async function writeConnectionFeed(directory,connection,{fs:io=fs,uid=()=>process.getuid(),publication}={}) {
  if(!validatePublicConnection(connection)||connection.reportDir!==directory)throw new Error('invalid-descriptor');
  if(publication)return publication(connection);
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
module.exports={readConnectionFeeds,writeConnectionFeed,checkConnectionFeed,withClaimedFeedPublication};
