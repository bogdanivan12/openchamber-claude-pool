# Changelog

## 0.3.0

- Panel redesign: a header with a one-line pool summary (how many accounts are available and where a new chat goes); all accounts on one surface split by hairlines instead of separate cards; per account a status dot, the badge next to the name, the "In pool" switch and a "⋯" menu (Rename, Move up, Move down, Remove); 5-hour and weekly usage one under the other (like the Work Status widget), each with its reset time beside the label, neutral until 70%, then warning and error; "Sign in again" takes the badge's place on a signed-out account; a "Switching" section for the threshold; skeleton rows while loading.
- Work Status widget polished (same labels, clock-style resets and 50% / 80% tones as the built-in Usage block): a thin bar under every window, hairlines between accounts, the ↻ button moved to a footer with the time of the last update so it no longer overlaps the first account, skeleton rows while loading.
- New **How it works** button in the panel: a FAQ explaining how an account is chosen, when a chat moves and what happens to its history, what happens when every account is at its limit, what the labels and the threshold mean, where the numbers come from, and basic troubleshooting.

## 0.2.3

- Fix: "Bun is not defined" when OpenChamber's built-in OpenCode (which runs on Node, not Bun) starts the plugin's proxy. The proxy now uses `Bun.serve` under Bun and a `node:http` server otherwise. Restart OpenChamber to load the updated plugin.

## 0.2.2

- A response that is still streaming keeps its account green: the proxy renews the conversation's activity every 10 s while the body is open and once more when it ends (the 5-minute window then starts). Cancelling or finishing the stream stops the heartbeat. Restart OpenChamber to load the updated plugin.

## 0.2.1

- Fix: the pool state keeps fields it does not know. An older service or plugin process rewriting `state.json` used to drop the new conversation activity, so busy accounts flickered back to grey. Restart OpenChamber after updating so every process runs the same version.

## 0.2.0

- Real usage in the panel and Work Status: the account list now refreshes 5h and 7d usage (at most every 45 s) instead of showing an empty stored state.
- Work Status section restyled like the built-in Usage block: label with reset time on the left, used share on the right, with the same tone rules (50% warning, 80% error) and theme variables.
- A colored dot per account: green = has active conversations (with a chat count), hollow grey = available, red = unavailable (limit reached, limited or sign-in needed). "Next for new chats" marks where the router sends new conversations. The widget refreshes itself every 30 s.
- The proxy records conversation activity (at most every 15 s per conversation); a conversation counts as active for 5 minutes after its last request. Restart OpenChamber to load the updated plugin.
- Tests no longer assume POSIX paths; CI passes on Windows again.

## 0.1.0

- `claude-pool` provider: failover across enabled accounts. A conversation sticks to its account until it passes the threshold (default 90% of the 5h or 7d window) or hits a limit, then moves to the account with the most headroom.
- One `claude-pool-<id>` provider per account, shown as "Claude · name".
- Failover retries a turn on the next account when no output was streamed yet, and copies the Claude session transcript to the new account's folder. When every account is at its limit the proxy answers 429 with the earliest reset.
- Claude Pool panel: in-app sign-in, import of existing `~/.claude*` logins, rename, reorder, enable or disable, safe removal, threshold setting, duplicate and changed-account warnings.
- Usage card with the pool's current account windows on top and a group per account.
- Work Status section with a 5h bar per account.
- Committed bundles with a freshness check; CI on macOS and Windows.
- Hardening after review: a Keychain denial or other credential read error no longer marks an account as signed out; `claude` is found in homebrew, nvm, volta, bun and npm-global locations; the default account never inherits the server's `CLAUDE_CONFIG_DIR`; rate-limit resets no longer leak across windows; transient file errors no longer empty the account list; directory comparison is case-insensitive on Windows; CI runs a portable plugin test subset on Windows.
