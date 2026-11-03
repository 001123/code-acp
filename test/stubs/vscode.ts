/** Minimal stand-in for the `vscode` module, covering only what the tested modules touch. */
import * as fs from "node:fs/promises";
import * as path from "node:path";

const settings = new Map<string, unknown>();
const workspaceSettings = new Map<string, unknown>();
/** By folder path, then full key. */
const folderSettings = new Map<string, Map<string, unknown>>();
const listeners = new Set<(e: { affectsConfiguration(section: string): boolean }) => void>();
const closeListeners = new Set<(terminal: unknown) => void>();

/** Test hooks; not part of the real vscode API. */
export const __test = {
  /** Sets `codeAcp.<key>` (or any full key like `codeAcp.language`). */
  setSetting(key: string, value: unknown) {
    settings.set(key, value);
    for (const listener of listeners) {
      listener({ affectsConfiguration: (section) => key === section || key.startsWith(`${section}.`) });
    }
  },
  /** Sets a full key like `codeAcp.language` in the workspace's settings; undefined removes it. */
  setWorkspaceSetting(key: string, value: unknown) {
    workspaceSettings.set(key, value);
  },
  /** Sets a full key in the settings of the workspace folder at `folder`. */
  setFolderSetting(folder: string, key: string, value: unknown) {
    folderSettings.set(folder, new Map([[key, value]]));
  },
  /** The lines of each output channel created, by name. */
  outputChannels: new Map<string, string[]>(),
  /** Paths passed to `openTextDocument`. */
  openedDocuments: [] as string[],
  /** What `env.openExternal` was asked to open. */
  openedExternal: [] as unknown[],
  /** What `env.openExternal` answers: false when the user turned it down. */
  openExternalResult: true,
  /** The webview panels created: what each posted, and how to send it a message or close it. */
  panels: [] as Array<{ posted: Array<Record<string, any>>; receive(message: unknown): void; close(): void }>,
  /** The terminals created. */
  terminals: [] as Array<{ options: unknown }>,
  /** As if the user closed the terminal. */
  closeTerminal(terminal: unknown) {
    for (const listener of [...closeListeners]) {
      listener(terminal);
    }
  },
  reset() {
    settings.clear();
    workspaceSettings.clear();
    folderSettings.clear();
    __test.outputChannels.clear();
    __test.openedDocuments.length = 0;
    __test.terminals.length = 0;
    __test.panels.length = 0;
    __test.openedExternal.length = 0;
    __test.openExternalResult = true;
    env.language = "en";
    workspace.workspaceFolders = undefined;
    workspace.textDocuments = [];
    window.activeTextEditor = undefined;
  },
};

export const env = {
  language: "en",
  openExternal: async (target: unknown): Promise<boolean> => {
    __test.openedExternal.push(target);
    return __test.openExternalResult;
  },
};

export class Uri {
  private constructor(
    readonly scheme: string,
    readonly path: string,
    readonly query: string = "",
  ) {}
  static file(p: string) {
    return new Uri("file", p);
  }
  static parse(value: string) {
    return new Uri("file", value.replace(/^file:\/\//, ""));
  }
  static from(c: { scheme: string; path?: string; query?: string }) {
    return new Uri(c.scheme, c.path ?? "", c.query);
  }
  static joinPath(base: Uri, ...segments: string[]) {
    return new Uri(base.scheme, path.join(base.path, ...segments));
  }
  get fsPath() {
    return this.path;
  }
  toString() {
    return `${this.scheme}://${this.path}`;
  }
}

export class Disposable {
  constructor(private readonly callback: () => void) {}
  static from(...disposables: ReadonlyArray<{ dispose(): unknown }>) {
    return new Disposable(() => disposables.forEach((each) => each.dispose()));
  }
  dispose() {
    this.callback();
  }
}

export class EventEmitter<T> {
  private readonly listeners = new Set<(value: T) => void>();
  readonly event = (listener: (value: T) => void) => {
    this.listeners.add(listener);
    return { dispose: () => void this.listeners.delete(listener) };
  };
  fire(value: T) {
    for (const listener of this.listeners) {
      listener(value);
    }
  }
  dispose() {
    this.listeners.clear();
  }
}

export class FileSystemError extends Error {
  constructor(
    message: string,
    readonly code = "Unknown",
  ) {
    super(message);
  }
}

export class Position {
  constructor(
    readonly line: number,
    readonly character: number,
  ) {}
}
export class Range {
  constructor(
    readonly startLine: number,
    readonly startCharacter: number,
    readonly endLine: number,
    readonly endCharacter: number,
  ) {}
}
export class ThemeColor {
  constructor(readonly id: string) {}
}
export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}
export enum OverviewRulerLane {
  Full = 7,
}
export enum TextEditorRevealType {
  InCenterIfOutsideViewport = 2,
}
export enum DiagnosticSeverity {
  Error = 0,
  Warning = 1,
  Information = 2,
  Hint = 3,
}

export class CodeActionKind {
  static readonly Empty = new CodeActionKind("");
  static readonly QuickFix = new CodeActionKind("quickfix");
  private constructor(readonly value: string) {}
  append(part: string): CodeActionKind {
    return new CodeActionKind(this.value ? `${this.value}.${part}` : part);
  }
}

export class CodeAction {
  command?: { command: string; title: string; arguments?: unknown[] };
  constructor(
    readonly title: string,
    readonly kind?: CodeActionKind,
  ) {}
}

export class WorkspaceEdit {
  readonly replaced: Array<{ uri: Uri; range: Range; text: string }> = [];
  replace(uri: Uri, range: Range, text: string) {
    this.replaced.push({ uri, range, text });
  }
}

const noDisposable = { dispose() {} };

const toError = (e: unknown, p: string) =>
  (e as NodeJS.ErrnoException).code === "ENOENT"
    ? new FileSystemError(p, "FileNotFound")
    : (e as Error);

export const workspace = {
  workspaceFolders: undefined as ReadonlyArray<{ name?: string; uri: Uri }> | undefined,
  textDocuments: [] as Array<{ uri: Uri; isClosed: boolean; lineCount: number; save(): Promise<boolean>; getText?(): string }>,
  getConfiguration(section?: string, scope?: Uri) {
    const full = (key: string) => (section ? `${section}.${key}` : key);
    return {
      inspect(key: string) {
        const k = full(key);
        return {
          globalValue: settings.get(k),
          workspaceValue: workspaceSettings.get(k),
          workspaceFolderValue: scope && folderSettings.get(scope.fsPath)?.get(k),
        };
      },
      get<T>(key: string, fallback?: T): T | undefined {
        const k = full(key);
        return (settings.has(k) ? settings.get(k) : fallback) as T | undefined;
      },
    };
  },
  onDidChangeConfiguration(listener: (e: { affectsConfiguration(section: string): boolean }) => void) {
    listeners.add(listener);
    return { dispose: () => void listeners.delete(listener) };
  },
  async openTextDocument(uri: Uri) {
    __test.openedDocuments.push(uri.fsPath);
    const text = await fs.readFile(uri.fsPath, "utf8");
    return { getText: () => text };
  },
  async applyEdit(_edit: WorkspaceEdit) {
    return true;
  },
  asRelativePath: (p: string) => p,
  decode: async (content: Uint8Array, _options?: { uri: Uri }) => new TextDecoder().decode(content),
  fs: {
    async readFile(uri: Uri): Promise<Uint8Array> {
      return fs.readFile(uri.fsPath).catch((e) => {
        throw toError(e, uri.fsPath);
      });
    },
    async stat(uri: Uri) {
      const info = await fs.stat(uri.fsPath);
      return { type: info.isDirectory() ? FileType.Directory : FileType.File, size: info.size };
    },
    async createDirectory(uri: Uri) {
      await fs.mkdir(uri.fsPath, { recursive: true });
    },
    async writeFile(uri: Uri, content: Uint8Array) {
      await fs.mkdir(path.dirname(uri.fsPath), { recursive: true });
      await fs.writeFile(uri.fsPath, content);
    },
    async delete(uri: Uri) {
      await fs.rm(uri.fsPath).catch((e) => {
        throw toError(e, uri.fsPath);
      });
    },
  },
  registerTextDocumentContentProvider: () => ({ dispose() {} }),
  onDidChangeWorkspaceFolders: () => noDisposable,
  onDidSaveTextDocument: () => noDisposable,
  createFileSystemWatcher: () => ({
    onDidChange: () => noDisposable,
    onDidCreate: () => noDisposable,
    onDidDelete: () => noDisposable,
    dispose() {},
  }),
  findFiles: async () => [],
};

export const ViewColumn = { Active: -1 };

export const QuickPickItemKind = { Separator: -1, Default: 0 };

export const ProgressLocation = { SourceControl: 1, Window: 10, Notification: 15 };

export const window = {
  activeTextEditor: undefined as { document: { uri: Uri } } | undefined,
  createOutputChannel(name: string) {
    const lines: string[] = [];
    __test.outputChannels.set(name, lines);
    return { name, appendLine: (line: string) => void lines.push(line), show: () => {}, dispose: () => {} };
  },
  showWarningMessage: async (_message: string, _options: unknown, ..._actions: string[]): Promise<string | undefined> => undefined,
  showInformationMessage: async (_message: string, ..._actions: string[]): Promise<string | undefined> => undefined,
  showErrorMessage: async (_message: string, ..._actions: string[]): Promise<string | undefined> => undefined,
  showQuickPick: async <T>(_items: ReadonlyArray<T>, _options?: unknown): Promise<T | T[] | undefined> => undefined,
  createWebviewPanel: () => {
    const received = new EventEmitter<unknown>();
    const disposed = new EventEmitter<void>();
    const posted: Array<Record<string, any>> = [];
    __test.panels.push({ posted, receive: (message) => received.fire(message), close: () => disposed.fire() });
    return {
      visible: true,
      title: "",
      iconPath: undefined as unknown,
      reveal: () => {},
      onDidDispose: disposed.event,
      webview: {
        html: "",
        cspSource: "test",
        asWebviewUri: (uri: Uri) => uri,
        onDidReceiveMessage: received.event,
        postMessage: async (message: Record<string, any>) => {
          posted.push(message);
          return true;
        },
      },
    };
  },
  showInputBox: async (_options?: unknown): Promise<string | undefined> => undefined,
  withProgress: async <R>(_options: unknown, task: (progress: { report(value: unknown): void }) => Thenable<R>): Promise<R> => task({ report: () => {} }),
  state: { focused: true },
  onDidChangeWindowState: () => noDisposable,
  onDidStartTerminalShellExecution: () => noDisposable,
  onDidEndTerminalShellExecution: () => noDisposable,
  onDidCloseTerminal: (listener: (terminal: unknown) => void) => {
    closeListeners.add(listener);
    return { dispose: () => void closeListeners.delete(listener) };
  },
  createTerminal: (options: unknown) => {
    const terminal = { options, show: () => {} };
    __test.terminals.push(terminal);
    return terminal;
  },
  createTextEditorDecorationType: () => noDisposable,
  createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
};

export const commands: { executeCommand: (...args: unknown[]) => Promise<unknown> } = { executeCommand: async () => undefined };

export const FileType = { File: 1, Directory: 2 } as const;
