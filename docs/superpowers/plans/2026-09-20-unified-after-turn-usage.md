# Unified After-Turn Account Usage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Codex, Claude Code, and Antigravity publish terminal-bound account usage after a completed turn, while restoring a usable setup action when provider detection is unavailable.

**Architecture:** Keep the existing bounded report schema, publisher-process identity, atomic report store, and terminal matcher. Claude Code and Antigravity retain their working statusline publishers; Codex installs a user-level `Stop` hook that invokes the bundled collector in the active Codex process and profile context, then queries `account/read` and `account/rateLimits/read` without a model turn. The extension becomes a report reader for every provider and offers either a provider-specific connection or a generic picker when safe process detection cannot name an unconnected provider.

**Tech Stack:** Node.js CommonJS, VS Code Extension API, Linux `/proc`, Codex hooks JSON, Codex app-server JSON-RPC, Node test runner.

**Spec:** `docs/superpowers/specs/2026-09-20-unified-after-turn-usage-design.md`

## Build choices

orchestration: native
runs_in: task:align-all-providers-on-zero-token-after

## Global Constraints

- Linux terminal hosts only; do not broaden the published platform claim.
- No model request, prompt injection, transcript content, credential-file parsing, token storage, user-to-account mapping, terminal-title inference, or newest-report guessing.
- Hook and native-query stdout must remain empty; errors must not block or change the CLI turn.
- Preserve existing Claude, Antigravity, and Codex hook/statusline commands through connect, upgrade, and disconnect.
- Native commands use argument arrays without a shell, bounded time and output, and may kill only their own child.
- Reports remain schema version 1 and keep the current ownership, mode, size, atomic-write, live-process, and terminal-ancestry checks.
- Failed account or quota reads publish explicit partial coverage and never reuse identity from an older turn.

## Declared file actions

### UPDATE /opt/glitch/workspaces/llm-oauth-acc-usage-indicator--align-all-providers-on-zero-token-after/collectors/passive.cjs
### UPDATE /opt/glitch/workspaces/llm-oauth-acc-usage-indicator--align-all-providers-on-zero-token-after/src/extension.cjs
### UPDATE /opt/glitch/workspaces/llm-oauth-acc-usage-indicator--align-all-providers-on-zero-token-after/src/panel.cjs
### UPDATE /opt/glitch/workspaces/llm-oauth-acc-usage-indicator--align-all-providers-on-zero-token-after/src/provider.cjs
### UPDATE /opt/glitch/workspaces/llm-oauth-acc-usage-indicator--align-all-providers-on-zero-token-after/src/setup.cjs
### UPDATE /opt/glitch/workspaces/llm-oauth-acc-usage-indicator--align-all-providers-on-zero-token-after/test/extension.test.cjs
### UPDATE /opt/glitch/workspaces/llm-oauth-acc-usage-indicator--align-all-providers-on-zero-token-after/test/panel.test.cjs
### UPDATE /opt/glitch/workspaces/llm-oauth-acc-usage-indicator--align-all-providers-on-zero-token-after/test/passive.test.cjs
### UPDATE /opt/glitch/workspaces/llm-oauth-acc-usage-indicator--align-all-providers-on-zero-token-after/test/provider.test.cjs
### UPDATE /opt/glitch/workspaces/llm-oauth-acc-usage-indicator--align-all-providers-on-zero-token-after/test/setup.test.cjs
### UPDATE /opt/glitch/workspaces/llm-oauth-acc-usage-indicator--align-all-providers-on-zero-token-after/README.md
### UPDATE /opt/glitch/workspaces/llm-oauth-acc-usage-indicator--align-all-providers-on-zero-token-after/docs/SETUP.md
### UPDATE /opt/glitch/workspaces/llm-oauth-acc-usage-indicator--align-all-providers-on-zero-token-after/docs/PRIVACY.md
### UPDATE /opt/glitch/workspaces/llm-oauth-acc-usage-indicator--align-all-providers-on-zero-token-after/docs/superpowers/specs/2026-09-20-unified-after-turn-usage-design.md
### UPDATE /opt/glitch/workspaces/llm-oauth-acc-usage-indicator--align-all-providers-on-zero-token-after/package.json
### UPDATE /opt/glitch/workspaces/llm-oauth-acc-usage-indicator--align-all-providers-on-zero-token-after/package-lock.json

## Review Focus

- A Codex hooks file with unrelated events and multiple existing `Stop` entries retains every existing entry in order after connect and after disconnect.
- A completed Codex turn whose account query succeeds but rate-limit query fails publishes that turn's account with no stale windows and an explicit partial-coverage statement.
- A completed Codex turn whose rate-limit query succeeds but account query fails publishes current windows without an account identity.
- A process replacement between hook input, native query, and publish produces no report for the replacement process.
- An unavailable terminal with unknown provider offers only unconnected providers; changing terminals during its confirmation cannot connect a profile silently.

---

### Task 1: Restore safe universal connection entry points

**Files:**
- Modify: `src/provider.cjs`
- Modify: `src/extension.cjs`
- Modify: `src/panel.cjs`
- Modify: `test/provider.test.cjs`
- Modify: `test/extension.test.cjs`
- Modify: `test/panel.test.cjs`

**Interfaces:**
- Consumes: `detectProvider(terminalPid)` and `setup.listConnections()`.
- Produces: a detected `{provider, cliPath, executable, process}` for Codex as well as Claude/Antigravity; `state.setupTarget` as either an exact target or `{provider:null}`; `buildViewModel(...).setupProvider` where `null` means no action, `generic` means `Connect Provider`, and a provider name means a specific action.

- [x] **Step 1: Write failing provider, extension, and panel tests**

```js
test('a foreground native Codex process is detected through its stable CLI lookup', async () => {
  // Arrange `/opt/tools/codex` -> `/opt/releases/codex/1.0.0` and assert the
  // detector returns provider `codex` with the live process identity.
});

test('an unknown unavailable session offers the generic picker for unconnected providers', async () => {
  // Refresh with no detector result, click the card action, choose Codex, and
  // assert setup receives provider `codex` only after the normal confirmation.
});

test('unknown sessions stop offering setup when every provider is connected', async () => {
  // Supply connected Claude, Codex, and Antigravity receipts and assert no
  // setup target, button, or picker is reachable.
});

test('unavailable cards render specific and generic setup labels only when offered', () => {
  // Assert Connect Codex/Claude/Antigravity for exact targets, Connect Provider
  // for `{provider:null}`, and no button without `setupTarget`.
});
```

- [x] **Step 2: Run the focused tests and verify RED**

Run: `node --test test/provider.test.cjs test/extension.test.cjs test/panel.test.cjs`

Expected: failures show Codex is not detected, generic setup is absent, and the panel cannot render Codex or generic labels.

- [x] **Step 3: Implement the minimal connection behavior**

```js
// provider.cjs: include the native `codex` lookup alongside `claude` and `agy`.
for (const [provider, command] of [
  ['claude', 'claude'],
  ['codex', 'codex'],
  ['antigravity', 'agy']
]) { /* existing safe lookup and live-process checks */ }

// extension.cjs: exact detection wins; otherwise expose a generic target only
// while at least one supported provider is not connected.
result.setupTarget = target && !connected.has(target.provider)
  ? target
  : !target && connected.size < 3
    ? {provider:null}
    : undefined;
```

The picker contains Codex, Claude Code, and Antigravity, excludes connected providers, rechecks the selected terminal before the write, and retains the existing profile/executable confirmation.

- [x] **Step 4: Run the focused tests and verify GREEN**

Run: `node --test test/provider.test.cjs test/extension.test.cjs test/panel.test.cjs`

Expected: all focused tests pass with no warnings.

- [x] **Step 5: Commit**

```bash
git add src/provider.cjs src/extension.cjs src/panel.cjs test/provider.test.cjs test/extension.test.cjs test/panel.test.cjs
git commit -m "fix: restore provider setup from unavailable terminals"
```

### Task 2: Collect Codex identity and quota after a completed turn

**Files:**
- Modify: `collectors/passive.cjs`
- Modify: `test/passive.test.cjs`

**Interfaces:**
- Consumes: a Codex `Stop` hook JSON object on stdin, the live Codex ancestor, and that hook process's `HOME`/optional `CODEX_HOME`.
- Produces: `codexNativeReport(data, identity, executable, capturedAt, options)` returning the existing schema-v1 report populated from one bounded app-server observation; `runCollection(... mode:'codex-hook')` publishes it.

- [ ] **Step 1: Write failing native-query and report tests**

```js
test('Codex Stop reads account and all rate-limit buckets without a model turn', async () => {
  // Fake app-server initialize, account/read, and account/rateLimits/read.
  // Assert refreshToken:false, no turn/start request, the current email/plan,
  // all primary/secondary buckets, and source/account timestamps from this hook.
});

test('Codex Stop publishes partial reports instead of stale account or quota data', async () => {
  // Exercise account-only, quota-only, and both-query-failed responses and
  // assert each report contains only this observation plus explicit coverage.
});

test('Codex Stop emits no stdout and process replacement prevents publication', async () => {
  // Run main with a hook payload and assert empty stdout; replace the ancestor
  // identity before publish and assert no report is accepted.
});
```

- [ ] **Step 2: Run the focused collector tests and verify RED**

Run: `node --test test/passive.test.cjs`

Expected: failures show `codex-hook` still reads transcript quota and has no paired native account/rate-limit query.

- [ ] **Step 3: Implement the bounded Codex app-server observation**

```js
// Start only the selected Codex binary's app-server and send, after initialize:
send({id:2, method:'account/read', params:{refreshToken:false}});
send({id:3, method:'account/rateLimits/read', params:{}});

// Prefer rateLimitsByLimitId when present, otherwise the single rateLimits
// bucket. Sanitize only limitId/primary/secondary/planType and email. Build the
// report from the hook's session_id and current capture time; never include the
// hook prompt, assistant message, transcript path, tokens, or raw native output.
```

Spawn with a closed environment containing only validated `HOME`, optional `CODEX_HOME`, fixed `PATH`, and locale. Bound stdout/stderr, duration, JSON line size, and process rechecks. Query failures return a report with empty missing fields and coverage naming the unavailable observation; unsafe process/profile state fails without publishing.

- [ ] **Step 4: Run the focused collector tests and verify GREEN**

Run: `node --test test/passive.test.cjs`

Expected: all collector tests pass with no warnings.

- [ ] **Step 5: Commit**

```bash
git add collectors/passive.cjs test/passive.test.cjs
git commit -m "feat: publish Codex usage after each completed turn"
```

### Task 3: Install, refresh, and restore the Codex user hook

**Files:**
- Modify: `src/setup.cjs`
- Modify: `test/setup.test.cjs`

**Interfaces:**
- Consumes: provider `codex`, its native executable, a Codex profile directory, and the existing `<profile>/hooks.json` object.
- Produces: an idempotent managed `Stop` hook, a provider receipt/report directory compatible with `listConnections`, and exact removal/restoration behavior on disconnect.

- [ ] **Step 1: Write failing Codex setup lifecycle tests**

```js
test('Codex connect appends one managed Stop hook and preserves unrelated hooks', async () => {
  // Seed SessionStart plus two Stop entries, connect twice, and assert one
  // managed entry, original entries unchanged and ordered, and report runtime.
});

test('Codex disconnect removes only its exact managed Stop hook', async () => {
  // Modify an unrelated hook after connect, disconnect, and assert the unrelated
  // edit survives while Account Usage is removed.
});

test('edited or replaced managed Codex hooks fail closed with recovery intact', async () => {
  // Change the installed command and assert refresh/disconnect refuse without
  // overwriting hooks.json or the saved pre-connect backup.
});
```

- [ ] **Step 2: Run setup tests and verify RED**

Run: `node --test test/setup.test.cjs`

Expected: failures show Codex is rejected as unsupported and no hooks file lifecycle exists.

- [ ] **Step 3: Implement provider-specific Codex setup**

```js
const PROVIDERS = ['claude', 'codex', 'antigravity'];

// Codex profile defaults to `<home>/.codex`; its settings path is hooks.json.
// The managed entry is a normal Stop command hook with a unique marker in the
// absolute launcher command. Claude and Antigravity keep their statusLine path.
```

The Codex launcher reads hook JSON from stdin, invokes `passive.cjs codex-hook` with the pinned native CLI and report directory, redirects collector output, and always exits zero so usage collection cannot change the turn. Receipts identify the provider-specific installed entry; refresh rewrites only runtime bytes, connect is idempotent, and disconnect removes only an unchanged exact managed hook while retaining all unrelated hook configuration.

- [ ] **Step 4: Run setup tests and verify GREEN**

Run: `node --test test/setup.test.cjs`

Expected: all setup tests pass, including the existing Claude and Antigravity cases.

- [ ] **Step 5: Commit**

```bash
git add src/setup.cjs test/setup.test.cjs
git commit -m "feat: manage Codex after-turn usage hooks"
```

### Task 4: Make reports authoritative, document the flow, and package acceptance bytes

**Files:**
- Modify: `src/extension.cjs`
- Modify: `test/extension.test.cjs`
- Modify: `README.md`
- Modify: `docs/SETUP.md`
- Modify: `docs/PRIVACY.md`
- Modify: `docs/superpowers/specs/2026-09-20-unified-after-turn-usage-design.md`
- Modify: `package.json`
- Modify: `package-lock.json`
- Test: `test/*.test.cjs`

**Interfaces:**
- Consumes: connected provider report directories and configured additional feed directories.
- Produces: one report-only selection path for every provider, version `0.3.3`, current setup/privacy documentation, and a VSIX whose bytes pass the installed-package acceptance checks.

- [ ] **Step 1: Write failing authoritative-path tests**

```js
test('Codex selection reads its connected report and never invokes direct collection', async () => {
  // Supply a matching Codex report; make any direct collector throw; assert the
  // card is ready from the report and no extension-host native query occurs.
});

test('a connected provider without a fresh report is pending without a setup action', async () => {
  // Detect exact Codex/Claude/Antigravity targets with matching connections and
  // assert the waiting reason and absence of a connect button.
});
```

- [ ] **Step 2: Run extension tests and verify RED**

Run: `node --test test/extension.test.cjs`

Expected: the direct Codex collector is still invoked before report feeds and the new authoritative-path assertion fails.

- [ ] **Step 3: Remove the shipped direct-collection call and update product text**

```js
// extension.cjs selection order for all providers:
await setupReady;
const connections = await setup.listConnections(setupOptions).catch(() => []);
const {reports, rejected} = await readFeeds([...connectionDirs, ...extraDirs]);
const result = await matchReports(pid, reports);
```

Document that every provider publishes locally after a fresh turn, Codex setup modifies only its user-level `Stop` hooks, existing provider commands are preserved, reports contain sanitized identity/quota fields only, and the after-turn process adds no model input or tokens. Change package and lockfile version to `0.3.3`.

- [ ] **Step 4: Run full validation and package**

Run: `npm test`

Expected: every test passes with zero failures.

Run: `npm run package`

Expected: package succeeds and creates the versioned VSIX.

Run: `npx vsce ls --tree`

Expected: the bundled collector, source, media, docs, manifest, license, and notices are present; tests and planning files are absent.

- [ ] **Step 5: Exercise installed-package acceptance**

```text
Install the final VSIX into the real Remote-SSH extension host. Connect Codex,
Claude Code, and Antigravity through the card/command flow. For each provider,
complete one fresh turn and verify the selected terminal shows that session's
email (when supplied), plan, quota windows, and reset times. Reload VS Code and
switch among the three terminals; each must retain its own matching card.
Before an Antigravity report exists, verify a provider-specific or generic setup
button is present. While Codex/Claude/Antigravity is connected but waiting for
its next turn, verify no setup button remains.
```

Expected: both reported regressions are absent in the installed package, and no hook writes model-visible output.

- [ ] **Step 6: Commit**

```bash
git add src/extension.cjs test/extension.test.cjs README.md docs/SETUP.md docs/PRIVACY.md docs/superpowers/specs/2026-09-20-unified-after-turn-usage-design.md package.json package-lock.json
git commit -m "release: prepare Account Usage 0.3.3"
```

## Progress

- Checkpoint 1 implemented: Codex detection plus safe generic/provider-specific setup actions; RED confirmed 4 failures, GREEN `36/36` via `node --test test/provider.test.cjs test/extension.test.cjs test/panel.test.cjs`.
