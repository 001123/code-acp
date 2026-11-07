import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { vscode: fileURLToPath(new URL("./test/stubs/vscode.ts", import.meta.url)) },
  },
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    // Tests commit in temporary repos; CI runners have no git identity.
    env: {
      GIT_AUTHOR_NAME: "KD Code Tests",
      GIT_AUTHOR_EMAIL: "tests@kd-code.invalid",
      GIT_COMMITTER_NAME: "KD Code Tests",
      GIT_COMMITTER_EMAIL: "tests@kd-code.invalid",
    },
  },
});
