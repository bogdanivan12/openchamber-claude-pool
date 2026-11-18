import { mountBanner, mountButton, mountSpinner, mountTextField } from "@openchamber/sdk/ui";
import type { LoginView } from "../shared/api.ts";
import type { Ctx } from "./ctx.ts";
import { el } from "./views.ts";

export const VERIFY_POLL_MS = 1000;
export const VERIFY_MAX_POLLS = 60;

/** Puts the service's login back to idle. A finished result stays there until this runs. Errors are ignored. */
const resetLogin = (ctx: Ctx) => ctx.client.loginCancel().then(() => undefined, () => undefined);

/** Opens the sign-in page. If the host refuses, the address is shown so the user can copy it. */
async function openSignInPage(ctx: Ctx, url: string): Promise<void> {
  try {
    await ctx.host.openUrl(url);
  } catch (e) {
    ctx.notify({ tone: "error", title: "Could not open the sign-in page", body: `${(e as Error).message} Open this address yourself: ${url}` });
  }
}

/** Moves the panel to the screen a login view calls for. `fresh` opens the sign-in page; a resumed view only offers the link. */
export async function applyLoginView(ctx: Ctx, view: LoginView, fresh: boolean): Promise<void> {
  switch (view.state) {
    case "idle":
      ctx.screen = { kind: "list" };
      return;
    case "awaiting-code": {
      const isNew = !ctx.data?.accounts.some((a) => a.id === view.accountId);
      ctx.screen = { kind: "awaiting-code", view, isNew, code: "" };
      if (fresh) await openSignInPage(ctx, view.url);
      return;
    }
    case "verifying":
      ctx.screen = { kind: "verifying" };
      ctx.render();
      await pollVerifying(ctx);
      return;
    case "succeeded": {
      ctx.screen = { kind: "list" };
      const acct = view.account;
      const onDismiss = () => void resetLogin(ctx);
      if (view.duplicateOf) {
        const other = ctx.data?.accounts.find((a) => a.id === view.duplicateOf)?.label;
        ctx.notify({
          tone: "warning",
          title: "This Claude account is already in the pool under another name",
          body: `${other ? `It is already there as "${other}". ` : ""}Both entries use the same subscription, so the pool gains nothing from the second one.`,
          action: { label: "Remove the duplicate", onClick: () => void ctx.run(async () => { await ctx.client.remove(acct.id, false); await resetLogin(ctx); }) },
          onDismiss,
        });
      }
      if (view.emailChanged) {
        ctx.notify({ tone: "warning", title: `Signed in as ${view.emailChanged.to} (was ${view.emailChanged.from})`, body: "This account's usage and name now refer to a different Claude account.", onDismiss });
      }
      if (view.warning) ctx.notify({ tone: "info", title: "Signed in, with a note", body: view.warning, onDismiss });
      // Nothing to show later: the result is surfaced, so the service can forget it unless a banner above still waits on the user.
      if (!view.duplicateOf && !view.emailChanged && !view.warning) await resetLogin(ctx);
      return;
    }
    case "failed":
      ctx.screen = { kind: "failed", message: view.message };
      return;
  }
}

/** Polls once per second until the verification ends, for at most VERIFY_MAX_POLLS seconds. Only runs while verifying. */
async function pollVerifying(ctx: Ctx): Promise<void> {
  for (let i = 0; i < VERIFY_MAX_POLLS; i++) {
    await ctx.sleep(VERIFY_POLL_MS);
    let view: LoginView;
    try { view = await ctx.client.login(); }
    catch (e) { ctx.screen = { kind: "list" }; throw e; }
    if (view.state !== "verifying") { await applyLoginView(ctx, view, false); return; }
  }
  ctx.screen = { kind: "list" };
  ctx.notify({ tone: "warning", title: "The sign-in is taking too long", body: "Checking it timed out after 60 seconds. Look at the account list; if it is missing, add it again." });
}

export async function startLogin(ctx: Ctx, p: { label: string } | { accountId: string }): Promise<void> {
  ctx.screen = { kind: "verifying", message: "Starting the sign-in…" };
  ctx.render();
  try {
    await applyLoginView(ctx, await ctx.client.loginStart(p), true);
  } catch (e) {
    ctx.screen = { kind: "list" };
    throw e;
  }
}

/**
 * On load: resume a login that is still in progress (panel reloaded, service restarted).
 * Only awaiting-code and verifying are acted on. A finished result (succeeded/failed) is old news: reset it silently.
 * Ends with a fresh list when the list is the screen.
 */
export async function resumeLogin(ctx: Ctx): Promise<void> {
  const view = await ctx.client.login();
  if (view.state === "awaiting-code" || view.state === "verifying") await applyLoginView(ctx, view, false);
  else if (view.state !== "idle") await resetLogin(ctx);
  if (ctx.screen.kind === "list") await ctx.refresh();
  else ctx.render();
}

export function renderLoginScreen(ctx: Ctx, page: HTMLElement): void {
  const s = ctx.screen;
  if (s.kind === "verifying") {
    const box = el("div", "acct");
    mountSpinner(box, { label: s.message ?? "Checking the code with Claude…" });
    page.append(box);
    return;
  }
  if (s.kind === "failed") {
    mountBanner(page, { tone: "error", title: "Sign-in failed", body: s.message, action: { label: "Back", onClick: () => { ctx.screen = { kind: "list" }; void resetLogin(ctx); void ctx.refresh(); } } });
    return;
  }
  if (s.kind !== "awaiting-code") return;

  const box = el("div", "acct");
  box.append(el("strong", "", s.isNew ? `Sign in "${s.view.label}"` : `Sign in again as "${s.view.label}"`));
  box.append(el("div", "", "Sign in on the Claude page that opened, then paste the code it shows."));
  if (s.isNew) box.append(el("div", "muted", "A wrong code starts the sign-in over."));
  const link = el("div", "row");
  mountButton(link, { label: "Open the sign-in page", variant: "ghost", size: "sm", onClick: () => void openSignInPage(ctx, s.view.url).then(() => ctx.render()) });
  box.append(link);
  const field = mountTextField(box, { label: "Code", value: s.code, mono: true, error: s.error, onChange: (v) => { s.code = v; s.error = undefined; field.update({ value: v, error: undefined }); } });
  const row = el("div", "row");
  const submit = mountButton(row, { label: "Finish sign-in", onClick: () => {
    const code = s.code.trim();
    if (!code) { s.error = "Paste the code first."; field.update({ error: s.error }); return; }
    void ctx.run(async () => {
      try {
        await applyLoginView(ctx, await ctx.client.loginCode(code), false);
      } catch (e) {
        // The login is probably gone (service restarted). Go back to a working list.
        ctx.screen = { kind: "list" };
        throw e;
      }
    }, submit);
  } });
  const cancel = mountButton(row, { label: "Cancel", variant: "ghost", onClick: () => {
    void ctx.run(async () => { ctx.screen = { kind: "list" }; await ctx.client.loginCancel(); }, cancel);
  } });
  box.append(row);
  page.append(box);
}
