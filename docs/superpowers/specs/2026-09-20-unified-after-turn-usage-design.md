# Unified after-turn account usage design

## Status

Approved in conversation on 20 September 2026. Implemented for version 0.3.3; final installed-package acceptance remains the release gate.

## Outcome

Account Usage follows the selected supported CLI terminal and, after that session completes a fresh turn, shows the OAuth account and quota reported for that session. Codex, Claude Code and Antigravity use the same collection shape.

Success means:

- a fresh completed turn produces one sanitized account-usage report without starting a model turn or adding anything to model context;
- switching terminals switches to the report for that live session, including when several accounts of one provider are active concurrently;
- a provider that has not been connected offers a setup action, while a connected, pending or populated card does not retain a setup button;
- no user-to-account mapping, terminal-title inference, hard-coded machine identity or credential-file parsing is required;
- existing account-card functionality remains: account email when reported, subscription tier, quota windows, reset times and explicit unavailable states.

## Problem

The public release currently has three different collection shapes:

- Codex is collected directly by the VS Code extension from a same-user Linux process and transcript;
- Claude Code publishes through a configured statusline adapter;
- Antigravity publishes through a configured statusline adapter and may run its native `/usage` query.

Version 0.3.2 also made the setup button depend on the extension host identifying the selected provider through process metadata. That suppresses setup when the extension cannot inspect the provider process, and direct Codex collection fails for the same reason. These are consequences of where collection runs, not reasons to configure account mappings or remove account usage.

## Design decision

All supported providers publish through one after-turn adapter contract. The adapter runs in the CLI session's own user and OAuth context, gathers native account and quota metadata, and writes the same bounded report schema already consumed by the extension. The extension matches reports to the selected live terminal and renders them; it does not query provider accounts itself.

The completed turn is the binding event. Account metadata is not injected into that turn. The adapter emits no model-visible output and does not submit a prompt.

### Provider sources

| Provider | Turn trigger | Native account and quota source |
| --- | --- | --- |
| Codex | user-level turn-completion hook | `account/read` with token refresh disabled and `account/rateLimits/read` in the active Codex profile |
| Claude Code | configured statusline update after an API response | statusline session/rate-limit payload plus native `claude auth status` metadata |
| Antigravity | configured idle/statusline update after a turn | statusline session/account metadata plus native `/usage` output |

Each adapter is provider-specific only at this boundary. Its output is provider-neutral apart from the provider name and the closed set of provider quota pools.

## Report contract

The existing versioned report envelope remains the interchange format:

- provider and session identifier;
- live publisher process identity: PID, UID, process start ticks and boot ID;
- capture and provider-observation times;
- account email and subscription tier only when returned by the provider-native account query for that observation;
- named quota pools and windows with usage, duration and reset time;
- a bounded coverage statement describing omitted or unavailable provider data.

Reports are written atomically. Readers retain the existing path, ownership, mode, size, schema, filename and live-process validation. A failed identity query cannot reuse identity from an older turn. A failed quota query produces an explicit unavailable or partial report rather than another account's cached values.

No access token, refresh token, credential path, raw transcript, prompt, response text or native command output is written to the report.

## Runtime flow

1. A supported CLI completes a turn.
2. Its configured adapter runs locally in that CLI's account context.
3. The adapter captures and rechecks the live CLI process identity.
4. It invokes the provider-native account and quota reads with strict time and output bounds and without a model request.
5. It validates, sanitizes and atomically publishes one report.
6. When the Account Usage view is visible, selected-terminal changes and normal refreshes read the configured report directories.
7. Existing ancestry and foreground-process matching selects exactly one live report for the active terminal. Ambiguity remains unavailable; the extension never guesses by terminal name, recency or email.
8. The webview renders the matched card in the viewing computer's timezone.

The first card for a session may remain pending until that session completes one fresh turn. This is accepted product behavior.

## Connection and card behavior

Connection remains an explicit one-time consent because setup modifies a provider's user-level hook or statusline configuration.

- A ready account card has no setup button.
- A connector that is installed and waiting for its first fresh turn has no setup button and says it is waiting for a fresh turn.
- An unavailable card for a confidently detected, unconnected provider shows `Connect Claude`, `Connect Codex` or `Connect Antigravity`.
- When the provider cannot be identified safely, the unavailable card shows `Connect Provider`; the existing provider picker is the next step.
- Unsupported sessions may show the generic action only when provider setup can genuinely proceed. A setup action must never silently bind a different profile.

Setup preserves and chains an existing user hook or statusline command. Disconnect restores the exact previous configuration. Installation, upgrade and disconnect are idempotent and recoverable after interruption.

For the ordinary case, the extension and CLI run as the same OS user and setup writes the user's native configuration after consent. If the selected CLI runs as another OS user, setup must execute in that user's context through an explicit user action; the extension does not elevate itself, read that user's credentials or maintain a cross-user account map. The report protocol itself remains identical.

## Migration

- Existing valid Claude Code and Antigravity connections are retained and upgraded in place.
- Codex has moved from extension-host collection to the after-turn connector. The extension's selection path reads reports for all three providers and no longer invokes direct Codex collection.
- The shipped runtime has one authoritative report path, so duplicate observations cannot become an ambiguity.
- Existing reports remain readable until they go stale or their publisher exits. No historical login is reconstructed.
- The public support matrix continues to state only platforms and transports that have passed real installation and runtime acceptance. This change does not silently broaden OS claims.

## Failure behavior

- Adapter failure never blocks or changes the user's CLI turn.
- Hooks emit no stdout or additional model context. Safe diagnostics are local and contain no provider output or account identifiers.
- Native queries are bounded by elapsed time and bytes, use argument arrays without a shell, and kill only the child process created for the query.
- A process change, login uncertainty, unsafe path, malformed output, several matching sessions or unreadable report fails closed to a clear unavailable state.
- A stale report is visibly stale and is never presented as a fresh observation.

## Verification

Automated tests must prove:

- each adapter produces the same validated report contract from a fresh turn;
- adapter execution adds no hook output or model input and invokes no model command;
- Codex account and rate-limit reads remain paired to the same fresh turn observation;
- Claude and Antigravity preserve existing statusline behavior while publishing usage;
- two concurrent accounts of the same provider remain distinct;
- login changes, process replacement, stale turns, out-of-order completion and query failure cannot reuse another account's identity;
- terminal switching, editor reload and extension upgrade select the correct live report;
- ready and pending cards have no connect button, while an unconnected empty card has a usable provider-specific or generic setup action;
- existing hook/statusline commands survive connect, upgrade and disconnect byte-for-byte.

Installed-package acceptance must cover one real fresh turn for Codex, Claude Code and Antigravity, including the reported failing shapes: a selected Codex session produces a card after its next turn, and an unconnected Antigravity session offers setup before its first report. Release evidence is bound to the final VSIX bytes.

## Non-goals

- account or Unix-user mapping tables;
- deriving identity from terminal titles, process names, email equality or newest-file heuristics;
- reading or storing OAuth tokens;
- polling providers independently of a live session turn;
- adding account metadata to model context;
- claiming a platform, transport or provider version that has not passed real acceptance.
