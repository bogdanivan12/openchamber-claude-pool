# Claude Pool

An [OpenChamber](https://github.com/openchamber/openchamber) extension that lets you use several Claude subscriptions (Pro or Max) at once. It adds a failover **pool** provider, one provider per account, a panel to add and manage accounts, a usage card with a group per account, and a Work Status section with a 5h bar per enabled account.

Status: 0.2.2, not yet published.

## Requirements

- OpenChamber 2.7.0 or later (desktop or web).
- The Claude Code CLI (`claude`). It is found on your `PATH`, or in `~/.local/bin`, the npm global bin, `/opt/homebrew/bin`, `/usr/local/bin`, `~/.claude/local`, `~/.bun/bin`, `~/.npm-global/bin`, `~/.volta/bin`, an nvm version folder (`~/.nvm/versions/node/*/bin`) or an fnm one, because the desktop app starts the server with a minimal `PATH`.
- One or more Claude Pro or Max accounts. Only Claude subscription (claude.ai OAuth) logins are accepted; API-key, Bedrock and Vertex logins are refused.

## Install

**From a local folder.** In OpenChamber open Settings → Extensions, add an extension and paste the absolute path of this folder.

**From git, once the repository is published.** The intended location is `https://github.com/bogdanivan12/openchamber-claude-pool.git` (it does not exist yet). Settings → Extensions → Add, then paste that URL.

Approve the permissions the extension asks for. The capability names below are paraphrased from the plan; OpenChamber's approval dialog may word them differently. It should also list the programs the service may run: `claude` and `security`, from `service.permissions.exec` in `package.json`. What the service actually runs: `claude` (`auth status --json`, `auth logout`, `auth login --claudeai`, `--version`) and, on macOS, `security find-generic-password` (read-only). While looking for the CLI it also runs `npm prefix -g` and, on Windows for an npm install that only has `cli.js`, `node`. Neither `npm` nor `node` is declared in the manifest, so if OpenChamber enforces the list those probes are refused and the CLI is found through the fixed locations above instead. A local service runs with your user's full access, so only approve it if you trust this code.

- Run a local service
- Add a plugin to OpenCode
- Reports usage like a built-in provider

## Add accounts

Open the **Claude Pool** panel.

- **Import**: lists the existing Claude Code logins on this computer (`~/.claude` and `~/.claude-*`). Tick the ones you want and import them. Logins that are not a Claude subscription, or are already in the pool, are skipped with a reason.
- **Add account**: type a name (names must be unique), press Start, sign in on the Claude page that opens, and paste the code it shows. A wrong code on a new account cancels that sign-in: the panel shows a "Sign-in failed" banner with a Back button, the half-created account and its folder are discarded, and you press "Add account" again to retry. A wrong code for an existing account ("Sign in again") leaves that account untouched. New accounts get their own folder in `~/.claude-pool/accounts/<id>`.

Other panel actions: turn an account on or off ("In pool"), rename, reorder (↑ ↓) and remove. Removing never deletes a login folder unless you tick "Also sign out and delete this account's folder", and that box only appears for folders the pool created. For those, `claude auth logout` is run before the folder is deleted. Folders you imported are never deleted.

## Using it

The model picker shows these providers only when at least one account is enabled:

- **Claude Pool**: automatic failover across your enabled accounts.
- **Claude · name**: one provider per account; it only ever uses that account.

How the pool behaves:

- A conversation sticks to its account until that account passes the threshold or hits a limit. The threshold applies to the 5h and the 7-day window and defaults to 90%. Set it between 50 and 100 in the panel.
- Then the conversation moves to the account with the most headroom. If the account refuses a turn with a limit before any output was streamed, the turn is retried automatically on the next account.
- On a move, the Claude session transcript is copied to the new account's folder so the conversation keeps its context. The first turn after a move has a cold prompt cache, so it reads (and bills) the whole context again.
- If no account is available, the proxy answers 429. That happens when every account is at a hard limit or over the threshold, not only at a hard limit. The message names the earliest time one frees up. When no reset time is known, it says the accounts are limited or signed out, and the retry-after is 10 minutes.

## The usage card and Work Status

Settings → Usage (menu name from the plan; not yet confirmed in OpenChamber) shows one **Claude Pool** card: on top the 5h and 7d windows of the account the pool would use now (labelled with its name), then a group per enabled account that has usage data. A group says "(sign in again)" for an account that needs a new login, "(limited)" while it is at a limit, and "(data N min old)" when its numbers could not be refreshed. The built-in Claude card keeps showing the default Claude Code account; you can hide it in Settings → Usage (menu name from the plan; not yet confirmed in OpenChamber).

The Work Status section "Claude Pool" has one row per enabled account with a 5h bar, a ● marker on the account the pool would use now, and a ↻ button to refresh.

## How it works

- Each account is one Claude Code config folder, run with its own `CLAUDE_CONFIG_DIR`. The default `~/.claude` runs without the variable.
- Data lives in `~/.claude-pool/`: `accounts.json`, `state.json`, `state.lock`, and `accounts/<id>` for logins created by the pool.
- Requests go through a local OpenCode plugin (a fork of opencode-claude, in `plugin/`) that calls the Claude Agent SDK, which runs your `claude` CLI. The plugin watches `accounts.json` and updates the providers when it changes.
- Usage is read from Anthropic's OAuth usage endpoint for each account, and from rate-limit events during turns.
- The extension reads the OAuth login that Claude Code stored; it never writes or refreshes tokens and never logs them.
- Nothing runs permanently. The extension's service is started by OpenChamber on demand and stopped by it after idle, and nothing polls in the background.

## Use at your own risk

Anthropic's terms say plan limits assume ordinary, individual use. There are public reports of accounts suspended for automatic rotation across several subscriptions. Claude Pool does not hide what it does. Decide whether the pool fits how you use your accounts; per-account providers work without it.

This is an independent community project, not affiliated with or endorsed by Anthropic.

## Platform notes

- **macOS**: reads each account's Keychain item (the default folder uses `Claude Code-credentials`; other folders use a name derived from the folder path), falling back to the folder's `.credentials.json`. The first read may show a Keychain prompt.
- **Windows**: reads `<folder>\.credentials.json`.
- **Panel controls**: accounts are reordered with up/down buttons and the switch threshold is a text field (the design envisaged drag and drop and a slider).

Windows status: the code paths are written for Windows. On windows-latest CI runs the shared, service and UI tests and the pool-specific plugin tests (`bun run test:plugin:windows`); the full plugin suite, whose forked tests use shell-script fake CLIs and symlinks, runs on macOS only. It has not been verified on a real Windows machine with real accounts. The UI has been tested headlessly (happy-dom), not yet visually in OpenChamber. The macOS end-to-end check in [docs/e2e-checklist.md](docs/e2e-checklist.md) is still to be run.

## Development

```bash
bun install
bun run check          # TypeScript
bun run test           # shared, service, ui and plugin tests (test:shared / test:plugin separately)
bun run build          # rebuild the committed bundles
bun run check:bundles  # fails if the committed bundles are stale
bun run check:guest    # OpenChamber's extension guest check
```

The built bundles (`service/main.js`, `ui/panel/main.js`, `ui/status/main.js`, `plugin/index.js`) are committed because OpenChamber loads the extension straight from the folder. Run `bun run build` after any source change and commit the result; CI runs `check:bundles` on macOS.

Layout:

- `shared/`: accounts and state files, router, credential reading, paths.
- `service/`: the local service (accounts, sign-in, import, usage card).
- `ui/`: the panel and the Work Status section.
- `plugin/`: the OpenCode plugin, a fork of [opencode-claude](https://github.com/openchamber/opencode-claude).
- `docs/`: design spec, plan and the manual check list.

## Credits and license

MIT. Built on [openchamber/opencode-claude](https://github.com/openchamber/opencode-claude) (MIT, copyright lines kept in `LICENSE` and `plugin/LICENSE`; upstream: "Copyright (c) 2026 Otto Assistant contributors") and the OpenChamber extension SDK.
