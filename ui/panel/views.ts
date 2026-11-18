import { mountBadge, mountBanner, mountButton, mountCheckbox, mountEmpty, mountProgress, mountSwitch, mountTextField } from "@openchamber/sdk/ui";
import { resetText, statusBadge, validateThreshold, windowPercent, type AccountView } from "../shared/format.ts";
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
  for (const n of ctx.notices) mountBanner(page, n);
}

export function renderList(ctx: Ctx, page: HTMLElement): void {
  const data = ctx.data;
  if (!data) return;
  const now = Date.now();
  const f = ctx.flows;

  const head = el("div", "row");
  head.append(el("strong", "grow", "Claude accounts"));
  mountButton(head, { label: "Add account", disabled: f.adding !== null, onClick: () => { ctx.notices.length = 0; f.adding = { name: "" }; ctx.render(); } });
  const importBtn = mountButton(head, { label: "Import", variant: "outline", disabled: f.importing !== null, onClick: () => {
    void ctx.run(async () => {
      const { candidates } = await ctx.client.candidates();
      if (candidates.length === 0) ctx.notify({ tone: "info", title: "Nothing to import", body: "No other Claude Code logins were found in your home folder." });
      else f.importing = { candidates, selected: new Set() };
    }, importBtn);
  } });
  page.append(head);

  if (f.adding) page.append(addRow(ctx));
  if (f.importing) page.append(importPanel(ctx));

  if (data.accounts.length === 0 && !f.adding) {
    mountEmpty(page, { title: "No accounts yet", body: "Add a Claude account, or import the ones Claude Code is already signed in to." });
  }
  data.accounts.forEach((a, i) => page.append(accountCard(ctx, a, i, data.accounts, now)));
  page.append(thresholdBox(ctx, data.threshold));
}

function addRow(ctx: Ctx): HTMLElement {
  const box = el("div", "acct");
  const adding = ctx.flows.adding!;
  const field = mountTextField(box, { label: "Name for the new account (e.g. work, personal)", value: adding.name, error: adding.error, onChange: (v) => { adding.name = v; field.update({ value: v }); } });
  const row = el("div", "row");
  const start = mountButton(row, { label: "Start", onClick: () => {
    const label = adding.name.trim();
    if (!label) { field.update({ error: "Enter a name." }); return; }
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
      if (out.skipped.length) ctx.notify({ tone: "warning", title: "Some logins were skipped", body: out.skipped.map((s) => `${s.configDir}: ${s.reason}`).join("\n") });
    }, go);
  } });
  mountButton(row, { label: "Cancel", variant: "ghost", onClick: () => { ctx.flows.importing = null; ctx.render(); } });
  box.append(row);
  return box;
}

function accountCard(ctx: Ctx, a: AccountView, index: number, all: AccountView[], now: number): HTMLElement {
  const card = el("div", "acct");
  const top = el("div", "row");
  const name = el("div", "grow");
  name.append(el("strong", "", a.label), el("div", "muted", [a.email, a.plan && a.plan.toUpperCase()].filter(Boolean).join(" · ")));
  top.append(name);
  mountBadge(top, statusBadge(a, now));
  card.append(top);

  const bars = el("div", "bars");
  for (const [key, label] of [["five_hour", "5h"], ["seven_day", "7d"]] as const) {
    bars.append(el("span", "muted", label));
    const cell = el("div");
    const pct = windowPercent(a.state, key, now);
    mountProgress(cell, { value: pct, tone: pct >= 90 ? "error" : pct >= 70 ? "warning" : "primary" });
    bars.append(cell, el("span", "muted", `${Math.round(pct)}% ${resetText(a.state?.windows[key]?.resetsAt ?? null, now)}`.trim()));
  }
  card.append(bars);

  const f = ctx.flows;
  if (f.renaming?.id === a.id) { card.append(renameRow(ctx, a)); return card; }
  if (f.removing?.id === a.id) { card.append(removeRow(ctx, a)); return card; }

  const actions = el("div", "row");
  mountSwitch(actions, { label: "In pool", checked: a.enabled, onChange: (v) => void ctx.run(async () => { await ctx.client.patch(a.id, { enabled: v }); }) });
  if (a.state?.needsLogin) {
    const b = mountButton(actions, { label: "Sign in again", size: "sm", onClick: () => void ctx.run(() => ctx.startLogin({ accountId: a.id }), b) });
  }
  mountButton(actions, { label: "Rename", variant: "ghost", size: "sm", onClick: () => { f.renaming = { id: a.id, text: a.label }; f.removing = null; ctx.render(); } });
  const move = (from: number, to: number) => {
    const ids = all.map((x) => x.id);
    [ids[from], ids[to]] = [ids[to], ids[from]];
    void ctx.run(async () => { await ctx.client.reorder(ids); });
  };
  if (index > 0) mountButton(actions, { label: "↑", variant: "ghost", size: "xs", onClick: () => move(index, index - 1) });
  if (index < all.length - 1) mountButton(actions, { label: "↓", variant: "ghost", size: "xs", onClick: () => move(index, index + 1) });
  mountButton(actions, { label: "Remove", variant: "destructive", size: "sm", onClick: () => { f.removing = { id: a.id, deleteLogin: false }; f.renaming = null; ctx.render(); } });
  card.append(actions);
  return card;
}

function renameRow(ctx: Ctx, a: AccountView): HTMLElement {
  const box = el("div", "stack");
  const r = ctx.flows.renaming!;
  const field = mountTextField(box, { label: "New name", value: r.text, error: r.error, onChange: (v) => { r.text = v; field.update({ value: v }); } });
  const row = el("div", "row");
  const save = mountButton(row, { label: "Save", size: "sm", onClick: () => {
    const label = r.text.trim();
    if (!label) { field.update({ error: "Enter a name." }); return; }
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
  const box = el("div", "acct");
  const t = (ctx.flows.threshold ??= { text: String(saved) });
  const field = mountTextField(box, {
    label: "Switch accounts at (% of the 5h or weekly window)",
    value: t.text,
    error: t.error,
    helper: "50–100. The pool moves a conversation to another account once its account passes this.",
    onChange: (v) => { t.text = v; field.update({ value: v }); },
  });
  const save = mountButton(box, { label: "Save", variant: "secondary", size: "sm", onClick: () => {
    const v = validateThreshold(t.text);
    if (!v.ok) { field.update({ error: v.error }); return; }
    void ctx.run(async () => {
      try { await ctx.client.setThreshold(v.value); ctx.flows.threshold = null; }
      catch (e) { t.error = (e as Error).message; }
    }, save, { keepNotices: true });
  } });
  return box;
}
