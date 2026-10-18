// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Skill argument variables are literal instruction text.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createMockPi } from "@juicesharp/rpiv-test-utils";
import { describe, expect, it, vi } from "vitest";
import { FLAG_DEBUG, MSG_TYPE_PIPELINE_INDEX } from "./constants.js";
import { BUNDLED_SKILLS_DIR } from "./paths.js";
import { injectPipelinePointer, PIPELINE_POINTER } from "./pipeline-pointer.js";

const skillText = (name: string) =>
	readFileSync(fileURLToPath(new URL(`../../skills/${name}/SKILL.md`, import.meta.url)), "utf8");

/** Bundled skills with whether their frontmatter carries `disable-model-invocation: true`. */
function bundledSkills(): Array<{ name: string; hidden: boolean }> {
	return readdirSync(BUNDLED_SKILLS_DIR, { withFileTypes: true })
		.filter((d) => d.isDirectory() && existsSync(join(BUNDLED_SKILLS_DIR, d.name, "SKILL.md")))
		.map((d) => ({
			name: d.name,
			hidden: /^disable-model-invocation:\s*true\s*$/m.test(
				readFileSync(join(BUNDLED_SKILLS_DIR, d.name, "SKILL.md"), "utf-8"),
			),
		}));
}

/**
 * Skill-name tokens the pointer mentions. Splitting on anything outside
 * [a-z0-9:-] keeps `design-slice` whole and turns `/skill:design` into
 * `skill:design`, whose prefix is then stripped — so `design` matching here
 * cannot be a false positive from `design-slice`.
 */
function pointerTokens(): Set<string> {
	return new Set(
		PIPELINE_POINTER.toLowerCase()
			.split(/[^a-z0-9:-]+/)
			.map((t) => t.replace(/^skill:/, "")),
	);
}

describe("injectPipelinePointer", () => {
	it("sends the pointer as a hidden message with its own customType", () => {
		const { pi } = createMockPi();
		injectPipelinePointer(pi);
		expect(pi.sendMessage).toHaveBeenCalledExactlyOnceWith({
			customType: MSG_TYPE_PIPELINE_INDEX,
			content: PIPELINE_POINTER,
			display: false,
		});
	});

	it("displays the message when the debug flag is set", () => {
		const { pi, captured } = createMockPi();
		captured.flags.set(FLAG_DEBUG, true);
		injectPipelinePointer(pi);
		expect(vi.mocked(pi.sendMessage).mock.calls[0]?.[0]).toMatchObject({ display: true });
	});
});

describe("PIPELINE_POINTER ↔ skill frontmatter sync (issue #77 tiers)", () => {
	const skills = bundledSkills();
	const tokens = pointerTokens();

	it("sanity: bundled skills were enumerated and both tiers exist", () => {
		expect(skills.length).toBeGreaterThan(0);
		expect(skills.some((s) => s.hidden)).toBe(true);
		expect(skills.some((s) => !s.hidden)).toBe(true);
	});

	it("every disable-model-invocation skill is routable via the pointer", () => {
		const missing = skills.filter((s) => s.hidden && !tokens.has(s.name)).map((s) => s.name);
		expect(missing).toEqual([]);
	});

	it("no model-visible skill is duplicated into the pointer", () => {
		const duplicated = skills.filter((s) => !s.hidden && tokens.has(s.name)).map((s) => s.name);
		expect(duplicated).toEqual([]);
	});
});

// Instruction-contract tests, not a claim that an LLM will obey these instructions.
describe("conversation-local next authorization", () => {
	it("allows standalone next for one previously recommended skill, not autonomous chaining", () => {
		expect(PIPELINE_POINTER).toContain('standalone "next"');
		expect(PIPELINE_POINTER).toContain("exactly one");
		expect(PIPELINE_POINTER).toContain("most recent assistant handoff");
		expect(PIPELINE_POINTER).toContain("Never auto-chain");
		expect(PIPELINE_POINTER).not.toContain("Never start a stage yourself");
	});

	it("fails closed on missing, ambiguous, stale, blocked, or wrong-worktree context", () => {
		for (const term of ["missing", "ambiguous", "stale", "blocked", "worktree", "ask", "quoted", "/new"]) {
			expect(PIPELINE_POINTER).toContain(term);
		}
		expect(PIPELINE_POINTER).toContain("exact command, arguments, and working directory");
		expect(PIPELINE_POINTER).toContain("Workflow-internal (dispatched by lanes — never suggest)");
	});

	for (const name of [
		"discover",
		"research",
		"explore",
		"design",
		"plan",
		"blueprint",
		"revise",
		"implement",
		"validate",
		"architecture-review",
		"code-review",
		"create-handoff",
		"migrate-to-guidance",
	]) {
		it(`${name} offers next, the exact worktree, and a fresh-session fallback`, () => {
			const text = skillText(name);
			expect(text).toContain("Reply `next`");
			expect(text).toContain("**Working directory:** `{absolute working directory}`");
			expect(text).toContain("After `/new`, use the full command above");
			expect(text).not.toContain("start a fresh session with `/new` first");
			expect(text).toContain("[handoff rules](../_shared/next-handoff.md)");
		});
	}

	it("research chooses design by default while preserving blueprint as an explicit alternative", () => {
		const text = skillText("research");
		expect(text).toContain("**Next step (default):** `/skill:design");
		expect(text).toContain("**Alternative:** `/skill:blueprint");
	});

	it("documents actual skill loading and manual argument/setup expansion for hosts without a loader", () => {
		const rules = readFileSync(new URL("../../skills/_shared/next-handoff.md", import.meta.url), "utf8");
		for (const term of [
			"$ARGUMENTS",
			"positional arguments",
			"${SKILL_DIR}",
			"${CWD}",
			"shell-context setup",
			"Never auto-chain",
			"Confirm the directory and required input artifact still exist",
		]) {
			expect(rules).toContain(term);
		}
		expect(PIPELINE_POINTER).toContain(
			fileURLToPath(new URL("../../skills/_shared/next-handoff.md", import.meta.url)),
		);
	});

	it("does not remove the failed-validation gate", () => {
		expect(skillText("validate")).toContain("skip if `verdict: fail`");
	});
});
