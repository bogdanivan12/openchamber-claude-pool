import type { HostReadyContext } from "@openchamber/sdk";
import { applyHostReady } from "@openchamber/sdk/ui";
import { api, type Host } from "../shared/api.ts";
import { accountKind, statusBadge, windowPercent, type AccountView } from "../shared/format.ts";

/** The part of the SDK host the section uses. */
export type StatusHost = Host & {
  onReady(listener: (context: HostReadyContext) => void): unknown;
  setHeight(height: number): Promise<unknown>;
};

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = "") => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text) node.textContent = text;
  return node;
};

const line = (text: string, cls = "muted") => el("span", `line ${cls}`, text);
const MIN_HEIGHT = 24;

const clock = (t: number, withDay: boolean): string => {
  const d = new Date(t);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  return withDay ? `${d.toLocaleDateString("en-US", { weekday: "short" })} ${time}` : time;
};

/** One usage line in the look of the built-in Usage block: small label, reset time, then the used share. */
function windowLine(label: string, a: AccountView, name: "five_hour" | "seven_day", now: number): HTMLElement | null {
  const w = a.state?.windows[name];
  if (!w) return null;
  const percent = Math.round(windowPercent(a.state, name, now));
  const left = el("span", "win-label");
  left.append(el("span", "", label));
  if (w.resetsAt !== null && w.resetsAt > now) left.append(el("span", "win-reset", clock(w.resetsAt, name === "seven_day")));
  const tone = percent >= 80 ? "pct pct-error" : percent >= 50 ? "pct pct-warning" : "pct";
  const l = el("div", "win");
  l.append(left, el("span", tone, `${percent}%`));
  return l;
}

function row(a: AccountView, now: number, out: Element[]): void {
  const k = accountKind(a, now);
  const dot = el("span", `dot ${k.kind}`);
  dot.title = k.label;
  dot.setAttribute("role", "img");
  dot.setAttribute("aria-label", k.label);
  const name = el("span", `name${a.poolActive ? " active" : ""}`, a.label);
  const badge = statusBadge(a, now);
  const head = el("div", "head");
  const who = el("span", "who");
  who.append(dot, name);
  head.append(who);
  if (badge.tone === "error") head.append(el("span", "note error", badge.label.toLowerCase()));
  else if (badge.tone === "warning") head.append(el("span", "note warning", badge.label.toLowerCase()));
  else if (k.kind === "out") head.append(el("span", "note warning", "limit reached"));
  else if (a.nextChat) head.append(el("span", "note muted", "next for new chats"));
  const r = el("div", "row");
  r.append(head);
  for (const l of [windowLine("5-Hour", a, "five_hour", now), windowLine("7-Day Limit", a, "seven_day", now)]) if (l) r.append(l);
  out.push(r);
}

/** Builds the Work Status section inside `root`. It refreshes on mount and on each ready; there is no timer. */
export function createStatus(host: StatusHost, root: Element, opts: { now?: () => number } = {}): void {
  const client = api(host);
  const now = opts.now ?? Date.now;
  let seq = 0;

  const body = el("div", "list");
  const refresh = el("button", "refresh", "↻");
  refresh.type = "button";
  refresh.title = "Refresh";
  refresh.setAttribute("aria-label", "Refresh");
  refresh.addEventListener("click", () => void load());
  root.replaceChildren(body, refresh);
  body.append(line("Loading…"));

  async function reportHeight(): Promise<void> {
    try {
      const content = Math.ceil(root.getBoundingClientRect().height);
      await host.setHeight?.(Math.max(MIN_HEIGHT, content));
    } catch {
      // The host clamps and may refuse; the section works at any height.
    }
  }

  async function load(): Promise<void> {
    const mine = ++seq;
    refresh.disabled = true;
    const children: Element[] = [];
    try {
      const data = await client.list();
      const t = now();
      const enabled = data.accounts.filter((a) => a.enabled);
      if (!data.cliFound) children.push(line("Claude Code CLI not found"));
      else if (data.accounts.length === 0) children.push(line("No accounts. Open the Claude Pool panel to add one."));
      else for (const a of enabled) row(a, t, children);
    } catch (e) {
      const message = (e as Error).message;
      const l = line(message, "muted error-line");
      l.title = message;
      children.push(l);
    }
    if (mine !== seq) return; // a newer refresh is in flight
    refresh.disabled = false;
    body.replaceChildren(...children);
    await reportHeight();
  }

  host.onReady((context) => {
    applyHostReady(context, document.documentElement);
    void load();
  });
}
