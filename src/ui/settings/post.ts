import type { SettingKey } from "../../settings";
import type { FromWebview as SettingsMessage } from "../../settingsPanel";
import { poster } from "../vscode";

export const post = poster<SettingsMessage>();

export function set(key: SettingKey, value: unknown): void {
  post({ type: "set", key, value });
}
