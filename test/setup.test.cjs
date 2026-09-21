'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {execFileSync, spawnSync} = require('node:child_process');
const {createSetup} = require('../src/setup.cjs');

async function fixture(t, provider = 'claude') {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'account-usage-setup-'));
  t.after(() => fs.rm(homeDir, {recursive:true, force:true}));
  const profilePath = path.join(homeDir, provider === 'claude' ? '.claude' : provider === 'codex' ? '.codex' : '.gemini/antigravity-cli');
  await fs.mkdir(profilePath, {recursive:true, mode:0o700});
  const settingsPath = path.join(profilePath, provider === 'codex' ? 'hooks.json' : 'settings.json');
  const collectorPath = path.join(homeDir, 'collector.cjs');
  await fs.writeFile(collectorPath, `const fs=require('node:fs');const cp=require('node:child_process');const args=process.argv.slice(2);const i=args.indexOf('--original-argv-json');const input=fs.readFileSync(0);if(i>=0){const [file,...argv]=JSON.parse(args[i+1]);const r=cp.spawnSync(file,argv,{input,encoding:null,env:process.env});if(r.stdout)process.stdout.write(r.stdout);if(r.stderr)process.stderr.write(r.stderr);process.exitCode=r.status??1;}else process.stdout.write(JSON.stringify({args,node:process.execPath,electron:process.env.ELECTRON_RUN_AS_NODE}));`, {mode:0o600});
  // Test sandboxes may remap system-owned files to the overflow UID.
  const options = {provider, homeDir, systemUid:(await fs.stat('/')).uid, env:{PATH:process.env.PATH}, storagePath:path.join(homeDir, 'extension-storage'), nodePath:process.execPath, collectorPath, cliPath:process.execPath};
  const setup = createSetup();
  return {homeDir,profilePath,settingsPath,collectorPath,options,setup};
}
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const writeJson = (file, value) => fs.writeFile(file, JSON.stringify(value), {mode:0o600});

test('fresh connect installs stable private runtime and preserves unrelated config', async t => {
  const f = await fixture(t);
  await writeJson(f.settingsPath, {theme:'dark', permissions:{deny:['example']}});
  const before = await fs.readFile(f.settingsPath);
  const preview = await f.setup.discoverProvider(f.options);
  assert.equal(preview.hasExistingStatusLine, false);
  assert.equal(preview.settingsPath, f.settingsPath);
  const result = await f.setup.connectProvider(f.options);
  const config = await readJson(f.settingsPath);
  assert.equal(config.theme, 'dark');
  assert.deepEqual(config.permissions, {deny:['example']});
  assert.equal(result.connected, true);
  assert.deepEqual(await fs.readFile(result.backupPath), before);
  assert.equal((await fs.stat(result.reportDir)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(result.backupPath)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.dirname(result.launcherPath))).mode & 0o777, 0o700);
  const run = JSON.parse(execFileSync('/bin/sh', [result.launcherPath], {input:'{}', encoding:'utf8'}));
  assert.ok(run.args.includes('--claude-auth-status'));
  const trustIndex = run.args.indexOf('--trusted-cli-paths-json');
  assert.notEqual(trustIndex, -1);
  assert.deepEqual(JSON.parse(run.args[trustIndex + 1]), []);
  assert.equal(run.electron, '1');
  assert.equal(run.args[0], 'claude-statusline');
  assert.deepEqual((await f.setup.listConnections(f.options)).map(v => v.reportDir), [result.reportDir]);
});

test('shared home and profile require reviewed trust, then connect without changing permissions', async t => {
  const f = await fixture(t);
  await writeJson(f.settingsPath, {theme:'keep'});
  await fs.chmod(f.homeDir, 0o2770);
  await fs.chmod(f.profilePath, 0o2775);
  const before = await fs.readFile(f.settingsPath);
  const preview = await f.setup.discoverProvider(f.options);
  assert.deepEqual(preview.sharedDirectories.map(item => item.path), [f.homeDir, f.profilePath]);
  assert.deepEqual(await fs.readFile(f.settingsPath), before);
  await assert.rejects(fs.stat(f.options.storagePath), {code:'ENOENT'});
  await assert.rejects(f.setup.connectProvider(f.options), {code:'DIRECTORY_TRUST_REQUIRED'});
  const options = {...f.options, trustedDirectories:preview.sharedDirectories};
  const result = await f.setup.connectProvider(options);
  assert.equal(result.connected, true);
  assert.deepEqual((await f.setup.listConnections(options)).map(value => value.provider), ['claude']);
  assert.deepEqual((await f.setup.refreshRuntime(options)).warnings, []);
  assert.equal((await fs.stat(f.homeDir)).mode & 0o7777, 0o2770);
  assert.equal((await fs.stat(f.profilePath)).mode & 0o7777, 0o2775);
  await f.setup.disconnectProvider(options);
  assert.deepEqual(await readJson(f.settingsPath), {theme:'keep'});
});

test('shared directory trust cannot approve a different group, world writes, links or writable settings', async t => {
  const f = await fixture(t);
  await writeJson(f.settingsPath, {});
  await fs.chmod(f.homeDir, 0o2770);
  const preview = await f.setup.discoverProvider(f.options);
  const wrongGroup = preview.sharedDirectories.map(item => ({...item, gid:item.gid + 1}));
  await assert.rejects(f.setup.connectProvider({...f.options, trustedDirectories:wrongGroup}), {code:'DIRECTORY_TRUST_REQUIRED'});
  const options = {...f.options, trustedDirectories:preview.sharedDirectories};
  await fs.chmod(f.homeDir, 0o777);
  await assert.rejects(f.setup.discoverProvider(options), {code:'UNSAFE_PATH'});
  await fs.chmod(f.homeDir, 0o2770);
  await fs.chmod(f.settingsPath, 0o660);
  await assert.rejects(f.setup.connectProvider(options), {code:'UNSAFE_PATH'});
  await fs.chmod(f.settingsPath, 0o600);
  const link = path.join(f.homeDir, 'linked');
  await fs.symlink(f.profilePath, link);
  await assert.rejects(f.setup.connectProvider({...options, profilePath:link}), {code:'UNSAFE_PATH'});
});

test('a CLI controlled by another user or shared group reaches explicit trust instead of being refused', async t => {
  const f = await fixture(t, 'codex');
  await writeJson(f.settingsPath, {});
  const sharedRoot = path.join(f.homeDir, 'shared-cli');
  const sharedLib = path.join(sharedRoot, 'lib');
  const executable = path.join(sharedLib, 'codex');
  await fs.mkdir(sharedLib, {recursive:true, mode:0o2775});
  await fs.chmod(sharedRoot, 0o2775);
  await fs.chmod(sharedLib, 0o2775);
  await fs.copyFile(process.execPath, executable);
  await fs.chmod(executable, 0o775);
  const externalUid = process.getuid() + 1000;
  const sharedGid = 4242;
  const externalInfo = async (method, file, ...args) => {
    const info = await fs[method](file, ...args);
    if(file === sharedRoot || file === sharedLib || file === executable) {
      info.uid = externalUid;
      info.gid = sharedGid;
    }
    return info;
  };
  const io = new Proxy(fs, {get(target, key) {
    if(key === 'lstat' || key === 'stat')return (file, ...args) => externalInfo(key, file, ...args);
    return target[key];
  }});
  const setup = createSetup({fs:io});
  const options = {...f.options, cliPath:executable};

  const preview = await setup.discoverProvider(options);
  assert.deepEqual(preview.sharedDirectories.map(item => ({path:item.path,kind:item.kind,uid:item.uid,gid:item.gid})), [
    {path:sharedRoot,kind:'directory',uid:externalUid,gid:sharedGid},
    {path:sharedLib,kind:'directory',uid:externalUid,gid:sharedGid},
    {path:executable,kind:'executable',uid:externalUid,gid:sharedGid}
  ]);
  await assert.rejects(setup.connectProvider(options), {code:'DIRECTORY_TRUST_REQUIRED'});
  const result = await setup.connectProvider({...options, trustedDirectories:preview.sharedDirectories});
  assert.equal(result.connected, true);
});

test('CLI trust is invalidated by changed ownership or permissions and never accepts world writes', async t => {
  const f = await fixture(t, 'codex');
  await writeJson(f.settingsPath, {});
  const executable = path.join(f.homeDir, 'shared-codex');
  await fs.copyFile(process.execPath, executable);
  await fs.chmod(executable, 0o755);
  const externalUid = process.getuid() + 1000;
  const sharedGid = 4242;
  let permissions = 0o755;
  const io = new Proxy(fs, {get(target, key) {
    if(key === 'stat')return async (file, ...args) => {
      const info = await target.stat(file, ...args);
      if(file === executable) {
        info.uid = externalUid;
        info.gid = sharedGid;
        info.mode = (info.mode & ~0o7777) | permissions;
      }
      return info;
    };
    return target[key];
  }});
  const setup = createSetup({fs:io});
  const options = {...f.options, cliPath:executable};
  const preview = await setup.discoverProvider(options);
  const trusted = {...options, trustedDirectories:preview.sharedDirectories};

  assert.deepEqual((await setup.discoverProvider(trusted)).sharedDirectories, []);
  permissions = 0o775;
  const changed = await setup.discoverProvider(trusted);
  assert.deepEqual(changed.sharedDirectories.map(item => item.path), [executable]);
  await assert.rejects(setup.connectProvider(trusted), {code:'DIRECTORY_TRUST_REQUIRED'});
  permissions = 0o777;
  await assert.rejects(setup.discoverProvider(trusted), {code:'UNSUPPORTED_CLI'});
});

test('permission drift hides the connection, disables its launcher and requires renewed trust', async t => {
  const f = await fixture(t);
  await writeJson(f.settingsPath, {});
  const executable = path.join(f.homeDir, 'shared-claude');
  await fs.copyFile(process.execPath, executable);
  await fs.chmod(executable, 0o755);
  const externalUid = process.getuid() + 1000, sharedGid = 4242;
  let permissions = 0o755;
  const io = new Proxy(fs, {get(target, key) {
    if(key === 'stat')return async (file, ...args) => {
      const info = await target.stat(file, ...args);
      if(file === executable) {
        info.uid = externalUid;info.gid = sharedGid;
        info.mode = (info.mode & ~0o7777) | permissions;
      }
      return info;
    };
    return target[key];
  }});
  const setup = createSetup({fs:io});
  const options = {...f.options, cliPath:executable};
  const firstReview = await setup.discoverProvider(options);
  const trusted = {...options, trustedDirectories:firstReview.sharedDirectories};
  const installed = await setup.connectProvider(trusted);
  permissions = 0o775;
  assert.deepEqual(await setup.listConnections(trusted), []);
  const refreshed = await setup.refreshRuntime(trusted);
  assert.deepEqual(refreshed.refreshed, []);
  assert.equal(refreshed.warnings.length, 1);
  assert.equal(execFileSync('/bin/sh', [installed.launcherPath], {input:'{}', encoding:'utf8'}), '');
  const nextReview = await setup.discoverProvider(trusted);
  assert.deepEqual(nextReview.sharedDirectories.map(item => item.path), [executable]);
  const renewed = {...options, trustedDirectories:firstReview.sharedDirectories.filter(item => item.path !== executable).concat(nextReview.sharedDirectories)};
  await setup.connectProvider(renewed);
  const run = JSON.parse(execFileSync('/bin/sh', [installed.launcherPath], {input:'{}', encoding:'utf8'}));
  const trustIndex = run.args.indexOf('--trusted-cli-paths-json');
  assert.deepEqual(JSON.parse(run.args[trustIndex + 1]).find(item => item.path === executable).mode, 0o775);
});

test('reconnect persists a newly detected native target after a package launcher update', async t => {
  const f = await fixture(t);
  const first = path.join(f.homeDir, 'native-v1'), second = path.join(f.homeDir, 'native-v2');
  await fs.copyFile(process.execPath, first);await fs.chmod(first, 0o700);
  await fs.copyFile(process.execPath, second);await fs.chmod(second, 0o700);
  const installed = await f.setup.connectProvider({...f.options,cliPath:first});
  await f.setup.connectProvider({...f.options,cliPath:second});
  const run = JSON.parse(execFileSync('/bin/sh', [installed.launcherPath], {input:'{}', encoding:'utf8'}));
  assert.equal(run.args[run.args.indexOf('--cli-executable') + 1], second);
  const receipt = await readJson(path.join(path.dirname(installed.launcherPath), 'connection.json'));
  assert.equal(receipt.cliPath, second);
  assert.equal(receipt.cliLookupPath, second);
});

test('disabling a drifted collector still preserves the original statusline byte stream', async t => {
  const f = await fixture(t);
  await writeJson(f.settingsPath, {statusLine:{type:'command',command:'printf "kept:"; cat'}});
  const executable = path.join(f.homeDir, 'shared-claude');
  await fs.copyFile(process.execPath, executable);await fs.chmod(executable, 0o770);
  const options = {...f.options,cliPath:executable};
  const preview = await f.setup.discoverProvider(options);
  const trusted = {...options,trustedDirectories:preview.sharedDirectories};
  await f.setup.connectProvider(trusted);
  await fs.chmod(executable, 0o750);
  assert.equal((await f.setup.refreshRuntime(trusted)).warnings.length, 1);
  const command = (await readJson(f.settingsPath)).statusLine.command;
  assert.equal(execFileSync('/bin/sh', ['-c', command], {input:'original bytes',encoding:'utf8'}), 'kept:original bytes');
});

test('repeated connect preserves original backup and statusline stdin, shell syntax and stdout', async t => {
  const f = await fixture(t);
  const original = {type:'command', command:'prefix=kept; printf "%s:" "$prefix"; cat', padding:2};
  await writeJson(f.settingsPath, {statusLine:original, other:1});
  const first = await f.setup.connectProvider(f.options);
  const second = await f.setup.connectProvider(f.options);
  assert.equal(first.backupPath, second.backupPath);
  assert.equal((await readJson(f.settingsPath)).statusLine.padding, 2);
  const input = Buffer.from([0, 10, 13, 255, 123, 125]);
  const output = execFileSync('/bin/sh', ['-c', (await readJson(f.settingsPath)).statusLine.command], {input});
  assert.deepEqual(output, Buffer.concat([Buffer.from('kept:'), input]));
  await f.setup.disconnectProvider(f.options);
  assert.deepEqual((await readJson(f.settingsPath)).statusLine, original);
});

test('disconnect removes only installed key and preserves later unrelated edits', async t => {
  const f = await fixture(t);
  const result = await f.setup.connectProvider(f.options);
  const config = await readJson(f.settingsPath);
  config.theme = 'changed';
  await writeJson(f.settingsPath, config);
  await fs.writeFile(path.join(result.reportDir, 'someone-elses-file'), 'keep', {mode:0o600});
  const disconnected = await f.setup.disconnectProvider(f.options);
  assert.equal(disconnected.connected, false);
  assert.deepEqual(await readJson(f.settingsPath), {theme:'changed'});
  assert.equal(await fs.readFile(path.join(result.reportDir, 'someone-elses-file'), 'utf8'), 'keep');
  assert.deepEqual(await f.setup.listConnections(f.options), []);
  assert.equal((await f.setup.disconnectProvider(f.options)).connected, false);
});

test('edited installed statusline blocks reconnect and disconnect without clobbering', async t => {
  const f = await fixture(t);
  await f.setup.connectProvider(f.options);
  const config = await readJson(f.settingsPath);
  config.statusLine.command += ' # edited';
  await writeJson(f.settingsPath, config);
  const before = await fs.readFile(f.settingsPath);
  await assert.rejects(f.setup.disconnectProvider(f.options), {code:'SETTINGS_CHANGED'});
  await assert.rejects(f.setup.connectProvider(f.options), {code:'SETTINGS_CHANGED'});
  assert.deepEqual(await fs.readFile(f.settingsPath), before);
});

test('activation refresh updates owned runtime without writing provider settings', async t => {
  const f = await fixture(t);
  const result = await f.setup.connectProvider(f.options);
  const before = await fs.readFile(f.settingsPath);
  await fs.writeFile(f.collectorPath, 'process.stdout.write("upgraded");', {mode:0o600});
  const refreshed = await f.setup.refreshRuntime(f.options);
  assert.deepEqual(refreshed.warnings, []);
  assert.deepEqual(await fs.readFile(f.settingsPath), before);
  assert.equal(execFileSync('/bin/sh', [result.launcherPath], {encoding:'utf8'}), 'upgraded');
  await f.setup.disconnectProvider(f.options);
  assert.deepEqual(await readJson(f.settingsPath), {});
});

test('existing statusline survives a missing or crashing Node runtime and removed editor storage', async t => {
  const f = await fixture(t);
  await writeJson(f.settingsPath, {statusLine:{type:'command', command:'cat; exit 7'}});
  const localNode = path.join(f.homeDir, 'old-node');
  await fs.copyFile(process.execPath, localNode);
  await fs.chmod(localNode, 0o700);
  const result = await f.setup.connectProvider({...f.options, nodePath:localNode});
  const command = (await readJson(f.settingsPath)).statusLine.command;
  await fs.unlink(localNode);
  await fs.rm(f.options.storagePath, {recursive:true, force:true});
  const input = Buffer.from([0, 255, 10, 123, 125]);
  function run() {
    try { execFileSync('/bin/sh', ['-c', command], {input}); assert.fail('original must exit 7'); }
    catch(error) { assert.equal(error.status, 7); assert.deepEqual(error.stdout, input); }
  }
  run();
  await fs.writeFile(f.collectorPath, 'process.exit(23);', {mode:0o600});
  await f.setup.refreshRuntime(f.options);
  run();
});

test('a hung collector is bounded while original statusline keeps its bytes and exit status', {timeout:17000}, async t => {
  const f = await fixture(t);
  await writeJson(f.settingsPath, {statusLine:{type:'command', command:'cat; exit 9'}});
  await fs.writeFile(f.collectorPath, 'process.stdin.resume();setInterval(()=>{},1000);', {mode:0o600});
  const result = await f.setup.connectProvider(f.options);
  const started = Date.now();
  const command = (await readJson(f.settingsPath)).statusLine.command;
  try { execFileSync('/bin/sh', ['-c', command], {input:'unchanged bytes', timeout:15000}); assert.fail('original must exit 9'); }
  catch(error) { assert.equal(error.status, 9); assert.equal(error.stdout.toString(), 'unchanged bytes'); }
  assert.ok(Date.now() - started < 14500);
  assert.equal((await fs.readdir(path.dirname(result.launcherPath))).some(name => name.startsWith('.stream-')), false);
});

test('the provider execution shell retains bash-only syntax and original command exit status', async t => {
  const f = await fixture(t);
  const original = 'values=(one two); [[ ${values[1]} == two ]] || exit 3; printf "%s:" "${values[0]}"; cat; exit 7';
  await writeJson(f.settingsPath, {statusLine:{type:'command', command:original}});
  await f.setup.connectProvider(f.options);
  const command = (await readJson(f.settingsPath)).statusLine.command;
  try { execFileSync('/bin/bash', ['-c', command], {input:'preserved'}); assert.fail('original must exit 7'); }
  catch(error) { assert.equal(error.status, 7); assert.equal(error.stdout.toString(), 'one:preserved'); }
});

test('another editor storage cannot chain an already managed provider hook', async t => {
  const f = await fixture(t);
  await f.setup.connectProvider(f.options);
  const before = await fs.readFile(f.settingsPath);
  const other = {...f.options, storagePath:path.join(f.homeDir, 'other-editor')};
  await assert.rejects(f.setup.connectProvider(other), {code:'ALREADY_CONNECTED'});
  assert.deepEqual(await fs.readFile(f.settingsPath), before);
});

test('missing editor ownership requires explicit takeover confirmation', async t => {
  const f = await fixture(t);
  const installed = await f.setup.connectProvider(f.options);
  const original = await fs.readFile(f.settingsPath);
  const other = {...f.options, storagePath:path.join(f.homeDir, 'other-editor')};
  await assert.rejects(f.setup.connectProvider({...other, confirmTakeover:true}), {code:'ALREADY_CONNECTED'});
  await fs.rm(f.options.storagePath, {recursive:true, force:true});
  await assert.rejects(f.setup.connectProvider(other), {code:'TAKEOVER_REQUIRED', recoverable:true, recoveryAction:'confirm-takeover', safeToDisplay:true});
  assert.deepEqual(await fs.readFile(f.settingsPath), original);
  const taken = await f.setup.connectProvider({...other, confirmTakeover:true});
  assert.equal(taken.backupPath, installed.backupPath);
  assert.deepEqual(await fs.readFile(f.settingsPath), original);
  await f.setup.disconnectProvider(other);
  assert.deepEqual(await readJson(f.settingsPath), {});
});

test('interrupted install and manual hook removal recover without overwriting replacement settings', async t => {
  const f = await fixture(t);
  for(const replacement of [{theme:'new'}, {statusLine:{type:'command',command:'printf owner-replacement'}, theme:'new'}]) {
    await f.setup.connectProvider(f.options);
    await writeJson(f.settingsPath, replacement);
    const before = await fs.readFile(f.settingsPath);
    const result = await f.setup.disconnectProvider(f.options);
    assert.equal(result.connected, false);
    assert.deepEqual(await fs.readFile(f.settingsPath), before);
    await f.setup.connectProvider(f.options);
    await f.setup.disconnectProvider(f.options);
    assert.deepEqual(await readJson(f.settingsPath), replacement);
  }
  await f.setup.connectProvider(f.options);
  await fs.unlink(f.settingsPath);
  await f.setup.connectProvider(f.options);
  assert.ok((await readJson(f.settingsPath)).statusLine.command.includes('llm-account-usage-managed-v1'));
});

async function processMarker() {
  const text = await fs.readFile(`/proc/${process.pid}/stat`, 'utf8');
  return {pid:process.pid, uid:process.getuid(), start_ticks:text.slice(text.lastIndexOf(')') + 2).split(' ')[19],
    boot_id:(await fs.readFile('/proc/sys/kernel/random/boot_id','utf8')).trim()};
}
async function installLock(root, marker) {
  const directory = path.join(root, '.setup-lock');
  await fs.mkdir(directory, {mode:0o700});
  await writeJson(path.join(directory, 'owner-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.json'), marker);
  return directory;
}
test('only provably dead setup locks are reclaimed and live activation contention is benign', async t => {
  const f = await fixture(t);
  const installed = await f.setup.connectProvider(f.options);
  const root = path.dirname(installed.launcherPath), marker = await processMarker();
  let lock = await installLock(root, {...marker, boot_id:'00000000-0000-0000-0000-000000000000'});
  await f.setup.connectProvider(f.options);
  assert.equal(await fs.stat(lock).catch(e => e.code), 'ENOENT');
  lock = await installLock(root, {...marker, start_ticks:String(BigInt(marker.start_ticks) + 1n)});
  await f.setup.disconnectProvider(f.options);
  await f.setup.connectProvider(f.options);
  lock = await installLock(root, marker);
  await assert.rejects(f.setup.disconnectProvider(f.options), {code:'SETUP_BUSY'});
  assert.deepEqual((await f.setup.refreshRuntime(f.options)).warnings, []);
  assert.ok(await fs.stat(lock));
  await fs.rm(lock, {recursive:true});
  await fs.writeFile(lock, '', {mode:0o600});
  await assert.rejects(f.setup.connectProvider(f.options), {code:'SETUP_LOCK_UNVERIFIABLE', recoverable:true, recoveryAction:'review-lock'});
  assert.equal((await fs.stat(lock)).isFile(), true);
});

test('process crashes before installation, after installation, and after restoration remain recoverable', async t => {
  const f = await fixture(t);
  const original = {theme:'retained',statusLine:{type:'command',command:'printf original'}};
  await writeJson(f.settingsPath, original);
  const child = `const fs=require('node:fs/promises');const {createSetup}=require(process.argv[1]);
    const options=JSON.parse(process.argv[2]),phase=process.argv[3];
    const io=new Proxy(fs,{get(target,key){if(key==='rename')return async(from,to)=>{
      await target.rename(from,to);
      if((phase==='receipt'&&String(to).endsWith('/connection.json'))||
         (phase!=='receipt'&&to===options.homeDir+'/.claude/settings.json'))process.exit(17);
    };return target[key];}});
    createSetup({fs:io})[phase==='restore'?'disconnectProvider':'connectProvider'](options).then(()=>process.exit(99)).catch(()=>process.exit(98));`;
  const crash = phase => {
    const result = spawnSync(process.execPath, ['-e', child, path.resolve(__dirname, '../src/setup.cjs'), JSON.stringify(f.options), phase],
      {env:{...process.env,NODE_NO_WARNINGS:'1'},timeout:5000});
    assert.equal(result.status, 17);
  };
  crash('receipt');
  assert.deepEqual(await readJson(f.settingsPath), original);
  await f.setup.disconnectProvider(f.options);
  assert.deepEqual(await readJson(f.settingsPath), original);
  crash('install');
  assert.ok((await readJson(f.settingsPath)).statusLine.command.includes('llm-account-usage-managed-v1'));
  await f.setup.connectProvider(f.options);
  crash('restore');
  assert.deepEqual(await readJson(f.settingsPath), original);
  await f.setup.disconnectProvider(f.options);
  await f.setup.connectProvider(f.options);
  await f.setup.disconnectProvider(f.options);
  assert.deepEqual(await readJson(f.settingsPath), original);
});

test('a corrupt receipt cannot suppress another valid provider connection', async t => {
  const f = await fixture(t);
  const claude = await f.setup.connectProvider(f.options);
  const agyProfile = path.join(f.homeDir, '.gemini/antigravity-cli');
  await fs.mkdir(agyProfile, {recursive:true, mode:0o700});
  await f.setup.connectProvider({...f.options, provider:'antigravity'});
  await fs.writeFile(path.join(path.dirname(claude.launcherPath), 'connection.json'), '{bad', {mode:0o600});
  const connections = await f.setup.listConnections(f.options);
  assert.deepEqual(connections.map(v => v.provider), ['antigravity']);
  const refreshed = await f.setup.refreshRuntime(f.options);
  assert.equal(refreshed.warnings.length, 1);
  assert.deepEqual(refreshed.refreshed, ['antigravity']);
});

test('settings owned by another user and shared runtime directories are refused', async t => {
  const f = await fixture(t);
  await writeJson(f.settingsPath, {});
  const io = new Proxy(fs, {get(target, key) {
    if(key === 'lstat') return async file => {
      const info = await target.lstat(file);
      if(file === f.settingsPath) info.uid += 1;
      return info;
    };
    return target[key];
  }});
  await assert.rejects(createSetup({fs:io}).connectProvider(f.options), {code:'UNSAFE_PATH'});
  const result = await f.setup.connectProvider(f.options);
  await fs.chmod(path.dirname(result.launcherPath), 0o755);
  await assert.rejects(f.setup.disconnectProvider(f.options), {code:'UNSAFE_PATH'});
});

test('provider CLI symlink upgrades refresh runtime without changing settings', async t => {
  const f = await fixture(t);
  const first = path.join(f.homeDir, 'cli-first');
  const second = path.join(f.homeDir, 'cli-second');
  const alias = path.join(f.homeDir, 'cli');
  await fs.copyFile(process.execPath, first);
  await fs.chmod(first, 0o700);
  await fs.copyFile('/usr/bin/true', second);
  await fs.chmod(second, 0o700);
  await fs.symlink(first, alias);
  const result = await f.setup.connectProvider({...f.options, cliPath:alias});
  const before = await fs.readFile(f.settingsPath);
  await fs.unlink(alias);
  await fs.symlink(second, alias);
  await fs.unlink(first);
  const unrefreshed = JSON.parse(execFileSync('/bin/sh', [result.launcherPath], {input:'{}', encoding:'utf8'}));
  assert.equal(unrefreshed.args[unrefreshed.args.indexOf('--cli-lookup-path') + 1], alias);
  assert.equal(await fs.realpath(unrefreshed.args[unrefreshed.args.indexOf('--cli-lookup-path') + 1]), second);
  await f.setup.refreshRuntime(f.options);
  const run = JSON.parse(execFileSync('/bin/sh', [result.launcherPath], {input:'{}', encoding:'utf8'}));
  assert.equal(run.args[run.args.indexOf('--cli-executable') + 1], second);
  assert.deepEqual(await fs.readFile(f.settingsPath), before);
});

test('profile overrides are explicit and preview contains no existing command text', async t => {
  const f = await fixture(t);
  const custom = path.join(f.homeDir, 'custom-profile');
  await fs.mkdir(custom, {mode:0o700});
  await writeJson(path.join(custom, 'settings.json'), {statusLine:{type:'command', command:'printf secret-value'}});
  const preview = await f.setup.discoverProvider({...f.options, env:{CLAUDE_CONFIG_DIR:custom}});
  assert.equal(preview.profilePath, custom);
  assert.equal(preview.hasExistingStatusLine, true);
  assert.equal(JSON.stringify(preview).includes('secret-value'), false);
  await assert.rejects(f.setup.discoverProvider({...f.options, env:{CLAUDE_CONFIG_DIR:'relative'}}), {code:'PROFILE_REQUIRED'});
  await assert.rejects(f.setup.discoverProvider({...f.options, env:{CLAUDE_PROFILE:'unknown'}}), {code:'PROFILE_REQUIRED'});
});

test('Antigravity uses its own config and native idle usage collector', async t => {
  const f = await fixture(t, 'antigravity');
  const result = await f.setup.connectProvider(f.options);
  const config = await readJson(f.settingsPath);
  assert.equal(config.statusLine.stack_with_default, true);
  const run = JSON.parse(execFileSync('/bin/sh', [result.launcherPath], {input:'{}', encoding:'utf8'}));
  assert.equal(run.args[0], 'antigravity-statusline');
  assert.ok(run.args.includes('--agy-full-usage'));
  await assert.rejects(f.setup.discoverProvider({...f.options, env:{GEMINI_CLI_HOME:'/unknown'}}), {code:'PROFILE_REQUIRED'});
});

test('Codex connect appends one managed Stop hook and preserves unrelated hooks', async t => {
  const f = await fixture(t, 'codex'),invocation=path.join(f.homeDir,'codex-invocation.json');
  await fs.writeFile(f.collectorPath,`const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(invocation)},JSON.stringify({args:process.argv.slice(2),input:fs.readFileSync(0,'utf8'),electron:process.env.ELECTRON_RUN_AS_NODE}));process.stdout.write('PRIVATE');process.stderr.write('PRIVATE');`,{mode:0o600});
  const sessionStart = [{matcher:'.*', hooks:[{type:'command',command:'printf session'}]}];
  const originalStop = [{matcher:'first',hooks:[{type:'command',command:'printf first'}]}, {matcher:'second',hooks:[{type:'command',command:'printf second'}]}];
  await writeJson(f.settingsPath, {theme:'dark', hooks:{SessionStart:sessionStart, Stop:originalStop}});
  const first = await f.setup.connectProvider(f.options), second = await f.setup.connectProvider(f.options);
  assert.equal(first.backupPath, second.backupPath);
  const config = await readJson(f.settingsPath);
  assert.equal(config.theme, 'dark');assert.deepEqual(config.hooks.SessionStart, sessionStart);assert.deepEqual(config.hooks.Stop.slice(0,2), originalStop);
  const managed = config.hooks.Stop.filter(entry => entry.hooks?.some(hook => hook.command?.includes('llm-account-usage-managed-v1')));
  assert.equal(managed.length, 1);assert.equal(managed[0].matcher, '.*');assert.equal(managed[0].hooks[0].type, 'command');
  assert.deepEqual((await f.setup.listConnections(f.options)).map(value=>value.provider), ['codex']);
  const input=JSON.stringify({hook_event_name:'Stop',session_id:'s'}),run=execFileSync('/bin/sh',['-c',managed[0].hooks[0].command],{input,encoding:'utf8'});
  assert.equal(run,'');const called=await readJson(invocation);assert.equal(called.args[0],'codex-hook');assert.ok(called.args.includes('--report-dir'));assert.equal(called.args.includes('--claude-auth-status'),false);assert.equal(called.args.includes('--agy-full-usage'),false);assert.equal(called.input,input);assert.equal(called.electron,'1');
});

test('Codex disconnect removes only its exact managed Stop hook', async t => {
  const f = await fixture(t, 'codex'),original={matcher:'original',hooks:[{type:'command',command:'printf original'}]};
  await writeJson(f.settingsPath, {hooks:{Stop:[original]},theme:'before'});
  await f.setup.connectProvider(f.options);
  const config = await readJson(f.settingsPath),later={matcher:'later',hooks:[{type:'command',command:'printf later'}]};
  config.hooks.Stop.push(later);config.theme='later';await writeJson(f.settingsPath, config);
  const disconnected=await f.setup.disconnectProvider(f.options);assert.equal(disconnected.connected,false);
  const restored=await readJson(f.settingsPath);assert.deepEqual(restored,{hooks:{Stop:[original,later]},theme:'later'});
  assert.deepEqual(await f.setup.listConnections(f.options),[]);
});

test('edited or replaced managed Codex hooks fail closed with recovery intact', async t => {
  const f = await fixture(t, 'codex'),installed=await f.setup.connectProvider(f.options);
  const backup=await fs.readFile(installed.backupPath),runtime=await fs.readFile(path.join(path.dirname(installed.launcherPath),'passive.cjs'));
  const config=await readJson(f.settingsPath),managed=config.hooks.Stop.find(entry=>entry.hooks?.some(hook=>hook.command?.includes('llm-account-usage-managed-v1')));
  managed.hooks[0].command='printf replacement # llm-account-usage-managed-v1';await writeJson(f.settingsPath,config);
  const changed=await fs.readFile(f.settingsPath);await fs.writeFile(f.collectorPath,'process.stdout.write("changed");',{mode:0o600});
  const refreshed=await f.setup.refreshRuntime(f.options);assert.equal(refreshed.refreshed.includes('codex'),false);assert.equal(refreshed.warnings.length,1);
  assert.deepEqual(await fs.readFile(path.join(path.dirname(installed.launcherPath),'passive.cjs')),runtime);
  await assert.rejects(f.setup.connectProvider(f.options),{code:'SETTINGS_CHANGED'});await assert.rejects(f.setup.disconnectProvider(f.options),{code:'SETTINGS_CHANGED'});
  assert.deepEqual(await fs.readFile(f.settingsPath),changed);assert.deepEqual(await fs.readFile(installed.backupPath),backup);
});

test('unsafe config, symlink directories and unrecognized statuslines are refused', async t => {
  const f = await fixture(t);
  await writeJson(f.settingsPath, {statusLine:{type:'prompt', command:'private'}});
  await assert.rejects(f.setup.connectProvider(f.options), {code:'UNSUPPORTED_STATUSLINE'});
  await writeJson(f.settingsPath, {});
  await fs.chmod(f.settingsPath, 0o666);
  await assert.rejects(f.setup.connectProvider(f.options), {code:'UNSAFE_PATH'});
  await fs.chmod(f.settingsPath, 0o600);
  const link = path.join(f.homeDir, 'linked-profile');
  await fs.symlink(f.profilePath, link);
  await assert.rejects(f.setup.connectProvider({...f.options, profilePath:link}), {code:'UNSAFE_PATH'});
  await fs.unlink(f.settingsPath);
  await fs.symlink(f.collectorPath, f.settingsPath);
  await assert.rejects(f.setup.connectProvider(f.options), {code:'UNSAFE_PATH'});
});

test('non-Linux hosts, missing profiles and script-based CLI launchers are explicit failures', async t => {
  const f = await fixture(t);
  await assert.rejects(f.setup.connectProvider({...f.options, platform:'win32'}), {code:'UNSUPPORTED_PLATFORM'});
  await assert.rejects(f.setup.connectProvider({...f.options, profilePath:path.join(f.homeDir,'missing')}), {code:'PROFILE_REQUIRED'});
  const script = path.join(f.homeDir, 'claude');
  await fs.writeFile(script, '#!/bin/sh\nexit 0\n', {mode:0o700});
  await assert.rejects(f.setup.connectProvider({...f.options, cliPath:script}), {code:'UNSUPPORTED_CLI'});
});

test('compare-before-write refuses a concurrent provider settings edit', async t => {
  const f = await fixture(t);
  await writeJson(f.settingsPath, {old:true});
  let changed = false;
  const io = new Proxy(fs, {get(target, key) {
    if(key === 'open') return async (filename, ...args) => {
      if(path.dirname(String(filename)) === f.profilePath && path.basename(String(filename)).startsWith('.account-usage-')) {
        changed = true;
        await writeJson(f.settingsPath, {new:true});
      }
      return target.open(filename, ...args);
    };
    return target[key];
  }});
  const setup = createSetup({fs:io});
  await assert.rejects(setup.connectProvider(f.options), {code:'SETTINGS_CHANGED'});
  assert.equal(changed, true);
  assert.deepEqual(await readJson(f.settingsPath), {new:true});
});
