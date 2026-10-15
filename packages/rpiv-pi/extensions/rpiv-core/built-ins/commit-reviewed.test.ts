/**
 * commit-reviewed.test.ts — every built-in commit stage dispatches `--reviewed`
 * exactly when the gate that routes into it passed, read from run state rather
 * than assumed from the workflow. Without the flag an unattended commit stage
 * asks for confirmation no one can give, commits nothing, and records a no-op.
 */

import type { RunView } from "@juicesharp/rpiv-workflow";
import { fs as fsHandle } from "@juicesharp/rpiv-workflow/registration";
import { describe, expect, it } from "vitest";
import { findWorkflow } from "../workflow-test-harness.js";

const commitDispatch = async (workflow: string, named: Record<string, unknown>) => {
	const prompt = findWorkflow(workflow).stages.commit?.prompt;
	if (typeof prompt !== "function") throw new Error(`${workflow} commit stage has no prompt fn`);
	return prompt({ cwd: "/repo", input: undefined, state: { named } as unknown as RunView });
};
const out = (data: unknown, artifacts: unknown[] = []) => ({ artifacts, data, kind: "", meta: {} });
const goal = out(undefined, [
	{ handle: fsHandle(".rpiv/artifacts/goal/goal-t.md") },
	{ handle: fsHandle(".rpiv/artifacts/goal/baseline-t.json"), role: "baseline" },
]);

describe.each(["build", "ship"])("%s commit", (wf) => {
	it("is reviewed when the latest validate verdict passed", async () => {
		const named = { goal: [goal], validation: [out({ verdict: "fail" }), out({ verdict: "pass" })] };
		expect(await commitDispatch(wf, named)).toBe(
			"/skill:commit --reviewed --baseline .rpiv/artifacts/goal/baseline-t.json",
		);
	});

	it("is not reviewed when the latest verdict is anything but pass", async () => {
		for (const validation of [[], [out({ verdict: "pass" }), out({ verdict: "fail" })], [out(undefined)]]) {
			expect(await commitDispatch(wf, { goal: [goal], validation })).toBe(
				"/skill:commit --baseline .rpiv/artifacts/goal/baseline-t.json",
			);
		}
	});
});

describe.each(["vet", "polish"])("%s commit", (wf) => {
	const review = (blockers: unknown, name: string) =>
		out({ blockers_count: blockers }, [{ handle: fsHandle(`.rpiv/artifacts/reviews/${name}.md`) }]);

	it("is reviewed when the latest code review left zero blockers, with that review as evidence and no baseline", async () => {
		const named = { goal: [goal], reviews: [review(2, "r1"), review(0, "r2")] };
		expect(await commitDispatch(wf, named)).toBe("/skill:commit --reviewed --evidence .rpiv/artifacts/reviews/r2.md");
	});

	it("is not reviewed while blockers remain or no review is recorded", async () => {
		expect(await commitDispatch(wf, { reviews: [review(1, "r1")] })).toBe(
			"/skill:commit --evidence .rpiv/artifacts/reviews/r1.md",
		);
		expect(await commitDispatch(wf, { reviews: [out({ blockers_count: "0" })] })).toBe("/skill:commit");
		expect(await commitDispatch(wf, {})).toBe("/skill:commit");
	});
});

describe("meta commit", () => {
	const record = (decision: string, round: number) =>
		out({ decision, round, generation: 0, stage: "gate", pass: decision === "pass", failures: [] });

	it("is reviewed when the last unit's latest gate record passed", async () => {
		const named = { goal: [goal], "implement-gate": [record("correct", 1), record("pass", 2)] };
		expect(await commitDispatch("meta", named)).toBe(
			"/skill:commit --reviewed --baseline .rpiv/artifacts/goal/baseline-t.json",
		);
	});

	it("is not reviewed when the last unit was advanced red by policy", async () => {
		const named = { goal: [goal], "implement-gate": [record("correct", 1), record("advance", 3)] };
		expect(await commitDispatch("meta", named)).toBe("/skill:commit --baseline .rpiv/artifacts/goal/baseline-t.json");
	});

	it("reads the last unit, not an earlier one that passed", async () => {
		const named = { "plan-gate": [record("pass", 1)], "implement-gate": [record("advance", 3)] };
		expect(await commitDispatch("meta", named)).toBe("/skill:commit");
	});
});
