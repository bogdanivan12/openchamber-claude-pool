import { mountButton } from "@openchamber/sdk/ui";
import type { Ctx } from "./ctx.ts";
import { el } from "./views.ts";

export type Faq = { q: string; a: string[] };
export type FaqGroup = { title: string; items: Faq[] };

/** User-facing documentation. Keep it in step with shared/router.ts and plugin/src/pool-proxy.ts. */
export const INTRO =
  "Claude Pool lets OpenChamber use several Claude subscriptions. Pick the Claude Pool provider and it chooses an account for you; pick “Claude · name” and it always uses that one account.";

export const FAQ: FaqGroup[] = [
  {
    title: "Choosing an account",
    items: [
      {
        q: "Which account does a new chat start on?",
        a: [
          "An account counts as available when it is switched on (“In pool”), signed in, not at a limit, and below 100% in both its 5-hour and 7-day windows.",
          "Among the available accounts a new chat gets the one with the most room left, counted on its fuller window (5-hour or weekly). A tie goes to the account higher in the list (reorder with Move up / Move down in the account’s ⋯ menu).",
          "The account marked “Next for new chats” is the one a new chat would get right now.",
        ],
      },
      {
        q: "When does a running chat move to another account?",
        a: [
          "Never without a reason. A chat stays on its account, which keeps Claude's prompt cache warm and is cheaper, until that account is full or hits a limit.",
          "The check happens when you send a message, not in the middle of an answer that is already streaming.",
        ],
      },
      {
        q: "What happens to the conversation when it moves?",
        a: [
          "Its history is copied to the new account, so Claude keeps the context. The first message after a move has a cold cache: Claude reads the whole conversation again, which uses more of the new account's allowance than usual.",
          "If an account refuses a message with a limit before it started answering, the same message is retried on the next account automatically and you will not notice. If the limit hits halfway through an answer, OpenChamber shows a retryable error and its automatic retry lands on the next account.",
        ],
      },
      {
        q: "What do the status labels mean?",
        a: [
          "In use now: a conversation used this account in the last 5 minutes (or is streaming an answer).",
          "Next for new chats: where the pool would send a new conversation.",
          "Ready: available, but not the next pick.",
          "Limited · 2h 10m: the account hit its limit and is skipped until then.",
          "Sign in again: its login expired or was revoked. It is skipped until you sign in again.",
          "Disabled: switched off with “In pool”. It is skipped and has no provider in the model picker.",
        ],
      },
    ],
  },
  {
    title: "When accounts run out",
    items: [
      {
        q: "What happens when every account is at its limit?",
        a: [
          "The pool answers “Every Claude Pool account is at its limit” and OpenChamber shows a countdown to the earliest moment one account frees up. Messages work again by themselves after that; there is nothing to click.",
          "If no reset time is known (for example the accounts are signed out), it asks you to sign in again and suggests retrying in 10 minutes.",
        ],
      },
      {
        q: "Can a long answer run into the limit halfway?",
        a: [
          "Yes, rarely. The pool uses each account up to its real limit, and the numbers it checks are from before the message: what the answer itself uses is not known in advance. If the limit hits halfway through an answer, OpenChamber shows a retryable error and its retry lands on the next account.",
        ],
      },
      {
        q: "Does the pool skip a window that has already reset?",
        a: [
          "Yes. Once a window's reset time has passed it counts as 0% used, even before fresh numbers arrive.",
        ],
      },
    ],
  },
  {
    title: "Accounts and data",
    items: [
      {
        q: "How do I add an account?",
        a: [
          "Add account: name it, sign in on the Claude page that opens, paste the code. Import finds Claude Code logins already on this computer (~/.claude and ~/.claude-*). Both need the Claude Code CLI (`claude`) to be installed.",
          "Two entries for the same Claude account gain nothing, and the panel warns you if you add a duplicate.",
        ],
      },
      {
        q: "Where do the usage numbers come from, and how fresh are they?",
        a: [
          "From Anthropic's usage endpoint, read with each account's own login, plus the rate-limit information Claude sends during chats. They refresh when you open this panel or press Refresh (at most every 45 seconds), and before a Claude Pool message picks an account when the numbers are more than 2 minutes old and the account is close to full (or the chat is new). That check waits at most 1.5 seconds; a slower answer is used for the next message. Nothing polls in the background and no daemon is left running.",
        ],
      },
      {
        q: "What do chat titles and summaries use?",
        a: [
          "The account the chat is already on, if it is available. They never move a chat to another account.",
        ],
      },
      {
        q: "What does Remove do?",
        a: [
          "It takes the account out of the pool. A login folder you imported is never deleted. For accounts created here you can also tick “Also sign out and delete this account's folder”.",
        ],
      },
      {
        q: "Is this safe for my login?",
        a: [
          "The extension only reads the login Claude Code stored on your computer. It never writes or refreshes tokens, never logs them, and signing in is done by the Claude CLI itself.",
          "Anthropic's terms say plan limits assume ordinary individual use, and there are reports of accounts suspended for automatic rotation across several subscriptions. Decide whether the pool fits how you use your accounts. Per-account providers work without the pool.",
        ],
      },
    ],
  },
  {
    title: "Troubleshooting",
    items: [
      {
        q: "The panel says the Claude Code CLI was not found.",
        a: [
          "Install it (`npm install -g @anthropic-ai/claude-code` or the native installer) and make sure `claude` is on your PATH, then reopen the panel. Messages fail until it is installed.",
        ],
      },
      {
        q: "I changed accounts but the model picker did not update.",
        a: [
          "The plugin watches the account list and updates its providers shortly after a change. If a provider is still missing, restart OpenChamber.",
        ],
      },
      {
        q: "An account keeps showing “Sign in again”.",
        a: [
          "Press “Sign in again” on its card and finish the sign-in. A temporary failure to read a login (for example a denied Keychain prompt on macOS) does not mark an account as signed out.",
        ],
      },
    ],
  },
];

export function renderHelp(ctx: Ctx, page: HTMLElement): void {
  const head = el("div", "header");
  head.append(el("h1", "title grow", "How Claude Pool works"));
  mountButton(head, { label: "Back", variant: "ghost", size: "sm", onClick: () => { ctx.screen = { kind: "list" }; ctx.render(); } });
  page.append(head, el("p", "intro", INTRO));

  for (const group of FAQ) {
    page.append(el("h2", "section-title", group.title));
    const list = el("div", "faq");
    for (const item of group.items) {
      const d = document.createElement("details");
      d.className = "faq-item";
      d.append(el("summary", "", item.q));
      const body = el("div", "faq-body");
      for (const para of item.a) body.append(el("p", "", para));
      d.append(body);
      list.append(d);
    }
    page.append(list);
  }
}
