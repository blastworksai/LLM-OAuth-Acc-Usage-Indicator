# Setup and troubleshooting

## Remote-SSH

Connect desktop VS Code to your Linux host, then install the VSIX into that SSH environment. Open a supported CLI in VS Code's integrated terminal and run **Account Usage: Open Card**. The selected terminal determines the account card.

The extension and CLI must run as the same operating-system user. A terminal launched through `sudo` into another user is outside automatic setup. Additional report directories are an advanced setting, not permission to read another user's login or session files.

## Codex

Select a native Codex session authenticated through ChatGPT and click **Connect Codex**. Setup shows the active profile and appends one command to that profile's user-level `hooks.json` `Stop` list. Existing events and `Stop` hooks keep their order and contents. `CODEX_HOME` is honored when it is available to the extension host; select the exact profile explicitly for a terminal-only override.

After connection, finish one fresh turn in that Codex session. The hook silently reads the current ChatGPT account and rate limits through Codex's native app-server, writes a sanitized local report, and returns no output to the turn. It does not submit a prompt or add account data to model context.

## Claude Code and Antigravity

Select the CLI terminal and click **Connect Claude** or **Connect Antigravity** on its card. When the provider is safely detected there is no picker. Check the profile shown and approve the connection. The button disappears after connection, including while the first fresh-turn reading is pending. It returns if a later package update moves that terminal to a different native executable, allowing the existing connection to be reviewed and rebound.

If automatic detection is unavailable, use **Account Usage: Connect Provider** in the Command Palette. This offers a provider picker only when the selected terminal cannot identify the provider. Connect the profile your terminal actually uses. Claude's `CLAUDE_CONFIG_DIR` is honored. Other detected overrides require an explicit profile selection; a profile selected only through terminal-specific flags must also be selected explicitly. Package-manager scripts are supported when their exact native provider process is running in the selected terminal. If the native CLI is outside the editor's PATH and no matching process is available, manual setup offers an executable picker.

Claude and Antigravity setup changes only the user profile's `statusLine` setting and preserves an existing command using its shell semantics. A project-level or command-line setting can override that user setting; check the CLI's effective settings if no reports arrive. Codex setup changes only its user-level `hooks.json` by appending the managed `Stop` entry. Unsafe files and conflicting edits stop setup with a message. Antigravity's full quota reader uses its built-in `/usage` command; after connecting, `/usage` followed by closing the native panel can provide a fresh idle reading without a model turn.

One profile per provider can be connected for each Linux user. A second editor installation must disconnect the existing connection before taking ownership; setup does not nest multiple Account Usage hooks. GNU-compatible `tee`, `timeout` and standard shell utilities must be available. If prerequisites are unavailable, provider settings stay unchanged.

The profile and its settings must belong to your user, and settings files must not be writable by other users or groups. A CLI may come from a system installation, another owner's installation or a directory maintained by a shared Linux group. When that control boundary is not private to your user or root, setup lists each exact directory and executable with its owner UID, group GID and permission mode and offers **Trust and connect**. Choose it only if you trust the listed owners and everyone who can write through those groups. Approval is saved in this extension host's local editor state for those exact paths and metadata and is rechecked before every collection. Changed ownership or permissions disable the saved collector until you connect again and approve the new fingerprint. World-writable paths and symlinked directories remain refused. Setup never changes existing permissions. Private report directories can inherit the Linux setgid bit without granting group write access.

If the original editor storage has been removed, Connect or Disconnect offers to recover its saved connection after your confirmation. Interrupted setup is recovered without replacing a statusline or Codex hook you subsequently changed.

## No account reading yet

Check that the selected terminal contains a supported native CLI, its provider is connected to the profile used by that session, and the session has finished one fresh turn since connection. An exited process, ambiguous foreground session, unreadable report or unsupported host clears the card instead of keeping another account's reading.

The refresh button rereads available reports; it does not submit a prompt or force the provider to produce new usage data.

## Disconnect and upgrades

Run **Account Usage: Disconnect Provider** before uninstalling. For Claude and Antigravity it restores the original statusline only if the setting still matches this connection. For Codex it removes only the exact managed `Stop` entry and preserves all other hook edits. If you edited the managed setting after connection, resolve the reported conflict rather than overwriting newer configuration.

Upgrades refresh the owned collector runtime without replacing current provider settings. If the editor's Node binary disappears, a preserved original statusline still runs; opening the updated extension refreshes the runtime path. Finish a fresh turn to publish another report. The extension never reloads VS Code or sends text into a terminal.
