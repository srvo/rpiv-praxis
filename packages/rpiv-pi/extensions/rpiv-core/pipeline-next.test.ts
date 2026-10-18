// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Skill argument variables are literal instruction text.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PIPELINE_POINTER, RPIV_STAGE_NAMES } from "./pipeline-pointer.js";

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
			expect(text).toContain("**Working directory:**");
			expect(text).not.toContain("start a fresh session with `/new` first");
		});
	}

	it("emits the exact /next metadata only for actionable public-stage defaults, outside fences", () => {
		expect(RPIV_STAGE_NAMES).toEqual([
			"discover",
			"research",
			"design",
			"explore",
			"plan",
			"blueprint",
			"implement",
			"validate",
		]);
		for (const name of [
			"discover",
			"research",
			"explore",
			"design",
			"plan",
			"blueprint",
			"implement",
			"architecture-review",
			"code-review",
			"revise",
		]) {
			const text = skillText(name);
			const marker = "Reply /next to run only the ";
			const index = text.indexOf(marker);
			expect(index).toBeGreaterThanOrEqual(0);
			expect((text.slice(0, index).split("```").length - 1) % 2).toBe(0);
			expect(text.match(/^Reply \/next to run only the /gm)?.length).toBe(1);
			for (const field of [
				"**Next step",
				"**Working directory:**",
				"**Input artifact:**",
				"**Branch:**",
				"**Kata issue:**",
			]) {
				expect(text).toContain(field);
			}
		}
	});

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

	it("keeps native /next separate from conversational approval and completion", () => {
		expect(PIPELINE_POINTER).toContain("user-issued /next command");
		expect(PIPELINE_POINTER).toContain("do not emulate it");
		expect(PIPELINE_POINTER).toContain("receipt as stage completion");
	});
});
