import type * as acp from "@agentclientprotocol/sdk";
import { t } from "./i18n";

/** The config option standing for an agent's modes; the agent never sees this id. */
export const MODE_OPTION = "_kd-code/mode";

type Options = ReadonlyArray<acp.SessionConfigOption> | null | undefined;

const modeOption = (modes: acp.SessionModeState): acp.SessionConfigOption => ({
  type: "select",
  id: MODE_OPTION,
  name: t("chat.mode"),
  category: "mode",
  currentValue: modes.currentModeId,
  options: modes.availableModes.map((mode) => ({ value: mode.id, name: mode.name, description: mode.description })),
});

/**
 * The modes of the sessions of an agent that offers modes but no config options, shown to the rest of the extension as
 * one config option. ACP has clients prefer config options, so an agent's modes are ignored when it offers both.
 */
export class SessionModes {
  private readonly bySession = new Map<string, acp.SessionModeState>();

  /** `session` with its modes as a config option, when it only has modes. */
  adopt<S extends { readonly configOptions?: Options; readonly modes?: acp.SessionModeState | null }>(
    sessionId: string,
    session: S,
  ): S {
    if (session.configOptions?.length || !session.modes?.availableModes.length) {
      this.bySession.delete(sessionId);
      return session;
    }
    this.bySession.set(sessionId, session.modes);
    return { ...session, configOptions: [modeOption(session.modes)] };
  }

  /** The options of a session once its mode is `modeId`. */
  select(sessionId: string, modeId: string): Array<acp.SessionConfigOption> {
    const modes = this.bySession.get(sessionId);
    if (!modes) {
      return [];
    }
    const next = { ...modes, currentModeId: modeId };
    this.bySession.set(sessionId, next);
    return [modeOption(next)];
  }

  /** A mode the agent switched to, told as the change of the config option standing for its modes. */
  translate(notification: acp.SessionNotification): acp.SessionNotification {
    const { sessionId, update } = notification;
    if (update.sessionUpdate !== "current_mode_update" || !this.bySession.has(sessionId)) {
      return notification;
    }
    return {
      ...notification,
      update: { sessionUpdate: "config_option_update", configOptions: this.select(sessionId, update.currentModeId) },
    };
  }

  forget(sessionId: string): void {
    this.bySession.delete(sessionId);
  }
}
