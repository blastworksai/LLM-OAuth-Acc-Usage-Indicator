'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const feed=require('../src/shared-feed.cjs');
const ID='v2-'+'a1'.repeat(16),UUID='0f8fad5b-d9cb-469f-a165-70867728950e',B=`/var/lib/llm-account-usage/bundles/${UUID}`;
const MANIFEST=['src/setup-cli.cjs','src/setup.cjs','src/connection.cjs','src/connection-feed.cjs','src/provider.cjs','src/core.cjs','collectors/passive.cjs'];
async function tmp(t) {const dir=await fs.mkdtemp(path.join(os.tmpdir(),'shared-feed-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}
test('roots and paths are the fixed /var/lib/llm-account-usage tree',()=>{
  assert.equal(feed.ROOT,'/var/lib/llm-account-usage');
  assert.equal(feed.FEEDS,'/var/lib/llm-account-usage/feeds');
  assert.equal(feed.BUNDLES,'/var/lib/llm-account-usage/bundles');
  assert.equal(feed.feedPath(ID),`/var/lib/llm-account-usage/feeds/${ID}`);
  assert.equal(feed.bundlePath(UUID),B);
  assert.deepEqual(feed.ensureRootsArgv(),['/usr/bin/install','-d','-m','0755','-o','root','-g','root',
    '/var/lib/llm-account-usage','/var/lib/llm-account-usage/feeds','/var/lib/llm-account-usage/bundles']);
});
test('createFeedArgv: target owner, numeric VS Code gid, setgid 2750',()=>{
  assert.deepEqual(feed.createFeedArgv({connectionId:ID,uid:1053,gid:1054}),
    ['/usr/bin/install','-d','-m','2750','-o','1053','-g','1054',`/var/lib/llm-account-usage/feeds/${ID}`]);
  assert.deepEqual(feed.createFeedArgv({connectionId:ID,uid:0,gid:0}).slice(4,8),['-o','0','-g','0']);
  for(const bad of [{uid:'1053',gid:1054},{uid:1053,gid:'glitch'},{uid:1053},{uid:-1,gid:1},{uid:1,gid:1.5},{uid:1,gid:0xffffffff},{uid:NaN,gid:1}])
    assert.throws(()=>feed.createFeedArgv({connectionId:ID,...bad}),/Invalid shared feed argument/);
});
test('removeFeedArgv is rmdir only, never a recursive delete of target content',()=>{
  assert.deepEqual(feed.removeFeedArgv(ID),['/usr/bin/rmdir','--',`/var/lib/llm-account-usage/feeds/${ID}`]);
});
test('connection ids must match v2-<32 hex>; anything else is refused before an argv exists',()=>{
  for(const bad of ['v2-'+'A'.repeat(32),'v2-'+'a'.repeat(31),'v2-'+'a'.repeat(33),'v1-'+'a'.repeat(32),'../etc','v2-'+'a'.repeat(32)+'/..',
    `v2-${'a'.repeat(32)}\n`,['v2-'+'a'.repeat(32)],undefined,null,'']) {
    for(const build of [()=>feed.feedPath(bad),()=>feed.removeFeedArgv(bad),()=>feed.createFeedArgv({connectionId:bad,uid:1,gid:1})])
      assert.throws(build,error=>error.code==='INVALID_CONNECTION_ID');
  }
});
test('stageBundleArgv: one install -d, then one root-owned install per manifest file under the bundle',()=>{
  const argv=feed.stageBundleArgv({bundleId:UUID,files:MANIFEST,extensionPath:'/home/glitch/.vscode-server/extensions/x-0.4.0'});
  assert.deepEqual(argv[0],['/usr/bin/install','-d','-m','0755','-o','root','-g','root',B,`${B}/src`,`${B}/collectors`]);
  assert.deepEqual(argv.slice(1),MANIFEST.map(name=>['/usr/bin/install','-m',name.startsWith('collectors/')?'0444':'0555','-o','root','-g','root',
    `/home/glitch/.vscode-server/extensions/x-0.4.0/${name}`,`${B}/${name}`]));
  assert.deepEqual(argv[1],['/usr/bin/install','-m','0555','-o','root','-g','root','/home/glitch/.vscode-server/extensions/x-0.4.0/src/setup-cli.cjs',
    `${B}/src/setup-cli.cjs`]);
  assert.deepEqual(argv.at(-1),['/usr/bin/install','-m','0444','-o','root','-g','root','/home/glitch/.vscode-server/extensions/x-0.4.0/collectors/passive.cjs',
    `${B}/collectors/passive.cjs`]);
  for(const command of argv) {
    assert.ok(path.isAbsolute(command[0]));
    for(const dest of command[1]==='-d'?command.slice(8):[command.at(-1)])assert.ok(dest===B||dest.startsWith(B+'/'),dest);
  }
});
test('stageBundleArgv refuses a bad uuid, a relative extension path and any manifest name that could leave the bundle',()=>{
  const ok={bundleId:UUID,files:MANIFEST,extensionPath:'/ext'};
  for(const bundleId of ['0F8FAD5B-D9CB-469F-A165-70867728950E','0f8fad5b-d9cb-469f-a165-70867728950','../0f8fad5b-d9cb-469f-a165-70867728950e',
    `${UUID}/..`,'',undefined,[UUID]])
    assert.throws(()=>feed.stageBundleArgv({...ok,bundleId}),error=>error.code==='INVALID_BUNDLE_ID');
  for(const extensionPath of ['ext','./ext','/ext/../ext','/ext/','/a\nb',undefined,''])
    assert.throws(()=>feed.stageBundleArgv({...ok,extensionPath}),error=>error.code==='INVALID_EXTENSION_PATH');
  for(const files of [[],undefined,'src/setup.cjs',['src/../../etc/shadow'],['../src/x.cjs'],['/src/x.cjs'],['src/a/b.cjs'],['other/x.cjs'],
    ['src/..'],['src/.hidden'],['src/x.cjs','src/x.cjs'],['src/x\n.cjs'],[1],Array.from({length:65},(_,i)=>`src/f${i}.cjs`)])
    assert.throws(()=>feed.stageBundleArgv({...ok,files}),error=>error.code==='INVALID_BUNDLE_MANIFEST');
});
test('removeBundleArgv: rm -r only on a regex-checked uuid under the bundles root',()=>{
  assert.deepEqual(feed.removeBundleArgv(UUID),['/usr/bin/rm','-r','--',B]);
  for(const bad of ['*','..','','/','0f8fad5b-d9cb-469f-a165-70867728950e/../../feeds',undefined])
    assert.throws(()=>feed.removeBundleArgv(bad),error=>error.code==='INVALID_BUNDLE_ID');
});
test('inspectFeed reports lstat facts without following a symlink, and absence as exists:false',async t=>{
  const dir=await tmp(t),folder=path.join(dir,'feed'),link=path.join(dir,'link');
  assert.deepEqual(await feed.inspectFeed(folder),{exists:false});
  await fs.mkdir(folder);await fs.chmod(folder,0o2750);await fs.symlink(folder,link);
  const st=await fs.lstat(folder);
  assert.deepEqual(await feed.inspectFeed(folder),{exists:true,directory:true,uid:st.uid,gid:st.gid,mode:0o2750});
  assert.equal((await feed.inspectFeed(link)).directory,false);
  await assert.rejects(feed.inspectFeed('relative/feed'),error=>error.code==='INVALID_FEED_PATH');
  const eacces=Object.assign(new Error('denied'),{code:'EACCES'});
  await assert.rejects(feed.inspectFeed('/x',{fs:{lstat:async()=>{throw eacces;}}}),error=>error===eacces);
});
test('precheckReadable passes on a 0750 and a 2750 folder the host can list',async t=>{
  const dir=await tmp(t);
  for(const mode of [0o750,0o2750]) {const folder=path.join(dir,mode.toString(8));await fs.mkdir(folder);await fs.chmod(folder,mode);
    await fs.writeFile(path.join(folder,'.connection.json'),'{}');assert.equal(await feed.precheckReadable(folder),true);}
});
test('precheckReadable fails on a folder the host cannot read, a symlink, a file, absence and a relative path',async t=>{
  const dir=await tmp(t),unreadable=path.join(dir,'unreadable'),target=path.join(dir,'real'),link=path.join(dir,'link'),file=path.join(dir,'file');
  await fs.mkdir(target,{mode:0o750});await fs.symlink(target,link);await fs.writeFile(file,'x');
  await fs.mkdir(unreadable);await fs.chmod(unreadable,0o300);
  try {if(process.getuid()!==0)assert.equal(await feed.precheckReadable(unreadable),false);} finally {await fs.chmod(unreadable,0o700);}
  assert.equal(await feed.precheckReadable(link),false);
  assert.equal(await feed.precheckReadable(file),false);
  assert.equal(await feed.precheckReadable(path.join(dir,'absent')),false);
  assert.equal(await feed.precheckReadable('relative'),false);
});
test('precheckReadable fails on a 0700 folder owned by another uid',{skip:process.getuid()!==0&&'needs root to chown the folder to another uid'},async t=>{
  const dir=await tmp(t),folder=path.join(dir,'other');
  await fs.chmod(dir,0o755);await fs.mkdir(folder,{mode:0o700});await fs.chown(folder,65534,65534);
  const {execFileSync}=require('node:child_process');
  // Root reads everything, so prove it as an unprivileged uid.
  const out=execFileSync(process.execPath,['-e',`process.setgid(65534);process.setuid(65534);require(${JSON.stringify(path.resolve(__dirname,'../src/shared-feed.cjs'))})
    .precheckReadable(${JSON.stringify(folder)}).then(r=>process.stdout.write(String(r)))`],{encoding:'utf8'});
  assert.equal(out,'false');
});
test('precheckReadable pins O_RDONLY|O_DIRECTORY|O_NOFOLLOW and reads through the fd anchor, never the path',async()=>{
  const {constants}=require('node:fs'),calls=[];
  const stat={isDirectory:()=>true,ino:7,dev:3,uid:1053};
  const io={lstat:async p=>{calls.push(['lstat',p]);return stat;},
    open:async(p,flags)=>{calls.push(['open',p,flags]);return {fd:42,stat:async()=>stat,close:async()=>calls.push(['close'])};},
    readdir:async p=>{calls.push(['readdir',p]);return [];}};
  assert.equal(await feed.precheckReadable(`/var/lib/llm-account-usage/feeds/${ID}`,{fs:io}),true);
  assert.deepEqual(calls,[['lstat',`/var/lib/llm-account-usage/feeds/${ID}`],
    ['open',`/var/lib/llm-account-usage/feeds/${ID}`,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW],
    ['readdir','/proc/self/fd/42'],['close']]);
});
test('precheckReadable refuses a folder swapped between lstat and open, and closes the fd on a read error',async()=>{
  let closed=0;const before={isDirectory:()=>true,ino:7,dev:3,uid:1};
  const io=(pinned,readdir=async()=>[])=>({lstat:async()=>before,open:async()=>({fd:5,stat:async()=>pinned,close:async()=>{closed++;}}),readdir});
  assert.equal(await feed.precheckReadable('/f',{fs:io({...before,ino:8})}),false);
  assert.equal(await feed.precheckReadable('/f',{fs:io({...before,uid:2})}),false);
  assert.equal(await feed.precheckReadable('/f',{fs:io(before,async()=>{throw Object.assign(new Error('x'),{code:'EACCES'});})}),false);
  assert.equal(closed,3);
});

test('claimFeedArgv: an atomic, root-only mkdir of exactly the feed path; bad ids refused',()=>{
  assert.deepEqual(feed.claimFeedArgv(ID),['/usr/bin/mkdir','-m','0700','--',feed.feedPath(ID)]);
  for(const bad of ['v2-XYZ','../x','',null])assert.throws(()=>feed.claimFeedArgv(bad));
});
