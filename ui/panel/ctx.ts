import type { HostReadyContext } from "@openchamber/sdk";
import type { BannerTone, ButtonHandle } from "@openchamber/sdk/ui";
import type { Client, Host, LoginView } from "../shared/api.ts";
import type { AccountView } from "../shared/format.ts";

/** The part of the SDK host the panel uses. */
export type PanelHost = Host & {
  openUrl(url: string): Promise<unknown>;
  onReady(listener: (context: HostReadyContext) => void): unknown;
};

export type Notice = {
  tone: BannerTone;
  title: string;
  body?: string;
  action?: { label: string; onClick: () => void };
  /** Runs when the user dismisses the banner. */
  onDismiss?: () => void;
};
export type ListData = { accounts: AccountView[]; recoveredBackup: boolean; cliFound: boolean };
export type AwaitingCode = Extract<LoginView, { state: "awaiting-code" }>;

/** Which full-page screen is showing. The list is the default. */
export type Screen =
  | { kind: "list" }
  | { kind: "help" }
  | { kind: "awaiting-code"; view: AwaitingCode; isNew: boolean; code: string; error?: string }
  | { kind: "verifying"; message?: string }
  | { kind: "failed"; message: string };

/** Inline flows on the list screen. Each is null while closed. */
export type Flows = {
  adding: { name: string; error?: string } | null;
  renaming: { id: string; text: string; error?: string } | null;
  removing: { id: string; deleteLogin: boolean } | null;
  importing: { candidates: string[]; selected: Set<string> } | null;
};

export type Ctx = {
  host: PanelHost;
  client: Client;
  data: ListData | null;
  /** True until the first list answer (or failure) arrives. */
  loading: boolean;
  screen: Screen;
  flows: Flows;
  notices: Notice[];
  /** Waits; injectable so tests do not wait a real second. */
  sleep(ms: number): Promise<void>;
  /** Shows a banner unless an identical one is showing. Without an action it gets a Dismiss. */
  notify(n: Notice): void;
  dismiss(n: Notice): void;
  /** Runs one guarded request at a time. Errors become banners. Refreshes the list at the end. */
  run(fn: () => Promise<void>, btn?: ButtonHandle, opts?: { keepNotices?: boolean }): Promise<void>;
  render(): void;
  refresh(): Promise<void>;
  /** Starts a sign-in (new account or sign in again) and moves to the screen its answer calls for. */
  startLogin(p: { label: string } | { accountId: string }): Promise<void>;
};
