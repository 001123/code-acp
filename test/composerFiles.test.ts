import { afterEach, assert, describe, it } from "@effect/vitest";
import { vi } from "vitest";
import type { Attachment } from "../src/chat/protocol";
import { takeTransfer } from "../src/ui/chat/composerFiles";

const fileItem = (file: Partial<File>, directory = false) => ({
  kind: "file",
  webkitGetAsEntry: () => ({ isDirectory: directory }),
  getAsFile: () => file as File,
});

const transfer = (data: Record<string, string>, items: unknown[] = []) =>
  ({ items, types: Object.keys(data), getData: (type: string) => data[type] ?? "" }) as unknown as DataTransfer;

const intake = (remote = false) => {
  const attached: Attachment[] = [];
  const errors: unknown[][] = [];
  return {
    attached,
    errors,
    remote,
    attach: (a: Attachment) => void attached.push(a),
    error: (...args: unknown[]) => void errors.push(args),
  };
};

const VSCODE_URIS = "application/vnd.code.uri-list";

afterEach(() => void vi.unstubAllGlobals());

describe("takeTransfer", () => {
  it("attaches URIs, skipping comments", () => {
    const to = intake();
    assert.isTrue(takeTransfer(transfer({ "text/uri-list": "# comment\r\nfile:///w/a%20b.ts\nfile:///w/c.ts" }), to));
    assert.deepStrictEqual(to.attached, [
      { kind: "uri", uri: "file:///w/a%20b.ts", name: "a b.ts" },
      { kind: "uri", uri: "file:///w/c.ts", name: "c.ts" },
    ]);
  });

  it("takes nothing without URIs or files", () => {
    const to = intake();
    assert.isFalse(takeTransfer(transfer({ "text/plain": "hi" }), to));
    assert.deepStrictEqual(to.attached, []);
  });

  it("refuses folders from the OS", () => {
    const to = intake();
    assert.isTrue(takeTransfer(transfer({}, [fileItem({ name: "dir" }, true)]), to));
    assert.deepStrictEqual(to.errors, [["chat.externalFolder"]]);
  });

  it("refuses files that are too large", () => {
    const to = intake();
    assert.isTrue(takeTransfer(transfer({}, [fileItem({ name: "big.bin", size: 21 * 1024 * 1024 })]), to));
    assert.deepStrictEqual(to.errors, [["chat.tooLarge", "big.bin"]]);
  });

  describe("reading files", () => {
    const stubReader = (result: string) =>
      vi.stubGlobal(
        "FileReader",
        class {
          result = result;
          onload?: () => void;
          readAsDataURL() {
            this.onload?.();
          }
        },
      );

    it("sends the bytes of a file, named from its type when it has no name", () => {
      stubReader("data:image/png;base64,AAAA");
      const to = intake();
      const now = vi.spyOn(Date, "now").mockReturnValue(7);
      assert.isTrue(takeTransfer(transfer({}, [fileItem({ name: "", size: 3, type: "image/png" })]), to));
      now.mockRestore();
      assert.deepStrictEqual(to.attached, [
        { kind: "data", name: "clipboard-7.png", mimeType: "image/png", data: "AAAA" },
      ]);
    });

    it("sends OS files of a remote window as bytes, though they have URIs", () => {
      stubReader("data:text/plain;base64,QQ==");
      const to = intake(true);
      assert.isTrue(
        takeTransfer(
          transfer({ "text/uri-list": "file:///local/a.txt" }, [
            fileItem({ name: "a.txt", size: 1, type: "text/plain" }),
          ]),
          to,
        ),
      );
      assert.deepStrictEqual(to.attached, [{ kind: "data", name: "a.txt", mimeType: "text/plain", data: "QQ==" }]);
    });

    it("trusts VS Code's own list in a remote window", () => {
      const to = intake(true);
      assert.isTrue(
        takeTransfer(
          transfer({ [VSCODE_URIS]: "vscode-remote://ssh/w/a.ts" }, [fileItem({ name: "a.ts", size: 1 })]),
          to,
        ),
      );
      assert.deepStrictEqual(to.attached, [{ kind: "uri", uri: "vscode-remote://ssh/w/a.ts", name: "a.ts" }]);
    });
  });
});
