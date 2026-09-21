'use strict';
// Same-user Linux setup only. No credential files, login flows, network requests,
// privileged operations, or changes to VS Code's own settings.
const fs = require('node:fs/promises');
const {constants} = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {randomUUID, createHash} = require('node:crypto');
const {isDeepStrictEqual} = require('node:util');
const {promisify} = require('node:util');
const {execFile} = require('node:child_process');
const {connectionIdentity, sameProcess} = require('./connection.cjs');
const PROVIDERS = ['claude', 'codex', 'antigravity'];
const MARKER = 'llm-account-usage-managed-v1';
const MAX_SETTINGS = 1024 * 1024;
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const sameBytes = (a, b) => a === null ? b === null : b !== null && a.equals(b);
function failure(code, message) { const error = new Error(message); error.code = code; error.safeToDisplay = true; return error; }
function recoverable(code, message, recoveryAction) {
  return Object.assign(failure(code, message), {recoverable:true, recoveryAction});
}
const managedStatusLine = line => typeof line?.command === 'string' && line.command.includes(MARKER);
function installedCommand(launcherPath, originalStatusLine) {
  // Let the provider's existing shell interpret the exact user-owned source.
  // The launcher only duplicates raw stdin; it never selects an interpreter
  // for the original command or evaluates vendor data as source.
  return originalStatusLine
    ? `${quote(launcherPath)} | (\n${originalStatusLine.command}\n)\n# ${MARKER}`
    : `${quote(launcherPath)} # ${MARKER}`;
}
function installedCodexHook(launcherPath) {
  return {matcher:'.*', hooks:[{type:'command', statusMessage:'Account Usage', command:`${quote(launcherPath)} # ${MARKER}`}]};
}
const managedCodexHook = entry => Array.isArray(entry?.hooks) && entry.hooks.some(hook =>
  typeof hook?.command === 'string' && hook.command.includes(MARKER));

function createSetup(dependencies = {}) {
  const io = dependencies.fs || fs;
  const executeFile = dependencies.execFile || promisify(execFile);
  function options(input = {}) {
    const result = {homeDir:os.homedir(), env:process.env, platform:process.platform,
      uid:process.getuid?.(), systemUid:0, nodePath:process.execPath, ...dependencies, ...input};
    if(result.platform !== 'linux' || !Number.isSafeInteger(result.uid))
      throw failure('UNSUPPORTED_PLATFORM', 'Provider setup supports Linux terminal hosts, including Remote-SSH to Linux.');
    if(result.provider !== undefined && !PROVIDERS.includes(result.provider))
      throw failure('UNSUPPORTED_PROVIDER', 'Choose Claude Code, Codex, or Antigravity CLI.');
    return result;
  }
  function absolute(value, code = 'UNSAFE_PATH') {
    if(typeof value !== 'string' || !path.isAbsolute(value) || /[\0\r\n]/.test(value))
      throw failure(code, 'An absolute local path is required.');
    return path.resolve(value);
  }
  async function stat(file) {
    try { return await io.lstat(file); } catch(error) { if(error.code === 'ENOENT') return null; throw error; }
  }
  function reviewItem(file, entry, kind) {
    return {path:file, kind, uid:entry.uid, gid:entry.gid, mode:entry.mode & 0o7777};
  }
  const hasPathTrust = (file, o, kind) => Array.isArray(o.trustedDirectories) &&
    o.trustedDirectories.some(saved => saved?.path === file && saved.kind === kind);
  function requirePathTrust(file, entry, o, kind) {
    const item = reviewItem(file, entry, kind);
    const approved = Array.isArray(o.trustedDirectories) && o.trustedDirectories.some(saved =>
      saved?.path === item.path && saved.kind === item.kind && saved.uid === item.uid &&
      saved.gid === item.gid && saved.mode === item.mode);
    if(approved) {
      if(o.usedPathTrust)o.usedPathTrust.set(`${kind}:${file}`, item);
      return;
    }
    if(o.sharedDirectoryReview) {
      o.sharedDirectoryReview.set(`${kind}:${file}`, item);
      return;
    }
    throw failure('DIRECTORY_TRUST_REQUIRED',
      `A path is controlled by another Linux owner or writable by a shared group. Connect Provider again to review and trust it: ${file}`);
  }
  // Inspect every path component. System-owned ancestors are acceptable; an
  // owner-owned sticky directory (e.g. /tmp) is not acceptable as our data root.
  async function safeDirectories(directory, o, {create = false, privateLeaf = false, ownerLeaf = true, allowMissing = false} = {}) {
    const target = absolute(directory);
    let current = path.parse(target).root;
    for(const segment of target.slice(current.length).split('/').filter(Boolean)) {
      current = path.join(current, segment);
      let entry = await stat(current);
      if(!entry && create) {
        try { await io.mkdir(current, {mode:0o700}); } catch(error) { if(error.code !== 'EEXIST') throw error; }
        entry = await stat(current);
      }
      if(!entry && allowMissing) break;
      if(!entry) throw failure('PROFILE_REQUIRED', 'The selected profile directory does not exist. Sign in with the provider separately first.');
      const leaf = current === target;
      const trustedSticky = !leaf && entry.uid === o.systemUid && (entry.mode & 0o1000);
      const externalOwner = entry.uid !== o.uid && entry.uid !== o.systemUid;
      if(entry.isSymbolicLink() || !entry.isDirectory() ||
        (leaf && ownerLeaf && externalOwner) ||
        ((entry.mode & 0o002) && !trustedSticky) ||
        (leaf && privateLeaf && (entry.mode & 0o077)))
        throw failure('UNSAFE_PATH', `Setup refused an unsafe directory owner, link, or permission mode: ${current}`);
      if(hasPathTrust(current, o, 'directory') || (!trustedSticky && (externalOwner || (entry.mode & 0o020))))
        requirePathTrust(current, entry, o, 'directory');
    }
    return target;
  }
  async function readSafe(file, o, {privateFile = false, limit = MAX_SETTINGS} = {}) {
    await safeDirectories(path.dirname(file), o);
    const entry = await stat(file);
    if(!entry) return null;
    if(!entry.isFile() || entry.isSymbolicLink() || entry.uid !== o.uid ||
      (entry.mode & 0o022) || (privateFile && (entry.mode & 0o077)) || entry.nlink !== 1 || entry.size > limit)
      throw failure('UNSAFE_PATH', 'Setup refused an unsafe file owner, link, size, or permission mode.');
    const handle = await io.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      if(opened.ino !== entry.ino || opened.dev !== entry.dev) throw failure('SETTINGS_CHANGED', 'The file changed while setup was reading it.');
      const bytes = await handle.readFile();
      if(bytes.length > limit) throw failure('UNSAFE_PATH', 'The configuration file is too large.');
      return bytes;
    } finally { await handle.close(); }
  }
  function parse(bytes) {
    if(bytes === null) return {};
    let result;
    try { result = JSON.parse(bytes.toString('utf8')); } catch { throw failure('INVALID_SETTINGS', 'The settings file must contain a JSON object. Setup left it unchanged.'); }
    if(!object(result)) throw failure('INVALID_SETTINGS', 'The settings file must contain a JSON object. Setup left it unchanged.');
    return result;
  }
  async function replace(file, bytes, expected, o, mode = 0o600) {
    await safeDirectories(path.dirname(file), o);
    const temporary = path.join(path.dirname(file), `.account-usage-${randomUUID()}.tmp`);
    const handle = await io.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      if(!sameBytes(await readSafe(file, o), expected))
        throw failure('SETTINGS_CHANGED', 'Settings changed during setup. Nothing was overwritten; retry after reviewing the change.');
      await safeDirectories(path.dirname(file), o);
      await io.rename(temporary, file);
    } finally {
      await handle.close().catch(() => {});
      await io.unlink(temporary).catch(error => { if(error.code !== 'ENOENT') throw error; });
    }
  }
  async function put(file, bytes, o, mode) {
    const existing = await readSafe(file, o, {privateFile:true});
    if(!sameBytes(bytes, existing)) await replace(file, bytes, existing, o, mode);
  }
  async function nativeExecutable(file, o, code = 'UNSUPPORTED_CLI') {
    let real;
    try { real = await io.realpath(absolute(file, code)); } catch { throw failure(code, 'The native executable was not found on this Linux host.'); }
    await safeDirectories(path.dirname(real), o, {ownerLeaf:false});
    const entry = await io.stat(real);
    if(!entry.isFile() || !(entry.mode & 0o111) || (entry.mode & 0o002))
      throw failure(code, 'The executable must be a trusted native Linux binary that is not writable by everyone.');
    if(hasPathTrust(real, o, 'executable') || (entry.mode & 0o020) || ![o.systemUid, o.uid].includes(entry.uid))
      requirePathTrust(real, entry, o, 'executable');
    const handle = await io.open(real, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const magic = Buffer.alloc(4);
      await handle.read(magic, 0, 4, 0);
      if(!magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])))
        throw failure(code, 'This connection requires the native Linux CLI. Script or npm launchers cannot be matched safely.');
    } finally { await handle.close(); }
    return real;
  }
  async function findCli(o) {
    if(o.cliPath) return {cliPath:await nativeExecutable(o.cliPath, o), cliLookupPath:absolute(o.cliPath)};
    const command = o.provider === 'claude' ? 'claude' : o.provider === 'codex' ? 'codex' : 'agy';
    for(const directory of String(o.env.PATH || '').split(path.delimiter)) {
      if(!path.isAbsolute(directory)) continue;
      const candidate = path.join(directory, command);
      if(await stat(candidate)) return {cliPath:await nativeExecutable(candidate, o), cliLookupPath:candidate};
    }
    throw failure('CLI_NOT_FOUND', `The native ${command} CLI is not on this host's PATH. Select its executable explicitly.`);
  }
  function profile(o) {
    if(o.profilePath) return absolute(o.profilePath, 'PROFILE_REQUIRED');
    const suspicious = Object.keys(o.env).some(key => o.env[key] &&
      (o.provider === 'claude' ? /^CLAUDE_.*(?:PROFILE|CONFIG|HOME)/.test(key) && key !== 'CLAUDE_CONFIG_DIR'
        : o.provider === 'codex' ? /^CODEX_.*(?:PROFILE|CONFIG|HOME|DIR)/.test(key) && key !== 'CODEX_HOME'
          : /^(?:AGY|ANTIGRAVITY|GEMINI)_.*(?:PROFILE|CONFIG|HOME|DIR)/.test(key)));
    if(suspicious || o.profileOverrideDetected)
      throw failure('PROFILE_REQUIRED', 'A provider profile override is present. Select its exact settings directory explicitly.');
    if(o.provider === 'claude' && o.env.CLAUDE_CONFIG_DIR) return absolute(o.env.CLAUDE_CONFIG_DIR, 'PROFILE_REQUIRED');
    if(o.provider === 'codex' && o.env.CODEX_HOME) return absolute(o.env.CODEX_HOME, 'PROFILE_REQUIRED');
    return path.join(absolute(o.homeDir), o.provider === 'claude' ? '.claude' : o.provider === 'codex' ? '.codex' : '.gemini/antigravity-cli');
  }
  function checkStatusLine(config) {
    if(!own(config, 'statusLine')) return;
    const line = config.statusLine;
    if(!object(line) || line.type !== 'command' || typeof line.command !== 'string' || !line.command.trim() || line.command.includes('\0'))
      throw failure('UNSUPPORTED_STATUSLINE', 'The existing status line is not a supported command. Setup left it unchanged.');
    if(line.enabled === false) throw failure('UNSUPPORTED_STATUSLINE', 'The existing status line is disabled. Enable it in the provider before connecting.');
  }
  function checkCodexHooks(config) {
    if(own(config, 'hooks') && (!object(config.hooks) || Object.values(config.hooks).some(value => !Array.isArray(value))))
      throw failure('UNSUPPORTED_HOOKS', 'The existing Codex hooks file has an unsupported shape. Setup left it unchanged.');
  }
  function codexHookState(config, installedHook) {
    checkCodexHooks(config);
    const events = object(config.hooks) ? Object.values(config.hooks) : [], entries = events.flat(), stop=config.hooks?.Stop||[];
    return {exact:stop.filter(entry => isDeepStrictEqual(entry, installedHook)), managed:entries.filter(managedCodexHook)};
  }
  async function inspect(o, {validateStatusLine = true} = {}) {
    if(!o.provider) throw failure('UNSUPPORTED_PROVIDER', 'Choose a provider.');
    const selectedProfile = profile(o);
    await safeDirectories(selectedProfile, o);
    const profilePath = await io.realpath(selectedProfile);
    const settingsPath = path.join(profilePath, o.provider === 'codex' ? 'hooks.json' : 'settings.json');
    const bytes = await readSafe(settingsPath, o);
    const config = parse(bytes);
    if(o.provider === 'codex') checkCodexHooks(config);else if(validateStatusLine) checkStatusLine(config);
    const identity = connectionIdentity({provider:o.provider, uid:o.uid, settingsPath});
    return {identity, id:identity.id, provider:o.provider, profilePath, settingsPath, ...await findCli(o),
      hasExistingStatusLine:o.provider !== 'codex' && own(config, 'statusLine'), hasExistingHooks:o.provider === 'codex' && own(config, 'hooks'), bytes, config};
  }
  async function discoverProvider(input) {
    const o = options(input);
    // Discovery only reads. Collect exact directories for the connection's
    // confirmation; permission to use them is never inferred from membership.
    o.sharedDirectoryReview = new Map();
    const {bytes, config, ...preview} = await inspect(o);
    await safeDirectories(o.storagePath, o, {allowMissing:true});
    let loc=locations(o,preview.identity);
    // Connect scans this parent even when it ultimately reuses legacy storage.
    const scanParent=path.dirname(loc.root);
    if(await stat(scanParent))await safeDirectories(scanParent,o);
    const legacy=legacyLocations(o,o.provider);
    const legacyOptions={...o,sharedDirectoryReview:new Map()};
    try {
      if(await stat(legacy.root)) {
        await safeDirectories(legacy.root,legacyOptions,{privateLeaf:true});
        const data=await receipt(legacyOptions,legacy);
        if(data?.id===preview.id) {
          loc=legacy;
          // Review the runtime that connect will reuse, without asking for
          // trust in an unrelated profile's legacy storage.
          for(const [key,item] of legacyOptions.sharedDirectoryReview)o.sharedDirectoryReview.set(key,item);
        }
      }
    } catch { /* An unverifiable legacy neighbor cannot select this profile's runtime. */ }
    await safeDirectories(loc.root, o, {allowMissing:true});
    await nativeExecutable(o.nodePath, o, 'UNSUPPORTED_RUNTIME');
    return {...preview, sharedDirectories:[...o.sharedDirectoryReview.values()]};
  }
  function locations(o, identity) {
    if(!identity || typeof identity.id !== 'string' || !/^v2-[a-f0-9]{32}$/.test(identity.id))
      throw failure('INVALID_CONNECTION', 'A valid profile connection is required.');
    // The provider still invokes this hook after an editor uninstall. Its
    // launcher and original-command recovery must outlive editor-owned storage.
    const root = path.join(absolute(o.homeDir), '.local/state/llm-account-usage/connections', identity.id);
    return {id:identity.id, legacy:false, ...runtimeLocations(root)};
  }
  function runtimeLocations(root) {
    return {root, receiptPath:path.join(root, 'connection.json'), launcherPath:path.join(root, 'run.sh'),
      collectorPath:path.join(root, 'passive.cjs'), reportDir:path.join(root, 'reports')};
  }
  function legacyLocations(o, provider) {
    const root=path.join(absolute(o.homeDir),'.local/state/llm-account-usage/providers',provider);
    return {provider,legacy:true,...runtimeLocations(root)};
  }
  async function connectionLocations(o, {reserveSlot=false} = {}) {
    const parent=path.join(absolute(o.homeDir),'.local/state/llm-account-usage/connections');
    if(!await stat(parent))return [];
    await safeDirectories(parent,o);
    const names=[];
    let count=0;
    for await(const entry of await io.opendir(parent)) {
      if(++count>(reserveSlot?127:128))throw failure('TOO_MANY_CONNECTIONS','Too many saved profile connections were found.');
      if(entry.isDirectory()&&/^v2-[a-f0-9]{32}$/.test(entry.name))names.push(entry.name);
    }
    return names.sort().map(id=>locations(o,{id}));
  }
  async function savedConnections(o) {
    const candidates=[...await connectionLocations(o),...PROVIDERS.map(provider=>legacyLocations(o,provider))];
    const entries=[],identities=new Set();
    for(const loc of candidates) {
      let data;
      try {
        if(!await stat(loc.root))continue;
        await safeDirectories(loc.root,o,{privateLeaf:true});
        data=await receipt({...o,provider:undefined},loc);
      } catch(error) {
        entries.push({loc,error});
        continue;
      }
      if(data) {
        // Check claims before owner/hook filtering: an ambiguous identity must
        // never select whichever receipt happens to look active first.
        if(identities.has(data.id))throw failure('DUPLICATE_CONNECTION',
          'Multiple saved receipts claim the same profile connection. Review them before changing provider setup.');
        identities.add(data.id);
        loc.id=data.id;
      }
      entries.push({loc,data});
    }
    return entries;
  }
  async function savedLocation(o,id) {
    const entries=await savedConnections(o);
    // An interrupted v2 attempt may have left an empty directory beside the
    // valid legacy receipt. Only a validated receipt can choose its location.
    return entries.find(entry=>entry.data?.id===id)?.loc || entries.find(entry=>entry.loc.id===id)?.loc;
  }
  function pendingProcess(value, uid) {
    if(value === undefined || value === null)return null;
    if(!object(value) || !Number.isSafeInteger(value.pid) || value.pid<=0 || value.uid!==uid ||
      typeof value.start_ticks!=='string' || !/^\d{1,30}$/.test(value.start_ticks) ||
      typeof value.boot_id!=='string' || !value.boot_id.length || value.boot_id.length>128 || /[\0\r\n]/.test(value.boot_id))
      throw failure('INVALID_PROCESS','The pending process must identify a process owned by this connection.');
    return {pid:value.pid,uid:value.uid,start_ticks:value.start_ticks,boot_id:value.boot_id};
  }
  async function receipt(o, loc) {
    const bytes = await readSafe(loc.receiptPath, o, {privateFile:true});
    if(bytes === null) return null;
    const data = parse(bytes);
    const kind = data.kind || (data.provider === 'codex' ? null : 'statusline');
    let identity;
    try { identity=connectionIdentity(data); } catch { /* Rejected below. */ }
    const version = loc.legacy ? data.version === 1 && data.provider === loc.provider &&
      (!loc.id || identity?.id === loc.id) : data.version === 2 && data.id === loc.id && identity?.id === loc.id;
    const profilePath=loc.legacy && identity ? path.dirname(identity.settingsPath) : data.profilePath;
    const common = version && identity &&
      (!o.provider || data.provider === o.provider) && data.uid === o.uid &&
      data.settingsPath === identity.settingsPath && typeof profilePath === 'string' &&
      data.settingsPath === path.join(profilePath, data.provider === 'codex' ? 'hooks.json' : 'settings.json') &&
      ['connected', 'disconnected'].includes(data.status) && typeof data.cliPath === 'string' &&
      typeof data.cliLookupPath === 'string' && typeof data.ownerStoragePath === 'string';
    const statusline = kind === 'statusline' && object(data.installedStatusLine) &&
      (data.hadStatusLine ? object(data.originalStatusLine) && typeof data.originalStatusLine.command === 'string' : true) &&
      data.installedStatusLine.command === installedCommand(loc.launcherPath, data.hadStatusLine ? data.originalStatusLine : null) &&
      typeof data.hadStatusLine === 'boolean' && typeof data.backupName === 'string' && /^settings\.before-[\w-]+\.json$/.test(data.backupName);
    const codex = kind === 'codex-hook' && isDeepStrictEqual(data.installedHook, installedCodexHook(loc.launcherPath)) &&
      typeof data.hadHooks === 'boolean' && typeof data.hadStop === 'boolean' && typeof data.backupName === 'string' &&
      /^hooks\.before-[\w-]+\.json$/.test(data.backupName);
    if(!common || (!statusline && !codex))
      throw failure('INVALID_RECEIPT', 'The saved connection cannot be verified. Provider settings were left unchanged.');
    absolute(data.settingsPath);
    data.id=identity.id;
    data.profilePath=profilePath;
    absolute(data.profilePath);
    data.pendingProcess=pendingProcess(data.pendingProcess,data.uid);
    data.kind = kind;
    return data;
  }
  async function processIdentity(pid) {
    const proc = `/proc/${pid}`;
    const [record, info, boot] = await Promise.all([
      io.readFile(`${proc}/stat`, 'utf8'), io.stat(proc), io.readFile('/proc/sys/kernel/random/boot_id', 'utf8')]);
    const fields = record.slice(record.lastIndexOf(')') + 2).trim().split(/\s+/);
    const start_ticks = fields[19], boot_id = boot.trim();
    if(!/^\d{1,30}$/.test(start_ticks || '') || !/^[a-f0-9-]{36}$/i.test(boot_id))
      throw failure('SETUP_LOCK_UNVERIFIABLE', 'The Linux process identity could not be verified.');
    return {pid, uid:info.uid, start_ticks, boot_id};
  }
  function sameOwner(a, b) {
    return sameProcess(a,b);
  }
  function invalidLock(loc) {
    return recoverable('SETUP_LOCK_UNVERIFIABLE',
      `The saved setup lock cannot be verified. Review it before removing it: ${path.join(loc.root, '.setup-lock')}`, 'review-lock');
  }
  async function reclaimDeadLock(anchor, loc, o, self) {
    let directory, ownerFile;
    try {
      directory = await io.open(`${anchor}/.setup-lock`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const info = await directory.stat();
      if(info.uid !== o.uid || (info.mode & 0o5777) !== 0o700) throw invalidLock(loc);
      const pinned = `/proc/self/fd/${directory.fd}`, entries = [];
      const iterator = await io.opendir(pinned);
      for await(const entry of iterator) { entries.push(entry.name); if(entries.length > 1) break; }
      // Empty directories are the release window and can be replaced by rename.
      if(entries.length === 0) return;
      if(entries.length !== 1 || !/^owner-[a-f0-9-]{36}\.json$/.test(entries[0])) throw invalidLock(loc);
      ownerFile = await io.open(`${pinned}/${entries[0]}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const st = await ownerFile.stat();
      if(!st.isFile() || st.uid !== o.uid || st.nlink !== 1 || (st.mode & 0o7777) !== 0o600 || st.size > 512) throw invalidLock(loc);
      const bytes = Buffer.alloc(513), {bytesRead} = await ownerFile.read(bytes, 0, 513, 0);
      if(bytesRead > 512) throw invalidLock(loc);
      let owner;
      try { owner = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')); } catch { throw invalidLock(loc); }
      if(!object(owner) || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || owner.uid !== o.uid ||
        !/^\d{1,30}$/.test(owner.start_ticks || '') || !/^[a-f0-9-]{36}$/i.test(owner.boot_id || '')) throw invalidLock(loc);
      let dead = owner.boot_id !== self.boot_id;
      if(!dead) {
        try { dead = !sameOwner(owner, await processIdentity(owner.pid)); }
        catch { try { await io.stat(`/proc/${owner.pid}`); } catch(error) { if(error.code === 'ENOENT') dead = true; } }
      }
      if(!dead) throw failure('SETUP_BUSY', 'Another setup is in progress. Retry after it finishes.');
      // Only the unique dead owner's marker is removed. A concurrent winner's
      // non-empty lock cannot be removed by rmdir.
      await io.unlink(`${pinned}/${entries[0]}`);
      try { await io.rmdir(`${anchor}/.setup-lock`); } catch(error) { if(!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; }
    } catch(error) {
      if(error.code === 'ENOENT') return;
      if(error.safeToDisplay) throw error;
      throw invalidLock(loc);
    } finally { await ownerFile?.close(); await directory?.close(); }
  }
  async function locked(o, loc, action) {
    await safeDirectories(loc.root, o, {create:true, privateLeaf:true});
    const root = await io.open(loc.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const anchor = `/proc/self/fd/${root.fd}`, unique = randomUUID();
    const prepared = `${anchor}/.setup-${unique}`, marker = `owner-${unique}.json`;
    let acquired = false, preparedExists = false;
    try {
      const self = await processIdentity(process.pid);
      await io.mkdir(prepared, {mode:0o700}); preparedExists = true;
      await io.writeFile(`${prepared}/${marker}`, json(self), {mode:0o600, flag:'wx'});
      for(let attempt = 0; attempt < 3; attempt++) {
        try { await io.rename(prepared, `${anchor}/.setup-lock`); acquired = true; preparedExists = false; break; }
        catch(error) { if(!['EEXIST', 'ENOTEMPTY', 'ENOTDIR', 'EISDIR'].includes(error.code)) throw error; }
        await reclaimDeadLock(anchor, loc, o, self);
      }
      if(!acquired) throw failure('SETUP_BUSY', 'Another setup is in progress. Retry after it finishes.');
      return await action(loc);
    } finally {
      try {
        if(acquired) {
          try { await io.unlink(`${anchor}/.setup-lock/${marker}`); await io.rmdir(`${anchor}/.setup-lock`); }
          catch(error) { if(!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; }
        } else if(preparedExists) {
          await io.unlink(`${prepared}/${marker}`).catch(error => { if(error.code !== 'ENOENT') throw error; });
          await io.rmdir(prepared);
        }
      } finally { await root.close(); }
    }
  }
  async function retireMissingHook(o, loc, data) {
    if(data?.status !== 'connected') return data;
    const config = await stat(data.settingsPath) ? parse(await readSafe(data.settingsPath, o)) : {};
    if(data.kind === 'codex-hook') {
      const state = codexHookState(config, data.installedHook);
      if(state.exact.length === 1 && state.managed.length === 1) return data;
      if(state.managed.length) throw failure('SETTINGS_CHANGED', 'The installed Account Usage Codex hook was edited. Review it before reconnecting or disconnecting.');
      const original = parse(await readSafe(path.join(loc.root, data.backupName), o, {privateFile:true}));
      if(!isDeepStrictEqual(config, original))
        throw failure('SETTINGS_CHANGED', 'The installed Account Usage Codex hook was replaced. Review it before reconnecting or disconnecting.');
      data.status = 'disconnected';
      await put(loc.receiptPath, json(data), o, 0o600);
    } else if(managedStatusLine(config.statusLine)) {
      if(!isDeepStrictEqual(config.statusLine, data.installedStatusLine))
        throw failure('SETTINGS_CHANGED', 'The installed Account Usage status line was edited. Review it before reconnecting or disconnecting.');
    } else {
      // A crash before installing, a crash after restoring, or manual removal
      // needs only receipt recovery. Never restore over the user's replacement.
      data.status = 'disconnected';
      await put(loc.receiptPath, json(data), o, 0o600);
    }
    return data;
  }
  async function claimConnection(o, loc, data) {
    if(data.ownerStoragePath === absolute(o.storagePath)) return;
    if(await stat(absolute(data.ownerStoragePath)))
      throw failure('ALREADY_CONNECTED', 'This provider is already connected by another editor. Disconnect it there before connecting here.');
    if(o.confirmTakeover !== true)
      throw recoverable('TAKEOVER_REQUIRED', 'The original editor storage is missing. Explicit confirmation is required to take over this saved provider connection.', 'confirm-takeover');
    await safeDirectories(o.storagePath, o, {create:true});
    // The absent owner is checked again immediately before the receipt write.
    if(await stat(data.ownerStoragePath)) throw failure('ALREADY_CONNECTED', 'The original editor storage reappeared. Disconnect in that editor first.');
    data.ownerStoragePath = absolute(o.storagePath);
    await put(loc.receiptPath, json(data), o, 0o600);
  }
  function publicConnection(data, loc) {
    return {id:data.id, legacy:loc.legacy, provider:data.provider, uid:data.uid, profilePath:data.profilePath,
      pendingProcess:data.pendingProcess, connected:data.status === 'connected', settingsPath:data.settingsPath,
      cliLookupPath:data.cliLookupPath, reportDir:loc.reportDir, launcherPath:loc.launcherPath,
      backupPath:path.join(loc.root, data.backupName)};
  }
  async function writeRuntime(o, loc, data) {
    const nodePath = await nativeExecutable(o.nodePath, o, 'UNSUPPORTED_RUNTIME');
    const cliOptions = {...o, usedPathTrust:new Map()};
    const cliPath = await nativeExecutable(data.cliLookupPath, cliOptions);
    const commands = o.provider === 'codex' ? ['/bin/sh', '/usr/bin/timeout'] :
      ['/bin/sh', '/usr/bin/cat', '/usr/bin/tee', '/usr/bin/mktemp', '/usr/bin/mkfifo', '/usr/bin/timeout', '/usr/bin/rm', '/usr/bin/rmdir'];
    for(const command of commands)
      await nativeExecutable(command, o, 'UNSUPPORTED_RUNTIME');
    if(o.provider !== 'codex') {
      const {stdout} = await executeFile('/usr/bin/tee', ['--version'], {timeout:2000, maxBuffer:4096, encoding:'utf8'});
      if(!/(?:GNU|uutils) coreutils/.test(stdout)) throw failure('UNSUPPORTED_RUNTIME', 'Provider setup requires GNU-compatible coreutils on this Linux host.');
    }
    const sourcePath = absolute(o.collectorPath);
    const source = await io.readFile(sourcePath);
    if(source.length > 1024 * 1024) throw failure('UNSAFE_PATH', 'The bundled collector is too large.');
    const trustedCliPathsJson = JSON.stringify([...cliOptions.usedPathTrust.values()]);
    if(Buffer.byteLength(trustedCliPathsJson) > 32768 || cliOptions.usedPathTrust.size > 128)
      throw failure('UNSAFE_PATH', 'The reviewed CLI path is too deep to save safely.');
    const args = [nodePath, loc.collectorPath, o.provider === 'codex' ? 'codex-hook' : `${o.provider}-statusline`, '--cli-executable', cliPath,
      '--cli-lookup-path', data.cliLookupPath,
      '--trusted-cli-paths-json', trustedCliPathsJson,
      '--report-dir', loc.reportDir];
    if(o.provider !== 'codex') args.push(o.provider === 'claude' ? '--claude-auth-status' : '--agy-full-usage');
    const collector = 'ELECTRON_RUN_AS_NODE=1 /usr/bin/timeout --kill-after=1s 12s ' + args.map(quote).join(' ');
    let script = `#!/bin/sh\n# ${MARKER}\n`;
    if(o.provider === 'codex') {
      script += `if [ -x ${quote(nodePath)} ] && [ -r ${quote(loc.collectorPath)} ]; then ${collector} >/dev/null 2>/dev/null; fi\nexit 0\n`;
    } else if(data.hadStatusLine) {
      // The shell supervisor owns the original stream independently of Node.
      // A FIFO contains bytes only in kernel memory. GNU tee keeps forwarding
      // them when a failed collector closes its branch. Wait keeps the provider
      // ancestor alive; timeout also bounds a broken collector itself.
      script += `if [ ! -x ${quote(nodePath)} ] || [ ! -r ${quote(loc.collectorPath)} ]; then exec /usr/bin/cat; fi\n`;
      script += `stream_dir=$(/usr/bin/mktemp -d ${quote(path.join(loc.root, '.stream-XXXXXXXX'))}) || exec /usr/bin/cat\n`;
      script += `/usr/bin/mkfifo -m 600 "$stream_dir/input" || { /usr/bin/rmdir "$stream_dir"; exec /usr/bin/cat; }\n`;
      script += `trap '/usr/bin/rm -f "$stream_dir/input"; /usr/bin/rmdir "$stream_dir"' 0\n`;
      script += `${collector} <"$stream_dir/input" >/dev/null 2>/dev/null &\ncollector_pid=$!\n`;
      script += `trap 'kill "$collector_pid" 2>/dev/null; exit 1' 1 2 15\n`;
      script += `/usr/bin/tee --output-error=warn-nopipe "$stream_dir/input" 2>/dev/null\n`;
      script += `wait "$collector_pid" 2>/dev/null\nexit 0\n`;
    } else {
      script += `if [ -x ${quote(nodePath)} ] && [ -r ${quote(loc.collectorPath)} ]; then ${collector}; fi\nexit 0\n`;
    }
    const launcher = Buffer.from(script);
    await safeDirectories(loc.reportDir, o, {create:true, privateLeaf:true});
    await put(loc.collectorPath, source, o, 0o600);
    await put(loc.launcherPath, launcher, o, 0o700);
    return {collectorHash:createHash('sha256').update(source).digest('hex'),cliPath};
  }
  async function disableRuntime(o, loc, data) {
    const action=data.kind==='statusline' && data.hadStatusLine?'exec /usr/bin/cat':'exit 0';
    await put(loc.launcherPath, Buffer.from(`#!/bin/sh\n# ${MARKER}\n${action}\n`), o, 0o700);
  }
  async function connectProvider(input) {
    const o = options(input);
    const found = await inspect(o, {validateStatusLine:false});
    const pending=pendingProcess(o.pendingProcess,o.uid);
    const loc=await savedLocation(o,found.id) || locations(o,found.identity);
    if(!await stat(loc.root)) {
      // Reserve capacity and create its directory under one cross-process lock.
      // Keep admission state outside the bounded connection-directory scan.
      const admission={root:path.join(absolute(o.homeDir),'.local/state/llm-account-usage/.connection-admission')};
      await locked(o,admission,async()=>{
        if(await stat(loc.root))return;
        await connectionLocations(o,{reserveSlot:true});
        await safeDirectories(loc.root,o,{create:true,privateLeaf:true});
      });
    }
    return locked(o, loc, async loc => {
      let data = await retireMissingHook(o, loc, await receipt(o, loc));
      if(data?.status === 'connected') {
        await claimConnection(o, loc, data);
        if(data.kind === 'codex-hook') {
          const state = codexHookState(found.config, data.installedHook);
          if(state.exact.length !== 1 || state.managed.length !== 1)
            throw failure('SETTINGS_CHANGED', 'The installed Codex hook was edited. Review it before reconnecting or disconnecting.');
        } else if(!isDeepStrictEqual(found.config.statusLine, data.installedStatusLine))
          throw failure('SETTINGS_CHANGED', 'The installed status line was edited. Review it before reconnecting or disconnecting.');
        const nextData={...data,cliPath:found.cliPath,cliLookupPath:found.cliLookupPath,
          pendingProcess:o.pendingProcess === undefined ? data.pendingProcess : pending};
        const runtime=await writeRuntime(o, loc, nextData);nextData.cliPath=runtime.cliPath;
        await put(loc.receiptPath, json(nextData), o, 0o600);
        return publicConnection(nextData, loc);
      }
      if(o.provider === 'codex') {
        if(codexHookState(found.config, installedCodexHook(loc.launcherPath)).managed.length)
          throw failure('ALREADY_CONNECTED', 'Codex already has an Account Usage hook. Restore or disconnect its original installation first.');
      } else {
        checkStatusLine(found.config);
        if(managedStatusLine(found.config.statusLine))
          throw failure('ALREADY_CONNECTED', 'This provider already has an Account Usage hook. Restore or disconnect its original installation first.');
      }
      await safeDirectories(o.storagePath, o, {create:true});
      let next;
      const common = {version:loc.legacy?1:2, id:found.id, profilePath:found.profilePath, pendingProcess:pending,
        status:'connected', provider:o.provider, uid:o.uid, settingsPath:found.settingsPath,
        ownerStoragePath:absolute(o.storagePath), cliPath:found.cliPath, cliLookupPath:found.cliLookupPath,
        settingsExisted:found.bytes !== null};
      if(o.provider === 'codex') {
        const installedHook = installedCodexHook(loc.launcherPath), hadHooks=own(found.config,'hooks'),
          hooks=hadHooks?{...found.config.hooks}:{}, hadStop=own(hooks,'Stop');
        hooks.Stop=[...(hadStop?hooks.Stop:[]),installedHook];next={...found.config,hooks};
        data={...common,kind:'codex-hook',installedHook,hadHooks,hadStop,backupName:`hooks.before-${randomUUID()}.json`};
      } else {
        const installedStatusLine = found.hasExistingStatusLine ? {...found.config.statusLine} : {type:'command'};
        installedStatusLine.command = installedCommand(loc.launcherPath, found.hasExistingStatusLine ? found.config.statusLine : null);
        if(o.provider === 'antigravity' && !found.hasExistingStatusLine)Object.assign(installedStatusLine, {enabled:true, stack_with_default:true});
        data={...common,kind:'statusline',installedStatusLine,hadStatusLine:found.hasExistingStatusLine,
          originalStatusLine:found.hasExistingStatusLine ? found.config.statusLine : null,backupName:`settings.before-${randomUUID()}.json`};
        next={...found.config,statusLine:installedStatusLine};
      }
      await put(path.join(loc.root, data.backupName), found.bytes || json({}), o, 0o600);
      const runtime=await writeRuntime(o, loc, data);data.cliPath=runtime.cliPath;
      // Save recovery information before touching provider settings. If a crash
      // occurs, disconnect checks the installed value before restoring one key.
      await put(loc.receiptPath, json(data), o, 0o600);
      try { await replace(found.settingsPath, json(next), found.bytes, o); }
      catch(error) {
        data.status = 'disconnected';
        await put(loc.receiptPath, json(data), o, 0o600);
        throw error;
      }
      return publicConnection(data, loc);
    });
  }
  async function disconnectProvider(input) {
    const o = options(input);
    let loc;
    if(o.connectionId !== undefined) {
      locations(o,{id:o.connectionId});
      loc=await savedLocation(o,o.connectionId);
      if(!loc)throw failure('INVALID_CONNECTION','The selected profile connection was not found.');
    } else {
      if(!o.provider)throw failure('UNSUPPORTED_PROVIDER','Choose a provider.');
      const selectedProfile=profile(o);
      await safeDirectories(selectedProfile,o);
      const profilePath=await io.realpath(selectedProfile);
      const identity=connectionIdentity({provider:o.provider,uid:o.uid,
        settingsPath:path.join(profilePath,o.provider==='codex'?'hooks.json':'settings.json')});
      loc=await savedLocation(o,identity.id) || locations(o,identity);
    }
    if(!await stat(loc.root)) return {provider:o.provider, connected:false};
    return locked(o, loc, async current => {
      const data = await retireMissingHook(o, current, await receipt(o, current));
      if(!data && o.connectionId !== undefined)throw failure('INVALID_CONNECTION','The selected profile connection was not found.');
      if(!data) return {provider:o.provider, connected:false};
      if(data.status === 'disconnected')return publicConnection(data,current);
      await claimConnection(o, current, data);
      const bytes = await readSafe(data.settingsPath, o);
      const config = parse(bytes);
      if(data.kind === 'codex-hook') {
        const state=codexHookState(config,data.installedHook);
        if(state.exact.length !== 1 || state.managed.length !== 1)
          throw failure('SETTINGS_CHANGED', 'The installed Codex hook was edited or removed. Disconnect left the hooks unchanged.');
        const hooks={...config.hooks},stop=[...hooks.Stop],index=stop.findIndex(entry=>isDeepStrictEqual(entry,data.installedHook));
        stop.splice(index,1);
        if(stop.length || data.hadStop)hooks.Stop=stop;else delete hooks.Stop;
        if(Object.keys(hooks).length || data.hadHooks)config.hooks=hooks;else delete config.hooks;
      } else {
        if(!isDeepStrictEqual(config.statusLine, data.installedStatusLine))
          throw failure('SETTINGS_CHANGED', 'The installed status line was edited or removed. Disconnect left the settings unchanged.');
        if(data.hadStatusLine) config.statusLine = data.originalStatusLine;
        else delete config.statusLine;
      }
      await replace(data.settingsPath, json(config), bytes, o);
      data.status = 'disconnected';
      await put(current.receiptPath, json(data), o, 0o600);
      return publicConnection(data, current);
    });
  }
  async function listConnections(input) {
    const base = options(input);
    const results = [];
    for(const {loc,data,error} of await savedConnections(base)) {
      if(error)continue;
      const o = {...base, provider:undefined};
      try {
        if(data?.status !== 'connected' || data.ownerStoragePath !== absolute(o.storagePath)) continue;
        await nativeExecutable(data.cliLookupPath, o);
        await safeDirectories(loc.reportDir, o, {privateLeaf:true});
        const config = parse(await readSafe(data.settingsPath, o));
        if(data.kind === 'codex-hook') {
          const state=codexHookState(config,data.installedHook);
          if(state.exact.length===1 && state.managed.length===1)results.push(publicConnection(data,loc));
        } else if(isDeepStrictEqual(config.statusLine, data.installedStatusLine)) results.push(publicConnection(data, loc));
      } catch { /* A damaged connection cannot suppress another profile. */ }
    }
    return results;
  }
  async function listDisconnectConnections(input) {
    const base=options(input),storagePath=absolute(base.storagePath),results=[];
    for(const {loc,data,error} of await savedConnections(base)) {
      if(error || data?.status!=='connected')continue;
      try {
        // Recovery needs the validated receipt even when its CLI or report
        // feed is unavailable. Only disconnectProvider may claim an orphan.
        if(data.ownerStoragePath!==storagePath && await stat(absolute(data.ownerStoragePath)))continue;
        results.push(publicConnection(data,loc));
      } catch { /* An unverifiable owner cannot suppress a sibling receipt. */ }
    }
    return results;
  }
  async function refreshRuntime(input) {
    const base = options(input), warnings = [], refreshed = [];
    for(const entry of await savedConnections(base)) {
      const {loc}=entry;
      const o = {...base, provider:undefined};
      let data=entry.data;
      try {
        if(entry.error)throw entry.error;
        await locked(o, loc, async current => {
          data = await receipt(o, current);
          if(data?.status === 'connected' && data.ownerStoragePath === absolute(o.storagePath)) {
            o.provider=data.provider;
            if(data.kind === 'codex-hook') {
              const config=parse(await readSafe(data.settingsPath,o)),state=codexHookState(config,data.installedHook);
              if(state.exact.length!==1 || state.managed.length!==1)
                throw failure('SETTINGS_CHANGED','The installed Codex hook was edited. Runtime was not refreshed.');
            }
            try {
              const runtime=await writeRuntime(o, current, data);
              if(data.cliPath!==runtime.cliPath) {data.cliPath=runtime.cliPath;await put(current.receiptPath,json(data),o,0o600);}
              refreshed.push(data.id);
            } catch(error) {await disableRuntime(o,current,data);throw error;}
          }
        });
      } catch(error) {
        if(error.code !== 'SETUP_BUSY') {
          const label=data ? `${data.provider} (${data.profilePath}; ${data.id})` : `${loc.id || loc.provider} (${loc.root})`;
          warnings.push(`${label}: saved collector runtime could not be refreshed; reconnect after reviewing setup.`);
        }
      }
    }
    return {refreshed, warnings};
  }
  return {discoverProvider, connectProvider, disconnectProvider, listConnections, listDisconnectConnections, refreshRuntime};
}

module.exports = {createSetup, ...createSetup()};
