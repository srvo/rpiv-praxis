/**
 * Human checkpoints (kata ac4x): a `checkpoint: true` stage tells the host so,
 * via `spawnChild({ checkpoint: true })`; other stages do not.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockSessionChain, mockAssistantMessage } from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acts, type Workflow } from "./api.js";
import { runWorkflow } from "./runner/index.js";

let tmpDir: string;
beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "rpiv-checkpoint-"));
});
afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

describe("checkpoint stages", () => {
	it("only the checkpoint stage's child is opened with checkpoint: true", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("ok")] }, { branch: [mockAssistantMessage("ok")] }],
		});
		const workflow = {
			name: "wf",
			start: "work",
			stages: { work: acts(), review: acts({ checkpoint: true, inheritsArtifacts: false }) },
			edges: { work: "review", review: "stop" },
		} as Workflow;

		const result = await runWorkflow(chain.ctx, { workflow, input: "x" });

		expect(result.error).toBeUndefined();
		const calls = (chain.ctx.spawnChild as unknown as { mock: { calls: Array<[Record<string, unknown>]> } }).mock
			.calls;
		expect(calls.map(([o]) => o.checkpoint)).toEqual([undefined, true]);
	});
});
