# Manual end-to-end check (macOS, two real accounts)

Run this before publishing. Mark each item Pass or Fail and note anything odd in the Results table at the end.

Prep: OpenChamber running; Settings → Extensions → Add, the absolute path of this repo folder. Have two Claude subscription accounts (account 1 on `~/.claude`, account 2 on `~/.claude-b` or similar) and a third login (or a duplicate of one of them) for the sign-in items. Open claude.ai usage for both accounts to compare.

## A. Install and accounts

- [ ] **A1** Approve the permissions (Run a local service, Add a plugin to OpenCode, Reports usage). Settings → Plugins lists `claude-pool` as active within seconds. Pass ☐ Fail ☐
- [ ] **A2** Before any account exists, the model picker shows no Claude Pool providers. Pass ☐ Fail ☐
- [ ] **A3** Panel → Import: `~/.claude` and `~/.claude-b` are offered; import both. Each shows its email and plan. Pass ☐ Fail ☐
- [ ] **A4** Model picker shows `Claude Pool` and `Claude · <name>` for each account. Pass ☐ Fail ☐
- [ ] **A5** Import again: nothing left to offer (the "Nothing to import" note appears). Pass ☐ Fail ☐
- [ ] **A6** Panel → Add account with a new name, finish with the code from the Claude page: the account appears with email and plan; its folder exists in `~/.claude-pool/accounts/`. Pass ☐ Fail ☐
- [ ] **A7** Add account with a name that is already used: an error is shown, nothing starts. Pass ☐ Fail ☐
- [ ] **A8** New sign-in with a WRONG code: the sign-in starts over (new page and code prompt or a failed screen with Back); no half-created account appears in the list and no leftover folder remains in `~/.claude-pool/accounts/`. Pass ☐ Fail ☐
- [ ] **A9** Start a new sign-in and reload the panel while the code screen is open: the code screen comes back (resumes). Finish with the right code. Pass ☐ Fail ☐
- [ ] **A10** Submit a code and reload the panel while it says verifying: the panel resumes and ends on the list. Pass ☐ Fail ☐
- [ ] **A11** Sign in with an account that is already in the pool (new name): the duplicate warning appears; "Remove the duplicate" removes the new entry and the original is untouched (still listed, still works). Pass ☐ Fail ☐
- [ ] **A12** Make an account need login (or use "Sign in again" if shown), and sign in again with a different Claude login: the "Signed in as … (was …)" warning appears. A wrong code here leaves the account untouched. Pass ☐ Fail ☐
- [ ] **A13** Rename an account to a name another account uses: an error shows in the field and the name is not changed. Pass ☐ Fail ☐
- [ ] **A14** Threshold: enter 49, 101 and `abc`: each shows an error. Enter 50 and 100: each saves. Set it back to 90. Pass ☐ Fail ☐
- [ ] **A15** Disable an account ("In pool" off): its provider leaves the model picker within seconds; turn it on again and it returns. Pass ☐ Fail ☐
- [ ] **A16** Reorder with ↑ and ↓: the order changes and stays after Refresh. Pass ☐ Fail ☐
- [ ] **A17** Remove an imported account (its folder is not under `~/.claude-pool/accounts`): no "delete" checkbox is offered; the account leaves the list and its login folder is untouched. Pass ☐ Fail ☐
- [ ] **A18** Remove a pool-created account WITHOUT ticking the box: it leaves the list, its folder is still in `~/.claude-pool/accounts/`. Pass ☐ Fail ☐
- [ ] **A19** Remove a pool-created account WITH "Also sign out and delete this account's folder": the folder in `~/.claude-pool/accounts/` is gone. Pass ☐ Fail ☐
- [ ] **A20** Backup banner (optional): quit OpenChamber, write invalid JSON into `~/.claude-pool/accounts.json`, reopen the panel. The "accounts.json was unreadable" banner appears, `accounts.json.bak` exists, and Dismiss removes the banner. Restore your accounts afterwards. Pass ☐ Fail ☐ Skipped ☐

## B. Providers and usage

- [ ] **B1** Send one message with `Claude · <account 2>`. On claude.ai (account 2) usage rose; account 1 unchanged. Pass ☐ Fail ☐
- [ ] **B2** Send one message with `Claude · <account 1>`. Account 1 rose; account 2 unchanged. Pass ☐ Fail ☐
- [ ] **B3** Settings → Usage: the Claude Pool card shows both the 5h and 7d windows on top (labelled with the pool account's name) and a group per account with both windows. The built-in Claude card can be hidden there. Pass ☐ Fail ☐
- [ ] **B4** Work Status shows the Claude Pool section with a row per enabled account (5h bar and both percentages). A long account name is truncated (try renaming one to 40 characters), the frame height fits the rows, and ↻ refreshes. Pass ☐ Fail ☐
- [ ] **B5** Sign out an account's login on purpose (or break it) and refresh: its group shows "(sign in again)" and the panel offers "Sign in again". Pass ☐ Fail ☐ Skipped ☐

## C. Pool and failover

- [ ] **C1** Send with `Claude Pool`: the turn runs on one account and the next turns of the same conversation stay on it. Pass ☐ Fail ☐
- [ ] **C2** Set the threshold to 50, or to a value below the active account's current 5h usage. Send the next turn of the same conversation: it runs on the other account and the answer still uses the earlier context. Pass ☐ Fail ☐
- [ ] **C3** Transcript copy: after the move, the Claude session file for that conversation exists under both config dirs, for example `find ~/.claude ~/.claude-b ~/.claude-pool/accounts -name '<session id>.jsonl'` (look in `projects/...`). Pass ☐ Fail ☐
- [ ] **C4** Set the threshold back to 90. Pass ☐ Fail ☐
- [ ] **C5** (Only if you can) With every account at or over the threshold, a `Claude Pool` turn is refused with a 429 that names the earliest reset, not a hang. Pass ☐ Fail ☐ Skipped ☐

## D. Service and processes

- [ ] **D1** Stop and restart the OpenChamber service (or restart OpenChamber): the panel keeps working after it comes back. Pass ☐ Fail ☐
- [ ] **D2** Quit OpenChamber: no `claude-pool` service process remains (`ps aux | grep service/main.js`). Pass ☐ Fail ☐

## E. Windows (for whoever can run it)

Same items as above, with these changes: credentials are read from `<folder>\.credentials.json` (there is no Keychain), account folders are in `%USERPROFILE%\.claude-pool\accounts\`, the process check is Task Manager or `tasklist | findstr node`, and the session file search is `dir /s /b %USERPROFILE%\.claude*\<session id>.jsonl`.

- [ ] **E1** A1 to A19, B1 to B4, C1 to C3, D1 and D2 pass on Windows. Pass ☐ Fail ☐ Not run ☐ (list failures below)

## Results

| Item | Pass / Fail | Notes |
| --- | --- | --- |
| A1–A5 | | |
| A6–A12 | | |
| A13–A20 | | |
| B1–B5 | | |
| C1–C5 | | |
| D1–D2 | | |
| E1 (Windows) | | |

Tester, date, OpenChamber version, macOS version:
