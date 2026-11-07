import { assert, describe, it } from "@effect/vitest";
import { existsSync, readFileSync } from "node:fs";

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const manifestText = read("package.json");
const manifest = JSON.parse(manifestText);
const contributes = manifest.contributes;
const en: Record<string, string> = JSON.parse(read("package.nls.json"));
const vi: Record<string, string> = JSON.parse(read("package.nls.vi.json"));

describe("localized manifest strings", () => {
  const used = [...manifestText.matchAll(/"%([^%"]+)%"/g)].map((match) => match[1]!);

  it("every %key% in package.json exists in both languages", () => {
    assert.deepStrictEqual(
      used.filter((key) => !(key in en)),
      [],
    );
    assert.deepStrictEqual(
      used.filter((key) => !(key in vi)),
      [],
    );
  });

  it("both languages have the same keys", () => {
    assert.sameMembers(Object.keys(vi), Object.keys(en));
  });
});

describe("walkthrough", () => {
  const steps: ReadonlyArray<Record<string, any>> = contributes.walkthroughs.flatMap(
    (walkthrough: any) => walkthrough.steps,
  );
  const commands = new Set<string>(contributes.commands.map((command: any) => command.command));
  const views = new Set<string>(
    Object.values<any[]>(contributes.views)
      .flat()
      .map((view) => view.id),
  );
  // VS Code generates "<view id>.focus" for each view.
  const runnable = (command: string) =>
    commands.has(command) || (command.endsWith(".focus") && views.has(command.slice(0, -".focus".length)));

  it("the extension's command opens a walkthrough it contributes", () => {
    assert.isTrue(commands.has("kdCode.openWalkthrough"));
    assert.include(read("src/extension.ts"), `#${contributes.walkthroughs[0].id}\``);
  });

  for (const step of steps) {
    it(`step ${step.id}: its media ships in the package`, () => {
      assert.isTrue(existsSync(new URL(`../${step.media.svg}`, import.meta.url)));
      assert.notMatch(read(".vscodeignore"), /^media\/(\*\*\/\*\.svg|walkthrough)/m);
    });

    it(`step ${step.id}: its buttons run real commands, in both languages`, () => {
      const key = step.description.slice(1, -1);
      for (const text of [en[key]!, vi[key]!]) {
        const links = [...text.matchAll(/\]\(command:([^)]+)\)/g)].map((match) => match[1]!);
        assert.isNotEmpty(links);
        assert.deepStrictEqual(
          links.filter((command) => !runnable(command)),
          [],
        );
      }
    });

    it(`step ${step.id}: it can complete`, () => {
      for (const event of step.completionEvents as ReadonlyArray<string>) {
        const [kind, name] = event.split(":") as [string, string];
        if (kind === "onCommand") {
          assert.isTrue(commands.has(name), event);
        } else if (kind === "onView") {
          assert.isTrue(views.has(name), event);
        } else {
          assert.strictEqual(event, "onContext:kdCode.hasAgent");
          assert.include(read("src/extension.ts"), '"kdCode.hasAgent"');
        }
      }
    });
  }
});
