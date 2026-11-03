import type * as acp from "@agentclientprotocol/sdk";
import type { Effect } from "effect";
import type { MessageKey } from "../i18n";
import type { AppServices } from "../runtime";
import type { Tab } from "./tabs";

/** What the parts of the chat view share: how they reach the webview and run effects. */
export interface ChatUi {
  /** Posts a message that belongs to one tab's conversation. */
  postTab(tab: Tab, message: Record<string, unknown>): void;
  /** Shows the tab sidebar and saves it. */
  postTabs(): void;
  status(tab: Tab, key: MessageKey, extra?: Record<string, unknown>): void;
  /** Re-posts the last status, e.g. after `busy` changed. */
  refreshStatus(tab: Tab): void;
  saveTabs(): void;
  /** Keeps the session's config options (null or absent: unchanged) for the status bar. */
  setConfigOptions(tab: Tab, options: ReadonlyArray<acp.SessionConfigOption> | null | undefined): void;
  /** Runs an effect from a callback, showing failures in the tab. */
  run<E>(effect: Effect.Effect<void, E, AppServices>, tab: Tab): void;
}
