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
    !publicPath(target?.cliPath)||!Number.isSafeInteger(target?.process?.uid)||target.process.uid<0||
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
  const verify=revalidate||(()=>require('./provider.cjs').detectProvider(target.terminalPid||target.process.pid));
  const root=await io.mkdtemp(path.join(tempRoot,'llm-account-usage-'));
  let drop,disposed=false;
  const identity=await io.lstat(root);
  async function dispose() {
    if(disposed)return;disposed=true;
    await drop?.close();drop=null;
    const current=await io.lstat(root).catch(error=>{if(error.code!=='ENOENT')throw error;});
    if(current && current.isDirectory() && current.ino===identity.ino && current.dev===identity.dev && current.uid===identity.uid)
      await io.rm(root,{recursive:true,force:true});
  }
  try {
    await io.chmod(root,0o755);
    for(const name of ['src','collectors']) {await io.mkdir(path.join(root,name),{mode:0o755});await io.chmod(path.join(root,name),0o755);}
    for(const name of ['src/setup-cli.cjs','src/setup.cjs','src/connection.cjs','src/connection-feed.cjs','collectors/passive.cjs']) {
      const source=path.join(extensionPath,name),info=await io.lstat(source);
      if(!info.isFile()||info.size>1024*1024)throw invalid();
      await io.copyFile(source,path.join(root,name),constants.COPYFILE_EXCL);
      await io.chmod(path.join(root,name),name.startsWith('collectors/')?0o444:0o555);
    }
    const dropPath=path.join(root,'results');await io.mkdir(dropPath,{mode:0o1733});await io.chmod(dropPath,0o1733);
    drop=await io.open(dropPath,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
    const filename=`${randomUUID()}.json`,resultPath=path.join(dropPath,filename);
    const args=action==='connect'?['--provider',provider,'--cli',target.cliPath,'--result',resultPath,'--runtime-version',runtimeVersion,
      ...(profilePath?['--profile',profilePath]:[]),...(reportDir?['--report-dir',reportDir]:[])]:['--connection-id',connectionId,'--result',resultPath];
    const command=`node ${quote(path.join(root,'src/setup-cli.cjs'))} ${action} `+args.map((value,index)=>index%2?quote(value):value).join(' ');
    async function readResult() {
      if(disposed)throw invalid();
      let file;
      try {
        try {file=await io.open(`/proc/self/fd/${drop.fd}/${filename}`,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}
        catch(error) {if(error.code==='ENOENT'&&!disposed)return null;throw error;}
        const st=await file.stat();
        if(!st.isFile()||st.nlink!==1||st.uid!==expected.process.uid||((st.mode&0o7777)&~0o644)||st.size>32768)throw invalid();
        const bytes=Buffer.alloc(32769),{bytesRead}=await file.read(bytes,0,bytes.length,0);
        if(bytesRead>32768)throw invalid();
        const result=JSON.parse(bytes.toString('utf8',0,bytesRead));
        if(!result||typeof result!=='object'||Array.isArray(result))throw invalid();
        if(result.ok===true) {
          const connection=result.connection;
          if(Object.keys(result).length!==2||!validatePublicConnection(connection)||connection.provider!==provider||
            connection.uid!==expected.process.uid||connection.connected!==(action==='connect')||
            (action==='connect'&&(connection.runtimeVersion!==runtimeVersion || connection.cliLookupPath!==expected.cliPath))||
            (action==='disconnect'&&connection.id!==connectionId)||
            (profilePath&&connection.profilePath!==profilePath)||(reportDir&&connection.reportDir!==reportDir))throw invalid();
        } else if(result.ok!==false||Object.keys(result).length!==3||!['CANCELLED','SETUP_FAILED'].includes(result.code)||
          typeof result.message!=='string'||result.message.length>512||/[\x00-\x1f\x7f]/.test(result.message))throw invalid();
        const current=await verify();
        if(disposed||!current||current.provider!==expected.provider||current.cliPath!==expected.cliPath||!sameProcess(current.process,expected.process))throw invalid();
        return result.ok?result:{ok:false,code:result.code,message:result.code==='CANCELLED'?'Setup cancelled.':'Target-user setup could not finish.'};
      } catch {throw invalid();}
      finally {await file?.close();}
    }
    return {root,command,resultPath,readResult,dispose};
  } catch(error) {await dispose();throw error;}
}
module.exports={prepareHandoff};
