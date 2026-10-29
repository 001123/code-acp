import type * as vscode from "vscode";
import { Layer } from "effect";
import { ExtensionCtx, Output } from "../src/runtime";

export interface OutputStub extends vscode.OutputChannel {
  readonly lines: Array<string>;
}

export const makeOutput = (): OutputStub => {
  const lines: Array<string> = [];
  return {
    lines,
    name: "test",
    append: (v: string) => void lines.push(v),
    appendLine: (v: string) => void lines.push(v),
    replace: () => {},
    clear: () => {},
    show: () => {},
    hide: () => {},
    dispose: () => {},
  } as OutputStub;
};

export const makeExtensionCtx = (globalStorage = "/tmp/code-acp-test-storage", packageJSON: unknown = { version: "1.2.3" }) =>
  ({
    extension: { packageJSON },
    globalStorageUri: { fsPath: globalStorage },
  }) as unknown as vscode.ExtensionContext;

export const stubLayer = (output: OutputStub, ctx = makeExtensionCtx()) =>
  Layer.mergeAll(Layer.succeed(Output, output), Layer.succeed(ExtensionCtx, ctx));
