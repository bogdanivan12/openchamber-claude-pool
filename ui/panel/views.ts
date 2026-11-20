import { mountBadge, mountBanner, mountButton, mountCheckbox, mountEmpty, mountMenu, mountProgress, mountSwitch, mountTextField } from "@openchamber/sdk/ui";
import { accountKind, resetText, statusBadge, validateThreshold, windowPercent, type AccountView } from "../shared/format.ts";
import type { Ctx } from "./ctx.ts";

export const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = "") => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text) n.textContent = text;
  return n;
};

/** Banners for the service-reported conditions plus every raised notice. */
export function renderBanners(ctx: Ctx, page: HTMLElement): void {
  const d = ctx.data;
  if (d && !d.cliFound) {
    mountBanner(page, { tone: "error", title: "Claude Code CLI not found", body: "Install it with `npm install -g @anthropic-ai/claude-code` (or the native installer), make sure `claude` is on PATH, then reopen this panel. Turns fail until it is installed." });
  }
  if (d?.recoveredBackup) {
    mountBanner(page, {
      tone: "warning",
      title: "accounts.json was unreadable",
      body: "It was moved to accounts.json.bak in ~/.claude-pool. Re-add your accounts or restore the file.",
      action: { label: "Dismiss", onClick: () => void ctx.run(async () => { await ctx.client.ackBackup(); }) },
    });
  }
  renderNotices(ctx, page);
}

/** Raised notices. One with its own action also gets a Dismiss button, since a banner holds a single action. */
export function renderNotices(ctx: Ctx, page: HTMLElement): void {
  for (const n of ctx.notices) {
    mountBanner(page, n);
    if (n.action && n.action.label !== "Dismiss") {
      const row = el("div", "row");
      mountButton(row, { label: "Dismiss", variant: "ghost", size: "xs", onClick: () => ctx.dismiss(n) });
      page.append(row);
    }
  }
}

export function renderList(ctx: Ctx, page: HTMLElement): void {
  const data = ctx.data;
  if (!data) return;
  const now = Date.now();
  const f = ctx.flows;

  const head = el("div", "header");
  const titles = el("div", "grow");
  titles.append(el("h1", "title", "Claude Pool"), el("div", "muted summary", poolSummary(data.accounts)));
  head.append(titles);
  mountButton(head, { label: "How it works", variant: "ghost", size: "sm", onClick: () => { ctx.screen = { kind: "help" }; ctx.render(); } });
  page.append(head);

  const tools = el("div", "row toolbar");
  mountButton(tools, { label: "Add account", size: "sm", disabled: f.adding !== null, onClick: () => { ctx.notices.length = 0; f.adding = { name: "" }; ctx.render(); } });
  const importBtn = mountButton(tools, { label: "Import", variant: "outline", size: "sm", disabled: f.importing !== null, onClick: () => {
    void ctx.run(async () => {
      const { candidates } = await ctx.client.candidates();
      if (candidates.length === 0) ctx.notify({ tone: "info", title: "Nothing to import", body: "No other Claude Code logins were found in your home folder." });
      else f.importing = { candidates, selected: new Set() };
    }, importBtn);
  } });
  tools.append(el("span", "grow"));
  const refreshBtn = mountButton(tools, { label: "Refresh", variant: "ghost", size: "sm", onClick: () => void ctx.run(async () => {}, refreshBtn) });
  page.append(tools);

  if (f.adding) page.append(addRow(ctx));
  if (f.importing) page.append(importPanel(ctx));

  if (data.accounts.length === 0 && !f.adding) {
    mountEmpty(page, { title: "No accounts yet", body: "Add a Claude account, or import the ones Claude Code is already signed in to." });
  }
  if (data.accounts.length > 0) {
    const list = el("div", "accounts");
    data.accounts.forEach((a, i) => list.append(accountCard(ctx, a, i, data.accounts, now)));
    page.append(list);
  }
  page.append(thresholdBox(ctx, data.threshold));
}

/** Placeholder rows in the shape of the account list, shown until the first answer. */
export function renderSkeleton(page: HTMLElement): void {
  const sr = el("span", "sr-only", "Loading…");
  const head = el("div", "header");
  head.append(el("div", "sk sk-title"));
  const list = el("div", "accounts");
  for (let i = 0; i < 2; i++) {
    const row = el("div", "acct");
    const top = el("div", "row");
    top.append(el("span", "sk sk-dot"), el("span", "sk sk-line"));
    const usage = el("div", "usage");
    usage.append(el("span", "sk sk-bar"), el("span", "sk sk-bar"));
    row.append(top, usage);
    list.append(row);
  }
  page.append(sr, head, list);
}

/** One line under the title: how many accounts the pool can use, and where a new chat would go. */
export function poolSummary(accounts: AccountView[]): string {
  const enabled = accounts.filter((a) => a.enabled);
  if (accounts.length === 0) return "No accounts yet";
  if (enabled.length === 0) return "Every account is switched off";
  const available = enabled.filter((a) => a.available !== false && !a.state?.needsLogin);
  const next = enabled.find((a) => a.nextChat);
  const count = `${available.length} of ${enabled.length} account${enabled.length === 1 ? "" : "s"} available`;
  return next ? `${count} · new chats go to ${next.label}` : `${count} · none can take a new chat right now`;
}

function addRow(ctx: Ctx): HTMLElement {
  const box = el("div", "acct");
  const adding = ctx.flows.adding!;
  const field = mountTextField(box, { label: "Name for the new account (e.g. work, personal)", value: adding.name, error: adding.error, onChange: (v) => { adding.name = v; adding.error = undefined; field.update({ value: v, error: undefined }); } });
  const row = el("div", "row");
  const start = mountButton(row, { label: "Start", onClick: () => {
    const label = adding.name.trim();
    if (!label) { adding.error = "Enter a name."; field.update({ error: adding.error }); return; }
    void ctx.run(async () => {
      ctx.flows.adding = null;
      try { await ctx.startLogin({ label }); } catch (e) { ctx.flows.adding = adding; throw e; }
    }, start);
  } });
  mountButton(row, { label: "Cancel", variant: "ghost", onClick: () => { ctx.flows.adding = null; ctx.render(); } });
  box.append(row);
  return box;
}

function importPanel(ctx: Ctx): HTMLElement {
  const box = el("div", "acct");
  const imp = ctx.flows.importing!;
  box.append(el("div", "", "Claude Code logins found on this computer:"));
  for (const dir of imp.candidates) {
    const cb = mountCheckbox(box, { label: dir, checked: imp.selected.has(dir), onChange: (c) => { if (c) imp.selected.add(dir); else imp.selected.delete(dir); cb.update({ checked: c }); } });
  }
  const row = el("div", "row");
  const go = mountButton(row, { label: "Import selected", onClick: () => {
    const dirs = imp.candidates.filter((d) => imp.selected.has(d));
    if (dirs.length === 0) { ctx.notify({ tone: "info", title: "Select at least one login to import." }); ctx.render(); return; }
    void ctx.run(async () => {
      const out = await ctx.client.import(dirs);
      ctx.flows.importing = null;
      if (out.skipped.length) ctx.notify({ tone: "warning", title: "Some logins were skipped", body: out.skipped.map((s) => `${s.configDir}: ${s.reason}`).join("; ") });
    }, go);
  } });
  mountButton(row, { label: "Cancel", variant: "ghost", onClick: () => { ctx.flows.importing = null; ctx.render(); } });
  box.append(row);
  return box;
}

function accountCard(ctx: Ctx, a: AccountView, index: number, all: AccountView[], now: number): HTMLElement {
  const kind = a.enabled ? accountKind(a, now).kind : "off";
  const card = el("div", `acct ${kind}`);
  const f = ctx.flows;

  const top = el("div", "acct-top");
  const dot = el("span", `dot ${kind}`);
  dot.setAttribute("aria-hidden", "true");
  const who = el("div", "who");
  const line = el("div", "name-line");
  line.append(el("span", "name", a.label));
  // A signed-out account shows its fix instead of a badge that says the same thing.
  if (a.state?.needsLogin) {
    const b = mountButton(line, { label: "Sign in again", variant: "outline", size: "xs", onClick: () => void ctx.run(() => ctx.startLogin({ accountId: a.id }), b) });
  } else mountBadge(line, statusBadge(a, now));
  who.append(line, el("div", "muted meta", [a.email, a.plan && a.plan.toUpperCase()].filter(Boolean).join(" · ")));
  const ctrl = el("div", "acct-ctrl");
  mountSwitch(ctrl, { label: "In pool", checked: a.enabled, onChange: (v) => void ctx.run(async () => { await ctx.client.patch(a.id, { enabled: v }); }) });
  const move = (from: number, to: number) => {
    const ids = all.map((x) => x.id);
    [ids[from], ids[to]] = [ids[to], ids[from]];
    void ctx.run(async () => { await ctx.client.reorder(ids); });
  };
  mountMenu(ctrl, {
    label: "⋯", variant: "ghost", size: "xs",
    items: [
      { id: "rename", label: "Rename" },
      { id: "up", label: "Move up", disabled: index === 0 },
      { id: "down", label: "Move down", disabled: index === all.length - 1 },
      { separator: true },
      { id: "remove", label: "Remove", destructive: true },
    ],
    onSelect: (id) => {
      if (id === "rename") { f.renaming = { id: a.id, text: a.label }; f.removing = null; ctx.render(); }
      else if (id === "up") move(index, index - 1);
      else if (id === "down") move(index, index + 1);
      else if (id === "remove") { f.removing = { id: a.id, deleteLogin: false }; f.renaming = null; ctx.render(); }
    },
  });
  top.append(dot, who, ctrl);
  card.append(top);

  const usage = el("div", "usage");
  for (const [key, label] of [["five_hour", "5-hour"], ["seven_day", "Weekly"]] as const) {
    const pct = windowPercent(a.state, key, now);
    const reset = resetText(a.state?.windows[key]?.resetsAt ?? null, now);
    const cell = el("div", "win");
    const head = el("div", "win-head");
    const left = el("span", "win-label");
    left.append(el("span", "win-name", label), ...(reset ? [el("span", "muted small", reset)] : []));
    head.append(left, el("span", "pct", `${Math.round(pct)}%`));
    cell.append(head);
    mountProgress(cell, { value: pct, ...(pct >= 90 ? { tone: "error" as const } : pct >= 70 ? { tone: "warning" as const } : {}) });
    usage.append(cell);
  }
  card.append(usage);

  if (f.renaming?.id === a.id) { card.append(renameRow(ctx, a)); return card; }
  if (f.removing?.id === a.id) { card.append(removeRow(ctx, a)); return card; }
  return card;
}

function renameRow(ctx: Ctx, a: AccountView): HTMLElement {
  const box = el("div", "stack");
  const r = ctx.flows.renaming!;
  const field = mountTextField(box, { label: "New name", value: r.text, error: r.error, onChange: (v) => { r.text = v; r.error = undefined; field.update({ value: v, error: undefined }); } });
  const row = el("div", "row");
  const save = mountButton(row, { label: "Save", size: "sm", onClick: () => {
    const label = r.text.trim();
    if (!label) { r.error = "Enter a name."; field.update({ error: r.error }); return; }
    // A rejected name (duplicate, invalid) keeps the field open with the service's message.
    void ctx.run(async () => {
      try { await ctx.client.patch(a.id, { label }); ctx.flows.renaming = null; }
      catch (e) { r.error = (e as Error).message; }
    }, save, { keepNotices: true });
  } });
  mountButton(row, { label: "Cancel", variant: "ghost", size: "sm", onClick: () => { ctx.flows.renaming = null; ctx.render(); } });
  box.append(row);
  return box;
}

function removeRow(ctx: Ctx, a: AccountView): HTMLElement {
  const box = el("div", "stack");
  const r = ctx.flows.removing!;
  box.append(el("strong", "", `Remove ${a.label}?`));
  if (a.canDeleteLogin) {
    const cb = mountCheckbox(box, { label: "Also sign out and delete this account's folder", checked: r.deleteLogin, onChange: (c) => { r.deleteLogin = c; cb.update({ checked: c }); } });
  }
  const row = el("div", "row");
  const go = mountButton(row, { label: "Remove", variant: "destructive", size: "sm", onClick: () => {
    void ctx.run(async () => {
      const out = await ctx.client.remove(a.id, a.canDeleteLogin && r.deleteLogin);
      ctx.flows.removing = null;
      if (out.warning) ctx.notify({ tone: "info", title: "Removed, with a note", body: out.warning });
    }, go);
  } });
  mountButton(row, { label: "Cancel", variant: "ghost", size: "sm", onClick: () => { ctx.flows.removing = null; ctx.render(); } });
  box.append(row);
  return box;
}

function thresholdBox(ctx: Ctx, saved: number): HTMLElement {
  const box = el("section", "settings");
  box.append(el("h2", "section-title", "Switching"));
  const t = (ctx.flows.threshold ??= { text: String(saved) });
  const row = el("div", "threshold-row");
  const fieldWrap = el("div", "threshold-field");
  const field = mountTextField(fieldWrap, {
    label: "Switch accounts at (%)",
    value: t.text,
    error: t.error,
    onChange: (v) => { t.text = v; t.error = undefined; field.update({ value: v, error: undefined }); },
  });
  row.append(fieldWrap);
  const save = mountButton(row, { label: "Save", variant: "outline", onClick: () => {
    const v = validateThreshold(t.text);
    if (!v.ok) { t.error = v.error; field.update({ error: v.error }); return; }
    void ctx.run(async () => {
      try { await ctx.client.setThreshold(v.value); ctx.flows.threshold = null; }
      catch (e) { t.error = (e as Error).message; }
    }, save, { keepNotices: true });
  } });
  box.append(row, el("p", "muted small helper", "From 50 to 100. An account stops taking chats once its 5-hour or weekly usage passes this share; 100 uses it up to the real limit."));
  return box;
}
