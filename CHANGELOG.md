# Changelog

## 0.1.0 – unreleased

- `claude-pool` provider: failover across enabled accounts. A conversation sticks to its account until it passes the threshold (default 90% of the 5h or 7d window) or hits a limit, then moves to the account with the most headroom.
- One `claude-pool-<id>` provider per account, shown as "Claude · name".
- Failover retries a turn on the next account when no output was streamed yet, and copies the Claude session transcript to the new account's folder. When every account is at its limit the proxy answers 429 with the earliest reset.
- Claude Pool panel: in-app sign-in, import of existing `~/.claude*` logins, rename, reorder, enable or disable, safe removal, threshold setting, duplicate and changed-account warnings.
- Usage card with the pool's current account windows on top and a group per account.
- Work Status section with a 5h bar per account.
- Committed bundles with a freshness check; CI on macOS and Windows.
