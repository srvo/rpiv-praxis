/**
 * Stage completion needs proof (kata mykj) — end-to-end over a scripted session
 * chain:
 *   - a clean `stop` whose final text carries leaked tool-call markup is retried
 *     ONCE in-session; a second leak halts as infra death;
 *   - a collection miss gets ONE in-session nudge before the stage halts.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockSessionChain, mockAssistantMessage } from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StageDef, Workflow } from "./api.js";
import { defineWorkflow, produces } from "./api.js";
import { fs as fsHandle } from "./handle.js";
import { fanout } from "./loop-constructors.js";
import type { Outcome } from "./output-spec.js";
import { runWorkflow } from "./runner/index.js";
import { hasLeakedToolMarkup } from "./transcript.js";

const PATH_RE = /\.rpiv\/artifacts\/[\w-]+\/[\w.-]+\.md/g;

/** Transcript-only outcome: the last announced path wins, no disk read. */
const announced: Outcome = {
	collector: {
		collect: (ctx) => {
			const start = Math.max(ctx.branchOffset ?? 0, 0);
			for (let i = ctx.branch.length - 1; i >= start; i--) {
				const text = ctx.branch[i]?.message?.content?.find((p) => p.type === "text")?.text;
				const hit = text?.match(PATH_RE)?.at(-1);
				if (hit) return { kind: "ok", artifacts: [{ handle: fsHandle(hit), role: "primary" }] };
			}
			return { kind: "fatal", message: `${ctx.skill} finished without producing a path` };
		},
	},
};

const oneStage = (): Workflow =>
	defineWorkflow({
		name: "proof",
		start: "research",
		stages: { research: { kind: "produces", sessionPolicy: "fresh", outcome: announced } as StageDef },
		edges: { research: "stop" },
	});

const DSML = '<｜DSML｜function_calls>\n<｜DSML｜invoke name="write">';

describe("hasLeakedToolMarkup", () => {
	const branch = (text: string) => [mockAssistantMessage(text)] as never[];

	it.each([
		["DeepSeek DSML", `Writing the plan now.\n${DSML}`],
		["DeepSeek special tokens", "<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function"],
		["Kimi section token", "<|tool_calls_section_begin|> functions.write:0"],
		["function_calls block", '<function_calls>\n<invoke name="Write">'],
		["tool_call JSON", '<tool_call>\n{"name": "write", "arguments": {}}'],
	])("detects %s", (_label, text) => {
		expect(hasLeakedToolMarkup(branch(text))).toBe(true);
	});

	it("ignores ordinary prose, including prose that names tool calls", () => {
		expect(hasLeakedToolMarkup(branch("Wrote .rpiv/artifacts/plans/p.md — one tool_call per file."))).toBe(false);
		expect(hasLeakedToolMarkup([])).toBe(false);
	});

	it("reads only the LAST assistant message", () => {
		const b = [mockAssistantMessage(DSML), mockAssistantMessage("done: .rpiv/artifacts/plans/p.md")] as never[];
		expect(hasLeakedToolMarkup(b)).toBe(false);
	});
});

describe("stage completion proof (runWorkflow)", () => {
	let tmpDir: string;
	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-proof-"));
	});
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	const rows = (): Array<Record<string, unknown>> => {
		const dir = join(tmpDir, ".rpiv", "workflows", "runs");
		const [file] = readdirSync(dir);
		return readFileSync(join(dir, file!), "utf-8")
			.trim()
			.split("\n")
			.slice(1)
			.map((l) => JSON.parse(l));
	};

	it("leaked markup on a clean stop is retried once in-session; a clean retry completes", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{
					branch: [mockAssistantMessage(`Saving .rpiv/artifacts/research/r.md\n${DSML}`, "stop")],
					onSend: [{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/research/r.md", "stop")] }],
				},
			],
		});
		const result = await runWorkflow(chain.ctx, { workflow: oneStage(), input: "x" });
		expect(result.success).toBe(true);
		expect(chain.sentMessages).toHaveLength(2);
		expect(chain.sentMessages[1]).toMatch(/raw tool-call markup/);
		expect(rows().map((r) => r.status)).toEqual(["completed"]);
	});

	it("a second leak halts as infra death — the leaked path is NOT collected", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{
					branch: [mockAssistantMessage(`Saving .rpiv/artifacts/research/r.md\n${DSML}`, "stop")],
					onSend: [{ branch: [mockAssistantMessage(`Again .rpiv/artifacts/research/r.md\n${DSML}`, "stop")] }],
				},
			],
		});
		const result = await runWorkflow(chain.ctx, { workflow: oneStage(), input: "x" });
		expect(result.success).toBe(false);
		expect(chain.sentMessages).toHaveLength(2); // exactly one retry
		const [row] = rows();
		expect(row).toMatchObject({ status: "failed" });
		expect(String(row?.errMsg)).toMatch(/leaked tool-call markup/);
	});

	it("a collection miss gets one in-session nudge; the nudged announcement is collected", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{
					branch: [mockAssistantMessage("All done!", "stop")],
					onSend: [{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/research/late.md", "stop")] }],
				},
			],
		});
		const result = await runWorkflow(chain.ctx, { workflow: oneStage(), input: "x" });
		expect(result.success).toBe(true);
		expect(chain.sentMessages[1]).toMatch(/could not be collected: research finished without producing a path/);
		expect(result.lastArtifact).toBe(".rpiv/artifacts/research/late.md");
	});

	it("a miss that survives the nudge halts with the collector's message", async () => {
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("All done!", "stop")], onSend: [{ branch: [] }] }],
		});
		const result = await runWorkflow(chain.ctx, { workflow: oneStage(), input: "x" });
		expect(result.success).toBe(false);
		expect(chain.sentMessages).toHaveLength(2); // exactly one nudge
		expect(String(rows()[0]?.errMsg)).toMatch(/without producing a path/);
	});

	it("a collect-all fanout unit that leaks twice hard-fails (uncollected) so resume re-dispatches it", async () => {
		const wf = {
			name: "proof-fanout",
			start: "impl",
			stages: {
				impl: produces({
					outcome: announced,
					loop: fanout({ units: () => [{ prompt: "u0", label: "u0", id: "u0" }] }),
				}),
			},
			edges: { impl: "stop" },
		} as Workflow;
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [
				{
					branch: [mockAssistantMessage(DSML, "stop")],
					onSend: [{ branch: [mockAssistantMessage(DSML, "stop")] }],
				},
			],
		});
		const result = await runWorkflow(chain.ctx, { workflow: wf, input: "x" });
		expect(result.success).toBe(false);
		expect(rows().filter((r) => r.collected === true)).toHaveLength(0);
	});

	it("the runner opens the stage window: the collector sees stageStartedAtMs from the spawn", async () => {
		const before = Date.now();
		const seen: Array<number | undefined> = [];
		const recording: Outcome = {
			collector: {
				collect: (ctx) => {
					seen.push(ctx.stageStartedAtMs);
					return announced.collector.collect(ctx);
				},
			},
		};
		const wf = defineWorkflow({
			name: "proof-window",
			start: "research",
			stages: { research: { kind: "produces", sessionPolicy: "fresh", outcome: recording } as StageDef },
			edges: { research: "stop" },
		});
		const chain = createMockSessionChain({
			cwd: tmpDir,
			steps: [{ branch: [mockAssistantMessage("Wrote .rpiv/artifacts/research/r.md", "stop")] }],
		});
		expect((await runWorkflow(chain.ctx, { workflow: wf, input: "x" })).success).toBe(true);
		expect(seen).toHaveLength(1);
		expect(seen[0]).toBeGreaterThanOrEqual(before);
		expect(seen[0]).toBeLessThanOrEqual(Date.now());
	});
});
