import type { BannerTone, ButtonHandle } from "@openchamber/sdk/ui";
import type { Client, LoginView } from "../shared/api.ts";
import type { AccountView } from "../shared/format.ts";

export type Notice = { tone: BannerTone; title: string; body?: string; action?: { label: string; onClick: () => void } };
export type ListData = { accounts: AccountView[]; threshold: number; recoveredBackup: boolean; cliFound: boolean };
export type AwaitingCode = Extract<LoginView, { state: "awaiting-code" }>;

/** Which full-page screen is showing. The list is the default. */
export type Screen =
  | { kind: "list" }
  | { kind: "awaiting-code"; view: AwaitingCode; isNew: boolean; code: string; error?: string }
  | { kind: "verifying"; message?: string }
  | { kind: "failed"; message: string };

/** Inline flows on the list screen. Each is null while closed. */
export type Flows = {
  adding: { name: string; error?: string } | null;
  renaming: { id: string; text: string; error?: string } | null;
  removing: { id: string; deleteLogin: boolean } | null;
  importing: { candidates: string[]; selected: Set<string> } | null;
  threshold: { text: string; error?: string } | null;
};

export type Ctx = {
  host: { openUrl(url: string): Promise<unknown> };
  client: Client;
  data: ListData | null;
  screen: Screen;
  flows: Flows;
  notices: Notice[];
  /** Shows a banner. Gets a Dismiss action unless it brings its own. */
  notify(n: Notice): void;
  /** Runs one guarded request at a time. Errors become banners. Refreshes the list at the end unless `rerender` is false. */
  run(fn: () => Promise<void>, btn?: ButtonHandle, opts?: { keepNotices?: boolean }): Promise<void>;
  render(): void;
  refresh(): Promise<void>;
  /** Starts a sign-in (new account or sign in again) and moves to the screen its answer calls for. */
  startLogin(p: { label: string } | { accountId: string }): Promise<void>;
};
