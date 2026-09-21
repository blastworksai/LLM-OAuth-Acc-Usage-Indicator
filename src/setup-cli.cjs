'use strict';
const fs=require('node:fs/promises');
const {constants}=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {publicPath:absolute,runtimeVersion:version}=require('./connection.cjs');
function parse(argv) {
  if(!Array.isArray(argv)||argv.length>15)throw new Error('arguments');
  const [action,...args]=argv,allowed=action==='connect'?['provider','cli','result','profile','report-dir','runtime-version']:
    action==='disconnect'?['connection-id','result']:[];
  if(!allowed.length || args.length%2)throw new Error('arguments');
  const values={action};
  for(let i=0;i<args.length;i+=2) {
    const key=typeof args[i]==='string'?args[i].slice(2):'';
    if(!args[i]?.startsWith('--')||!allowed.includes(key)||Object.hasOwn(values,key)||typeof args[i+1]!=='string'||args[i+1].length>4096)throw new Error('arguments');
    values[key]=args[i+1];
  }
  if(!absolute(values.result))throw new Error('arguments');
  if(action==='connect') {
    if(!['claude','codex','antigravity'].includes(values.provider)||!absolute(values.cli)||!version(values['runtime-version']))throw new Error('arguments');
    for(const key of ['profile','report-dir'])if(Object.hasOwn(values,key)&&!absolute(values[key]))throw new Error('arguments');
  } else if(!/^v2-[a-f0-9]{32}$/.test(values['connection-id']||''))throw new Error('arguments');
  return values;
}
async function writeResult(file,result,io=fs) {
  const bytes=Buffer.from(JSON.stringify(result)+'\n');
  if(bytes.length>32768)throw new Error('result-too-large');
  const handle=await io.open(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o644);
  try {await handle.chmod(0o644);await handle.writeFile(bytes);await handle.sync();}finally {await handle.close();}
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
    let preview;
    if(args.action==='connect') {
      Object.assign(options,{provider:args.provider,cliPath:args.cli,...(args.profile?{profilePath:args.profile}:{})});
      preview=await setup.discoverProvider(options);
    } else {
      const sharedDirectoryReview=new Map();
      preview=(await setup.listDisconnectConnections({...options,sharedDirectoryReview})).find(value=>value.id===args['connection-id'] && value.uid===uid);
      if(!preview)throw new Error('connection-not-found');
      preview={...preview,sharedDirectories:[...sharedDirectoryReview.values()]};
      options.connectionId=preview.id;
    }
    print(`Target UID ${uid}; ${args.action} ${preview.provider||args.provider}.\nProfile: ${preview.profilePath}`);
    if(args.action==='connect') {
      options.reportDir=args['report-dir']||path.join(homeDir,'.llm-account-usage-feeds',preview.id);
      print(`Report directory: ${options.reportDir}`);
    }
    print('Only this user’s selected provider configuration and sanitized usage feed will change. No provider process is restarted.');
    for(const item of preview.sharedDirectories||[])print(`${item.kind}: ${item.path} (owner UID ${item.uid}, group GID ${item.gid}, mode ${(item.mode&0o7777).toString(8)})`);
    if(preview.sharedDirectories?.length)print('Continuing trusts the listed owners and everyone who can write through these groups.');
    if((await (dependencies.readConsent||consent)())!=='yes') {
      await publish(args.result,{ok:false,code:'CANCELLED',message:'Setup cancelled.'});return {code:1};
    }
    options.trustedDirectories=preview.sharedDirectories||[];
    let result;
    if(args.action==='connect') {
      await (dependencies.ensureReportDirectory||setup.ensureReportDirectory)(options.reportDir,{...options,create:!args['report-dir']});
      await (dependencies.checkConnectionFeed||require('./connection-feed.cjs').checkConnectionFeed)(options.reportDir,preview.id);
      result=await setup.connectProvider(options);
    } else result=await setup.disconnectProvider(options);
    const connection={};
    for(const key of ['id','provider','uid','profilePath','settingsPath','connected','cliLookupPath','reportDir','launcherPath','backupPath'])connection[key]=result[key];
    connection.runtimeVersion=args['runtime-version']||preview.runtimeVersion||'0.0.0';
    await (dependencies.writeConnectionFeed||require('./connection-feed.cjs').writeConnectionFeed)(connection.reportDir,connection);
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
