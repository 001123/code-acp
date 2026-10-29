import type { FromWebview as ChatMessage } from "../../chat/protocol";
import type { FileRef } from "../markdown";
import { poster } from "../vscode";

export const post = poster<ChatMessage>();
export const openFile = (ref: FileRef) => post({ type: "openFile", ...ref });
