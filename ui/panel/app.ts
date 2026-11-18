import { applyHostReady, mountButton, mountSpinner } from "@openchamber/sdk/ui";
import { api } from "../shared/api.ts";
import type { Ctx, Notice, PanelHost } from "./ctx.ts";
import { renderLoginScreen, resumeLogin, startLogin } from "./login-flow.ts";
import { el, renderBanners, renderList, renderNotices } from "./views.ts";

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Builds the panel inside `root`. Returns its state object (tests read it). */
export function createPanel(host: PanelHost, root: Element, opts: { sleep?: (ms: number) => Promise<void> } = {}): Ctx {
  let busy = false;
  let mounted = false;
  let directory: string | null | undefined;

  const ctx: Ctx = {
    host,
    client: api(host),
    data: null,
    loading: true,
    screen: { kind: "list" },
    flows: { adding: null, renaming: null, removing: null, importing: null, threshold: null },
    notices: [],
    sleep: opts.sleep ?? realSleep,
    notify(n) {
      if (ctx.notices.some((x) => x.tone === n.tone && x.title === n.title && x.body === n.body)) return;
      const notice: Notice = n.action ? n : { ...n, action: { label: "Dismiss", onClick: () => ctx.dismiss(notice) } };
      ctx.notices.push(notice);
    },
    dismiss(n) {
      ctx.notices = ctx.notices.filter((x) => x !== n);
      n.onDismiss?.();
      ctx.render();
    },
    async run(fn, btn, o) {
      if (busy) return;
      busy = true;
      btn?.update({ loading: true });
      if (!o?.keepNotices) ctx.notices.length = 0;
      try {
        await fn();
      } catch (e) {
        ctx.notify({ tone: "error", title: "That did not work", body: (e as Error).message });
      }
      busy = false;
      await ctx.refresh();
    },
    render() {
      const page = el("div", "page");
      if (ctx.screen.kind === "list") {
        renderBanners(ctx, page);
        if (ctx.data) renderList(ctx, page);
        else if (ctx.loading) mountSpinner(page, { label: "Loading…" });
        else {
          const retry = mountButton(page, { label: "Try again", onClick: () => void ctx.run(async () => {}, retry) });
        }
      } else {
        renderNotices(ctx, page);
        renderLoginScreen(ctx, page);
      }
      root.replaceChildren(page);
    },
    async refresh() {
      try {
        ctx.data = await ctx.client.list();
      } catch (e) {
        ctx.data = null;
        ctx.notify({ tone: "error", title: "The Claude Pool service did not answer", body: (e as Error).message });
      }
      ctx.loading = false;
      ctx.render();
    },
    startLogin: (p) => startLogin(ctx, p),
  };

  async function load(): Promise<void> {
    await ctx.refresh();
    if (!ctx.data) return;
    try {
      await resumeLogin(ctx);
    } catch (e) {
      ctx.notify({ tone: "error", title: "Could not check for a sign-in in progress", body: (e as Error).message });
      ctx.screen = { kind: "list" };
      await ctx.refresh();
    }
  }

  ctx.render();
  host.onReady((context) => {
    applyHostReady(context, document.documentElement);
    if (!mounted) {
      mounted = true;
      directory = context.directory;
      void load();
      return;
    }
    // Ready again: refresh only when the project changed, so this cannot loop.
    if (context.directory !== directory) {
      directory = context.directory;
      if (!busy && ctx.screen.kind === "list") void ctx.refresh();
    }
  });
  return ctx;
}
