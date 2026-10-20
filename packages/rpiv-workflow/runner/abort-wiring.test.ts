/**
 * Cancellation wiring — the runner, not just the helper.
 *
 * `combineAbortSignals` is only meaningful if `runWorkflow` threads the combined
 * signal into dispatch. These tests drive the real runner with BOTH a caller
 * signal and a provider-owned signal present, and abort each one independently:
 * either must stop the run. A helper-only test would stay green if the runner
 * dropped `options.signal` (or `exec.signal`) on the floor.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockSessionChain, mockAssistantMessage } from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineWorkflow } from "../api.ts";
import { __resetWorkflowExecutionHost, registerWorkflowExecutionHost } from "../execution-host.ts";
import { runWorkflow } from "./runner.ts";

let tmpDir: string;
beforeEach(() => {
	__resetWorkflowExecutionHost();
	tmpDir = mkdtempSync(join(tmpdir(), "rpiv-abort-wiring-"));
});
afterEach(() => {
	__resetWorkflowExecutionHost();
	rmSync(tmpDir, { recursive: true, force: true });
});

/** Linear side-effect stages: each stage completes on its own, no artifact needed. */
const wf = (name: string, stages: string[]) => {
	const stageMap: Record<string, { kind: "side-effect"; sessionPolicy: "fresh" }> = {};
	const edges: Record<string, string> = {};
	stages.forEach((id, i) => {
		stageMap[id] = { kind: "side-effect", sessionPolicy: "fresh" };
		edges[id] = stages[i + 1] ?? "stop";
	});
	return defineWorkflow({ name, start: stages[0]!, stages: stageMap, edges } as never);
};

/** Register a provider whose `createHost` exposes a provider-owned abort signal. */
function providerWithSignal(): AbortController {
	const owned = new AbortController();
	registerWorkflowExecutionHost({
		createHost: (observer) => ({ host: observer, signal: owned.signal }),
	});
	return owned;
}

describe("runWorkflow cancellation wiring (caller + provider signals)", () => {
	it("aborts the run when only the CALLER signal fires", async () => {
		const caller = new AbortController();
		const provider = providerWithSignal(); // present but never aborted
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("done")] }, { branch: [mockAssistantMessage("done")] }],
		});

		const result = await runWorkflow(chain.ctx, {
			workflow: wf("two", ["research", "design"]),
			input: "x",
			signal: caller.signal,
			lifecycle: {
				onStageEnd: (stage) => {
					if (stage.name === "research") caller.abort();
				},
			},
		});

		expect(provider.signal.aborted).toBe(false);
		expect(result.success).toBe(false);
		expect(result.stagesCompleted).toBe(1);
		expect(result.error).toMatch(/aborted/i);
		expect(chain.ctx.spawnChild).toHaveBeenCalledTimes(1);
	});

	it("aborts the run when only the PROVIDER signal fires", async () => {
		const caller = new AbortController(); // present but never aborted
		const provider = providerWithSignal();
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("done")] }, { branch: [mockAssistantMessage("done")] }],
		});

		const result = await runWorkflow(chain.ctx, {
			workflow: wf("two", ["research", "design"]),
			input: "x",
			signal: caller.signal,
			lifecycle: {
				onStageEnd: (stage) => {
					if (stage.name === "research") provider.abort();
				},
			},
		});

		expect(caller.signal.aborted).toBe(false);
		expect(result.success).toBe(false);
		expect(result.stagesCompleted).toBe(1);
		expect(result.error).toMatch(/aborted/i);
		expect(chain.ctx.spawnChild).toHaveBeenCalledTimes(1);
	});

	it("a run with both signals live completes normally", async () => {
		const caller = new AbortController();
		providerWithSignal();
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("done")] }, { branch: [mockAssistantMessage("done")] }],
		});

		const result = await runWorkflow(chain.ctx, {
			workflow: wf("one", ["research"]),
			input: "x",
			signal: caller.signal,
		});

		expect(result.success).toBe(true);
		expect(result.stagesCompleted).toBe(1);
	});
});
