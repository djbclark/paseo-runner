import { describe, expect, it } from "vitest";
import { buildArgv } from "./params";
import { parseManifest, type Action } from "./schema";

function action(extra: Record<string, unknown> = {}): Action {
  const result = parseManifest({
    schemaVersion: 1,
    name: "demo",
    actions: [
      {
        id: "run",
        title: "Run",
        argv: ["tool", "--flag", "{{p}}"],
        params: [{ name: "p", type: "string" }],
        ...extra,
      },
    ],
  });
  if (!result.ok) throw new Error(result.reason);
  return result.manifest.actions[0];
}

describe("buildArgv keeps values literal", () => {
  it.each(["; rm -rf /", "$(x)", "a b", "`id`", "a\nb", "x|y"])("rejects %j by the default pattern", (value) => {
    expect(buildArgv(action(), { p: value })).toHaveProperty("error");
  });

  it("passes a leading dash as one argv element", () => {
    expect(buildArgv(action(), { p: "-rf" })).toEqual({ argv: ["tool", "--flag", "-rf"] });
  });

  it("passes spaces and shell syntax as one element when the author allows them", () => {
    const loose = action({ params: [{ name: "p", type: "string", pattern: "^.*$" }] });
    for (const value of ["; rm -rf /", "$(x)", "two words"]) {
      expect(buildArgv(loose, { p: value })).toEqual({ argv: ["tool", "--flag", value] });
    }
  });

  it("refuses unknown values and substitutes bool and int as text", () => {
    const typed = action({
      argv: ["tool", "{{b}}", "{{n}}"],
      params: [
        { name: "b", type: "bool" },
        { name: "n", type: "int", min: 1, max: 5 },
      ],
    });
    expect(buildArgv(typed, { b: true, n: 3 })).toEqual({ argv: ["tool", "true", "3"] });
    expect(buildArgv(typed, { b: false, n: 9 })).toHaveProperty("error");
    expect(buildArgv(typed, { b: true, n: 2, extra: "x" })).toHaveProperty("error");
  });
});

describe("manifest validation", () => {
  it("refuses an embedded placeholder", () => {
    const result = parseManifest({
      schemaVersion: 1,
      name: "demo",
      actions: [
        { id: "run", title: "Run", argv: ["tool", "--x={{p}}"], params: [{ name: "p", type: "string" }] },
      ],
    });
    expect(result.ok).toBe(false);
  });

  it("refuses a placeholder for an undeclared param", () => {
    const result = parseManifest({
      schemaVersion: 1,
      name: "demo",
      actions: [{ id: "run", title: "Run", argv: ["tool", "{{nope}}"] }],
    });
    expect(result.ok).toBe(false);
  });

  it("refuses secretRef params naming the action", () => {
    const result = parseManifest({
      schemaVersion: 1,
      name: "demo",
      actions: [{ id: "deploy", title: "D", argv: ["t", "{{k}}"], params: [{ name: "k", type: "secretRef" }] }],
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain('action "deploy"');
  });
});
