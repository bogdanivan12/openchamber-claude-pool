import type { HostReadyContext } from "@openchamber/sdk";
import { applyHostReady, mountProgress } from "@openchamber/sdk/ui";
import { api, type Host } from "../shared/api.ts";
import { statusBadge, windowPercent, type AccountView } from "../shared/format.ts";

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

function row(a: AccountView, now: number, out: Element[]): void {
  const name = el("span", a.poolActive ? "active" : "", (a.poolActive ? "● " : "") + a.label);
  const bar = el("div");
  const five = windowPercent(a.state, "five_hour", now);
  mountProgress(bar, { value: five, tone: five >= 90 ? "error" : five >= 70 ? "warning" : "primary" });
  const badge = statusBadge(a, now);
  let note: HTMLElement;
  if (badge.tone === "error") note = el("span", "muted error", badge.label.toLowerCase());
  else if (badge.tone === "warning") note = el("span", "muted warning", badge.label.toLowerCase());
  else note = el("span", "muted", `5h ${Math.round(five)}% · 7d ${Math.round(windowPercent(a.state, "seven_day", now))}%`);
  const r = el("div", "row");
  r.append(name, bar, note);
  out.push(r);
}

/** Builds the Work Status section inside `root`. It refreshes on mount and on each ready; there is no timer. */
export function createStatus(host: StatusHost, root: Element, opts: { now?: () => number } = {}): void {
  const client = api(host);
  const now = opts.now ?? Date.now;
  let mounted = false;
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
      await host.setHeight?.(Math.ceil(document.documentElement.scrollHeight));
    } catch {
      // The host clamps and may refuse; the section works at any height.
    }
  }

  async function load(): Promise<void> {
    const mine = ++seq;
    const children: Element[] = [];
    try {
      const data = await client.list();
      const t = now();
      const enabled = data.accounts.filter((a) => a.enabled);
      if (!data.cliFound) children.push(line("Claude Code CLI not found"));
      else if (data.accounts.length === 0) children.push(line("No accounts. Open the Claude Pool panel to add one."));
      else for (const a of enabled) row(a, t, children);
    } catch (e) {
      children.push(line((e as Error).message));
    }
    if (mine !== seq) return; // a newer refresh is in flight
    body.replaceChildren(...children);
    await reportHeight();
  }

  host.onReady((context) => {
    applyHostReady(context, document.documentElement);
    mounted = true;
    void load();
  });
  if (!mounted) void load();
}
