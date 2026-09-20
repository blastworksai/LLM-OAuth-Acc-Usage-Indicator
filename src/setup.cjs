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
const PROVIDERS = ['claude', 'antigravity'];
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
const managed = line => typeof line?.command === 'string' && line.command.includes(MARKER);
function installedCommand(launcherPath, originalStatusLine) {
  // Let the provider's existing shell interpret the exact user-owned source.
  // The launcher only duplicates raw stdin; it never selects an interpreter
  // for the original command or evaluates vendor data as source.
  return originalStatusLine
    ? `${quote(launcherPath)} | (\n${originalStatusLine.command}\n)\n# ${MARKER}`
    : `${quote(launcherPath)} # ${MARKER}`;
}

function createSetup(dependencies = {}) {
  const io = dependencies.fs || fs;
  const executeFile = dependencies.execFile || promisify(execFile);
  function options(input = {}) {
    const result = {homeDir:os.homedir(), env:process.env, platform:process.platform,
      uid:process.getuid?.(), systemUid:0, nodePath:process.execPath, ...dependencies, ...input};
    if(result.platform !== 'linux' || !Number.isSafeInteger(result.uid))
      throw failure('UNSUPPORTED_PLATFORM', 'Provider setup supports Linux terminal hosts, including Remote-SSH to Linux.');
    if(result.provider !== undefined && !PROVIDERS.includes(result.provider))
      throw failure('UNSUPPORTED_PROVIDER', 'Choose Claude Code or Antigravity CLI. Codex needs no provider setup.');
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
  // Inspect every path component. System-owned ancestors are acceptable; an
  // owner-owned sticky directory (e.g. /tmp) is not acceptable as our data root.
  async function safeDirectories(directory, o, {create = false, privateLeaf = false, ownerLeaf = true} = {}) {
    const target = absolute(directory);
    let current = path.parse(target).root;
    for(const segment of target.slice(current.length).split('/').filter(Boolean)) {
      current = path.join(current, segment);
      let entry = await stat(current);
      if(!entry && create) {
        try { await io.mkdir(current, {mode:0o700}); } catch(error) { if(error.code !== 'EEXIST') throw error; }
        entry = await stat(current);
      }
      if(!entry) throw failure('PROFILE_REQUIRED', 'The selected profile directory does not exist. Sign in with the provider separately first.');
      const leaf = current === target;
      const trustedSticky = !leaf && entry.uid === o.systemUid && (entry.mode & 0o1000);
      if(entry.isSymbolicLink() || !entry.isDirectory() ||
        (entry.uid !== o.uid && entry.uid !== o.systemUid) ||
        (leaf && ownerLeaf && entry.uid !== o.uid) ||
        ((entry.mode & 0o022) && !trustedSticky) ||
        (leaf && privateLeaf && (entry.mode & 0o077)))
        throw failure('UNSAFE_PATH', `Setup refused an unsafe directory owner, link, or permission mode: ${current}`);
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
    if(!entry.isFile() || !(entry.mode & 0o111) || (entry.mode & 0o022) || ![o.systemUid, o.uid].includes(entry.uid))
      throw failure(code, 'The executable must be a trusted, non-writable native Linux binary.');
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
    const command = o.provider === 'claude' ? 'claude' : 'agy';
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
        : /^(?:AGY|ANTIGRAVITY|GEMINI)_.*(?:PROFILE|CONFIG|HOME|DIR)/.test(key)));
    if(suspicious || o.profileOverrideDetected)
      throw failure('PROFILE_REQUIRED', 'A provider profile override is present. Select its exact settings directory explicitly.');
    if(o.provider === 'claude' && o.env.CLAUDE_CONFIG_DIR) return absolute(o.env.CLAUDE_CONFIG_DIR, 'PROFILE_REQUIRED');
    return path.join(absolute(o.homeDir), o.provider === 'claude' ? '.claude' : '.gemini/antigravity-cli');
  }
  function checkStatusLine(config) {
    if(!own(config, 'statusLine')) return;
    const line = config.statusLine;
    if(!object(line) || line.type !== 'command' || typeof line.command !== 'string' || !line.command.trim() || line.command.includes('\0'))
      throw failure('UNSUPPORTED_STATUSLINE', 'The existing status line is not a supported command. Setup left it unchanged.');
    if(line.enabled === false) throw failure('UNSUPPORTED_STATUSLINE', 'The existing status line is disabled. Enable it in the provider before connecting.');
  }
  async function inspect(o, {validateStatusLine = true} = {}) {
    if(!o.provider) throw failure('UNSUPPORTED_PROVIDER', 'Choose a provider.');
    const profilePath = profile(o);
    await safeDirectories(profilePath, o);
    const settingsPath = path.join(profilePath, 'settings.json');
    const bytes = await readSafe(settingsPath, o);
    const config = parse(bytes);
    if(validateStatusLine) checkStatusLine(config);
    return {provider:o.provider, profilePath, settingsPath, ...await findCli(o),
      hasExistingStatusLine:own(config, 'statusLine'), bytes, config};
  }
  async function discoverProvider(input) {
    const {bytes, config, ...preview} = await inspect(options(input));
    return preview;
  }
  function locations(o, provider = o.provider) {
    absolute(o.storagePath);
    // The provider still invokes this hook after an editor uninstall. Its
    // launcher and original-command recovery must outlive editor-owned storage.
    const root = path.join(absolute(o.homeDir), '.local/state/llm-account-usage/providers', provider);
    return {root, receiptPath:path.join(root, 'connection.json'), launcherPath:path.join(root, 'run.sh'),
      collectorPath:path.join(root, 'passive.cjs'), reportDir:path.join(root, 'reports')};
  }
  async function receipt(o, loc) {
    const bytes = await readSafe(loc.receiptPath, o, {privateFile:true});
    if(bytes === null) return null;
    const data = parse(bytes);
    if(data.version !== 1 || data.provider !== o.provider || data.uid !== o.uid ||
      !['connected', 'disconnected'].includes(data.status) || !object(data.installedStatusLine) ||
      (data.hadStatusLine && (!object(data.originalStatusLine) || typeof data.originalStatusLine.command !== 'string')) ||
      data.installedStatusLine.command !== installedCommand(loc.launcherPath, data.hadStatusLine ? data.originalStatusLine : null) ||
      typeof data.hadStatusLine !== 'boolean' || typeof data.cliPath !== 'string' || typeof data.cliLookupPath !== 'string' ||
      typeof data.ownerStoragePath !== 'string' ||
      typeof data.backupName !== 'string' || !/^settings\.before-[\w-]+\.json$/.test(data.backupName))
      throw failure('INVALID_RECEIPT', 'The saved connection cannot be verified. Provider settings were left unchanged.');
    absolute(data.settingsPath);
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
    return ['pid', 'uid', 'start_ticks', 'boot_id'].every(key => a[key] === b[key]);
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
      if(info.uid !== o.uid || (info.mode & 0o7777) !== 0o700) throw invalidLock(loc);
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
  async function locked(o, action) {
    const loc = locations(o);
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
    if(managed(config.statusLine)) {
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
    return {provider:data.provider, connected:data.status === 'connected', settingsPath:data.settingsPath,
      reportDir:loc.reportDir, launcherPath:loc.launcherPath, backupPath:path.join(loc.root, data.backupName)};
  }
  async function writeRuntime(o, loc, data) {
    const nodePath = await nativeExecutable(o.nodePath, o, 'UNSUPPORTED_RUNTIME');
    const cliPath = await nativeExecutable(data.cliLookupPath, o);
    for(const command of ['/bin/sh', '/usr/bin/cat', '/usr/bin/tee', '/usr/bin/mktemp', '/usr/bin/mkfifo', '/usr/bin/timeout', '/usr/bin/rm', '/usr/bin/rmdir'])
      await nativeExecutable(command, o, 'UNSUPPORTED_RUNTIME');
    const {stdout} = await executeFile('/usr/bin/tee', ['--version'], {timeout:2000, maxBuffer:4096, encoding:'utf8'});
    if(!/(?:GNU|uutils) coreutils/.test(stdout)) throw failure('UNSUPPORTED_RUNTIME', 'Provider setup requires GNU-compatible coreutils on this Linux host.');
    const sourcePath = absolute(o.collectorPath);
    const source = await io.readFile(sourcePath);
    if(source.length > 1024 * 1024) throw failure('UNSAFE_PATH', 'The bundled collector is too large.');
    const args = [nodePath, loc.collectorPath, `${o.provider}-statusline`, '--cli-executable', cliPath,
      '--cli-lookup-path', data.cliLookupPath,
      '--report-dir', loc.reportDir, o.provider === 'claude' ? '--claude-auth-status' : '--agy-full-usage'];
    const collector = 'ELECTRON_RUN_AS_NODE=1 /usr/bin/timeout --kill-after=1s 12s ' + args.map(quote).join(' ');
    let script = `#!/bin/sh\n# ${MARKER}\n`;
    if(data.hadStatusLine) {
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
    return createHash('sha256').update(source).digest('hex');
  }
  async function connectProvider(input) {
    const o = options(input);
    const found = await inspect(o, {validateStatusLine:false});
    return locked(o, async loc => {
      let data = await retireMissingHook(o, loc, await receipt(o, loc));
      if(data?.status === 'connected') {
        if(data.settingsPath !== found.settingsPath) throw failure('PROFILE_CONFLICT', 'Disconnect the existing provider profile before selecting another.');
        await claimConnection(o, loc, data);
        if(!isDeepStrictEqual(found.config.statusLine, data.installedStatusLine))
          throw failure('SETTINGS_CHANGED', 'The installed status line was edited. Review it before reconnecting or disconnecting.');
        await writeRuntime(o, loc, data);
        return publicConnection(data, loc);
      }
      checkStatusLine(found.config);
      if(managed(found.config.statusLine))
        throw failure('ALREADY_CONNECTED', 'This provider already has an Account Usage hook. Restore or disconnect its original installation first.');
      await safeDirectories(o.storagePath, o, {create:true});
      const installedStatusLine = found.hasExistingStatusLine ? {...found.config.statusLine} : {type:'command'};
      installedStatusLine.command = installedCommand(loc.launcherPath, found.hasExistingStatusLine ? found.config.statusLine : null);
      if(o.provider === 'antigravity' && !found.hasExistingStatusLine)
        Object.assign(installedStatusLine, {enabled:true, stack_with_default:true});
      data = {version:1, status:'connected', provider:o.provider, uid:o.uid, settingsPath:found.settingsPath,
        ownerStoragePath:absolute(o.storagePath),
        cliPath:found.cliPath, cliLookupPath:found.cliLookupPath, installedStatusLine, hadStatusLine:found.hasExistingStatusLine,
        originalStatusLine:found.hasExistingStatusLine ? found.config.statusLine : null,
        settingsExisted:found.bytes !== null, backupName:`settings.before-${randomUUID()}.json`};
      await put(path.join(loc.root, data.backupName), found.bytes || json({}), o, 0o600);
      await writeRuntime(o, loc, data);
      // Save recovery information before touching provider settings. If a crash
      // occurs, disconnect checks the installed value before restoring one key.
      await put(loc.receiptPath, json(data), o, 0o600);
      try { await replace(found.settingsPath, json({...found.config, statusLine:installedStatusLine}), found.bytes, o); }
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
    const loc = locations(o);
    if(!await stat(loc.root)) return {provider:o.provider, connected:false};
    return locked(o, async current => {
      const data = await retireMissingHook(o, current, await receipt(o, current));
      if(!data || data.status === 'disconnected') return {provider:o.provider, connected:false};
      await claimConnection(o, current, data);
      const bytes = await readSafe(data.settingsPath, o);
      const config = parse(bytes);
      if(!isDeepStrictEqual(config.statusLine, data.installedStatusLine))
        throw failure('SETTINGS_CHANGED', 'The installed status line was edited or removed. Disconnect left the settings unchanged.');
      if(data.hadStatusLine) config.statusLine = data.originalStatusLine;
      else delete config.statusLine;
      await replace(data.settingsPath, json(config), bytes, o);
      data.status = 'disconnected';
      await put(current.receiptPath, json(data), o, 0o600);
      return publicConnection(data, current);
    });
  }
  async function listConnections(input) {
    const base = options(input);
    const results = [];
    for(const provider of PROVIDERS) {
      const o = {...base, provider}, loc = locations(o);
      if(!await stat(loc.root)) continue;
      try {
        await safeDirectories(loc.root, o, {privateLeaf:true});
        const data = await receipt(o, loc);
        if(data?.status !== 'connected' || data.ownerStoragePath !== absolute(o.storagePath)) continue;
        await safeDirectories(loc.reportDir, o, {privateLeaf:true});
        const config = parse(await readSafe(data.settingsPath, o));
        if(isDeepStrictEqual(config.statusLine, data.installedStatusLine)) results.push(publicConnection(data, loc));
      } catch { /* A damaged provider receipt cannot suppress another provider. */ }
    }
    return results;
  }
  async function refreshRuntime(input) {
    const base = options(input), warnings = [], refreshed = [];
    for(const provider of PROVIDERS) {
      const o = {...base, provider}, loc = locations(o);
      if(!await stat(loc.root)) continue;
      try {
        await locked(o, async current => {
          const data = await receipt(o, current);
          if(data?.status === 'connected' && data.ownerStoragePath === absolute(o.storagePath)) { await writeRuntime(o, current, data); refreshed.push(provider); }
        });
      } catch(error) { if(error.code !== 'SETUP_BUSY') warnings.push(`${provider}: saved collector runtime could not be refreshed; reconnect after reviewing setup.`); }
    }
    return {refreshed, warnings};
  }
  return {discoverProvider, connectProvider, disconnectProvider, listConnections, refreshRuntime};
}

module.exports = {createSetup, ...createSetup()};
