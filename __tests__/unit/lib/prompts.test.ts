import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "@/lib/prompts";

/**
 * Temp prompts-dir factory. Each test gets its own isolated directory so
 * the loader's "read fresh on every call" behavior can be exercised
 * without stepping on shared state. Mirrors the tempProjectsDir pattern
 * in __tests__/unit/lib/logger.test.ts.
 */
const tmpDirs: string[] = [];
function tempPromptsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "histforge-prompts-test-"));
  mkdirSync(join(dir, "_shared"), { recursive: true });
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore Windows lock races
    }
  }
});

describe("render", () => {
  it("auto-loads _shared/ files into {{basename}} variables", () => {
    // Open Decision #4: every file in prompts/_shared/ is auto-loaded into
    // a variable matching its basename (audience_profile.md → {{audience_profile}}).
    // The caller does NOT have to pass audience_profile explicitly.
    const dir = tempPromptsDir();
    writeFileSync(
      join(dir, "_shared", "audience_profile.md"),
      "40+ history buffs"
    );
    writeFileSync(
      join(dir, "01_research_outline.md"),
      "Audience: {{audience_profile}}\nTopic: {{title}}"
    );

    const out = render(
      "01_research_outline.md",
      { title: "Rome" },
      dir
    );

    expect(out).toBe("Audience: 40+ history buffs\nTopic: Rome");
  });

  it("caller-supplied vars override shared-fragment names on collision", () => {
    // Merge precedence matters: the plan says "auto-loads every file … then
    // merges with caller-supplied vars". This test pins that the caller wins,
    // so a step can locally override a shared fragment if it ever needs to
    // (and so the precedence is explicit, not accidental).
    const dir = tempPromptsDir();
    writeFileSync(
      join(dir, "_shared", "audience_profile.md"),
      "default audience"
    );
    writeFileSync(
      join(dir, "test_prompt.md"),
      "Audience: {{audience_profile}}"
    );

    const out = render(
      "test_prompt.md",
      { audience_profile: "override" },
      dir
    );

    expect(out).toBe("Audience: override");
  });

  it("reads the file fresh on every call (no caching)", () => {
    // Spec :769-771 — the operator can edit a prompt file during a live
    // run and the next call must see the new content. A naive readFileSync
    // + module-level cache would break this.
    const dir = tempPromptsDir();
    writeFileSync(
      join(dir, "_shared", "audience_profile.md"),
      "history buffs"
    );
    writeFileSync(join(dir, "evolving.md"), "v1 {{audience_profile}}");

    const first = render("evolving.md", {}, dir);
    expect(first).toBe("v1 history buffs");

    writeFileSync(join(dir, "evolving.md"), "v2 {{audience_profile}}");
    writeFileSync(
      join(dir, "_shared", "audience_profile.md"),
      "everyone"
    );

    const second = render("evolving.md", {}, dir);
    expect(second).toBe("v2 everyone");
  });

  it("throws on unresolved {{var}} placeholders", () => {
    // A silent empty-string substitution would ship garbage prompts to the
    // LLM and waste money. Typo in a variable name should fail loudly.
    const dir = tempPromptsDir();
    writeFileSync(join(dir, "typo.md"), "Hello {{missing_var}}");

    expect(() => render("typo.md", {}, dir)).toThrow(
      /missing_var/
    );
  });

  it("substitutes {{good_examples}} as the empty string when supplied empty", () => {
    // Spec contract for step 09's few-shot slot: when
    // step_09_examples_json is empty or invalid, the step supplies
    // good_examples="" so render() stays happy (strict-throw on
    // unresolved vars). The template must collapse to no <good_examples>
    // block — just the surrounding content, byte-for-byte.
    const dir = tempPromptsDir();
    writeFileSync(
      join(dir, "tmpl.md"),
      "{{good_examples}}STYLE=x"
    );

    const out = render("tmpl.md", { good_examples: "" }, dir);
    expect(out).toBe("STYLE=x");
  });

  it("substitutes {{good_examples}} verbatim when supplied a non-empty block string", () => {
    // The step builds the <good_examples>...</good_examples> block above
    // step 09; render() must inline it verbatim so the LLM sees the same
    // bytes the step composed.
    const dir = tempPromptsDir();
    writeFileSync(
      join(dir, "tmpl.md"),
      "{{good_examples}}STYLE=x"
    );

    const block =
      "<good_examples>\nexample one\n</good_examples>\n\n";
    const out = render("tmpl.md", { good_examples: block }, dir);
    expect(out).toBe(`${block}STYLE=x`);
  });
});
