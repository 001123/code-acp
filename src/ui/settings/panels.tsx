import { useState, type ReactNode } from "react";
import type { ApprovalRules, SessionDefaults, SettingKey } from "../../settings";
import { Icon } from "../icon";
import { useL10n, type MessageKey } from "../l10n";
import type { DoctorState } from "../../doctor";
import { AgentModelFields, SessionOptionFields } from "./agentModel";
import { DoctorTab } from "./doctor";
import { Field, Overridden, Segmented, Text, Toggle } from "./fields";
import { parseHosts } from "./hosts";
import { formatPairs, parsePairs } from "./pairs";
import { post, set } from "./post";
import { stringOf, type LoadedOptions, type State } from "./state";
import warningIcon from "@tabler/icons/outline/alert-triangle.svg";

const isOverridden = (state: State) => (key: SettingKey) => state.overridden.includes(key);
const isLocked = (state: State) => (key: SettingKey) => state.locked.includes(key);

export function LanguageTab({ state }: { state: State }) {
  const { t } = useL10n();
  const overridden = isOverridden(state);
  return (
    <section className="card">
      <div className="field">
        <select
          id="language"
          aria-label={t("settings.language")}
          value={stringOf(state, "language", "auto")}
          onChange={(e) => set("language", e.target.value)}
        >
          <option value="auto">{t("settings.languageAuto")}</option>
          <option value="en">{t("settings.languageEn")}</option>
          <option value="vi">{t("settings.languageVi")}</option>
        </select>
        {overridden("language") && <Overridden />}
      </div>
    </section>
  );
}

export function GeneralTab({ state }: { state: State }) {
  const v = state.values;
  const overridden = isOverridden(state);
  return (
    <section className="card">
      <Field
        id="followAgent"
        label="settings.followAgent"
        desc="settings.followAgentDesc"
        overridden={overridden("followAgent")}
        inline
      >
        <Toggle id="followAgent" checked={v.followAgent === true} onChange={(checked) => set("followAgent", checked)} />
      </Field>
      <Field
        id="autoScroll"
        label="settings.autoScroll"
        desc="settings.autoScrollDesc"
        overridden={overridden("autoScroll")}
        inline
      >
        <Toggle id="autoScroll" checked={v.autoScroll !== false} onChange={(checked) => set("autoScroll", checked)} />
      </Field>
      <Field
        id="showChanges"
        label="settings.showChanges"
        desc="settings.showChangesDesc"
        overridden={overridden("showChanges")}
        inline
      >
        <Toggle
          id="showChanges"
          checked={v.showChanges !== false}
          onChange={(checked) => set("showChanges", checked)}
        />
      </Field>
      <Field
        id="showRestore"
        label="settings.showRestore"
        desc="settings.showRestoreDesc"
        overridden={overridden("showRestore")}
        inline
      >
        <Toggle id="showRestore" checked={v.showRestore === true} onChange={(checked) => set("showRestore", checked)} />
      </Field>
      <Field
        id="rememberSessionOptions"
        label="settings.rememberSessionOptions"
        desc="settings.rememberSessionOptionsDesc"
        overridden={overridden("rememberSessionOptions")}
        inline
      >
        <Toggle
          id="rememberSessionOptions"
          checked={v.rememberSessionOptions !== false}
          onChange={(checked) => set("rememberSessionOptions", checked)}
        />
      </Field>
    </section>
  );
}

export function NotificationsTab({ state }: { state: State }) {
  const v = state.values;
  const overridden = isOverridden(state);
  return (
    <section className="card">
      <Field
        id="notifications"
        label="settings.notifications"
        desc="settings.notificationsDesc"
        overridden={overridden("notifications")}
        inline
      >
        <Toggle
          id="notifications"
          checked={v.notifications !== false}
          onChange={(checked) => set("notifications", checked)}
        />
      </Field>
      <Field
        id="notifyFinished"
        label="settings.notifyFinished"
        desc="settings.notifyFinishedDesc"
        overridden={overridden("notifyFinished")}
        inline
      >
        <Toggle
          id="notifyFinished"
          checked={v.notifyFinished !== false}
          disabled={v.notifications === false}
          onChange={(checked) => set("notifyFinished", checked)}
        />
      </Field>
    </section>
  );
}

const APPROVAL_RULES: ReadonlyArray<{ key: keyof ApprovalRules; label: MessageKey; desc: MessageKey }> = [
  { key: "read", label: "settings.autoApproveRead", desc: "settings.autoApproveReadDesc" },
  { key: "edit", label: "settings.autoApproveEdit", desc: "settings.autoApproveEditDesc" },
  { key: "execute", label: "settings.autoApproveExecute", desc: "settings.autoApproveExecuteDesc" },
  { key: "fetch", label: "settings.autoApproveFetch", desc: "settings.autoApproveFetchDesc" },
  { key: "worktreeTabs", label: "settings.autoApproveWorktreeTabs", desc: "settings.autoApproveWorktreeTabsDesc" },
];

/** Follows the user's rule; only a workspace can say so. */
const INHERIT = "inherit";

export function PermissionsTab({ state }: { state: State }) {
  const { t } = useL10n();
  const user = (state.values.autoApprove ?? {}) as ApprovalRules;
  const workspace = state.workspaceAutoApprove;
  const inWorkspace = state.scope === "workspace";
  const rules = { ...user, ...workspace };
  const pick = (key: keyof ApprovalRules, value: string) => {
    const { [key]: _, ...others } = inWorkspace ? workspace : user;
    const removed = value === (inWorkspace ? INHERIT : "ask");
    const next = removed ? others : { ...others, [key]: value };
    if (inWorkspace) {
      post({ type: "workspaceAutoApprove", rules: next });
    } else {
      set("autoApprove", next);
    }
  };
  const options = [
    ...(inWorkspace ? [{ value: INHERIT, label: t("settings.autoApproveInherit") }] : []),
    { value: "ask", label: t("settings.autoApproveAsk") },
    { value: "allow", label: t("settings.autoApproveAllow") },
  ];
  return (
    <section className="card">
      {inWorkspace && <div className="note muted">{t("settings.autoApproveWorkspaceNote")}</div>}
      {APPROVAL_RULES.map(({ key, label, desc }) => (
        <Field
          key={key}
          id={`autoApprove-${key}`}
          label={label}
          desc={desc}
          overridden={!inWorkspace && workspace[key] !== undefined}
        >
          <Segmented
            id={`autoApprove-${key}`}
            value={(inWorkspace ? workspace[key] : user[key]) ?? (inWorkspace ? INHERIT : "ask")}
            options={options}
            onChange={(value) => pick(key, value)}
          />
        </Field>
      ))}
      {((rules.read === "allow" && rules.fetch === "allow") || rules.worktreeTabs === "allow") && (
        <div className="note warning">
          <Icon svg={warningIcon} />
          {t("settings.autoApproveLeakWarning")}
        </div>
      )}
    </section>
  );
}

function WorktreeCard({ state }: { state: State }) {
  const v = state.values;
  const overridden = isOverridden(state);
  return (
    <section className="card">
      <Field
        id="worktreeForNewTabs"
        label="settings.worktreeForNewTabs"
        desc="settings.worktreeForNewTabsDesc"
        overridden={overridden("worktreeForNewTabs")}
        inline
      >
        <Toggle
          id="worktreeForNewTabs"
          checked={v.worktreeForNewTabs === true}
          onChange={(checked) => set("worktreeForNewTabs", checked)}
        />
      </Field>
      <Field
        id="worktreeCopyFiles"
        label="settings.worktreeCopyFiles"
        desc="settings.worktreeCopyFilesDesc"
        overridden={overridden("worktreeCopyFiles")}
      >
        <Text
          id="worktreeCopyFiles"
          rows={4}
          placeholder={".env\nnode_modules"}
          value={((v.worktreeCopyFiles as ReadonlyArray<string> | undefined) ?? []).join("\n")}
          onCommit={(text) =>
            set(
              "worktreeCopyFiles",
              text
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter(Boolean),
            )
          }
        />
      </Field>
      {state.scope === "workspace" ? (
        <Field
          key="project"
          id="worktreeProjectSetupCommand"
          label="settings.worktreeProjectSetupCommand"
          desc="settings.worktreeProjectSetupCommandDesc"
        >
          <Text
            id="worktreeProjectSetupCommand"
            placeholder="npm install"
            value={stringOf(state, "worktreeProjectSetupCommand")}
            onCommit={(text) => set("worktreeProjectSetupCommand", text.trim())}
          />
        </Field>
      ) : (
        <Field
          key="user"
          id="worktreeSetupCommand"
          label="settings.worktreeSetupCommand"
          desc="settings.worktreeSetupCommandDesc"
          overridden={overridden("worktreeSetupCommand")}
        >
          <Text
            id="worktreeSetupCommand"
            placeholder="npm install"
            value={stringOf(state, "worktreeSetupCommand")}
            onCommit={(text) => set("worktreeSetupCommand", text.trim())}
          />
        </Field>
      )}
    </section>
  );
}

function TracingSection({ state }: { state: State }) {
  const { t } = useL10n();
  return (
    <>
      <section className="card">
        <Field
          id="tracing"
          label="settings.tracingEnabled"
          desc="settings.tracingDesc"
          overridden={isOverridden(state)("tracing")}
          inline
        >
          <Toggle
            id="tracing"
            checked={state.values.tracing === true}
            onChange={(checked) => set("tracing", checked)}
          />
        </Field>
      </section>
      <div className="note warning">
        <Icon svg={warningIcon} />
        {t("settings.tracingPrivacy")}
      </div>
    </>
  );
}

/** The hosts links from agents may reach over plain http, on the Permissions tab. */
export function AllowedHostsCard({ state }: { state: State }) {
  const { t } = useL10n();
  const [error, setError] = useState<string>();
  const hosts = state.values.allowedHttpHosts as ReadonlyArray<string> | undefined;
  return (
    <section className="card">
      <Field
        id="allowedHttpHosts"
        label="settings.allowedHttpHosts"
        desc="settings.allowedHttpHostsDesc"
        overridden={isOverridden(state)("allowedHttpHosts")}
        locked={isLocked(state)("allowedHttpHosts")}
        error={error}
      >
        <Text
          id="allowedHttpHosts"
          rows={4}
          placeholder="gitlab.internal"
          value={(hosts ?? []).join("\n")}
          onReset={() => setError(undefined)}
          onCommit={(text) => {
            const parsed = parseHosts(text);
            if (typeof parsed === "number") {
              setError(t("settings.allowedHttpHostsInvalid", parsed));
              return;
            }
            setError(undefined);
            set("allowedHttpHosts", parsed);
          }}
        />
      </Field>
    </section>
  );
}

function CommitCard(props: { state: State; loaded: LoadedOptions; load: (agentId: string, model: string) => void }) {
  const { state, loaded, load } = props;
  const overridden = isOverridden(state);
  return (
    <section className="card">
      <AgentModelFields
        id="commit"
        agentKey="commitMessage.agent"
        modelKey="commitMessage.model"
        effortKey="commitMessage.effort"
        fastModeKey="commitMessage.fastMode"
        effortDefault="lowest"
        agentDesc="settings.commitAgentDesc"
        effortDesc="settings.commitEffortDesc"
        state={state}
        loaded={loaded}
        load={load}
      />
      <Field
        id="commit-instructions"
        label="settings.commitInstructions"
        desc="settings.commitInstructionsDesc"
        overridden={overridden("commitMessage.instructions")}
      >
        <Text
          id="commit-instructions"
          rows={5}
          value={stringOf(state, "commitMessage.instructions")}
          onCommit={(s) => set("commitMessage.instructions", s.trim())}
        />
      </Field>
    </section>
  );
}

/** A heading inside a tab's panel, with what its card below is about. */
function PanelSection(props: { title: MessageKey; desc: MessageKey; children: ReactNode }) {
  const { t } = useL10n();
  return (
    <div className="panel-section">
      <h3>{t(props.title)}</h3>
      <div className="desc">{t(props.desc)}</div>
      {props.children}
    </div>
  );
}

export function GitTab(props: { state: State; loaded: LoadedOptions; load: (agentId: string, model: string) => void }) {
  return (
    <>
      <PanelSection title="settings.worktree" desc="settings.worktreeDesc">
        <WorktreeCard state={props.state} />
      </PanelSection>
      <PanelSection title="settings.commit" desc="settings.commitDesc">
        <CommitCard {...props} />
      </PanelSection>
    </>
  );
}

export function DebugTab(props: { state: State; doctor: DoctorState }) {
  return (
    <>
      <PanelSection title="settings.doctor" desc="settings.doctorDesc">
        <DoctorTab doctor={props.doctor} />
      </PanelSection>
      <PanelSection title="settings.tracing" desc="settings.tracingTabDesc">
        <TracingSection state={props.state} />
      </PanelSection>
    </>
  );
}
