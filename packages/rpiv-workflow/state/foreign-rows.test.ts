/**
 * Host telemetry rows in the run JSONL (rpiv-praxis's usage/invocation ledger)
 * carry a `type` and no `stageNumber`, so every engine reader skips them — the
 * resume fold never mistakes one for a malformed stage row.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendHeader, appendStage, readAllStages, readAllStagesForResume, STATE_SCHEMA_VERSION } from "./index.ts";
import { appendLoopCap } from "./writes.ts";

let cwd: string;
beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "rpiv-foreign-rows-"));
});
afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
});

describe("foreign telemetry rows", () => {
	it("usage and invocation rows are invisible to the stage readers and the resume fold", () => {
		const runId = "2026-10-16_00-00-00-aaaa";
		appendHeader(cwd, { runId, workflow: "wf", input: "x", ts: "t0", v: STATE_SCHEMA_VERSION });
		// Same writer path the ledger shape takes: one JSON object per line.
		appendLoopCap(cwd, runId, { type: "invocation", ts: "t1", invocation: "a", kind: "run" } as never);
		appendStage(cwd, runId, {
			session: null,
			stageNumber: 1,
			stage: "plan",
			skill: "plan",
			status: "completed",
			ts: "t2",
		});
		appendLoopCap(cwd, runId, {
			type: "usage",
			ts: "t3",
			invocation: "a",
			stage: "plan",
			sessionId: "s1",
			inputTokens: 5,
		} as never);
		expect(readAllStages(cwd, runId)).toHaveLength(1);
		const resume = readAllStagesForResume(cwd, runId);
		expect(resume.ok).toBe(true);
		expect(resume.ok && resume.rows).toHaveLength(1);
	});
});
