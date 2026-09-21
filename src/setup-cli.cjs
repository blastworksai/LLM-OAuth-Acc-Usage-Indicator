'use strict';
const fs=require('node:fs/promises');
const {constants}=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {publicPath:absolute,runtimeVersion:version}=require('./connection.cjs');
function parse(argv) {
  if(!Array.isArray(argv)||argv.length>17)throw new Error('arguments');
  const [action,...args]=argv,allowed=action==='connect'?['provider','cli','result','profile','report-dir','runtime-version','target']:
    action==='disconnect'?['connection-id','result','target']:[];
  if(!allowed.length || args.length%2)throw new Error('arguments');
  const values={action};
  for(let i=0;i<args.length;i+=2) {
    const key=typeof args[i]==='string'?args[i].slice(2):'';
    if(!args[i]?.startsWith('--')||!allowed.includes(key)||Object.hasOwn(values,key)||typeof args[i+1]!=='string'||args[i+1].length>4096)throw new Error('arguments');
    values[key]=args[i+1];
  }
  if(!absolute(values.result))throw new Error('arguments');
  if(Object.hasOwn(values,'target')) {
    const target=JSON.parse(values.target),p=target?.process;
    if(!target||Object.keys(target).length!==2||!['claude','codex','antigravity'].includes(target.provider)||!p||
      Object.keys(p).length!==4||!['pid','uid','start_ticks','boot_id'].every(key=>Object.hasOwn(p,key))||
      !Number.isSafeInteger(p.pid)||p.pid<=0||!Number.isSafeInteger(p.uid)||p.uid<0||!/^\d{1,30}$/.test(p.start_ticks)||
      typeof p.start_ticks!=='string'||typeof p.boot_id!=='string'||!p.boot_id.length||p.boot_id.length>128||/[\x00-\x1f\x7f]/.test(p.boot_id))throw new Error('arguments');
    values.target=target;
  }
  if(action==='connect') {
    if(!['claude','codex','antigravity'].includes(values.provider)||
      (values.target?(values.target.provider!==values.provider||(Object.hasOwn(values,'cli')&&!absolute(values.cli))):!absolute(values.cli))||!version(values['runtime-version']))throw new Error('arguments');
    for(const key of ['profile','report-dir'])if(Object.hasOwn(values,key)&&!absolute(values[key]))throw new Error('arguments');
  } else if(!/^v2-[a-f0-9]{32}$/.test(values['connection-id']||''))throw new Error('arguments');
  return values;
}
async function writeResult(file,result,io=fs) {
  const bytes=Buffer.from(JSON.stringify(result)+'\n');
  if(bytes.length>32768)throw new Error('result-too-large');
  // Linux O_PATH pins a write/execute-only (1733) dropbox without requiring
  // directory listing permission. Both publication and cleanup use this anchor.
  const directory=await io.open(path.dirname(file),0x200000|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  const anchor=`/proc/self/fd/${directory.fd}`,temporary=`${anchor}/.result-${randomUUID()}.tmp`;
  let handle;
  try {
    handle=await io.open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    await handle.writeFile(bytes);await handle.chmod(0o644);await handle.sync();await handle.close();handle=null;
    // link is atomic and exclusive: only completed JSON appears, and an
    // existing nonce can never be overwritten. Readers wait for nlink==1.
    await io.link(temporary,`${anchor}/${path.basename(file)}`);
  } finally {
    await handle?.close();
    try {await io.unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
    finally {await directory.close();}
  }
}
async function consent() {
  if(!process.stdin.isTTY)return null;
  const reader=require('node:readline').createInterface({input:process.stdin,output:process.stdout});
  try {return await new Promise(resolve=>{reader.once('close',()=>resolve(null));reader.question('Type yes to continue: ',resolve);});}
  finally {reader.close();}
}
async function run(argv,dependencies={}) {
  let args;
  const print=dependencies.print||console.log;
  try {args=parse(argv);}catch {print('Invalid setup arguments. Use explicit absolute paths and a supported provider.');return {code:2};}
  const setup=dependencies.setup||require('./setup.cjs');
  const homeDir=(dependencies.home||os.homedir)(),uid=(dependencies.uid||(()=>process.getuid()))();
  const options={homeDir,uid,env:dependencies.env||process.env,nodePath:dependencies.nodePath||process.execPath,
    collectorPath:dependencies.collectorPath||path.join(__dirname,'../collectors/passive.cjs'),
    storagePath:path.join(homeDir,'.local/state/llm-account-usage/target-setup')};
  const publish=dependencies.writeResult||((file,result)=>writeResult(file,result,dependencies.fs||fs));
  try {
    const verify=async()=>{
      if(!args.target)return null;
      if(args.target.process.uid!==uid)throw new Error('wrong-target-user');
      const target={...args.target,...(args.cli?{cliPath:args.cli}:{})};
      const value=await (dependencies.verifyTargetProcess||require('./provider.cjs').verifyTargetProcess)(target,{uid,env:options.env,home:homeDir});
      if(!value||value.provider!==args.target.provider||!absolute(value.cliPath)||(args.cli&&value.cliPath!==args.cli)||
        !require('./connection.cjs').sameProcess(value.process,args.target.process))throw new Error('unverified-target-process');
      return value;
    };
    const verified=await verify();
    let preview;
    if(args.action==='connect') {
      Object.assign(options,{provider:args.provider,cliPath:verified?.cliPath||args.cli,sharedFeed:true,...(args.profile?{profilePath:args.profile}:{}),
        ...(args['report-dir']?{reportDir:args['report-dir']}:{})});
      preview=await setup.discoverProvider(options);
    } else {
      const sharedDirectoryReview=new Map();
      preview=(await setup.listDisconnectConnections({...options,sharedDirectoryReview,sharedFeed:true,includeDisconnected:true,
        connectionId:args['connection-id']})).find(value=>value.id===args['connection-id'] && value.uid===uid);
      if(!preview)throw new Error('connection-not-found');
      if(verified&&preview.provider!==verified.provider)throw new Error('wrong-target-provider');
      preview={...preview,sharedDirectories:[...sharedDirectoryReview.values()]};
      options.connectionId=preview.id;
    }
    print(`Target UID ${uid}; ${args.action} ${preview.provider||args.provider}.\nProfile: ${preview.profilePath}`);
    if(args.action==='connect') {
      options.reportDir=preview.reportDir||args['report-dir']||path.join(homeDir,'.llm-account-usage-feeds',preview.id);
    }
    print(`Report directory: ${options.reportDir||preview.reportDir}`);
    print('Only this user’s selected provider configuration and sanitized usage feed will change. No provider process is restarted.');
    for(const item of preview.sharedDirectories||[])print(`${item.kind}: ${item.path} (owner UID ${item.uid}, group GID ${item.gid}, mode ${(item.mode&0o7777).toString(8)})`);
    if(preview.sharedDirectories?.length)print('Continuing trusts the listed owners and everyone who can write through these groups.');
    if((await (dependencies.readConsent||consent)())!=='yes') {
      await publish(args.result,{ok:false,code:'CANCELLED',message:'Setup cancelled.'});return {code:1};
    }
    options.trustedDirectories=preview.sharedDirectories||[];
    if(verified && (await verify()).cliPath!==verified.cliPath)throw new Error('changed-target-executable');
    if(args.action==='disconnect')options.reportDir=preview.reportDir;
    await (dependencies.ensureReportDirectory||setup.ensureReportDirectory)(options.reportDir,{...options,
      create:args.action==='connect'&&(preview.createReportDirectory??!args['report-dir'])});
    const connection=await (dependencies.withReportFeedClaim||setup.withReportFeedClaim)(options.reportDir,preview.id,options,async publication=>{
      await (dependencies.checkConnectionFeed||require('./connection-feed.cjs').checkConnectionFeed)(options.reportDir,preview.id);
      const result=args.action==='connect'?await setup.connectProvider(options):await setup.disconnectProvider(options);
      const value={};
      for(const key of ['id','provider','uid','profilePath','settingsPath','connected','cliLookupPath','reportDir','launcherPath','backupPath'])value[key]=result[key];
      value.runtimeVersion=args['runtime-version']||preview.runtimeVersion||'0.0.0';
      await (dependencies.writeConnectionFeed||require('./connection-feed.cjs').writeConnectionFeed)(value.reportDir,value,{publication});
      return value;
    });
    await publish(args.result,{ok:true,connection});return {code:0};
  } catch {
    const result={ok:false,code:'SETUP_FAILED',message:'Target-user setup could not finish. Review the selected profile, executable and report-directory permissions.'};
    print(result.message);
    try {await publish(args.result,result);}catch {print('The setup result could not be written.');}
    return {code:1};
  }
}
if(require.main===module)run(process.argv.slice(2)).then(result=>{process.exitCode=result.code;}).catch(()=>{process.exitCode=1;});
module.exports={run,writeResult};
