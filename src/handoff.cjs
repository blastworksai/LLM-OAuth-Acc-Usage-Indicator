'use strict';
const fs=require('node:fs/promises');
const {constants}=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {randomUUID}=require('node:crypto');
const {sameProcess,validatePublicConnection,publicPath,runtimeVersion:validVersion}=require('./connection.cjs');
const quote=value=>"'"+value.replace(/'/g,"'\\''")+"'";
const invalid=()=>Object.assign(new Error('The target-user setup result could not be verified. Select its terminal and connect again.'),
  {code:'UNVERIFIED_SETUP_RESULT',safeToDisplay:true});
async function prepareHandoff({extensionPath,provider,target,action='connect',connectionId,tempRoot=os.tmpdir(),fs:io=fs,
  runtimeVersion,revalidate,profilePath,reportDir}) {
  if(!['claude','codex','antigravity'].includes(provider)||!['connect','disconnect'].includes(action)||!publicPath(extensionPath)||
    !(target?.cliPath===null||publicPath(target?.cliPath))||!Number.isSafeInteger(target?.process?.uid)||target.process.uid<0||
    !Number.isSafeInteger(target.process.pid)||target.process.pid<=0||!/^\d{1,30}$/.test(target.process.start_ticks||'')||
    typeof target.process.boot_id!=='string'||!target.process.boot_id.length||target.process.boot_id.length>128||
    /[\x00-\x1f\x7f]/.test(target.process.boot_id)||
    (action==='disconnect'&&!/^v2-[a-f0-9]{32}$/.test(connectionId||''))||
    (profilePath!==undefined&&!publicPath(profilePath))||(reportDir!==undefined&&!publicPath(reportDir)))throw invalid();
  const expected={provider,cliPath:target.cliPath,process:{...target.process}};
  if(action==='connect') {
    runtimeVersion=runtimeVersion??JSON.parse(await io.readFile(path.join(extensionPath,'package.json'),'utf8')).version;
    if(!validVersion(runtimeVersion))throw invalid();
  }
  const verify=revalidate||(()=>require('./provider.cjs').detectProvider(target.terminalPid||target.process.pid,{allowForeign:true,topologyOnly:target.cliPath===null}));
  const root=await io.mkdtemp(path.join(tempRoot,'llm-account-usage-'));
  let drop,disposed=false,cleanupResult;
  const rootHandle=await io.open(root,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  const rootAnchor=`/proc/self/fd/${rootHandle.fd}`,directories=new Map();
  const filename=`${randomUUID()}.json`;
  const manifest=['src/setup-cli.cjs','src/setup.cjs','src/connection.cjs','src/connection-feed.cjs','src/provider.cjs','src/core.cjs','collectors/passive.cjs'];
  const identity=await io.lstat(root);
  async function dispose() {
    if(disposed)return cleanupResult;disposed=true;
    let left=false;
    const attempt=async operation=>{try {await operation();}catch(error){if(error.code!=='ENOENT')left=true;}};
    const removeFile=async(handle,name,uid)=>attempt(async()=>{
      const file=`/proc/self/fd/${handle.fd}/${name}`,info=await io.lstat(file);
      if(!info.isFile()||info.uid!==uid||info.nlink!==1){left=true;return;}
      // unlink never follows the final component, even if it is swapped here.
      await io.unlink(file);
    });
    try {
      if(drop)await removeFile(drop,filename,expected.process.uid);
      for(const name of manifest) {
        const [directory,file]=name.split('/'),handle=directories.get(directory);
        if(handle)await removeFile(handle,file,identity.uid);
      }
      // Only known, empty directories may be removed. Unexpected entries are
      // neither enumerated nor traversed; ENOTEMPTY leaves them for the owner.
      for(const [name,handle] of directories) {
        await handle.close();await attempt(()=>io.rmdir(`${rootAnchor}/${name}`));
      }
      if(drop){await drop.close();drop=null;await attempt(()=>io.rmdir(`${rootAnchor}/results`));}
      const current=await io.lstat(root).catch(error=>{if(error.code!=='ENOENT')throw error;});
      if(current && current.isDirectory() && current.ino===identity.ino && current.dev===identity.dev && current.uid===identity.uid)
        await attempt(()=>io.rmdir(root));
      else if(current)left=true;
    } finally {await rootHandle.close();}
    cleanupResult=left?{removed:false,warning:'Unexpected entries in the setup bundle were left safely in place.'}:{removed:true};
    return cleanupResult;
  }
  try {
    await io.chmod(root,0o755);
    for(const name of ['src','collectors']) {
      await io.mkdir(`${rootAnchor}/${name}`,{mode:0o755});
      const handle=await io.open(`${rootAnchor}/${name}`,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
      directories.set(name,handle);await handle.chmod(0o755);
    }
    for(const name of manifest) {
      const source=path.join(extensionPath,name),info=await io.lstat(source);
      if(!info.isFile()||info.size>1024*1024)throw invalid();
      await io.copyFile(source,path.join(root,name),constants.COPYFILE_EXCL);
      await io.chmod(path.join(root,name),name.startsWith('collectors/')?0o444:0o555);
    }
    const dropPath=path.join(root,'results');await io.mkdir(dropPath,{mode:0o1733});await io.chmod(dropPath,0o1733);
    drop=await io.open(dropPath,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
    const resultPath=path.join(dropPath,filename);
    const args=action==='connect'?['--provider',provider,...(target.cliPath?['--cli',target.cliPath]:[]),'--result',resultPath,'--runtime-version',runtimeVersion,
      ...(profilePath?['--profile',profilePath]:[]),...(reportDir?['--report-dir',reportDir]:[])]:['--connection-id',connectionId,'--result',resultPath];
    if(action==='connect'||target.cliPath===null)args.push('--target',JSON.stringify({provider,process:target.process}));
    const command=`node ${quote(path.join(root,'src/setup-cli.cjs'))} ${action} `+args.map((value,index)=>index%2?quote(value):value).join(' ');
    async function readResult() {
      if(disposed)throw invalid();
      let file;
      try {
        try {file=await io.open(`/proc/self/fd/${drop.fd}/${filename}`,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}
        catch(error) {if(error.code==='ENOENT'&&!disposed)return null;throw error;}
        const st=await file.stat();
        if(!st.isFile()||st.uid!==expected.process.uid||((st.mode&0o7777)&~0o644)||st.size>32768)throw invalid();
        if(st.nlink===2)return null; // Completed publication is unlinking its temporary name.
        if(st.nlink!==1)throw invalid();
        const bytes=Buffer.alloc(32769),{bytesRead}=await file.read(bytes,0,bytes.length,0);
        if(bytesRead>32768)throw invalid();
        const result=JSON.parse(bytes.toString('utf8',0,bytesRead));
        if(!result||typeof result!=='object'||Array.isArray(result))throw invalid();
        if(result.ok===true) {
          const connection=result.connection;
          if(Object.keys(result).length!==2||!validatePublicConnection(connection)||connection.provider!==provider||
            connection.uid!==expected.process.uid||connection.connected!==(action==='connect')||
            (action==='connect'&&(connection.runtimeVersion!==runtimeVersion || (expected.cliPath!==null&&connection.cliLookupPath!==expected.cliPath)))||
            (action==='disconnect'&&connection.id!==connectionId)||
            (profilePath&&connection.profilePath!==profilePath)||(reportDir&&connection.reportDir!==reportDir))throw invalid();
        } else if(result.ok!==false||Object.keys(result).length!==3||!['CANCELLED','SETUP_FAILED'].includes(result.code)||
          typeof result.message!=='string'||result.message.length>512||/[\x00-\x1f\x7f]/.test(result.message))throw invalid();
        const current=await verify();
        if(disposed||!current||current.unavailable||current.provider!==(expected.cliPath===null?null:expected.provider)||
          current.cliPath!==expected.cliPath||!sameProcess(current.process,expected.process))throw invalid();
        return result.ok?result:{ok:false,code:result.code,message:result.code==='CANCELLED'?'Setup cancelled.':'Target-user setup could not finish.'};
      } catch {throw invalid();}
      finally {await file?.close();}
    }
    return {root,command,resultPath,readResult,dispose};
  } catch(error) {await dispose();throw error;}
}
module.exports={prepareHandoff};
