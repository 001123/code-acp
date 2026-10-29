/** Minimal stand-in for the `vscode` module, covering only what the tested modules touch. */
import * as fs from "node:fs/promises";
import * as path from "node:path";

const settings = new Map<string, unknown>();
const listeners = new Set<(e: { affectsConfiguration(section: string): boolean }) => void>();

/** Test hooks; not part of the real vscode API. */
export const __test = {
  /** Sets `codeAcp.<key>` (or any full key like `codeAcp.language`). */
  setSetting(key: string, value: unknown) {
    settings.set(key, value);
    for (const listener of listeners) {
      listener({ affectsConfiguration: (section) => key === section || key.startsWith(`${section}.`) });
    }
  },
  reset() {
    settings.clear();
    env.language = "en";
    workspace.workspaceFolders = undefined;
    workspace.textDocuments = [];
    window.activeTextEditor = undefined;
  },
};

export const env = { language: "en" };

export class Uri {
  private constructor(
    readonly scheme: string,
    readonly path: string,
    readonly query: string = "",
  ) {}
  static file(p: string) {
    return new Uri("file", p);
  }
  static from(c: { scheme: string; path?: string; query?: string }) {
    return new Uri(c.scheme, c.path ?? "", c.query);
  }
  get fsPath() {
    return this.path;
  }
  toString() {
    return `${this.scheme}://${this.path}`;
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
export class WorkspaceEdit {
  readonly replaced: Array<{ uri: Uri; range: Range; text: string }> = [];
  replace(uri: Uri, range: Range, text: string) {
    this.replaced.push({ uri, range, text });
  }
}

const toError = (e: unknown, p: string) =>
  (e as NodeJS.ErrnoException).code === "ENOENT"
    ? new FileSystemError(p, "FileNotFound")
    : (e as Error);

export const workspace = {
  workspaceFolders: undefined as ReadonlyArray<{ name?: string; uri: Uri }> | undefined,
  textDocuments: [] as Array<{ uri: Uri; isClosed: boolean; lineCount: number; save(): Promise<boolean> }>,
  getConfiguration(section?: string) {
    const full = (key: string) => (section ? `${section}.${key}` : key);
    return {
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
    const text = await fs.readFile(uri.fsPath, "utf8");
    return { getText: () => text };
  },
  async applyEdit(_edit: WorkspaceEdit) {
    return true;
  },
  asRelativePath: (p: string) => p,
  fs: {
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
};

export const window = {
  activeTextEditor: undefined as { document: { uri: Uri } } | undefined,
};

export const commands = { executeCommand: async () => undefined };
