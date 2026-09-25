# Account Usage

Your AI account's quota, beside the terminal you're using.

Account Usage adds a card to VS Code's right sidebar. Switch terminals and the card follows the selected session's account: email, subscription type, quota bars and reset times. These are account limits, so usage can include other terminals and sessions. The active model is not used as the account identity.

| ChatGPT / Codex | Claude Code | Antigravity |
| --- | --- | --- |
| ![ChatGPT account usage card](docs/images/chatgpt.png) | ![Claude account usage card](docs/images/claude.png) | ![Antigravity account usage card showing both quota pools](docs/images/antigravity.png) |

Account emails are hidden in these screenshots.

## Install

1. Install [Account Usage from the VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=BlastworksAI.llm-oauth-acc-usage-indicator).
   For Remote-SSH, install it on the Linux SSH host.
2. Run **Account Usage: Open Card** and select your AI terminal.
3. For an unconnected supported terminal, click **Connect Codex**, **Connect Claude** or **Connect Antigravity** on the card.
   If safe process detection cannot name the provider, click **Connect Provider** and choose it.
   Check the profile and approve the connection.
   If the CLI runs as another Linux user, the card opens a connect wizard instead, as described in [setup](docs/SETUP.md#another-linux-user).
4. Finish one fresh turn in that CLI. Its local adapter publishes the account and quota reading, and the card follows that session.
   A session that was already running when you connected does not pick up the new hook or statusline, because the CLI reads its settings only at startup: close its terminal, open a fresh one, then finish one turn in it.

For manual installation, download the `.vsix` from [GitHub Releases](https://github.com/blastworksai/LLM-OAuth-Acc-Usage-Indicator/releases), then run **Extensions: Install from VSIX…** in VS Code.

Connect each provider profile independently, in any order, including multiple profiles of the same provider.
Use an existing CLI login; the extension does not ask for provider passwords, API keys or tokens.
The only password it can ask for is your own `sudo` password, when connecting a CLI that runs as another Linux user.
Same-user setup uses VS Code's Node runtime and needs one confirmation.
Cross-user setup runs `node` as the target user: through `sudo`, it must be on `sudo`'s `secure_path`; without `sudo`, on that user's shell PATH.
No Python installation is needed.

## Supported tools and hosts

| CLI | Account usage shown | Connection |
| --- | --- | --- |
| Codex with a ChatGPT login | Reported account windows, reset times and subscription tier; current login email | Connect its user-level `Stop` hook |
| Claude Code | Reported five-hour and weekly windows; native login email and subscription tier when available | Connect its statusline |
| Antigravity (`agy`) | Gemini and GPT/Claude quota pools, each with five-hour and weekly windows when reported; native account email and tier | Connect its statusline and built-in quota reader |
| Kimi | Unsupported: upstream quota reports are currently unreliable | No numbers displayed |
| Muse and other CLIs | Unsupported | No numbers displayed |

The terminal host must run **Linux**.
Desktop VS Code with Remote-SSH to Linux is the supported setup, including the connect wizard for a CLI running as another Linux user.
Local Windows/macOS terminals, browser VS Code, WSL, Dev Containers and Codespaces are outside this release's support scope.
A native provider process must be running in the selected terminal; common package-manager script launchers are supported by binding that exact process rather than guessing from terminal names.
Provider setup requires the standard Linux shell and GNU-compatible core utilities.

## What the card means

- Percentages mean **used**. Antigravity's remaining percentages are converted once.
- Window labels follow their reported duration. A primary slot is not assumed to be a five-hour window.
- Dates use the timezone of the computer displaying VS Code, including when the terminal runs remotely.
- A missing or expired reading stays visibly unavailable. Unsupported pools are named, not silently represented as zero.
- Email is the current CLI login sampled with that session's fresh usage update.
- Subscription renewal/end dates are hidden when the CLI does not report them. A quota reset is not a subscription expiry.

Refreshing the card only rereads local reports; it sends no model prompt. After a Codex turn, the local hook calls native `account/read` (with refresh disabled) and `account/rateLimits/read`. Claude uses its statusline and native authentication status. Antigravity's idle statusline can run its built-in `/usage` command. None of these collection calls starts a model turn or adds text to model context.

## Setup and removal

The connection button names a safely detected, unconnected provider for the selected session.
When detection is unavailable, the card can offer **Connect Provider** and let you choose.
It disappears for a connected session, including while the card waits for that session's first fresh turn; another profile of the same provider remains independently connectable.
If a package update moves the running native CLI, the button returns so the saved connection can be reviewed and rebound.
An older cross-user collector can show **Reconnect provider** beside its retained reading.
**Account Usage: Connect Provider** is also available in the Command Palette.

Setup shows the selected profile before changing provider configuration.
For Codex it appends one user-level `Stop` hook and preserves every existing hook.
For Claude and Antigravity it preserves and chains the existing statusline command.
Package-manager launchers are resolved through the exact native provider process in the selected terminal rather than through a vendor-specific installation layout.
If the CLI or one of its parent directories is controlled by another Linux owner or writable by a shared group, setup lists each exact path, owner, group and permission mode for approval; same-user setup offers **Trust and connect**.
Approve only when you trust everyone who can replace that software.
Detection has no hard-coded installation root or username; each approval is tied to the exact discovered metadata, and setup does not change existing permissions.

For a CLI owned by another Linux user, the card opens a connect wizard.
The extension uses `sudo` to change that user's settings and create its feed only after you press **Connect** on a review screen that lists every change and the exact commands.
Before that screen, `sudo` only checks that it is available, stages the wizard's own setup files and reads the profile as that user.
The extension never stores a sudo password; without `sudo`, it shows one command to run as that user.
It never sends text into the agent's terminal or stops its process.
If a step fails after changes were applied, the wizard undoes them in reverse order and lists anything it had to keep.
Cross-user reports go to a feed at `/var/lib/llm-account-usage/feeds/<connection-id>/`, owned by the target user, with the VS Code account's primary group and directory mode `2750`; report files are at most `0640`, with no group write or access for other users.
If the feed is not safely readable, the connection is not accepted; setup never makes reports world-readable.
Private backups and collector runtime remain under the profile owner's control.

Run **Account Usage: Disconnect Provider** before uninstalling and choose the individual profile by UID and path.
Disconnect restores only that profile's backed-up statusline or removes its exact managed Codex hook; other profiles stay connected.
Cross-user disconnect runs through the same wizard and removes the shared feed folder; without `sudo` the folder stays, because removing it needs an admin.
Removing an extension cannot guarantee that provider settings are restored automatically.

See [setup and troubleshooting](docs/SETUP.md) and [privacy](docs/PRIVACY.md). When reporting an issue, remove emails, account identifiers, terminal names, paths and session IDs from screenshots and diagnostics.

## Development

```sh
npm ci
npm test
npm run package
```

The packaged VSIX is written to `artifacts/`. Its contents are allowlisted; development files, fixtures and local configuration are not shipped.

MIT licensed. Provider names and marks identify their respective services; this independent project is not affiliated with or endorsed by those providers. See [third-party notices](THIRD-PARTY-NOTICES.md).
