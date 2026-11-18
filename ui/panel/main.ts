import { connectHost } from "@openchamber/sdk";
import { applyHostReady, mountBanner, mountButton } from "@openchamber/sdk/ui";
import { api } from "../shared/api.ts";
import type { Ctx } from "./ctx.ts";
import { renderLoginScreen, resumeLogin, startLogin } from "./login-flow.ts";
import { el, renderBanners, renderList } from "./views.ts";

const host = connectHost();
const root = document.querySelector("#root")!;
let busy = false;
let mounted = false;

const ctx: Ctx = {
  host,
  client: api(host),
  data: null,
  screen: { kind: "list" },
  flows: { adding: null, renaming: null, removing: null, importing: null, threshold: null },
  notices: [],
  notify(n) {
    const notice = n.action ? n : { ...n, action: { label: "Dismiss", onClick: () => { this.notices = this.notices.filter((x) => x !== notice); this.render(); } } };
    this.notices.push(notice);
  },
  async run(fn, btn, opts) {
    if (busy) return;
    busy = true;
    btn?.update({ loading: true });
    if (!opts?.keepNotices) this.notices.length = 0;
    try {
      await fn();
    } catch (e) {
      this.notify({ tone: "error", title: "That did not work", body: (e as Error).message });
    }
    busy = false;
    await this.refresh();
  },
  render() {
    const page = el("div", "page");
    if (this.screen.kind === "list") {
      renderBanners(this, page);
      if (this.data) renderList(this, page);
      else mountButton(page, { label: "Try again", onClick: () => void this.refresh() });
    } else {
      for (const n of this.notices) mountBanner(page, n);
      renderLoginScreen(this, page);
    }
    root.replaceChildren(page);
  },
  async refresh() {
    try {
      this.data = await this.client.list();
    } catch (e) {
      this.data = null;
      this.notify({ tone: "error", title: "The Claude Pool service did not answer", body: (e as Error).message });
    }
    this.render();
  },
  startLogin(p) { return startLogin(this, p); },
};

async function load(): Promise<void> {
  await ctx.refresh();
  if (!ctx.data) return;
  try {
    await resumeLogin(ctx);
  } catch (e) {
    ctx.notify({ tone: "error", title: "Could not check for a sign-in in progress", body: (e as Error).message });
  }
  ctx.render();
}

host.onReady((context) => {
  applyHostReady(context, document.documentElement);
  if (mounted) return;
  mounted = true;
  void load();
});
