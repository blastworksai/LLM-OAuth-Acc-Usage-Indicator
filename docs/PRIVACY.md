# Privacy

Account Usage runs on the VS Code extension host. It has no analytics endpoint or hosted collection service.

## Read locally

On Linux, terminal matching reads bounded process metadata: process IDs, user IDs, start ticks, boot ID, terminal foreground groups and executable paths. Every provider publishes the same bounded report from its own CLI context after a fresh turn. The extension reads those reports; it does not search transcripts, map operating-system users to accounts or infer accounts from terminal titles.

For Codex, the `Stop` hook uses the event's session identifier but does not read or store its transcript path, prompt or response. Only `HOME` and optional `CODEX_HOME` are forwarded to the short-lived native app-server child; credential and endpoint environment overrides are not forwarded. The collector does not read login files or decode saved tokens. It calls `account/read` with token refresh disabled and pairs that response with `account/rateLimits/read` from the same observation.

Claude and Antigravity connections receive the provider's native statusline input.
Sanitized reports still contain only provider/session/process identity, optional account email and subscription tier, quota windows and timestamps.
Connecting additional profiles or sharing a cross-user feed does not expand this report schema.
Raw conversations, hook payloads and credentials are not copied into reports.
Existing user statusline commands receive their original input so their behavior can be preserved.

## Provider requests

The extension sends no model prompts. Turn-completion collection returns no model-visible output, adds nothing to model context and consumes no model tokens. Native commands run under the existing user's login. Antigravity's built-in quota command and provider-native account/rate-limit reads may contact their provider backends through normal authentication machinery; the extension does not implement a login-renewal flow.

Quota readings can include use from other terminals and sessions on the same account. An email represents the current CLI login when the reading is observed, not a reconstruction of historical session logins.

## Stored locally

Each provider profile keeps its own backup, connection receipt and stable collector runtime under `~/.local/state/llm-account-usage/` on the profile owner's Linux host account.
Same-user reports also stay in that owner-private storage.
It survives removal of editor installation files, so a configured hook remains recoverable if editor files disappear.
Connections are distinguished by provider, numeric Linux UID and settings path, not by an account email or a user-to-account registry.
These are runtime data on the installing user's machine, never included in the downloadable package.

For cross-user setup, the target user publishes sanitized reports in a separate feed at `/var/lib/llm-account-usage/feeds/<connection-id>/`, which the connect wizard creates with `sudo`.
That feed is owned by the target user, with the VS Code account's primary group, so the extension host can read it.
Directory permissions are at most `2750` (`0750` without setgid); report files and the connection descriptor are at most `0640`.
Members of that group can read the reports, including account email when present, and the connection descriptor's UID and local configuration/runtime paths.
Backed-up settings and the private collector runtime are not placed in the shared feed.
The extension records the accepted feed path in machine-local editor state.
It does not add group memberships, change existing permissions or make reports world-readable if access fails.
Disconnect through the wizard removes the feed folder; a disconnect without `sudo` leaves it in place, because removing it needs an admin.

For a session owned by another Linux account, the extension uses `sudo` to change that account's settings and create its feed only after you press **Connect** on a review screen that lists every change and the exact commands.
Before that screen, `sudo` only checks that it is available, stages the setup files and reads the profile as that account.
If `sudo` needs a password, you type it into VS Code's password box; it goes to `sudo -S` for that run only and is never written anywhere.
The extension never stores a sudo password, never sends text into the agent's terminal and never stops the selected agent.
With `sudo`, root stages the setup files the target account runs in `/var/lib/llm-account-usage/bundles/`, where that account can read but not change them, and removes them when the run ends; the result comes back to the extension directly.

Without `sudo`, the extension shows one command to run as that account.
That command stages local helper code and a short-lived result containing connection metadata such as provider, UID and paths.
This temporary handoff is readable by other local users so the two Linux accounts can exchange the result; it contains no account email, quota readings, backed-up settings or credentials.
The extension validates the result's owner and selected live process before accepting it, then cleans up the known staged files.

The backup is a copy of the **full provider settings or hooks file**, which may include secrets or sensitive configuration you put there. Backups are readable only by your operating-system user and remain after disconnection for recovery. Treat them as private credentials and do not attach them to issues.

When you explicitly approve shared or externally owned Linux CLI paths during connection, each path's kind, numeric owner/group IDs and permission mode are saved in that profile's private launcher.
Same-user setup also saves the approval in the extension host's local editor state; for cross-user setup, pressing **Connect** in the wizard is the consent.
This approval is not synchronized through VS Code Settings Sync.
People who control those paths must be trusted; the extension does not make shared software private.
The collector rechecks the fingerprint before each observation.
Ownership or permission changes disable collection and require another review.
World-writable paths and world-writable settings files remain refused.

Run **Account Usage: Disconnect Provider** before uninstalling and choose each profile you want to remove.
Disconnect restores only the selected profile's backed-up statusline or removes its exact managed hook; other profiles remain connected.
Cross-user disconnect runs through the same wizard, with the same `sudo` rules.
Backups and reports may remain locally for recovery; they can be removed after checking the disconnect result.
Do not publish this storage folder in a bug report.

The card itself displays personal data. Review screenshots before sharing them, including expanded report details and terminal names.
