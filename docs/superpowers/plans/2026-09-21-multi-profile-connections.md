# Multi-Profile Connections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the provider-level first-wins race and make the existing after-turn collector work for simultaneous same-provider profiles, including an explicit public cross-user Remote-SSH setup path.

**Architecture:** Keep the passive data plane unchanged: each profile publishes one sanitized report after a turn and `matchReports` binds it to the selected terminal. Replace provider-singleton setup state with per-profile connection directories keyed by provider, Linux UID and canonical settings path. Same-user setup runs in the extension host as today; cross-user setup stages the same bounded installer for explicit execution under the target user and shares only a safe report feed.

**Tech Stack:** Node.js CommonJS, VS Code Extension API, Linux `/proc`, `node:test`, POSIX filesystem permissions, VSIX packaging through `@vscode/vsce`.

**Spec:** `docs/superpowers/specs/2026-09-21-multi-profile-connections-design.md`

## Global Constraints

- Preserve the existing after-turn report schema, provider collectors and process-ancestry matcher.
- A connection is keyed by provider, numeric Linux UID and canonical provider settings path; never by OAuth email.
- Do not read OAuth credential files, create an account mapping, add a daemon or send network traffic.
- Do not hard-code Odin users, groups, homes, CLI installation roots or privilege commands.
- The extension never elevates itself and never edits another Linux user's profile.
- Cross-user setup is an explicit command run under the target user and must not interrupt the selected agent session.
- Reports are never world-readable; cross-user feeds permit at most directory mode `2750` and file mode `0640`.
- One damaged connection must not suppress, refresh, disconnect or overwrite another connection.
- No new npm runtime dependency is introduced. The cross-user confirmation names the target-user `node` prerequisite before showing the command; the staged command uses that target shell's `node`.
- Version-1 provider receipts remain recoverable and must not be silently assigned to another profile.

## Review Focus

- Two live Claude profiles using the same native executable but different UIDs or settings paths must not collapse into one connection; Task 1 pins separate IDs, roots and receipts.
- A corrupt or half-installed connection beside a valid same-provider connection must not hide or disable the valid one; Task 2 pins per-entry failure isolation.
- A connected Claude profile must not remove setup for another selected Claude process; Task 3 pins process-specific pending/connected UI state.
- An unrelated process owned by another UID must never become a setup target merely because cross-user discovery is enabled; Task 4 pins foreground ancestry and terminal revalidation.
- A staged cross-user result written by the wrong UID, through a link, with unsafe modes or after cancellation must be rejected without changing editor state; Task 5 pins the handoff boundary.

---

### Task 1: Replace provider slots with per-profile connections

**Files:**
- Create: `src/connection.cjs`
- Create: `test/connection.test.cjs`
- Modify: `src/setup.cjs:12-257`
- Modify: `src/setup.cjs:294-570`
- Test: `test/setup.test.cjs`

**Interfaces:**
- Produces: `connectionIdentity({provider, uid, settingsPath}) -> {id, provider, uid, settingsPath}` where `id` is `v2-` plus 32 lowercase SHA-256 hex characters.
- Produces: `sameProcess(a, b) -> boolean` over `pid`, `uid`, `start_ticks` and `boot_id`.
- Changes: every public connection returned by setup includes `{id, provider, uid, profilePath, settingsPath, connected, cliLookupPath, reportDir, launcherPath, backupPath, pendingProcess}`.
- Changes: `disconnectProvider(options)` accepts `options.connectionId`. For existing callers without an ID it derives the exact connection from `provider` plus the canonical `profilePath` (or that provider's default profile); it never picks an arbitrary connection by provider name.

- [ ] **Step 1: Add failing identity tests**

```js
test('connection identity is stable per provider UID and canonical settings path',()=>{
  const base={provider:'claude',uid:1000,settingsPath:'/home/a/.claude/settings.json'};
  const first=connectionIdentity(base);
  assert.match(first.id,/^v2-[a-f0-9]{32}$/);
  assert.deepEqual(connectionIdentity({...base}),first);
  assert.notEqual(connectionIdentity({...base,uid:1001}).id,first.id);
  assert.notEqual(connectionIdentity({...base,settingsPath:'/home/a/second/settings.json'}).id,first.id);
  assert.notEqual(connectionIdentity({...base,provider:'antigravity'}).id,first.id);
});

test('process equality includes Linux owner and birth identity',()=>{
  const process={pid:20,uid:1000,start_ticks:'20',boot_id:'boot'};
  assert.equal(sameProcess(process,{...process}),true);
  assert.equal(sameProcess(process,{...process,uid:1001}),false);
  assert.equal(sameProcess(process,{...process,start_ticks:'21'}),false);
});
```

- [ ] **Step 2: Run the new identity tests and verify the missing module failure**

Run: `node --test test/connection.test.cjs`

Expected: FAIL with `Cannot find module '../src/connection.cjs'`.

- [ ] **Step 3: Implement the pure connection identity module**

```js
'use strict';
const path=require('node:path');
const {createHash}=require('node:crypto');
const PROVIDERS=new Set(['claude','codex','antigravity']);

function connectionIdentity({provider,uid,settingsPath}) {
  if(!PROVIDERS.has(provider) || !Number.isSafeInteger(uid) || uid<0 ||
    typeof settingsPath!=='string' || !path.isAbsolute(settingsPath))throw new TypeError('invalid-connection-identity');
  const canonical=path.resolve(settingsPath);
  const digest=createHash('sha256').update(JSON.stringify(['profile-v2',provider,uid,canonical])).digest('hex').slice(0,32);
  return {id:`v2-${digest}`,provider,uid,settingsPath:canonical};
}
function sameProcess(a,b) {
  return !!a&&!!b&&['pid','uid','start_ticks','boot_id'].every(key=>a[key]===b[key]);
}
module.exports={connectionIdentity,sameProcess};
```

- [ ] **Step 4: Add the failing two-profile setup regression**

Extend the fixture with a helper that creates another settings directory, then add:

```js
async function createProfile(f,name) {
  const profilePath=path.join(f.homeDir,name);
  await fs.mkdir(profilePath,{mode:0o700});
  const settings=path.join(profilePath,f.options.provider==='codex'?'hooks.json':'settings.json');
  await writeJson(settings,{profile:name});
  return profilePath;
}

test('two profiles of one provider connect and disconnect independently in either order',async t=>{
  const f=await fixture(t);
  const secondProfile=path.join(f.homeDir,'second-claude');
  await fs.mkdir(secondProfile,{mode:0o700});
  await writeJson(path.join(secondProfile,'settings.json'),{profile:'second'});

  const second=await f.setup.connectProvider({...f.options,profilePath:secondProfile,
    pendingProcess:{pid:22,uid:process.getuid(),start_ticks:'22',boot_id:'boot'}});
  const first=await f.setup.connectProvider({...f.options,
    pendingProcess:{pid:11,uid:process.getuid(),start_ticks:'11',boot_id:'boot'}});

  assert.notEqual(first.id,second.id);
  assert.notEqual(path.dirname(first.launcherPath),path.dirname(second.launcherPath));
  assert.deepEqual(new Set((await f.setup.listConnections(f.options)).map(value=>value.id)),new Set([first.id,second.id]));

  await f.setup.disconnectProvider({...f.options,connectionId:second.id});
  assert.equal((await f.setup.listConnections(f.options)).some(value=>value.id===first.id),true);
  assert.match((await readJson(f.settingsPath)).statusLine.command,/llm-account-usage-managed-v1/);
  assert.deepEqual(await readJson(path.join(secondProfile,'settings.json')),{profile:'second'});
});

test('every provider keeps two profile receipts independent in both connection orders',async t=>{
  for(const provider of ['claude','codex','antigravity'])for(const reverse of [false,true]) {
    const f=await fixture(t,provider);
    const other=await createProfile(f,`${provider}-${reverse?'reverse':'forward'}`);
    const profiles=reverse?[other,f.profilePath]:[f.profilePath,other];
    const connected=[];
    for(const profilePath of profiles)connected.push(await f.setup.connectProvider({...f.options,profilePath}));
    assert.equal(new Set(connected.map(value=>value.id)).size,2);
    assert.equal(new Set(connected.map(value=>value.launcherPath)).size,2);
  }
});
```

- [ ] **Step 5: Run only the new setup test and verify the provider-slot collision**

Run: `node --test --test-name-pattern='two profiles of one provider' test/setup.test.cjs`

Expected: FAIL with `PROFILE_CONFLICT`, or with both results pointing to the same provider runtime root.

- [ ] **Step 6: Compute the connection before choosing runtime locations**

In `inspect`, canonicalize the profile directory after `safeDirectories`, derive the settings path and return `identity`:

```js
const canonicalProfile=await io.realpath(profilePath);
const settingsPath=path.join(canonicalProfile,o.provider==='codex'?'hooks.json':'settings.json');
const identity=connectionIdentity({provider:o.provider,uid:o.uid,settingsPath});
return {identity,id:identity.id,provider:o.provider,profilePath:canonicalProfile,settingsPath,
  ...await findCli(o),hasExistingStatusLine:o.provider!=='codex'&&own(config,'statusLine'),
  hasExistingHooks:o.provider==='codex'&&own(config,'hooks'),bytes,config};
```

- [ ] **Step 7: Replace provider locations with connection locations**

Use the deterministic ID for all new runtime state:

```js
function locations(o,identity) {
  absolute(o.homeDir);
  if(!identity || !/^v2-[a-f0-9]{32}$/.test(identity.id))throw failure('INVALID_CONNECTION','A valid profile connection is required.');
  const root=path.join(absolute(o.homeDir),'.local/state/llm-account-usage/connections',identity.id);
  return {id:identity.id,root,receiptPath:path.join(root,'connection.json'),launcherPath:path.join(root,'run.sh'),
    collectorPath:path.join(root,'passive.cjs'),reportDir:path.join(root,'reports')};
}
```

Change `locked` to receive the already resolved `loc`, save receipt version `2` with `id`, `profilePath` and validated `pendingProcess`, and make `publicConnection` return those fields. Reject a pending process whose UID differs from the connection UID. When `disconnectProvider` has no `connectionId`, run the normal profile resolution and derive its exact ID; this preserves the existing internal callers without reintroducing provider-only selection.

- [ ] **Step 8: Enumerate bounded connection directories and address disconnect by ID**

Add a `connectionLocations(base)` iterator that reads at most 128 names from `~/.local/state/llm-account-usage/connections`, accepts only `v2-[a-f0-9]{32}`, pins each directory through the existing safe-directory checks, and yields failures per entry rather than aborting the scan:

```js
async function connectionLocations(o) {
  const parent=path.join(absolute(o.homeDir),'.local/state/llm-account-usage/connections');
  if(!await stat(parent))return [];
  await safeDirectories(parent,o);
  const names=[];
  for await(const entry of await io.opendir(parent)) {
    if(names.length>=128)throw failure('TOO_MANY_CONNECTIONS','Too many saved profile connections were found.');
    if(entry.isDirectory()&&/^v2-[a-f0-9]{32}$/.test(entry.name))names.push(entry.name);
  }
  return names.sort().map(id=>locations(o,{id}));
}
```

Make `listConnections` and `refreshRuntime` iterate these locations. Make `disconnectProvider` find exactly one listed location by `connectionId`, returning `INVALID_CONNECTION` for malformed or unknown IDs.

- [ ] **Step 9: Run focused setup and identity tests**

Run: `node --test test/connection.test.cjs test/setup.test.cjs`

Expected: PASS, including both connection orders and an independent disconnect.

- [ ] **Step 10: Commit the per-profile storage slice**

```bash
git -C /opt/glitch/workspaces/llm-oauth-acc-usage-indicator--more-bugfixing-of-blastworksai-llm-oauth add src/connection.cjs test/connection.test.cjs src/setup.cjs test/setup.test.cjs
git -C /opt/glitch/workspaces/llm-oauth-acc-usage-indicator--more-bugfixing-of-blastworksai-llm-oauth commit -m "fix: store provider connections per profile"
```

### Task 2: Preserve version-1 connections and isolate failures

**Files:**
- Modify: `src/setup.cjs:229-570`
- Test: `test/setup.test.cjs`

**Interfaces:**
- Consumes: `connectionIdentity` and the version-2 public connection shape from Task 1.
- Produces: `legacy: true|false` on public connections.
- Produces: logical version-1 migration: a valid legacy receipt is assigned its deterministic version-2 `id` while its runtime stays at the legacy path until explicit disconnect/reconnect, so the installed hook path never breaks.

- [ ] **Step 1: Add a version-1 fixture builder and failing migration test**

Add `seedLegacyConnection(f)` that creates the old `providers/claude` directory, a private receipt/backup/launcher/report directory and a settings command containing that exact launcher. The receipt must use version `1`, the fixture UID, the canonical settings path, the fixture CLI paths and the fixture editor storage path.

```js
test('a valid version-1 connection gains a stable ID without moving its installed launcher',async t=>{
  const f=await fixture(t);
  const legacy=await seedLegacyConnection(f);
  const [listed]=await f.setup.listConnections(f.options);
  assert.match(listed.id,/^v2-[a-f0-9]{32}$/);
  assert.equal(listed.legacy,true);
  assert.equal(listed.launcherPath,legacy.launcherPath);
  assert.equal((await readJson(f.settingsPath)).statusLine.command.includes(legacy.launcherPath),true);

  const reconnected=await f.setup.connectProvider(f.options);
  assert.equal(reconnected.id,listed.id);
  assert.equal(reconnected.launcherPath,legacy.launcherPath);
});
```

- [ ] **Step 2: Run the migration test and verify that legacy state is invisible**

Run: `node --test --test-name-pattern='version-1 connection' test/setup.test.cjs`

Expected: FAIL because `listConnections` scans only `connections/v2-*`.

- [ ] **Step 3: Add bounded legacy discovery without moving runtime files**

For each provider, inspect the old `providers/<provider>` location after scanning version-2 roots. Validate its receipt with the existing version-1 rules, derive `id` from the stored UID/settings path, set `legacy:true`, and keep `loc.root` unchanged. When connect resolves the same identity, reuse that location. When it resolves another profile, create the new version-2 location instead of returning `PROFILE_CONFLICT`.

```js
const identity=connectionIdentity({provider:data.provider,uid:data.uid,settingsPath:data.settingsPath});
const legacy={...legacyLocations(o,data.provider),id:identity.id,legacy:true};
// Reuse only when every identity field matches. The old launcher path remains installed.
if(identity.id===wanted.id)return legacy;
```

- [ ] **Step 4: Add failure-isolation tests for same-provider neighbors**

```js
test('a corrupt Claude connection does not hide or disable another Claude profile',async t=>{
  const f=await fixture(t);
  const other=await createProfile(f,'other-claude');
  const first=await f.setup.connectProvider(f.options);
  const second=await f.setup.connectProvider({...f.options,profilePath:other});
  await fs.writeFile(path.join(path.dirname(first.launcherPath),'connection.json'),'{bad',{mode:0o600});

  assert.deepEqual((await f.setup.listConnections(f.options)).map(value=>value.id),[second.id]);
  const refreshed=await f.setup.refreshRuntime(f.options);
  assert.deepEqual(refreshed.refreshed,[second.id]);
  assert.equal(refreshed.warnings.length,1);
});

test('disconnect and refresh touch only the addressed profile',async t=>{
  const f=await fixture(t);
  const other=await createProfile(f,'other-claude');
  const first=await f.setup.connectProvider(f.options);
  const second=await f.setup.connectProvider({...f.options,profilePath:other});
  const secondSettings=await fs.readFile(path.join(other,'settings.json'));
  await f.setup.disconnectProvider({...f.options,connectionId:first.id});
  assert.deepEqual(await fs.readFile(path.join(other,'settings.json')),secondSettings);
  assert.equal((await f.setup.listConnections(f.options))[0].id,second.id);
});

test('a legacy and version-2 receipt claiming one identity fail closed',async t=>{
  const f=await fixture(t);
  const current=await f.setup.connectProvider(f.options);
  await seedLegacyConnection(f,{settingsPath:current.settingsPath});
  await assert.rejects(f.setup.listConnections(f.options),{code:'DUPLICATE_CONNECTION'});
});
```

- [ ] **Step 5: Run the failure-isolation tests and make warning/refreshed values connection-specific**

Run: `node --test --test-name-pattern='corrupt Claude|addressed profile' test/setup.test.cjs`

Expected before implementation: FAIL because scans and result arrays are provider-specific. After the minimal changes, `refreshRuntime().refreshed` contains connection IDs and each warning identifies the provider plus profile path without account data.

- [ ] **Step 6: Run the full setup suite**

Run: `node --test test/setup.test.cjs`

Expected: PASS. Existing crash recovery, path trust, takeover compatibility for version-1 receipts, hook preservation and lock tests remain green.

- [ ] **Step 7: Commit migration and isolation**

```bash
git -C /opt/glitch/workspaces/llm-oauth-acc-usage-indicator--more-bugfixing-of-blastworksai-llm-oauth add src/setup.cjs test/setup.test.cjs
git -C /opt/glitch/workspaces/llm-oauth-acc-usage-indicator--more-bugfixing-of-blastworksai-llm-oauth commit -m "fix: isolate same-provider profile connections"
```

### Task 3: Make the extension UI follow an exact profile connection

**Files:**
- Modify: `src/connection.cjs`
- Modify: `src/extension.cjs:10-205`
- Test: `test/connection.test.cjs`
- Test: `test/extension.test.cjs`

**Interfaces:**
- Consumes: public connections and `pendingProcess` from Task 1.
- Produces: `connectionForTarget(connections, target) -> connection|null`; only an exact saved `pendingProcess`, provider and UID match is authoritative before a report exists.
- Changes: the disconnect picker returns a public connection and calls `disconnectProvider({...setupOptions, connectionId})`.

- [ ] **Step 1: Add failing exact-target matching tests**

```js
test('connectionForTarget never treats provider equality as profile equality',()=>{
  const first={id:'first',provider:'claude',uid:1000,pendingProcess:{pid:20,uid:1000,start_ticks:'20',boot_id:'boot'}};
  const second={id:'second',provider:'claude',uid:2000,pendingProcess:{pid:30,uid:2000,start_ticks:'30',boot_id:'boot'}};
  assert.equal(connectionForTarget([first,second],{provider:'claude',process:{...second.pendingProcess}}).id,'second');
  assert.equal(connectionForTarget([first,second],{provider:'claude',process:{...second.pendingProcess,pid:31}}),null);
  assert.equal(connectionForTarget([first],{provider:'codex',process:{...first.pendingProcess}}),null);
});
```

- [ ] **Step 2: Run the connection test and verify the missing export**

Run: `node --test test/connection.test.cjs`

Expected: FAIL because `connectionForTarget` is not exported.

- [ ] **Step 3: Implement exact pending-target matching**

```js
function connectionForTarget(connections,target) {
  if(!target || !Array.isArray(connections))return null;
  const matches=connections.filter(value=>value?.provider===target.provider &&
    value.uid===target.process?.uid && sameProcess(value.pendingProcess,target.process));
  return matches.length===1?matches[0]:null;
}
```

- [ ] **Step 4: Add failing extension regressions for two Claude profiles**

```js
test('the first Claude connection does not suppress Connect Claude for a second process',async()=>{
  const first=target('claude',20,1000),second=target('claude',30,2000);
  const h=harness({terminal:terminal(),detect:async()=>second,connections:[{
    id:'first',provider:'claude',uid:1000,reportDir:'/feeds/first',pendingProcess:first.process
  }]});
  await h.api.refresh();
  assert.deepEqual(JSON.parse(JSON.stringify(h.api.getState().setupTarget)),second);
  await h.openCard()({type:'connect'});
  assert.equal(h.connected[0].pendingProcess.pid,30);
});

test('two same-provider feeds are both read and exact pending state hides setup only for its process',async()=>{
  const first=target('claude',20,1000),second=target('claude',30,2000);
  const connections=[
    {id:'first',provider:'claude',uid:1000,reportDir:'/feeds/first',pendingProcess:first.process},
    {id:'second',provider:'claude',uid:2000,reportDir:'/feeds/second',pendingProcess:second.process}
  ];
  const h=harness({terminal:terminal(),detect:async()=>second,connections});
  await h.api.refresh();
  assert.deepEqual(JSON.parse(JSON.stringify(h.feedDirectories)),['/feeds/first','/feeds/second']);
  assert.equal(h.api.getState().setupTarget,undefined);
  assert.match(h.api.getState().reason,/connected.*fresh turn/i);
});
```

Update the test helper `target(provider,pid=20,uid=1000)` so it can model several processes.

- [ ] **Step 5: Run the extension regressions and verify first-wins behavior**

Run: `node --test --test-name-pattern='first Claude|same-provider feeds' test/extension.test.cjs`

Expected: FAIL because `connected` is a `Set` of provider names and because connect does not pass `pendingProcess`.

- [ ] **Step 6: Replace provider-set UI state with exact connection state**

Import `connectionForTarget`. In refresh, replace the provider-name set with:

```js
const connection=connectionForTarget(connections,target);
if(target&&!connection)result.setupTarget=target;
else if(connection)result.reason='This profile is connected. Waiting for this session to finish a fresh turn.';
else result.setupTarget={provider:null};
```

Always offer all three providers in the generic picker; another profile using that provider is not a reason to remove it. Pass `pendingProcess:detected.process` to `discoverProvider`/`connectProvider` options. Keep terminal/process revalidation immediately before the write.

- [ ] **Step 7: Address disconnect by the selected connection**

Build picker items from `listConnections`:

```js
const items=connections.map(connection=>({
  label:providerName(connection.provider),
  description:`UID ${connection.uid} · ${connection.profilePath}`,
  connection
}));
const picked=await vscode.window.showQuickPick(items,{title:'Disconnect account usage profile'});
if(picked)await withRecovery(setup.disconnectProvider,{...setupOptions,connectionId:picked.connection.id});
```

Add a test selecting one of two Claude items and assert only its ID is passed.

```js
test('disconnect addresses one profile connection by ID',async()=>{
  const connections=[
    {id:'first',provider:'claude',uid:1000,profilePath:'/home/one/.claude'},
    {id:'second',provider:'claude',uid:2000,profilePath:'/home/two/.claude'}
  ];
  const h=harness({connections,pickConnection:'second'});
  await h.commands.get('llmAccountUsage.disconnect')();
  assert.equal(h.connected.at(-1).connectionId,'second');
});
```

- [ ] **Step 8: Run connection and extension suites**

Run: `node --test test/connection.test.cjs test/extension.test.cjs`

Expected: PASS. Generic connection remains available, exact pending connections wait for a fresh turn, and both feed directories are read.

- [ ] **Step 9: Commit exact-profile UI behavior**

```bash
git -C /opt/glitch/workspaces/llm-oauth-acc-usage-indicator--more-bugfixing-of-blastworksai-llm-oauth add src/connection.cjs src/extension.cjs test/connection.test.cjs test/extension.test.cjs
git -C /opt/glitch/workspaces/llm-oauth-acc-usage-indicator--more-bugfixing-of-blastworksai-llm-oauth commit -m "fix: follow exact provider profile connections"
```

### Task 4: Detect the selected cross-user provider without weakening matching

**Files:**
- Modify: `src/provider.cjs:31-85`
- Test: `test/provider.test.cjs`

**Interfaces:**
- Preserves: `detectProvider(terminalPid) -> {provider, cliPath, process}|null`.
- Changes: `process.uid` may differ from the extension-host UID, but only when the process is the single revalidated foreground provider inside the selected terminal ancestry.

- [ ] **Step 1: Replace the old other-user rejection test with cross-user topology tests**

```js
test('the exact foreground provider may run as another Linux user',async()=>{
  const f=fixture();
  f.processes[1]=proc(20,10,{uid:2000});
  assert.deepEqual(await f.detect(10),{
    provider:'claude',cliPath:'/opt/tools/claude',
    process:{pid:20,uid:2000,start_ticks:'20',boot_id:'boot'}
  });
});

test('an unrelated other-user provider is never selected',async()=>{
  const f=fixture();
  f.processes.push(proc(30,1,{uid:2000}));
  assert.deepEqual(await f.detect(10),{provider:'claude',cliPath:'/opt/tools/claude',process:identity});
});
```

Retain cases for a terminal process not owned by the extension host, background groups, another TTY, multiple foreground candidates, PID reuse and executable drift.

- [ ] **Step 2: Run provider tests and verify the cross-user false negative**

Run: `node --test test/provider.test.cjs`

Expected: FAIL only for the new foreground cross-user case.

- [ ] **Step 3: Remove UID equality only from candidate enumeration**

Keep `terminal.uid===uid` as the extension-host terminal anchor. Change the candidate filter from:

```js
if(!current || current.uid!==uid)continue;
```

to:

```js
if(!current)continue;
```

Do not change the ancestry/TTY match, single-candidate requirement, executable re-resolution or final process/terminal rechecks.

- [ ] **Step 4: Run provider and core matcher suites**

Run: `node --test test/provider.test.cjs test/core.test.cjs`

Expected: PASS. Cross-user foreground detection works; unrelated, ambiguous, moved and reused processes remain unavailable.

- [ ] **Step 5: Commit bounded cross-user detection**

```bash
git -C /opt/glitch/workspaces/llm-oauth-acc-usage-indicator--more-bugfixing-of-blastworksai-llm-oauth add src/provider.cjs test/provider.test.cjs
git -C /opt/glitch/workspaces/llm-oauth-acc-usage-indicator--more-bugfixing-of-blastworksai-llm-oauth commit -m "fix: detect cross-user provider processes"
```

### Task 5: Add an explicit target-user setup handoff and safe shared feed

**Files:**
- Create: `src/setup-cli.cjs`
- Create: `src/handoff.cjs`
- Create: `test/setup-cli.test.cjs`
- Create: `test/handoff.test.cjs`
- Modify: `src/setup.cjs:82-105`
- Modify: `src/setup.cjs:218-235`
- Modify: `src/setup.cjs:378-427`
- Modify: `src/extension.cjs:10-205`
- Modify: `test/setup.test.cjs`
- Modify: `test/extension.test.cjs`

**Interfaces:**
- Produces: `setup-cli.cjs connect --provider <name> --cli <absolute-native-path> --result <absolute-result-path> [--profile <absolute-profile>] [--report-dir <absolute-directory>]`; it previews the exact profile and trust boundary, then requires an interactive `yes` before writing.
- Produces: `setup-cli.cjs disconnect --connection-id <v2-id> --result <absolute-result-path>`.
- Produces: `prepareHandoff({extensionPath, provider, target, action, connectionId?}) -> {command, resultPath, readResult(), dispose()}`.
- Changes: `connectProvider` accepts `reportDir`; when present it requires a target-owned directory no broader than mode `2750` and stores that exact path in the receipt.
- Produces: extension global state `managedCrossUserConnections`, containing only public connection descriptors and report paths—never account identity or credentials.

- [ ] **Step 1: Add failing setup CLI parsing and owner-context tests**

Use injected `setup`, `fs`, `os`, `process` and output dependencies so tests never touch a real provider profile:

```js
test('cross-user setup CLI passes only explicit public setup fields in its own user context',async()=>{
  const calls=[];
  const result=await run(['connect','--provider','claude','--cli','/opt/claude','--result','/drop/result.json'],{
    setup:{discoverProvider:async()=>({id:'v2-'+'a'.repeat(32),profilePath:'/home/target/.claude',sharedDirectories:[]}),
      connectProvider:async options=>{calls.push(options);return {id:'v2-'+'a'.repeat(32),provider:'claude',uid:2000,
      profilePath:'/home/target/.claude',settingsPath:'/home/target/.claude/settings.json',reportDir:'/home/target/.llm-account-usage-feeds/x'}},
    uid:()=>2000,home:()=>'/home/target',env:{PATH:'/usr/bin'},nodePath:'/usr/bin/node',collectorPath:'/bundle/passive.cjs',
    readConsent:async()=>'yes',writeResult:async()=>{}
  });
  assert.equal(result.code,0);
  assert.equal(calls[0].uid,2000);
  assert.equal(calls[0].homeDir,'/home/target');
  assert.equal(calls[0].cliPath,'/opt/claude');
  assert.equal(JSON.stringify(calls[0]).includes('account'),false);
});

test('setup CLI rejects duplicate, relative, unknown and oversized arguments before setup',async()=>{
  for(const argv of [
    ['connect','--provider','claude','--provider','codex','--cli','/opt/claude','--result','/drop/r'],
    ['connect','--provider','claude','--cli','relative','--result','/drop/r'],
    ['connect','--provider','unknown','--cli','/opt/x','--result','/drop/r'],
    ['connect','--provider','claude','--cli','/opt/x','--result','/drop/r','--unknown','x']
  ])assert.equal((await run(argv,testDependencies())).code,2);
});

test('setup CLI writes nothing until the target user types the full consent word',async()=>{
  for(const answer of ['', 'y', 'no']) {
    const deps=testDependencies({answer});
    assert.equal((await run(validConnectArguments,deps)).code,1);
    assert.equal(deps.connectCalls.length,0);
  }
  const deps=testDependencies({answer:'yes'});
  assert.equal((await run(validConnectArguments,deps)).code,0);
  assert.equal(deps.connectCalls.length,1);
  assert.deepEqual(deps.connectCalls[0].trustedDirectories,deps.preview.sharedDirectories);
});
```

- [ ] **Step 2: Run CLI tests and verify the missing module failure**

Run: `node --test test/setup-cli.test.cjs`

Expected: FAIL with `Cannot find module '../src/setup-cli.cjs'`.

- [ ] **Step 3: Implement the strict setup CLI**

Parse a closed argument set without a shell or third-party parser. Use `process.getuid()`, `os.homedir()`, `process.env` and `process.execPath` from the target invocation. Call `discoverProvider` first, print the exact profile plus every shared path fingerprint, and require the user to type the full word `yes`; EOF or any other input writes a cancelled result and changes nothing. Pass exactly the preview's `sharedDirectories` into `connectProvider` after consent.

After discovery supplies the connection ID, default a cross-user feed to:

```js
path.join(os.homedir(),'.llm-account-usage-feeds',connectionId)
```

Create only the missing feed root/leaf under the target-owned home, using mode `2750`; validate every existing component before use. Write a bounded JSON result containing `{ok:true,connection}` or `{ok:false,code,message}` to the exact result path with `wx`, `O_NOFOLLOW` and mode `0644`. The result never contains settings bytes, hook commands, environment values or native CLI output.

- [ ] **Step 4: Add failing shared-feed setup tests**

```js
test('an explicit target-owned setgid feed is retained and publishes group-readable reports',async t=>{
  const f=await fixture(t);
  const feed=path.join(f.homeDir,'shared-feed');
  await fs.mkdir(feed,{mode:0o2750});
  await fs.chmod(feed,0o2750);
  const connection=await f.setup.connectProvider({...f.options,reportDir:feed});
  assert.equal(connection.reportDir,feed);
  assert.equal((await fs.stat(feed)).mode&0o7777,0o2750);
  const invocation=JSON.parse(execFileSync('/bin/sh',[connection.launcherPath],{input:'{}',encoding:'utf8'}));
  assert.equal(invocation.args[invocation.args.indexOf('--report-dir')+1],feed);
});

test('cross-user feed validation refuses world access, group writes, links and another owner',async t=>{
  const f=await fixture(t);
  for(const mode of [0o2755,0o2770,0o2777]) {
    const feed=path.join(f.homeDir,`feed-${mode.toString(8)}`);
    await fs.mkdir(feed,{mode:0o700});await fs.chmod(feed,mode);
    await assert.rejects(f.setup.connectProvider({...f.options,reportDir:feed}),{code:'UNSAFE_REPORT_DIRECTORY'});
  }
  const safe=path.join(f.homeDir,'safe-feed');await fs.mkdir(safe,{mode:0o700});
  const linked=path.join(f.homeDir,'linked-feed');await fs.symlink(safe,linked);
  await assert.rejects(f.setup.connectProvider({...f.options,reportDir:linked}),{code:'UNSAFE_REPORT_DIRECTORY'});
  const externalFs=withReportedOwner(fs,safe,process.getuid()+1);
  await assert.rejects(createSetup({fs:externalFs}).connectProvider({...f.options,reportDir:safe}),{code:'UNSAFE_REPORT_DIRECTORY'});
});
```

- [ ] **Step 5: Add a dedicated report-directory validator to setup**

Do not weaken `safeDirectories` for receipts or provider settings. Add `safeReportDirectory(directory,o,{create=false})` that walks with the same no-link and world-write checks, requires the leaf owner to equal `o.uid`, and accepts only `0700`, `0750`, `2700` or `2750`. When the CLI creates its default feed, create it directly with `2750`, then restat and validate. Pass the selected path through `locations` and receipt validation.

- [ ] **Step 6: Add failing handoff staging and result-boundary tests**

```js
test('handoff stages immutable readable code and accepts only the expected target result',async t=>{
  const handoff=await prepareHandoff({extensionPath:fixtureExtension,provider:'claude',
    target:{cliPath:'/opt/claude',process:{pid:20,uid:2000,start_ticks:'20',boot_id:'boot'}},tempRoot:t.tempRoot});
  assert.match(handoff.command,/node .*setup-cli\.cjs connect/);
  assert.equal((await fs.stat(path.dirname(handoff.resultPath))).mode&0o1777,0o1733);
  await writeResultAs(handoff.resultPath,validResult,{uid:2000,mode:0o644});
  assert.equal((await handoff.readResult()).connection.uid,2000);
  await handoff.dispose();
  await assert.rejects(fs.stat(handoff.root),{code:'ENOENT'});
});

test('handoff rejects the wrong owner, symlink, writable result and changed target',async t=>{
  for(const mutation of ['uid','symlink','mode','process'])
    await assert.rejects(readMutatedHandoffResult(mutation),/setup result could not be verified/i);
});
```

- [ ] **Step 7: Implement the one-time local handoff**

Create a random directory under `os.tmpdir()` with an owner-controlled `0755` bundle root and a sticky, non-listable `1733` result dropbox. Copy exactly `setup-cli.cjs`, `setup.cjs`, `connection.cjs` and `collectors/passive.cjs`; set code files to `0555` and the collector to `0444`. Build a single-quoted command beginning with `node`, never `sudo`.

`readResult` opens only the nonce-named result with `O_NOFOLLOW|O_NONBLOCK`, requires a regular single-link file no larger than 32 KiB, owner UID equal to `target.process.uid`, mode no broader than `0644`, a matching provider/UID and a valid connection ID. Re-run provider detection before accepting the result so a changed selected terminal cannot bind it. `dispose` removes only the exact `mkdtemp` directory.

- [ ] **Step 8: Add the cross-user extension flow**

When `detected.process.uid!==process.getuid()`, do not call `discoverProvider` or `connectProvider`. Prepare a handoff, show the exact target UID/provider and command, and offer `Copy setup command`. Use `vscode.env.clipboard.writeText(command)`, then `vscode.window.withProgress({cancellable:true})` to poll only `handoff.resultPath` for up to two minutes. On verified success:

```js
const safeError=(code,message)=>Object.assign(new Error(message),{code,message,safeToDisplay:true});
const managed=context.globalState.get('managedCrossUserConnections',[])
  .filter(value=>value.id!==result.connection.id);
const connection={...result.connection,pendingProcess:target.process,runtimeVersion:context.extension.packageJSON.version};
const probe=await readFeeds([connection.reportDir]);
if(probe.rejected)throw safeError('SHARED_FEED_UNREADABLE','The target-user report feed is not safely readable by this VS Code host. Configure a shared Linux group directory and connect again.');
managed.push(connection);
await context.globalState.update('managedCrossUserConnections',managed);
```

Merge these descriptors into the normal connection list and their report paths into the feed list. On cancellation or failure, dispose the bundle and do not update global state. Cross-user disconnect uses the same handoff with `disconnect --connection-id`, removing the descriptor only after a verified successful result.

On activation, retain reports from an older `runtimeVersion` but mark that connection as needing an explicit reconnect before calling it current; a VS Code extension update cannot refresh files owned by another user. Add an extension test with a stored older version and assert that the selected profile receives a reconnect action while its last validated report remains readable.

- [ ] **Step 9: Add extension tests for the explicit handoff**

Extend the harness with `process.getuid`, `vscode.env.clipboard`, `withProgress` and injected handoff functions. Assert:

```js
test('cross-user Connect stages a command instead of reading the host profile',async()=>{
  const foreign=target('claude',30,2000);
  const h=harness({terminal:terminal(),detect:async()=>foreign,handoff:successfulHandoff(foreign)});
  await h.commands.get('llmAccountUsage.connect')();
  assert.equal(h.connected.length,0);
  assert.match(h.clipboard,/setup-cli\.cjs connect/);
  assert.equal(h.storage.get('managedCrossUserConnections')[0].uid,2000);
});

test('cancelled or wrong-owner cross-user setup stores no connection or feed',async()=>{
  for(const outcome of ['cancel','wrong-owner']) {
    const h=harness({terminal:terminal(),detect:async()=>target('claude',30,2000),handoff:failedHandoff(outcome)});
    await h.commands.get('llmAccountUsage.connect')();
    assert.deepEqual(h.storage.get('managedCrossUserConnections',[]),[]);
  }
});
```

- [ ] **Step 10: Run the setup, handoff, extension and passive suites**

Run: `node --test test/setup-cli.test.cjs test/handoff.test.cjs test/setup.test.cjs test/extension.test.cjs test/passive.test.cjs test/core.test.cjs`

Expected: PASS. Existing collector tests prove `2750` directories and `0640` reports; new tests prove only the setup control path crosses users.

- [ ] **Step 11: Commit the explicit cross-user setup slice**

```bash
git -C /opt/glitch/workspaces/llm-oauth-acc-usage-indicator--more-bugfixing-of-blastworksai-llm-oauth add src/setup-cli.cjs src/handoff.cjs src/setup.cjs src/extension.cjs test/setup-cli.test.cjs test/handoff.test.cjs test/setup.test.cjs test/extension.test.cjs
git -C /opt/glitch/workspaces/llm-oauth-acc-usage-indicator--more-bugfixing-of-blastworksai-llm-oauth commit -m "feat: add explicit cross-user profile setup"
```

### Task 6: Document, package and prove the release candidate

**Files:**
- Modify: `README.md:13-63`
- Modify: `docs/SETUP.md`
- Modify: `docs/PRIVACY.md`
- Modify: `package.json:4`
- Modify: `package-lock.json`
- Test: all `test/*.test.cjs`
- Output: `artifacts/llm-oauth-acc-usage-indicator-0.3.5.vsix`

**Interfaces:**
- Consumes: all code and tests from Tasks 1-5.
- Produces: a version `0.3.5` VSIX whose allowlisted payload includes the setup helper and whose documented behavior matches the verified support boundary.

- [ ] **Step 1: Update public setup and privacy documentation**

Document these exact behaviors:

- Connect every provider profile independently; order does not matter.
- Same-user Remote-SSH setup remains one confirmation.
- Cross-user Remote-SSH shows one command to run in a separate target-user shell; it never invokes `sudo` or stops the running agent.
- The target user needs `node` for that one-time setup command.
- Cross-user reports require a target-owned group-readable feed, at most `2750`/`0640`; failure remains private and explains the missing permission.
- The report still contains only provider/session/process identity, optional account email/tier, quota windows and timestamps.
- Disconnect is per profile and restores only that profile's backed-up hook/statusline.

Remove the README claim that cross-user `sudo` sessions are categorically unsupported. Do not claim WSL, containers, Codespaces, local Windows terminals or macOS terminals.

- [ ] **Step 2: Bump only the patch version**

Run: `npm version 0.3.5 --no-git-tag-version`

Expected: `package.json` and `package-lock.json` both report `0.3.5`; no tag or commit is created.

- [ ] **Step 3: Run the complete automated verification**

Run: `npm test`

Expected: every Node test passes with zero failures.

- [ ] **Step 4: Package the candidate and inspect its allowlisted contents**

Run: `npm run package`

Expected: `artifacts/llm-oauth-acc-usage-indicator-0.3.5.vsix` is created.

Run: `unzip -l artifacts/llm-oauth-acc-usage-indicator-0.3.5.vsix`

Expected: the archive includes `extension/src/setup-cli.cjs`, `extension/src/handoff.cjs`, `extension/src/connection.cjs`, `extension/src/setup.cjs`, `extension/collectors/passive.cjs`, the extension runtime/media/docs required by `.vscodeignore`, and no `test/`, `.git/`, `.env`, fixture or local configuration files.

- [ ] **Step 5: Install and exercise the exact VSIX on Odin at an approved safe moment**

Install the candidate through **Extensions: Install from VSIX…**, reload the Remote-SSH window, then use the real terminal profiles. Do not reuse source-tree execution as evidence.

Record this matrix in the task results:

```text
Order A: ClaudeKK -> ClaudeBW -> ChatGPTKK -> Antigrav
Order B: ClaudeBW -> ClaudeKK

For every row:
- Connect identifies the selected provider process and UID.
- Cross-user setup never stops the running CLI.
- A fresh completed turn produces the correct account and quota card.
- Switching terminals selects the corresponding live report.
- Another same-provider profile remains independently connectable.
- Disconnecting one profile leaves the other profile's card and hook working.
```

The two Claude profiles must be disconnected between Order A and Order B so the opposite order is a genuine first-wins regression test. Do not publish or replace the Marketplace release unless every row passes.

- [ ] **Step 6: Commit the release candidate sources after evidence is recorded**

```bash
git -C /opt/glitch/workspaces/llm-oauth-acc-usage-indicator--more-bugfixing-of-blastworksai-llm-oauth add README.md docs/SETUP.md docs/PRIVACY.md package.json package-lock.json
git -C /opt/glitch/workspaces/llm-oauth-acc-usage-indicator--more-bugfixing-of-blastworksai-llm-oauth commit -m "release: prepare multi-profile account usage 0.3.5"
```

- [ ] **Step 7: Run final branch verification**

Run: `npm test`

Expected: all tests pass at the final commit.

Run: `git -C /opt/glitch/workspaces/llm-oauth-acc-usage-indicator--more-bugfixing-of-blastworksai-llm-oauth status --short`

Expected: no output except the gitignored packaged artifact, if ignored; tracked source and documentation are clean.
