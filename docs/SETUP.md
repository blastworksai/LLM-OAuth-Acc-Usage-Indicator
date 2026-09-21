# Setup and troubleshooting

## Remote-SSH

Connect desktop VS Code to your Linux host, then install the VSIX into that SSH environment. Open a supported CLI in VS Code's integrated terminal and run **Account Usage: Open Card**. The selected terminal determines the account card.

Connect every provider profile separately; the connection order does not matter, including for two profiles of the same provider.
The profile's Linux UID and settings path distinguish connections, not its account email.
When the extension host and CLI run as the same Linux user, setup shows the profile and needs one confirmation.
For another Linux user, use the explicit command flow below.
Additional report directories are an advanced setting, not permission to read another user's login or session files.

### Another Linux user

Keep the selected provider session running.
Have a separate shell already open as the Linux user shown in the connection dialog; that shell needs `node` on PATH.
The setup command uses that user's Node runtime, which must remain available for collection.
The extension does not invoke `sudo`, change users, send text to the provider terminal or stop any running provider process.

1. Select the provider terminal and click its **Connect** button, or run **Account Usage: Connect Provider**.
2. Check the target UID in the dialog, then choose **Copy setup command**.
3. Run the copied command in the separate target-user shell.
   Keep the generated `--provider`, `--cli`, `--result` and `--runtime-version` arguments intact.
   For a non-default profile or an existing shared feed, set `--profile '/absolute/profile/path'` and `--report-dir '/absolute/feed/path'` on this command; do not repeat an option already present.
4. Review the profile, report directory and any software paths requiring trust in the shell, then type `yes` to continue.
5. Keep the original provider terminal selected in VS Code until setup is accepted, then finish a fresh turn in that session.

VS Code waits up to two minutes and offers cancellation.
Use a separate external shell for setup so the active provider terminal stays selected in VS Code.
If the wait expires or is cancelled, request a new command; do not reuse the expired one.
A cancelled wait does not undo a configuration change already confirmed in the target shell.

Each profile needs its own target-owned report feed, writable by that user and readable by the extension host through an existing Linux group.
The feed directory may use `0750` or `2750` (setgid); report and connection descriptor files allow at most `0640`.
Private `0700` or `2700` directories remain valid for owner-only access but cannot provide cross-user group access.
No feed may grant group write or permissions to other users; symlinked paths are refused.
The extension host also needs permission to traverse the parent directories, and the shared group must apply to the feed and its published files.

By default, the helper creates `~/.llm-account-usage-feeds/<connection-id>/` under the target user's home with mode `2750`.
It does not add group memberships or change existing permissions, so that default path is usable only if the extension host can already traverse and read it.
Use `--report-dir` to select a separately provisioned feed when needed.
Unsafe permissions stop setup; an unreadable feed is not accepted by VS Code, which explains that a shared Linux group directory is required.
Reports remain private to the owner and permitted group even when setup cannot finish.

## Codex

Select a native Codex session authenticated through ChatGPT and click **Connect Codex**. Setup shows the active profile and appends one command to that profile's user-level `hooks.json` `Stop` list. Existing events and `Stop` hooks keep their order and contents. `CODEX_HOME` is honored when it is available to the extension host; select the exact profile explicitly for a terminal-only override.

After connection, finish one fresh turn in that Codex session. The hook silently reads the current ChatGPT account and rate limits through Codex's native app-server, writes a sanitized local report, and returns no output to the turn. It does not submit a prompt or add account data to model context.

## Claude Code and Antigravity

Select the CLI terminal and click **Connect Claude** or **Connect Antigravity** on its card. When the provider is safely detected there is no picker. Check the profile shown and approve the connection. The button disappears after connection, including while the first fresh-turn reading is pending. It returns if a later package update moves that terminal to a different native executable, allowing the existing connection to be reviewed and rebound.

If automatic detection is unavailable, use **Account Usage: Connect Provider** in the Command Palette. This offers a provider picker only when the selected terminal cannot identify the provider. Connect the profile your terminal actually uses. Claude's `CLAUDE_CONFIG_DIR` is honored. Other detected overrides require an explicit profile selection; a profile selected only through terminal-specific flags must also be selected explicitly. Package-manager scripts are supported when their exact native provider process is running in the selected terminal. If the native CLI is outside the editor's PATH and no matching process is available, manual setup offers an executable picker.

Claude and Antigravity setup changes only the user profile's `statusLine` setting and preserves an existing command using its shell semantics. A project-level or command-line setting can override that user setting; check the CLI's effective settings if no reports arrive. Codex setup changes only its user-level `hooks.json` by appending the managed `Stop` entry. Unsafe files and conflicting edits stop setup with a message. Antigravity's full quota reader uses its built-in `/usage` command; after connecting, `/usage` followed by closing the native panel can provide a fresh idle reading without a model turn.

Several profiles of each provider can be connected for one Linux user or across different Linux users.
Each has its own backup, collector and report feed, and connecting one does not remove the connection button for another selected profile.
A second editor installation must disconnect the same profile's existing connection before taking ownership; setup does not nest multiple Account Usage hooks.
GNU-compatible `tee`, `timeout` and standard shell utilities must be available.
If prerequisites are unavailable, provider settings stay unchanged.

The profile and its settings must belong to the user running setup, and settings files must not be writable by other users or groups.
A CLI may come from a system installation, another owner's installation or a directory maintained by a shared Linux group.
When that control boundary is not private to the setup user or root, setup lists each exact directory and executable with its owner UID, group GID and permission mode.
Same-user setup offers **Trust and connect**; the target-user shell shows the same trust details before asking for `yes`.
Approve only if you trust the listed owners and everyone who can write through those groups.
The exact paths and metadata are saved with the private collector; same-user approval is also saved in the extension host's local editor state.
The collector rechecks them before every collection.
Changed ownership or permissions disable the saved collector until you connect again and approve the new fingerprint.
World-writable paths and symlinked directories remain refused.
Setup never changes existing permissions.
Private report directories can inherit the Linux setgid bit without granting group write access.

If the original editor storage has been removed, Connect or Disconnect offers to recover its saved connection after your confirmation. Interrupted setup is recovered without replacing a statusline or Codex hook you subsequently changed.

## No account reading yet

Check that the selected terminal contains a supported native CLI, its provider is connected to the profile used by that session, and the session has finished one fresh turn since connection. An exited process, ambiguous foreground session, unreadable report or unsupported host clears the card instead of keeping another account's reading.

The refresh button rereads available reports; it does not submit a prompt or force the provider to produce new usage data.

## Disconnect and upgrades

Run **Account Usage: Disconnect Provider** before uninstalling and select the individual profile using its UID and profile path.
For Claude and Antigravity it restores that profile's original statusline only if the setting still matches this connection.
For Codex it removes only that profile's exact managed `Stop` entry and preserves all other hook edits.
Other profiles, including those of the same provider, keep their hooks and account cards.
If you edited the managed setting after connection, resolve the reported conflict rather than overwriting newer configuration.

For a cross-user profile, first select a running terminal for that provider and Linux user.
Disconnect shows a fresh command to copy into a separate shell as that user; review it and type `yes` there, while keeping the provider terminal selected in VS Code.
It needs `node` on that shell's PATH and does not interrupt the running CLI.

Upgrades refresh same-user collector runtimes independently without replacing current provider settings.
If the editor's Node binary disappears, a preserved original statusline still runs; opening the updated extension refreshes the runtime path.
An older cross-user collector retains its last report with a **Reconnect provider** action; reconnect that profile through the target-user command to update it.
Finish a fresh turn to publish another report.
The extension never reloads VS Code or sends text into a terminal.
