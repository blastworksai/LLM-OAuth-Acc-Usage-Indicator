# Account Usage

Your AI account's quota, beside the terminal you're using.

Account Usage adds a card to VS Code's right sidebar. Switch terminals and the card follows the selected session's account: email, subscription type, quota bars and reset times. These are account limits, so usage can include other terminals and sessions. The active model is not used as the account identity.

| ChatGPT / Codex | Claude Code | Antigravity |
| --- | --- | --- |
| ![ChatGPT account usage card](docs/images/chatgpt.png) | ![Claude account usage card](docs/images/claude.png) | ![Antigravity account usage card showing both quota pools](docs/images/antigravity.png) |

Account emails are hidden in these screenshots.

## Install

1. Install [Account Usage from the VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=BlastworksAI.llm-oauth-acc-usage-indicator). For Remote-SSH, install it on the Linux SSH host.
2. Run **Account Usage: Open Card** and select your AI terminal.
3. Codex is detected automatically. For an unconnected Claude Code or Antigravity terminal, click **Connect Claude** or **Connect Antigravity** on the card. The provider is selected automatically; check the profile and approve the connection.

For manual installation, download the `.vsix` from [GitHub Releases](https://github.com/blastworksai/LLM-OAuth-Acc-Usage-Indicator/releases), then run **Extensions: Install from VSIX…** in VS Code.

Use an existing CLI login. The extension does not ask for passwords, API keys or tokens. It uses VS Code's own Node runtime; there is no separate Python or Node installation step.

## Supported tools and hosts

| CLI | Account usage shown | Connection |
| --- | --- | --- |
| Codex with a ChatGPT login | Reported account windows, reset times and subscription tier; current login email on a newly observed usage update | Automatic for the selected same-user native CLI process |
| Claude Code | Reported five-hour and weekly windows; native login email and subscription tier when available | Connect its statusline |
| Antigravity (`agy`) | Gemini and GPT/Claude quota pools, each with five-hour and weekly windows when reported; native account email and tier | Connect its statusline and built-in quota reader |
| Kimi | Unsupported: upstream quota reports are currently unreliable | No numbers displayed |
| Muse and other CLIs | Unsupported | No numbers displayed |

The terminal host must run **Linux**. Desktop VS Code with Remote-SSH to Linux is the initial supported setup. Local Windows/macOS terminals, browser VS Code and cross-user `sudo` sessions are not covered by this release. WSL, Dev Containers and Codespaces are untested. Native CLI executables are required; unsupported script launchers are not guessed from terminal names. Provider setup requires the standard Linux shell and GNU-compatible core utilities.

## What the card means

- Percentages mean **used**. Antigravity's remaining percentages are converted once.
- Window labels follow their reported duration. A primary slot is not assumed to be a five-hour window.
- Dates use the timezone of the computer displaying VS Code, including when the terminal runs remotely.
- A missing or expired reading stays visibly unavailable. Unsupported pools are named, not silently represented as zero.
- Email is the current CLI login sampled with a usage update. Older Codex readings may show **Account not identified** until a new event arrives.
- Subscription renewal/end dates are hidden when the CLI does not report them. A quota reset is not a subscription expiry.

Refreshing the card sends no model prompt. Codex reads the selected process's local usage events and uses its native account metadata command for a fresh event. Claude uses its statusline and native authentication status. Antigravity's idle statusline updates can run its built-in `/usage` command, which queries the vendor's quota service without a model turn.

## Setup and removal

The connection button appears only for a detected Claude or Antigravity terminal that needs setup. It disappears after connection and is absent from populated cards, plain shells and unsupported CLI sessions. **Account Usage: Connect Provider** remains available in the Command Palette for manual setup when automatic detection is unavailable.

Setup shows the selected profile before it changes its statusline setting. An existing statusline is preserved. If your directories are deliberately shared with a Linux group, setup lists them and offers **Trust and connect**; approve only when you trust everyone who can write there. It does not change their permissions. Runtime files and sanitized reports stay in owner-controlled local storage, separate from editor installation files. Run **Account Usage: Disconnect Provider** to restore the connection before uninstalling; removing an extension cannot guarantee that provider settings are restored automatically.

See [setup and troubleshooting](docs/SETUP.md) and [privacy](docs/PRIVACY.md). When reporting an issue, remove emails, account identifiers, terminal names, paths and session IDs from screenshots and diagnostics.

## Development

```sh
npm ci
npm test
npm run package
```

The packaged VSIX is written to `artifacts/`. Its contents are allowlisted; development files, fixtures and local configuration are not shipped.

MIT licensed. Provider names and marks identify their respective services; this independent project is not affiliated with or endorsed by those providers. See [third-party notices](THIRD-PARTY-NOTICES.md).
