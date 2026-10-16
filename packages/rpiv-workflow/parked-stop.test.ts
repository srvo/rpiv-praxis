/**
 * A stage that parked on a question (kata 439b) stops like an abort — same
 * `"aborted"` row, so resume re-dispatches it — but is reported as a park:
 * no "workflow aborted", no "artifacts produced before failure".
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockSessionChain, mockAssistantMessage } from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acts, type Workflow } from "./api.js";
import { runWorkflow } from "./runner/index.js";

let tmpDir: string;
beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "rpiv-parked-"));
});
afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

const workflow = { name: "wf", start: "ask", stages: { ask: acts() }, edges: { ask: "stop" } } as Workflow;

const lastRow = (): Record<string, unknown> => {
	const dir = join(tmpDir, ".rpiv", "workflows", "runs");
	const file = readdirSync(dir).find((f) => f.endsWith(".jsonl"))!;
	const rows = readFileSync(join(dir, file), "utf-8").trim().split("\n");
	return JSON.parse(rows[rows.length - 1]!);
};

const runWith = async (parked: boolean) => {
	const chain = createMockSessionChain({
		cwd: tmpDir,
		steps: [{ branch: [mockAssistantMessage("asked", "aborted")], parked }],
	});
	const result = await runWorkflow(chain.ctx, { workflow, input: "x" });
	return { result, notes: chain.notifications.map((n) => n.msg).join("\n") };
};

describe("a parked stage", () => {
	it("is reported as a park, with the same resumable aborted row", async () => {
		const { result, notes } = await runWith(true);
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/stage "ask" parked: waiting for a person's answer/);
		expect(notes).toContain("workflow parked");
		expect(notes).not.toMatch(/workflow aborted|Artifacts produced before failure/);
		expect(lastRow()).toMatchObject({ stage: "ask", status: "aborted" });
	});

	it("a plain abort keeps the abort wording", async () => {
		const { result } = await runWith(false);
		expect(result.error).toMatch(/workflow aborted before stage "ask"/);
	});
});
