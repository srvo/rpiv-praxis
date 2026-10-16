/**
 * Collect-all fanout holes (kata es63): a failed unit is a hole. By default
 * (`onHole: "halt"`) the generation close halts the run instead of advancing a
 * fan-in over a partial set, and a resume re-dispatches the holed unit.
 * `onHole: "continue"` keeps the old collect-all contract.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockSessionChain, mockAssistantMessage } from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acts, fanin, produces, type Workflow } from "./api.js";
import { fs as fsHandle } from "./handle.js";
import { fanout } from "./loop-constructors.js";
import type { Output } from "./output.js";
import type { Outcome } from "./output-spec.js";
import { resumeWorkflow, runWorkflow } from "./runner/index.js";
import {
	appendHeader,
	appendStage,
	readAllStages,
	STATE_SCHEMA_VERSION,
	type WorkflowHeader,
	type WorkflowStage,
} from "./state/index.js";

const MD = /\.rpiv\/artifacts\/[\w.-]+\/[\w.-]+\.md/g;
const outcome: Outcome = {
	name: "plans",
	collector: {
		collect: (ctx) => {
			for (let i = ctx.branch.length - 1; i >= Math.max(ctx.branchOffset ?? 0, 0); i--) {
				const text = ctx.branch[i]?.message?.content?.find((p) => p.type === "text")?.text;
				const hit = text?.match(MD)?.at(-1);
				if (hit) return { kind: "ok", artifacts: [{ handle: fsHandle(hit), role: "primary" }] };
			}
			return { kind: "fatal", message: `${ctx.skill} produced no artifact path` };
		},
	},
};

const twoUnits = () => [1, 2].map((n) => ({ prompt: `phase ${n}`, label: `phase ${n}`, id: `phase-${n}` }));
const wf = (onHole?: "halt" | "continue"): Workflow =>
	({
		name: "hole-wf",
		start: "impl",
		stages: {
			impl: produces({ outcome, loop: fanout({ units: twoUnits, ...(onHole ? { onHole } : {}) }) }),
			splice: acts({ reads: [fanin("plans")] }),
		},
		edges: { impl: "splice", splice: "stop" },
	}) as Workflow;

let tmpDir: string;
beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "rpiv-fanout-hole-"));
});
afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

// Unit 1 writes; unit 2 announces nothing (and stays silent after the collection nudge).
const holedSteps = () => [
	{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/plans/p1.md")] },
	{ branch: [mockAssistantMessage("no artifact")], onSend: [{ branch: [] }] },
];

describe("fanout onHole", () => {
	it("default: a failed unit halts the run at the generation close — the fan-in never runs", async () => {
		const chain = createMockSessionChain({ cwd: tmpDir, steps: holedSteps() });
		const result = await runWorkflow(chain.ctx, { workflow: wf(), input: "x" });
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/Fanout hole at stage "impl" \(1\/2 units failed: phase 2\)/);
		expect(chain.sentMessages.some((m) => m.startsWith("/skill:splice"))).toBe(false);
	});

	it('onHole: "continue" keeps collect-all — the chain advances into the fan-in', async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [...holedSteps(), { branch: [mockAssistantMessage("spliced")] }],
		});
		const result = await runWorkflow(chain.ctx, { workflow: wf("continue"), input: "x" });
		expect(result.success).toBe(true);
		expect(chain.sentMessages.some((m) => m.startsWith("/skill:splice"))).toBe(true);
	});

	it("rejects an unknown onHole value at construction", () => {
		expect(() => fanout({ units: twoUnits, onHole: "skip" as never })).toThrow(/onHole/);
	});

	it("resume after a hole halt re-dispatches the holed unit, then advances", async () => {
		const header: WorkflowHeader = {
			runId: "2026-10-16_00-00-00-hole",
			workflow: "hole-wf",
			input: "x",
			ts: "2026-10-16T00:00:00Z",
			v: STATE_SCHEMA_VERSION,
		};
		const done: WorkflowStage = {
			session: null,
			stageNumber: 1,
			stage: "impl (phase-1)",
			skill: "impl",
			status: "completed",
			ts: "t1",
			parent: "impl",
			role: "produce",
			unitId: "phase-1",
			unitIndex: 0,
			output: {
				kind: "artifacts",
				artifacts: [{ handle: fsHandle(".rpiv/artifacts/plans/p1.md"), role: "primary" }],
				data: {},
				meta: { stage: "impl", stageNumber: 1, ts: "", runId: "" },
			} satisfies Output,
		};
		const hole: WorkflowStage = {
			session: null,
			stageNumber: 2,
			stage: "impl (phase-2)",
			skill: "impl",
			status: "failed",
			ts: "t2",
			parent: "impl",
			role: "produce",
			unitId: "phase-2",
			unitIndex: 1,
			collected: true,
			errMsg: "impl produced no artifact path",
		};
		const halt: WorkflowStage = {
			session: null,
			stageNumber: 3,
			stage: "impl",
			skill: "impl",
			status: "failed",
			ts: "t3",
		};
		appendHeader(tmpDir, header);
		for (const row of [done, hole, halt]) appendStage(tmpDir, header.runId, row);

		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/plans/p2.md")] },
				{ branch: [mockAssistantMessage("spliced")] },
			],
		});
		const result = await resumeWorkflow(chain.ctx, { workflow: wf(), header, ref: "@x" });
		expect(result.success).toBe(true);
		expect(chain.sentMessages[0]).toMatch(/^\/skill:impl phase 2/);
		const rows = readAllStages(tmpDir, header.runId);
		expect(rows.find((r) => r.stage === "impl (phase-2)" && r.status === "completed")).toBeDefined();
	});
});
