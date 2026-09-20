# Setup and troubleshooting

## Remote-SSH

Connect desktop VS Code to your Linux host, then install the VSIX into that SSH environment. Open a supported CLI in VS Code's integrated terminal and run **Account Usage: Open Card**. The selected terminal determines the account card.

The extension and CLI must run as the same operating-system user. A terminal launched through `sudo` into another user is outside automatic setup. Additional report directories are an advanced setting, not permission to read another user's login or session files.

## Codex

No statusline setting is needed. Select a native Codex session authenticated through ChatGPT. The extension reads its open root session report. A newly observed usage event can attach the current login email; a report that predates collection may initially remain unidentified. Normal CLI activity supplies new usage events.

## Claude Code and Antigravity

Run **Account Usage: Connect Provider**, choose the provider and check the profile shown. Connect the profile your terminal actually uses. Claude's `CLAUDE_CONFIG_DIR` is honored. Other detected overrides require an explicit profile selection; a profile selected only through terminal-specific flags must also be selected explicitly. If the native CLI is outside the editor's PATH, the command offers an executable picker.

The connection changes only the user profile's `statusLine` setting and preserves an existing command using its shell semantics. A project-level or command-line setting can override that user setting; check the CLI's effective settings if no reports arrive. Unsafe files and conflicting edits stop setup with a message. The CLI must support the native statusline data used by this extension. Antigravity's full quota reader uses its built-in `/usage` command; after connecting, `/usage` followed by closing the native panel can provide a fresh idle reading without a model turn.

One profile per provider can be connected for each Linux user. A second editor installation must disconnect the existing connection before taking ownership; setup does not nest multiple Account Usage hooks. GNU-compatible `tee`, `timeout` and standard shell utilities must be available. If prerequisites are unavailable, provider settings stay unchanged.

The profile and its settings must belong to your user and must not be writable by other users or groups. Setup reports unsafe permissions instead of changing them. If the original editor storage has been removed, Connect or Disconnect offers to recover its saved connection after your confirmation. Interrupted setup is recovered without replacing a statusline you subsequently changed.

## No account reading yet

Check that the selected terminal contains a supported native CLI and has produced a current reading. Verify that Claude/Antigravity is connected to the profile used by that session. An exited process, ambiguous foreground session, unreadable report or unsupported host clears the card instead of keeping another account's reading.

The refresh button rereads available reports; it does not submit a prompt or force the provider to produce new usage data.

## Disconnect and upgrades

Run **Account Usage: Disconnect Provider** before uninstalling. It restores the original statusline only if the setting still matches this connection. If you edited it after connection, resolve the reported conflict rather than overwriting your newer configuration.

Upgrades refresh the owned collector runtime without replacing your current provider settings. If the editor's Node binary disappears, the preserved original statusline still runs; opening the updated extension refreshes the runtime path. Ordinary CLI activity supplies fresh reports afterward. The extension never reloads VS Code or sends text into a terminal.
