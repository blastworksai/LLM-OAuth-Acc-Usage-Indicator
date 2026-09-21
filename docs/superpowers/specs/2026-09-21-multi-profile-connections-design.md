# Multi-profile connection correction

## Status

Approved in conversation on 21 September 2026. Retain the existing after-turn
collector and correct only the connection/setup control plane.

## Outcome

Account Usage supports several simultaneous profiles of the same provider. Each
profile independently publishes provider, account and quota data after a fresh
turn, and selecting a terminal selects the matching live report. The order in
which profiles are connected has no effect.

The packaged extension must prove this on a Windows VS Code client connected by
Remote-SSH to Linux, including terminals whose CLI runs as a different Linux user
from the extension host.

## Keep the existing data plane

The after-turn collection design remains authoritative:

1. The provider completes a turn.
2. Its local statusline or stop-hook adapter runs in that CLI's user, profile and
   OAuth context.
3. The adapter captures provider, account identity when reported, quota windows,
   session identity and live Linux process identity.
4. It validates, sanitizes and atomically writes one bounded report.
5. The extension matches that report to the selected terminal by process identity
   and ancestry.

There is no account registry, account-to-user map, background daemon, network
relay, credential read or terminal-title heuristic. Account identity is learned
at the trustworthy event: the completed turn.

## Root cause being corrected

Version 0.3.4 made two control-plane assumptions that the report protocol does
not require:

- persistent setup state is stored in one directory per provider, so the first
  profile connected occupies the provider's only slot;
- discovery and setup use the extension host's UID, home and PATH even when the
  selected provider process runs as another Linux user.

This creates a literal first-wins race. Later profiles either conflict with the
first receipt, inspect the wrong profile directory, or fall back to a script
launcher from the extension host's PATH.

## Connection identity

A connection is a provider profile, not a provider and not an OAuth account.
Its stable identity consists of:

- provider;
- numeric Linux UID that owns the profile;
- canonical provider settings path.

The on-disk connection ID is a versioned digest of those fields. The receipt also
stores the unhashed fields for validation and recovery. OAuth email is never part
of the key because it may be unavailable before the first turn and can change when
the user signs in again.

Each connection has its own receipt, backup, launcher, collector and report feed.
Connect, refresh, upgrade and disconnect operate on exactly one connection.

## Setup behavior

### Same Linux user

The existing consent flow remains automatic. It discovers the selected native
CLI and profile, shows the exact profile and trust boundary, then installs the
adapter for that connection only.

### Different Linux user

The extension never edits another user's profile and never elevates itself.
Instead it prepares one bounded setup command and asks the user to run it in a
separate shell under the selected CLI user. The running agent session is not
interrupted.

The helper performs the same validation and consented change as same-user setup.
It receives the exact provider, profile and report-feed paths as arguments; it
does not discover accounts, read credentials or infer an estate-specific user,
group, home or `sudo` command.

Cross-user reports use an explicitly selected existing directory that is writable
by the connector user and readable by the extension-host user. Standard Linux
owner/group permissions are validated, not changed. A safe setgid directory with
mode `2750` and reports with mode `0640` is supported. If no such directory exists,
setup explains the filesystem requirement and stops; it does not weaken privacy
or make reports world-readable.

The machine-local feed-directory setting records only the sanitized report path.
It is not an account or Unix-user mapping.

## Extension behavior

- `listConnections` returns every valid connection rather than at most one entry
  for each provider.
- Connected and pending state is evaluated against the selected live process and
  profile connection, never a set of provider names.
- Before the first report, a bounded pending record ties the just-connected live
  process identity to its connection. It expires when that process exits.
- After a fresh turn, the existing report matcher is authoritative.
- A connected Claude profile does not remove `Connect Claude` for another
  unconnected Claude profile.
- Disconnect presents individual profile connections and restores only the exact
  configuration backed up by the selected receipt.

## Migration

A valid version-1 provider receipt already contains provider, UID and settings
path. The setup owner can therefore migrate it deterministically to the new
connection ID without account inference.

Migration validates the original receipt and installed hook before moving any
state. Missing, conflicting or unverifiable state is left untouched and gets an
explicit recovery message. Migration never assigns one profile's receipt to
another profile.

## Failure behavior

- Adapter failure never blocks the provider turn.
- One damaged connection cannot suppress another connection, including another
  profile of the same provider.
- Missing cross-user read/write permission produces a precise setup error.
- Ambiguous live reports remain unavailable; the extension never chooses the
  newest report or guesses by account email.
- Setup, refresh and disconnect preserve unrelated hooks, statuslines, receipts
  and reports byte-for-byte.

## Verification and release gate

Automated regression tests must prove:

- two Claude profiles coexist and are listed in either connection order;
- two profiles of every supported provider have independent receipts, runtime
  paths, reports, refresh and disconnect behavior;
- connecting one profile never removes the setup action for another live profile;
- same-provider reports still select solely by live process identity;
- setup uses the selected target UID/profile rather than the extension host's
  home or PATH;
- cross-user setup refuses an unreadable or unsafe feed without changing profile
  configuration;
- valid version-1 receipts migrate deterministically and ambiguous state fails
  closed.

The release candidate VSIX must then be installed and exercised on the real
Remote-SSH topology. Both Claude accounts, Codex and Antigravity must publish after
a fresh turn and switch correctly by active terminal. At least the two Claude
profiles must be disconnected and reconnected in the opposite order to prove that
there is no first-wins state.

## Non-goals

- a provider/account registry;
- a cross-user daemon or authenticated report relay;
- hard-coded estate users, groups, paths or privilege rules;
- reading OAuth credential files;
- interrupting a running agent to perform setup;
- weakening local report privacy to make cross-user sharing automatic.
