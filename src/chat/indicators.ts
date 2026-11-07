import { Effect } from "effect";
import * as vscode from "vscode";
import type { AgentManager } from "../agentManager";
import { t } from "../i18n";
import type { AppServices } from "../runtime";
import { choicesOf, modelOption, thoughtOption } from "../sessionOptions";
import { readSettings } from "../settings";
import { UsageLedger } from "../usageLedger";
import { UsageStatusBar } from "../usageStatusBar";
import { shouldNotify, type Attention, type AttentionReason } from "./attention";
import type { TabBackgroundTasks } from "./backgroundTasks";
import type { Permissions } from "./permissions";
import { ChatStatusBar } from "./statusBar";
import type { Tab, TabList } from "./tabs";
import type { TabUsage } from "./usage";

/** Catches what the ledger doesn't announce: other windows' records and a new day. */
const USAGE_REFRESH_MS = 60 * 1000;

/** What the indicators need from the chat view. */
export interface IndicatorsHost {
  readonly manager: AgentManager["Service"];
  readonly tabs: TabList;
  readonly permissions: Permissions<Tab>;
  readonly attention: Attention<Tab>;
  readonly usage: TabUsage;
  readonly backgroundTasks: TabBackgroundTasks;
  /** Run by the status bar item. */
  readonly showAttentionCommand: string;
  /** Run by the usage status bar item. */
  readonly showUsageCommand: string;
  view(): vscode.WebviewView | undefined;
  agentIdOf(tab: Tab): Effect.Effect<string | undefined>;
  /** Shows the chat with `tab` active. */
  reveal(tab: Tab): void;
  /** Runs an effect from a callback, showing failures in the active tab. */
  run(effect: Effect.Effect<void, never, AppServices>): void;
}

/** Where the chat shows what its tabs are doing outside the chat view: the status bar, the view's title and badge, and notifications. */
export class ChatIndicators implements vscode.Disposable {
  private readonly statusBar: ChatStatusBar;
  /** A status bar update is due; several changes in one tick share it. */
  private statusBarDue = false;
  /** Counts status bar updates, so one that took longer doesn't overwrite a newer one. */
  private statusBarRun = 0;
  private readonly usageStatusBar: UsageStatusBar;
  /** Counts usage updates, for the same reason. */
  private usageRun = 0;
  private readonly usageTimer: ReturnType<typeof setInterval>;
  private ledgerChanges: vscode.Disposable | undefined;

  constructor(private readonly host: IndicatorsHost) {
    this.statusBar = new ChatStatusBar(host.showAttentionCommand);
    this.usageStatusBar = new UsageStatusBar(host.showUsageCommand);
    this.usageTimer = setInterval(() => this.update(), USAGE_REFRESH_MS);
    host.run(
      UsageLedger.use((ledger) =>
        Effect.sync(() => {
          this.ledgerChanges = ledger.onDidChange(() => this.update());
        }),
      ),
    );
  }

  /** Shows the active tab's agent in the view title, its agent and model in the status bar, and what the tabs are doing. */
  update(): void {
    if (this.statusBarDue) {
      return;
    }
    this.statusBarDue = true;
    queueMicrotask(() => {
      this.statusBarDue = false;
      this.host.run(this.showStatusBar);
      this.host.run(this.showUsage);
    });
  }

  private get showStatusBar(): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      const { tabs, manager, permissions, attention } = this.host;
      const run = ++this.statusBarRun;
      const tab = tabs.active;
      const agentId = tab.running?.agentId ?? (yield* this.host.agentIdOf(tab));
      const agent = agentId === undefined ? undefined : (yield* manager.agents).find((a) => a.id === agentId)?.name;
      if (run !== this.statusBarRun) {
        return;
      }
      const view = this.host.view();
      if (view) {
        view.description = agent;
      }
      const model = modelOption(tab.configOptions);
      const thought = thoughtOption(tab.configOptions);
      this.statusBar.show({
        agent,
        model: model && choicesOf(model).find((c) => c.value === model.currentValue)?.name,
        effort: thought && choicesOf(thought).find((c) => c.value === thought.currentValue)?.name,
        waiting: permissions.owners.length,
        finished: attention.owners("finished").length,
        running: tabs.all.filter((t) => t.busy).length,
        background: tabs.all.reduce((n, t) => n + this.host.backgroundTasks.of(t).length, 0),
      });
    });
  }

  /** Shows what the active tab's session used; read apart from the status above, which shouldn't wait for the ledger. */
  private get showUsage(): Effect.Effect<void, never, AppServices> {
    return Effect.gen({ self: this }, function* () {
      const run = ++this.usageRun;
      const totals = yield* this.host.usage.totals(this.host.tabs.active);
      const today = yield* (yield* UsageLedger).today;
      if (run === this.usageRun) {
        this.usageStatusBar.show(totals, today);
      }
    });
  }

  showBadge(): void {
    this.update();
    const view = this.host.view();
    if (view) {
      const count = this.host.attention.count;
      view.badge = count ? { value: count, tooltip: t("attention.badge", count) } : undefined;
    }
  }

  /** Announces a tab that wants the user (codeAcp.notifications, codeAcp.notifyFinished); "Show" brings it up. */
  notify(tab: Tab, reason: AttentionReason): void {
    if (!shouldNotify(reason, readSettings())) {
      return;
    }
    const title = tab.name ?? tab.title ?? t("chat.untitled");
    const show = t("attention.show");
    const message = t(`attention.${reason}`, title);
    void vscode.window.showInformationMessage(message, show).then((picked) => {
      if (picked === show) {
        this.host.reveal(tab);
      }
    });
  }

  dispose(): void {
    clearInterval(this.usageTimer);
    this.ledgerChanges?.dispose();
    this.statusBar.dispose();
    this.usageStatusBar.dispose();
  }
}
