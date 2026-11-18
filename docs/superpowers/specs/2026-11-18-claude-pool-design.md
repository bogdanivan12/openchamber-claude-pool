# Claude Pool — design

Date: 2026-11-18
Status: approved in brainstorming, awaiting written-spec review

## 1. Goal

An OpenChamber extension that serves Claude subscription models (Pro/Max) from any number of Claude accounts, on macOS and Windows, and shows each account's usage in OpenChamber's usage widget (header, Work Status, Usage page, phone).

Success criteria:

- Any number of accounts can be added, signed in, renamed and removed from inside OpenChamber.
- A `claude-pool` provider moves between accounts automatically by the policy in section 5, and retries an interrupted turn without user action.
- One provider per account (`claude-pool-<id>`) lets the user pick an account by hand, including in OpenChamber auto-routing.
- One usage card shows the 5-hour and 7-day windows of every account.
- Nothing runs permanently: no daemon, LaunchAgent or polling loop.
- Works on macOS and Windows (Linux is a side effect of the Windows code path, but it is not a target).

Non-goals: OAuth implemented by us (the Claude Code CLI does every login), API-key accounts, Linux-specific testing, sharing accounts between machines.

## 2. Risk statement (goes into the README)

Anthropic's terms say limits assume ordinary individual use. There are public reports of accounts suspended for automatic rotation across several subscriptions. The extension is a tool; the user decides how to use it. The README says this plainly, and per-account providers (manual choice) remain available without the pool.

## 3. Packaging

One public MIT repository, `bogdanivan12/openchamber-claude-pool`, installed through Settings → Extensions → Add, and later submitted to the OpenChamber extension catalog.

The manifest lives under `openchamber` in the root `package.json`:

- `contributes.opencodePlugin`: `plugin/`, a folder with its own `package.json`. OpenChamber lists it in its managed OpenCode config while the extension is active.
- `contributes.service` with `provides: ["quota"]`: the Node service in `service/`. OpenChamber spawns it with its own Node runtime (`ELECTRON_RUN_AS_NODE`), on demand, and stops it after 10 minutes idle.
- `contributes.quota`: `{ "providers": [] }`. The service needs no OpenCode credentials, because it reads the Claude Code logins itself.
- A UI surface (panel plus Work Status section) for account management, served by the same service.

The plugin code starts as an import, with history, of the user's fork `bogdanivan12/opencode-claude` (v1.7.0, MIT, upstream `openchamber/opencode-claude` archived), keeping the original license notice.

Repository layout:

```
package.json            manifest + workspace
shared/                 pure modules used by plugin and service
  accounts.ts           accounts.json schema, read/write
  state.ts              state.json schema, read/write
  store-io.ts           atomic write (temp + rename), lock file
  router.ts             account choice (pure function)
  creds.ts              per-OS credential read
  paths.ts              data dir, account dirs, keychain service name
plugin/                 OpenCode plugin (fork of opencode-claude)
service/                quota + account-management service
ui/                     surface (panel, Work Status section)
test/                   unit + integration, fake claude CLI
docs/
```

## 4. Accounts and shared state

Data dir: `~/.claude-pool/` on macOS and `%USERPROFILE%\.claude-pool\` on Windows. The plugin and the service use the same path, so neither depends on the other's runtime data dir.

`accounts.json`:

```json
{
  "version": 1,
  "accounts": [
    { "id": "a1b2c3", "label": "webodes", "configDir": "~/.claude", "order": 0, "enabled": true },
    { "id": "d4e5f6", "label": "gmail",   "configDir": "~/.claude-b", "order": 1, "enabled": true }
  ],
  "threshold": 90
}
```

- `id`: 6 lowercase hex characters, stable, used in provider ids (`claude-pool-<id>`). `label` is only for display.
- `configDir`: absolute path once stored (`~` is expanded on write). New accounts get `~/.claude-pool/accounts/<id>`.
- Removing an account takes it out of the file. Its directory is deleted only when the user ticks "also delete the login".

`state.json`, keyed by account id:

```json
{
  "version": 1,
  "accounts": {
    "a1b2c3": {
      "windows": {
        "five_hour": { "utilization": 0.42, "resetsAt": 1763500000000 },
        "seven_day": { "utilization": 0.71, "resetsAt": 1763900000000 }
      },
      "limitedUntil": null,
      "needsLogin": false,
      "updatedAt": 1763480000000,
      "source": "rate_limit_event"
    }
  },
  "conversations": { "<conversationKey>": "a1b2c3" }
}
```

- Writers: the plugin (from `rate_limit_event`, from limit errors, from conversation bindings) and the service (from `/api/oauth/usage`). For each window, the newer `updatedAt` wins.
- All writes go temp file + rename, under `state.lock`, created with exclusive create. A lock older than 10 seconds is taken over.
- A `state.json` that does not parse is discarded and rebuilt. An `accounts.json` that does not parse is renamed to `.bak`, and the UI reports it.
- Conversation bindings older than 30 days are pruned on write.

## 5. Routing and failover

### Providers

The plugin registers providers from `accounts.json` on every setup (OpenCode starts one plugin instance per location):

- `claude-pool` ("Claude Pool"), only when at least one account is enabled.
- `claude-pool-<id>` ("Claude · <label>") for each enabled account.

Every provider gets the same model list (discovered through the CLI, as today). Ids never collide with OpenCode's native `claude-code`.

### Choosing an account (`router.ts`, pure)

Input: accounts, state, now, threshold, and the conversation's current account (if any). Output: an account id, or "none available" with the earliest reset.

An account is **available** when it is enabled, `needsLogin` is false, `limitedUntil` is null or past, and every window with a future `resetsAt` has `utilization * 100 < threshold`. A window whose `resetsAt` is past counts as 0.

1. If the conversation has a current account and it is available, keep it (sticky; keeps the prompt cache warm).
2. Otherwise pick the available account with the largest headroom, defined as `min over windows of (threshold - utilization*100)`. Ties go to the lower `order`.
3. If none is available, the result is "none", with `retryAt` = the earliest moment any account becomes available.

A per-account provider skips the router. Its account is fixed, and its only gate is that account's own `limitedUntil` / `needsLogin`.

### A turn on `claude-pool`

1. The proxy computes the conversation key (existing logic) and asks the router.
2. If the router picks a different account than the binding, migrate the conversation (section 6) and update the binding.
3. Spawn `claude` with `CLAUDE_CONFIG_DIR` = the account's dir (unset for the default `~/.claude`, so the CLI uses its default Keychain item).
4. Each `rate_limit_event` updates that account's window in `state.json`.
5. On a hard limit error, set `limitedUntil` (the reset time from the event or the text, else now + 10 min), then:
   - no output has been streamed yet: rerun the same request on the router's next choice, inside the proxy, invisible to OpenCode;
   - output has been streamed: emit the existing retryable stream error, and OpenCode's automatic retry lands on the next account;
   - the router answers "none": HTTP 429 with `Retry-After` = `retryAt`, so OpenChamber shows its countdown.
6. Hard cap: at most N-1 in-proxy reruns per request (N = enabled accounts), so a fault cannot loop.

The per-account limit store from v1.7.0 (`rate-limit.json` per config dir) is replaced by `state.json`.

## 6. Conversation migration

Claude Code keeps transcripts under `<configDir>/projects/<encoded cwd>/<sessionId>.jsonl`. When a conversation moves from account A to account B:

1. Find A's transcript (existing `findClaudeSessionFile`).
2. Copy it to the same relative path under B's dir (create folders; never overwrite a newer file).
3. Resume with `--resume <sessionId>` under B.
4. If any step fails, clear the foreign session id and fall back to the existing replay from OpenCode history.

The prompt cache is per account, so the first turn after a move is always a cold cache. This is expected, and the docs say so.

## 7. Credentials (`creds.ts`, read-only)

| | macOS | Windows |
|---|---|---|
| Default dir `~/.claude` | Keychain service `Claude Code-credentials` | `%USERPROFILE%\.claude\.credentials.json` |
| Other dir `D` | Keychain service `Claude Code-credentials-<first 8 hex of sha256(D)>` (D absolute, no trailing slash) | `D\.credentials.json` |

- macOS reads with `security find-generic-password -s <service> -w` through `execFile`, 10 s timeout. The secret is never logged.
- Only `claudeAiOauth.{accessToken, expiresAt, subscriptionType}` is used.
- The extension never writes or refreshes tokens. The CLI rotates them, and a second writer would race it.
- The sha256 suffix rule was verified on 2026-11-18 for `/Users/bogdanivan/.claude-b` → `fae08b37`. A unit test pins it.

## 8. Adding an account (in-app login)

1. UI: "Add account" asks for a label. The service creates `~/.claude-pool/accounts/<id>` and a pending entry.
2. The service spawns `claude auth login --claudeai` with `CLAUDE_CONFIG_DIR` set, using the relay from `cli-login.ts` (states `awaiting-code` → `verifying` → `succeeded | failed`).
3. UI: opens the authorize URL and shows a code field. The service writes the code to the CLI's stdin. No token passes through the extension.
4. On success the service runs `claude auth status` in that dir to read the email and plan, then marks the account enabled. If login fails or is cancelled, the pending entry and its empty dir are removed.

"Sign in again" runs the same flow on an existing account dir and clears `needsLogin`.

**First-run import:** the service lists `~/.claude` and every `~/.claude-*` dir whose credentials (section 7) exist and offers them as accounts. Nothing is added without the user's confirmation.

**Duplicate guard:** if a new login's email matches an existing account, the UI warns and offers to cancel.

## 9. Usage card (quota service)

On `POST /quota` (`usage.read`, wire v1):

1. For each enabled account, read the credential (section 7) and call `GET https://api.anthropic.com/api/oauth/usage` with it, all accounts in parallel, 8 s timeout each.
2. On success, write the windows to `state.json` (`source: "oauth_usage"`). On 401, set `needsLogin`. On an expired token or a network failure, fall back to the last `state.json` values and note how old they are.
3. Answer:
   - `windows`: the 5h and 7d windows of the account the pool would pick now (router output), each `valueLabel` prefixed with the account label;
   - `models`: one group per account, keyed by label, with `5h` and `7d` windows (`usedPercent`, `windowSeconds`, `resetAt`), at most 64 accounts;
   - `planLabel`: e.g. `Pro ×2, Max ×1`;
   - `ok: false` with `error` only when no account produced data at all.

The built-in Claude card is not touched. It keeps showing the default Keychain account, and the README tells users they can hide it in Usage settings.

## 10. UI surface

Panel: a list of accounts showing label, email, plan, 5h/7d bars, and a state badge (`active in pool`, `limited until …`, `needs login`, `disabled`), with actions Add, Sign in again, Rename, Enable/Disable, Remove (with the "also delete login" checkbox), drag to reorder, and a threshold slider (50–100, default 90).

Work Status section: one line per account with its 5h bar, and the pool's current account marked.

## 11. Errors

| Situation | Behavior |
|---|---|
| Account login expired or revoked | `needsLogin`, out of the pool; card and panel show "Sign in again"; pool continues |
| `claude` missing or below minimum version | providers not registered; panel shows the reason and the minimum version |
| Keychain access denied (macOS) | only that account's usage shows the error; turns still run (the CLI reads its own Keychain item) |
| Corrupt `state.json` / `accounts.json` | see section 4 |
| Only one account | pool behaves like a single provider, no failover |
| Stale lock | taken over after 10 s |
| Every account limited | 429 + Retry-After, countdown in OpenChamber |

## 12. Cross-platform specifics

- Finding the CLI: the existing `executable-path.ts`, plus `claude.exe` and npm `claude.cmd` on Windows (spawn `.cmd` through `cmd.exe /c` with escaped arguments).
- Paths: always `path.join`, home from `os.homedir()`, no hard-coded `/`.
- Locks: exclusive file create plus a timestamp (no `flock`), the same on both OSes.
- Keychain code runs only when `process.platform === "darwin"`.

## 13. Testing

| Level | Covers | Where |
|---|---|---|
| Unit (`bun test`) | router (stickiness, threshold per window, expired windows, headroom ties, none + retryAt), state merge by `updatedAt`, atomic write + lock takeover, keychain service name (pinned hash), credential paths per OS, transcript copy | local + GitHub Actions on `macos-latest` and `windows-latest` |
| Integration | proxy with a fake `claude` that emits `rate_limit_event` and limit errors: failover before output, after output, all accounts limited, rerun cap | local + CI on both OSes |
| Contract | service answers validated with `quotaProviderSchemasV1` from `@openchamber/sdk` | CI |
| End-to-end (manual) | two real accounts in OpenChamber on macOS: import, add account via login, a turn per provider, card values, forced switch via lowered threshold | user's Mac |

Windows end-to-end with real accounts stays an open item until someone runs it on a Windows machine. The README states this.

## 14. Release

1. The repo is created locally first. The GitHub repo is published (public) at the first release, with the user's approval.
2. The README covers install, requirements (Claude Code CLI, minimum version), macOS/Windows notes, how it works, the risk statement, and hiding the built-in Claude card.
3. Tag `v0.1.0`.
4. Submit to the catalog through the "Send your extension" email on openchamber.dev/extensions, only after the user approves.
