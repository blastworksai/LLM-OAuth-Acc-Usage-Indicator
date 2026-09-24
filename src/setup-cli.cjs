'use strict';
const fs=require('node:fs/promises');
const {constants}=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {publicPath:absolute,runtimeVersion:version}=require('./connection.cjs');
const KEYS={connect:['provider','cli','result','profile','report-dir','runtime-version','target','consent'],
  discover:['provider','cli','profile','report-dir','target','result'],
  disconnect:['connection-id','result','target','consent','remove-feed']};
// Hard cap: the action plus one flag/value pair per key of the widest action.
const MAX_ARGV=1+2*Math.max(...Object.values(KEYS).map(keys=>keys.length));
function parse(argv) {
  if(!Array.isArray(argv)||argv.length>MAX_ARGV)throw new Error('arguments');
  const [action,...args]=argv,allowed=typeof action==='string'&&Object.hasOwn(KEYS,action)?KEYS[action]:[];
  if(!allowed.length || args.length%2 || args.length>2*allowed.length)throw new Error('arguments');
  const values={action};
  for(let i=0;i<args.length;i+=2) {
    const key=typeof args[i]==='string'?args[i].slice(2):'';
    if(!args[i]?.startsWith('--')||!allowed.includes(key)||Object.hasOwn(values,key)||typeof args[i+1]!=='string'||args[i+1].length>4096)throw new Error('arguments');
    values[key]=args[i+1];
  }
  // `-` is the only non-absolute result: one JSON line on stdout.
  if(values.result!=='-'&&!absolute(values.result))throw new Error('arguments');
  if((Object.hasOwn(values,'consent')&&values.consent!=='granted')||(Object.hasOwn(values,'remove-feed')&&values['remove-feed']!=='yes'))throw new Error('arguments');
  if(Object.hasOwn(values,'target')) {
    const target=JSON.parse(values.target),p=target?.process;
    if(!target||Object.keys(target).length!==2||!['claude','codex','antigravity'].includes(target.provider)||!p||
      Object.keys(p).length!==4||!['pid','uid','start_ticks','boot_id'].every(key=>Object.hasOwn(p,key))||
      !Number.isSafeInteger(p.pid)||p.pid<=0||!Number.isSafeInteger(p.uid)||p.uid<0||!/^\d{1,30}$/.test(p.start_ticks)||
      typeof p.start_ticks!=='string'||typeof p.boot_id!=='string'||!p.boot_id.length||p.boot_id.length>128||/[\x00-\x1f\x7f]/.test(p.boot_id))throw new Error('arguments');
    values.target=target;
  }
  if(action==='connect'||action==='discover') {
    if(!['claude','codex','antigravity'].includes(values.provider)||
      (values.target?(values.target.provider!==values.provider||(Object.hasOwn(values,'cli')&&!absolute(values.cli))):!absolute(values.cli))||
      (action==='connect'&&!version(values['runtime-version'])))throw new Error('arguments');
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
async function consent(output=process.stdout) {
  if(!process.stdin.isTTY)return null;
  const reader=require('node:readline').createInterface({input:process.stdin,output});
  try {return await new Promise(resolve=>{reader.once('close',()=>resolve(null));reader.question('Type yes to continue: ',resolve);});}
  finally {reader.close();}
}
const FEED_NOT_EMPTY={removed:false,code:'FEED_NOT_EMPTY',message:'The report folder holds entries Account Usage did not create. They were left in place.'};
const FEED_REMOVE_FAILED={removed:false,code:'FEED_REMOVE_FAILED',message:'The report folder could not be emptied. Its remaining entries were left in place.'};
const REPORT_NAME=/^(claude|codex|antigravity)-[a-f0-9]{24}\.json$/,LOCK_NAME=/^(query-|\.lock-)[a-f0-9]{32}$/,OWNER_NAME=/^owner-[a-f0-9]{32}\.json$/;
// Runs as the feed's owner after a disconnect. Every directory is pinned with
// O_DIRECTORY|O_NOFOLLOW and every name is reached through its /proc/self/fd
// anchor. The whole tree is classified before anything is removed, so one
// unknown entry or link leaves all of it in place. The folder itself stays:
// on the shared road root removes it with rmdir, which refuses a non-empty one.
async function removeFeed(directory,uid,io=fs) {
  const handles=[],unknown=()=>Object.assign(new Error('feed-not-empty'),{feedNotEmpty:true});
  const file=entry=>entry.isFile()&&entry.uid===uid;
  async function pin(location,expected) {
    const handle=await io.open(location,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
    handles.push(handle);
    const pinned=await handle.stat();
    if(!pinned.isDirectory()||pinned.uid!==uid||pinned.ino!==expected.ino||pinned.dev!==expected.dev)throw unknown();
    return `/proc/self/fd/${handle.fd}`;
  }
  async function list(anchor) {
    const names=[];
    for await(const entry of await io.opendir(anchor)) {names.push(entry.name);if(names.length>256)throw unknown();}
    return names;
  }
  try {
    if(!absolute(directory))throw new Error('invalid-feed-directory');
    const before=await io.lstat(directory);
    if(!before.isDirectory()||before.uid!==uid||await io.realpath(directory)!==directory)throw new Error('unsafe-feed-directory');
    const root=await pin(directory,before),removals=[];
    for(const name of await list(root)) {
      const entry=await io.lstat(`${root}/${name}`);
      if(name==='.connection.json'||REPORT_NAME.test(name)) {
        if(!file(entry))throw unknown();
        removals.push([root,name,false]);continue;
      }
      if(!['.connection-control','.native-queries'].includes(name)||!entry.isDirectory()||entry.uid!==uid)throw unknown();
      const child=await pin(`${root}/${name}`,entry);
      for(const inner of await list(child)) {
        const info=await io.lstat(`${child}/${inner}`);
        if(name==='.connection-control') {
          if(inner!=='claim.json'||!file(info))throw unknown();
          removals.push([child,inner,false]);continue;
        }
        // .native-queries holds only the collector's lock folders and their owner markers.
        if(!LOCK_NAME.test(inner)||!info.isDirectory()||info.uid!==uid)throw unknown();
        const lock=await pin(`${child}/${inner}`,info);
        for(const owner of await list(lock)) {
          if(!OWNER_NAME.test(owner)||!file(await io.lstat(`${lock}/${owner}`)))throw unknown();
          removals.push([lock,owner,false]);
        }
        removals.push([child,inner,true]);
      }
      removals.push([root,name,true]);
    }
    for(const [anchor,name,folder] of removals) {
      try {await (folder?io.rmdir(`${anchor}/${name}`):io.unlink(`${anchor}/${name}`));}
      catch(error) {if(['ENOTEMPTY','EEXIST'].includes(error.code))throw unknown();if(error.code!=='ENOENT')throw error;}
    }
    if((await list(root)).length)throw unknown();
    return {removed:true};
  } catch(error) {return {...(error.feedNotEmpty?FEED_NOT_EMPTY:FEED_REMOVE_FAILED)};}
  finally {for(const handle of handles.reverse())await handle.close().catch(()=>{});}
}
async function run(argv,dependencies={}) {
  let args;
  // `--result -` keeps stdout for exactly one JSON line; every human line goes to stderr.
  const toStdout=Array.isArray(argv)&&argv.length<=MAX_ARGV&&argv.some((value,index)=>index%2===1&&value==='--result'&&argv[index+1]==='-');
  const print=dependencies.print||(toStdout?line=>process.stderr.write(`${line}\n`):console.log);
  const emit=dependencies.writeStdout||(line=>new Promise((resolve,reject)=>process.stdout.write(line,error=>error?reject(error):resolve())));
  let emitted=false;
  const publish=async(file,result)=>{
    if(file!=='-')return (dependencies.writeResult||((target,value)=>writeResult(target,value,dependencies.fs||fs)))(file,result);
    const line=JSON.stringify(result)+'\n';
    if(emitted||Buffer.byteLength(line)>32768)throw new Error('result-not-publishable');
    emitted=true;await emit(line);
  };
  try {args=parse(argv);}catch {
    print('Invalid setup arguments. Use explicit absolute paths and a supported provider.');
    if(toStdout)await publish('-',{ok:false,code:'INVALID_ARGUMENTS',message:'Invalid setup arguments.'}).catch(()=>{});
    return {code:2};
  }
  const setup=dependencies.setup||require('./setup.cjs');
  const homeDir=(dependencies.home||os.homedir)(),uid=(dependencies.uid||(()=>process.getuid()))();
  const options={homeDir,uid,env:dependencies.env||process.env,nodePath:dependencies.nodePath||process.execPath,
    collectorPath:dependencies.collectorPath||path.join(__dirname,'../collectors/passive.cjs'),
    storagePath:path.join(homeDir,'.local/state/llm-account-usage/target-setup')};
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
    if(args.action!=='disconnect') {
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
    if(args.action!=='disconnect') {
      options.reportDir=preview.reportDir||args['report-dir']||path.join(homeDir,'.llm-account-usage-feeds',preview.id);
    }
    print(`Report directory: ${options.reportDir||preview.reportDir}`);
    print(args.action==='discover'?'Discovery only reads. Nothing was changed.':
      'Only this user’s selected provider configuration and sanitized usage feed will change. No provider process is restarted.');
    if(args['remove-feed'])print('After disconnecting, the Account Usage files in this report directory are removed. The directory itself is left in place.');
    for(const item of preview.sharedDirectories||[])print(`${item.kind}: ${item.path} (owner UID ${item.uid}, group GID ${item.gid}, mode ${(item.mode&0o7777).toString(8)})`);
    if(preview.sharedDirectories?.length)print('Continuing trusts the listed owners and everyone who can write through these groups.');
    if(args.action==='discover') {
      await publish(args.result,{ok:true,preview:{id:preview.id,provider:preview.provider||args.provider,profilePath:preview.profilePath,
        settingsPath:preview.settingsPath,reportDir:options.reportDir,hasExistingStatusLine:preview.hasExistingStatusLine===true,
        hasExistingHooks:preview.hasExistingHooks===true,
        sharedDirectories:(preview.sharedDirectories||[]).map(({path:file,kind,uid:owner,gid,mode})=>({path:file,kind,uid:owner,gid,mode}))}});
      return {code:0};
    }
    // `--consent granted` is the consent given on the host's review screen; without it a TTY prompt decides.
    if(args.consent==='granted')print('Consent given on the command line (--consent granted).');
    else if((await (dependencies.readConsent||(()=>consent(toStdout?process.stderr:process.stdout)))())!=='yes') {
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
    if(!args['remove-feed']) {await publish(args.result,{ok:true,connection});return {code:0};}
    // The disconnect itself has finished; a feed that cannot be emptied is reported beside it, never as a setup failure.
    let feed;
    try {feed=await removeFeed(options.reportDir,uid,dependencies.fs||fs);}catch {feed={...FEED_REMOVE_FAILED};}
    print(feed.removed?'The Account Usage files in the report directory were removed.':feed.message);
    await publish(args.result,{ok:true,connection,feed});return {code:feed.removed?0:1};
  } catch {
    const result={ok:false,code:'SETUP_FAILED',message:'Target-user setup could not finish. Review the selected profile, executable and report-directory permissions.'};
    print(result.message);
    try {await publish(args.result,result);}catch {print('The setup result could not be written.');}
    return {code:1};
  }
}
if(require.main===module)run(process.argv.slice(2)).then(result=>{process.exitCode=result.code;}).catch(()=>{process.exitCode=1;});
module.exports={run,writeResult,removeFeed};
