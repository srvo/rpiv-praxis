import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createMockSessionChain } from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acts, type Workflow } from "../api.ts";
import { registerWorkflowExecutionHost } from "../execution-host.ts";
import { readAllStages, readHeader } from "../state/index.ts";
import { acquireResumeLock } from "./resume-lock.ts";
import { resumeWorkflow, runWorkflow } from "./runner.ts";

let cwd: string;
beforeEach(() => {
	cwd = process.env.RPIV_FRESH_RUN_CWD ?? mkdtempSync(join(tmpdir(), "rpiv-run-exclusion-"));
});
afterEach(() => {
	if (!process.env.RPIV_FRESH_RUN_CWD) rmSync(cwd, { recursive: true, force: true });
});

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("fresh-run execution lease", () => {
	it.each(["same-process", "child-process"])("refuses resume during fresh execution (%s)", async (mode) => {
		const entered = deferred();
		const release = deferred();
		let executions = 0;
		let runId = "";
		const workflow: Workflow = {
			name: "fresh-owner",
			start: "first",
			stages: {
				first: acts.script({ run: async () => {} }),
				second: acts.script({
					run: async () => {
						executions++;
						if (process.env.RPIV_FRESH_RUN_ID) throw new Error("duplicate dispatch in child process");
						if (executions === 1) {
							entered.resolve();
							await release.promise;
						}
					},
				}),
			},
			edges: { first: "second", second: "stop" },
		};
		const chain = createMockSessionChain({ cwd, steps: [] });
		const existingId = process.env.RPIV_FRESH_RUN_ID;
		if (existingId) {
			const rejected = await resumeWorkflow(chain.ctx, {
				workflow,
				header: readHeader(cwd, existingId)!,
				ref: `@${existingId}`,
			});
			expect(rejected.success).toBe(false);
			expect(rejected.error).toMatch(/already executing/);
			expect(executions).toBe(0);
			return;
		}
		const owner = runWorkflow(chain.ctx, {
			workflow,
			input: "x",
			lifecycle: {
				onWorkflowStart: (ctx) => {
					runId = ctx.runId;
				},
			},
		});
		await entered.promise;
		let before = "";
		let after = "";
		try {
			const header = readHeader(cwd, runId)!;
			const path = join(cwd, ".rpiv", "workflows", "runs", `${runId}.jsonl`);
			before = readFileSync(path, "utf8");
			if (mode === "same-process") {
				const rejected = await resumeWorkflow(chain.ctx, { workflow, header, ref: `@${runId}` });
				expect(rejected.success).toBe(false);
				expect(rejected.error).toMatch(/already executing/);
			} else {
				const child = spawnSync(
					process.execPath,
					[
						resolve("node_modules/vitest/vitest.mjs"),
						"run",
						fileURLToPath(import.meta.url),
						"-t",
						"child-process",
						"--maxWorkers=1",
					],
					{
						encoding: "utf8",
						timeout: 30_000,
						env: { ...process.env, RPIV_FRESH_RUN_CWD: cwd, RPIV_FRESH_RUN_ID: runId },
					},
				);
				expect(child.error, child.stdout + child.stderr).toBeUndefined();
				expect(child.status, child.stdout + child.stderr).toBe(0);
			}
			after = readFileSync(path, "utf8");
		} finally {
			release.resolve();
		}
		const completed = await owner;
		expect(after).toBe(before);
		expect(executions).toBe(1);
		expect(completed.success).toBe(true);
		expect(readAllStages(cwd, runId).filter((row) => row.stage === "second")).toHaveLength(1);
		const nextOwner = acquireResumeLock(cwd, runId);
		nextOwner();
	});

	it.each(["create", "dispose"])("releases the lease after provider %s throws", async (failure) => {
		const chain = createMockSessionChain({ cwd, steps: [] });
		let runId = "";
		let checks = 0;
		const assertHeld = () => {
			expect(() => acquireResumeLock(cwd, runId)).toThrow(/already executing/);
			checks++;
		};
		const unregister = registerWorkflowExecutionHost({
			createHost: (_observer, opts) => {
				runId = opts.runId;
				assertHeld();
				if (failure === "create") throw new Error("host failed");
				return {
					host: chain.ctx,
					dispose: () => {
						assertHeld();
						throw new Error("host failed");
					},
				};
			},
		});
		const workflow: Workflow = {
			name: "provider-failure",
			start: "effect",
			stages: { effect: acts.script({ run: async () => {} }) },
			edges: { effect: "stop" },
		};
		try {
			await expect(runWorkflow(chain.ctx, { workflow, input: "x" })).rejects.toThrow("host failed");
			expect(checks).toBe(failure === "create" ? 1 : 2);
			const nextOwner = acquireResumeLock(cwd, runId);
			nextOwner();
		} finally {
			unregister();
		}
	});

	it("releases the fresh lease after stage failure so the run can be retried", async () => {
		let fail = true;
		const workflow: Workflow = {
			name: "retry-owner",
			start: "effect",
			stages: {
				effect: acts.script({
					run: async () => {
						if (fail) throw new Error("retry me");
					},
				}),
			},
			edges: { effect: "stop" },
		};
		const chain = createMockSessionChain({ cwd, steps: [] });
		const result = await runWorkflow(chain.ctx, { workflow, input: "x" });
		expect(result.success).toBe(false);
		fail = false;
		const resumed = await resumeWorkflow(chain.ctx, {
			workflow,
			header: readHeader(cwd, result.runId!)!,
			ref: `@${result.runId}`,
		});
		expect(resumed.success).toBe(true);
	});
});
