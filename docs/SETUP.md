# Setup and troubleshooting

## Remote-SSH

Connect desktop VS Code to your Linux host, then install the VSIX into that SSH environment. Open a supported CLI in VS Code's integrated terminal and run **Account Usage: Open Card**. The selected terminal determines the account card.

Connect every provider profile separately; the connection order does not matter, including for two profiles of the same provider.
The profile's Linux UID and settings path distinguish connections, not its account email.
When the extension host and CLI run as the same Linux user, setup shows the profile and needs one confirmation.
For another Linux user, the card opens the connect wizard below.
Additional report directories are an advanced setting, not permission to read another user's login or session files.

### Another Linux user

When the selected session runs as another Linux user, connecting opens a wizard inside the Account Usage card.
No separate shell is needed when the VS Code account can use `sudo`.
The extension never sends text to the provider terminal or stops any running provider process.

1. Select the provider terminal and click its **Connect** button, or run **Account Usage: Connect Provider**.
2. The wizard shows the session it found and the Linux user it runs as. Press **Continue**.
3. The review screen lists every change and who makes it: root once for the feed folder, the target user for its settings.
   **Show the exact commands** lists the commands the wizard will run. Press **Connect**.
4. The wizard applies the changes with `sudo`, checks that VS Code can read the new connection, and shows that it is connected.
5. Finish one turn in that session. If it was already running when you connected, close its terminal and open a fresh one first: the CLI reads its settings only at startup, so a running session does not pick up the new hook or statusline.

The extension uses `sudo` to change the target user's settings and create its feed only after you press **Connect** on the review screen.
Before that screen, `sudo` only checks that it is available, stages the wizard's setup files in a root-owned folder under `/var/lib/llm-account-usage/bundles/` and reads the profile as the target user.
The staged files are removed when the run ends.
If `sudo` needs a password, VS Code's password box asks for it when you press **Continue**, three tries at most.
The password goes to `sudo -S` for this run only and is never written anywhere; **Connect** uses it without asking again.
The target user's `node` must be on `sudo`'s `secure_path`; if it is not, the wizard switches to the command line described below.

If a step fails after changes were applied, the wizard undoes them in reverse order and lists anything it had to keep; a feed folder that already existed stays.
Switching terminals while the wizard runs does not change its target: the run stays bound to the session chosen at the start.
If that session exits before **Connect**, nothing is changed; if it exits during setup, the wizard undoes the changes.

#### Without sudo

If the VS Code account cannot use `sudo`, pressing **Connect** shows one command line with a **Copy** button.
Run it once in any shell logged in as the target user; that shell needs `node` on PATH.
The line does not ask for `yes`: pressing **Connect** was the consent.
The wizard waits up to two minutes for its result and finishes on its own.
If the wait expires or is cancelled, start the wizard again for a new line; do not reuse the expired one.

The feed folder must already exist.
If it does not, the wizard first shows the admin line that creates it, and waits for the folder to appear before showing the target-user line:

```sh
sudo install -d -m 2750 -o <user> -g <gid> /var/lib/llm-account-usage/feeds/<connection-id>
```

Without `sudo`, the wizard cannot undo anything itself.
If the line fails after changing the status line, or had already run when you cancelled, the wizard names what changed and shows the exact disconnect line to run as the target user.

#### The shared feed

Each profile gets its own feed at `/var/lib/llm-account-usage/feeds/<connection-id>/`, under root-owned parents.
The wizard creates it with `sudo`: owned by the target user, with the VS Code account's primary group, mode `2750`.
Report and connection descriptor files allow at most `0640`.
No feed may grant group write or permissions to other users; symlinked paths are refused.
Before the target user's settings are touched, VS Code checks that it can read the new folder.
The wizard adds no group memberships and never changes an existing folder: one with a different owner, group or mode stops setup, and the wizard shows what it found.
Reports remain private to the owner and the VS Code account's group even when setup cannot finish.

## Codex

Select a native Codex session authenticated through ChatGPT and click **Connect Codex**. Setup shows the active profile and appends one command to that profile's user-level `hooks.json` `Stop` list. Existing events and `Stop` hooks keep their order and contents. `CODEX_HOME` is honored when it is available to the extension host; select the exact profile explicitly for a terminal-only override.

After connection, finish one fresh turn in that Codex session. If the session was already running when you connected, close its terminal and open a fresh one first: Codex reads its settings only at startup, so a running session does not pick up the new hook. The hook silently reads the current ChatGPT account and rate limits through Codex's native app-server, writes a sanitized local report, and returns no output to the turn. It does not submit a prompt or add account data to model context.

## Claude Code and Antigravity

Select the CLI terminal and click **Connect Claude** or **Connect Antigravity** on its card. When the provider is safely detected there is no picker. Check the profile shown and approve the connection. The button disappears after connection, including while the first fresh-turn reading is pending. A session that was already running when you connected does not pick up the new statusline, because the CLI reads its settings only at startup: close its terminal, open a fresh one, then finish one turn in it. It returns if a later package update moves that terminal to a different native executable, allowing the existing connection to be reviewed and rebound.

If automatic detection is unavailable, use **Account Usage: Connect Provider** in the Command Palette. This offers a provider picker only when the selected terminal cannot identify the provider. Connect the profile your terminal actually uses. Claude's `CLAUDE_CONFIG_DIR` is honored. Other detected overrides require an explicit profile selection; a profile selected only through terminal-specific flags must also be selected explicitly. Package-manager scripts are supported when their exact native provider process is running in the selected terminal. If the native CLI is outside the editor's PATH and no matching process is available, manual setup offers an executable picker.

Claude and Antigravity setup changes only the user profile's `statusLine` setting and preserves an existing command using its shell semantics. An all-empty Antigravity statusline stub (`{"type":"","command":""}`) counts as no statusline, and disconnect restores it exactly. A project-level or command-line setting can override that user setting; check the CLI's effective settings if no reports arrive. Codex setup changes only its user-level `hooks.json` by appending the managed `Stop` entry. Unsafe files and conflicting edits stop setup with a message that names the actual reason, such as an unsafe file, an unsupported statusline or a missing CLI; for another Linux user, the wizard shows it in the card. Antigravity's full quota reader uses its built-in `/usage` command; after connecting and starting a fresh session, `/usage` followed by closing the native panel can provide a fresh idle reading without a model turn.

Several profiles of each provider can be connected for one Linux user or across different Linux users.
Each has its own backup, collector and report feed, and connecting one does not remove the connection button for another selected profile.
A second editor installation must disconnect the same profile's existing connection before taking ownership; setup does not nest multiple Account Usage hooks.
GNU-compatible `tee`, `timeout` and standard shell utilities must be available.
If prerequisites are unavailable, provider settings stay unchanged.

The profile and its settings must belong to the user running setup, and settings files must not be writable by everyone.
A group-writable settings file is accepted and keeps its mode when setup rewrites it.
A CLI may come from a system installation, another owner's installation or a directory maintained by a shared Linux group.
When that control boundary is not private to the setup user or root, setup lists each exact directory and executable with its owner UID, group GID and permission mode.
Same-user setup offers **Trust and connect**; for another Linux user, the wizard's review screen lists the same trust details before **Connect**.
Without `sudo`, the review cannot read them in advance: the target-user line prints them as it runs, and running it trusts them.
Approve only if you trust the listed owners and everyone who can write through those groups.
The exact paths and metadata are saved with the private collector; same-user approval is also saved in the extension host's local editor state.
The collector rechecks them before every collection.
Changed ownership or permissions disable the saved collector until you connect again and approve the new fingerprint.
World-writable paths and symlinked directories remain refused.
Setup never changes existing permissions.
Private report directories can inherit the Linux setgid bit without granting group write access.

If the original editor storage has been removed, Connect or Disconnect offers to recover its saved connection after your confirmation. Interrupted setup is recovered without replacing a statusline or Codex hook you subsequently changed.

## No account reading yet

First, check whether the session was already running when you connected. The CLI reads its settings only at startup, so that session never picks up the new hook or statusline: close its terminal, open a fresh one and finish one turn in it.

Then check that the selected terminal contains a supported native CLI, its provider is connected to the profile used by that session, and the session has finished one fresh turn since connection. An exited process, ambiguous foreground session, unreadable report or unsupported host clears the card instead of keeping another account's reading.

The refresh button rereads available reports; it does not submit a prompt or force the provider to produce new usage data.

## Disconnect and upgrades

Run **Account Usage: Disconnect Provider** before uninstalling and select the individual profile using its UID and profile path.
For Claude and Antigravity it restores that profile's original statusline only if the setting still matches this connection.
For Codex it removes only that profile's exact managed `Stop` entry and preserves all other hook edits.
Other profiles, including those of the same provider, keep their hooks and account cards.
If you edited the managed setting after connection, resolve the reported conflict rather than overwriting newer configuration.

For a cross-user profile, first select a running terminal for that provider and Linux user.
Disconnect opens the same wizard: the review screen lists restoring the statusline as that user and, for a feed under `/var/lib/llm-account-usage/feeds/`, removing that folder as root; **Disconnect** applies them.
The folder is removed only when it holds nothing but Account Usage's own files; otherwise it is kept and named.
Without `sudo`, the wizard shows one disconnect line to run as that user, and the shared folder stays, because removing it needs an admin.
Disconnect does not interrupt the running CLI.

Upgrades refresh same-user collector runtimes independently without replacing current provider settings.
If the editor's Node binary disappears, a preserved original statusline still runs; opening the updated extension refreshes the runtime path.
An older cross-user collector retains its last report with a **Reconnect provider** action; reconnect that profile through the wizard to update it.
Finish a fresh turn to publish another report.
The extension never reloads VS Code or sends text into a terminal.
