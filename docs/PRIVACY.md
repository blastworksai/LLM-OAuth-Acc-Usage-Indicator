# Privacy

Account Usage runs on the VS Code extension host. It has no analytics endpoint or hosted collection service.

## Read locally

On Linux, terminal matching reads bounded process metadata: process IDs, user IDs, start ticks, boot ID, terminal foreground groups and executable paths. Codex collection reads the unique root session file already open by that matched CLI process. It does not search for the newest transcript or infer accounts from terminal titles.

For Codex account metadata, only the matched process's HOME and CODEX_HOME profile context is used. Other process environment values are not forwarded. The extension does not read login files or decode saved tokens. It invokes the native CLI to obtain the current login email, with token refresh explicitly disabled in the account request.

Claude and Antigravity connections receive the provider's native statusline input. Sanitized reports contain account email when available, subscription tier, quota windows, timestamps and the process/session identifiers needed for matching. Raw conversations and credentials are not copied into reports. Existing user statusline commands receive their original input so their behavior can be preserved.

## Provider requests

The extension sends no model prompts. Native commands run under the existing user's login. Antigravity's built-in quota command contacts its provider backend. Other native commands can use the provider's own normal authentication machinery; the extension does not implement a login-renewal flow.

Quota readings can include use from other terminals and sessions on the same account. An email represents the current CLI login when the reading is observed, not a reconstruction of historical session logins.

## Stored locally

Provider connections keep a backup, connection receipt, stable collector runtime and sanitized reports under `~/.local/state/llm-account-usage/` on the terminal host. This owner-private storage survives removal of editor installation files, so an existing statusline can still run if the editor's Node runtime disappears. These are runtime data on the installing user's machine, never included in the downloadable package. Codex account samples remain in extension memory.

The backup is a copy of the **full provider settings file**, which may include secrets or sensitive configuration you put there. Backups are readable only by your operating-system user and remain after disconnection for recovery. Treat them as private credentials and do not attach them to issues.

When you explicitly approve shared Linux directories during connection, their paths and numeric owner/group IDs are saved in the extension host's local editor state. This approval is not synchronized through VS Code Settings Sync. People with write access to those directories must be trusted; the extension does not make a shared home private. World-writable paths, writable settings files and changed ownership remain refused.

Run **Account Usage: Disconnect Provider** before uninstalling to restore provider settings. Backups and reports may remain locally for recovery; they can be removed after checking the disconnect result. Do not publish this storage folder in a bug report.

The card itself displays personal data. Review screenshots before sharing them, including expanded report details and terminal names.
