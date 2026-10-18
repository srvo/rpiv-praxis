// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Skill argument variables are literal instruction text.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PIPELINE_POINTER } from "./pipeline-pointer.js";

const skillText = (name: string) =>
	readFileSync(fileURLToPath(new URL(`../../skills/${name}/SKILL.md`, import.meta.url)), "utf8");

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
