/**
 * Pack-level model policy (`Workflow.models`, kata rb2w): per-stage pins and
 * the escalate-on-failed-verdict ladder. Pure resolution is unit-tested; the
 * wiring is pinned end-to-end through `runWorkflow` by reading the model each
 * spawned child was handed and the `model-escalation` rows in the run log.
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockSessionChain, mockAssistantMessage } from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acts, defineRoute, produces, type VerifySpec, type Workflow } from "./api.js";
import { fs as fsHandle } from "./handle.js";
import { judge } from "./judge.js";
import { verify } from "./loop-constructors.js";
import type { Output } from "./output.js";
import type { Outcome } from "./output-spec.js";
import { runWorkflow } from "./runner/index.js";
import { baseStageModel, escalatedModel, singleStageModel } from "./stage-models.js";
import { stateFilePath } from "./state/paths.js";
import { validateWorkflow } from "./validate-workflow.js";

const LADDER = ["haiku", "sonnet", "opus"] as const;
const wf = (models?: Workflow["models"]): Workflow =>
	({ name: "wf", start: "build", stages: {}, edges: {}, models }) as Workflow;

describe("baseStageModel — pin, then run resolver, then host default", () => {
	it("a pin wins over the run resolver and keeps the resolver's thinking", () => {
		const resolve = () => ({ model: "sonnet", thinking: "high" as const });
		expect(baseStageModel(wf({ stages: { build: "opus" } }), resolve, "build", "build")).toEqual({
			model: "opus",
			thinking: "high",
		});
	});

	it("an unpinned stage uses the run resolver (run-wide --model stays the default)", () => {
		expect(baseStageModel(wf({ stages: { other: "opus" } }), () => ({ model: "sonnet" }), "build", "b")).toEqual({
			model: "sonnet",
		});
	});

	it("no pin and no resolver → undefined (host default)", () => {
		expect(baseStageModel(wf(), undefined, "build", "build")).toBeUndefined();
	});
});

describe("escalatedModel — one ladder step per failed round, capped at the top", () => {
	const w = wf({ escalate: { ladder: LADDER } });

	it("climbs from the base's ladder position", () => {
		expect(escalatedModel(w, { model: "haiku" }, 1)).toBe("sonnet");
		expect(escalatedModel(w, { model: "haiku" }, 2)).toBe("opus");
		expect(escalatedModel(w, { model: "haiku" }, 5)).toBe("opus");
		expect(escalatedModel(w, { model: "sonnet" }, 1)).toBe("opus");
	});

	it("an off-ladder or unknown base starts below the ladder", () => {
		expect(escalatedModel(w, undefined, 1)).toBe("haiku");
		expect(escalatedModel(w, { model: "other" }, 2)).toBe("sonnet");
	});

	it("round 0 and a missing ladder never escalate", () => {
		expect(escalatedModel(w, { model: "haiku" }, 0)).toBeUndefined();
		expect(escalatedModel(wf(), { model: "haiku" }, 1)).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// End-to-end: a verify-bearing stage under a ladder
// ---------------------------------------------------------------------------

let tmpDir: string;
beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "rpiv-models-"));
});
afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

const MD = /\.rpiv\/artifacts\/[\w.-]+\/[\w.-]+\.md/;
const JSON_PATH = /\.rpiv\/verdicts\/[\w.-]+\.json/;

const lastText = (ctx: { branch: unknown[]; branchOffset?: number }, re: RegExp): string | undefined => {
	let found: string | undefined;
	for (const entry of ctx.branch.slice(Math.max(ctx.branchOffset ?? 0, 0)) as Array<{
		type?: string;
		message?: { role?: string; content?: Array<{ type?: string; text?: string }> };
	}>) {
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
		for (const part of entry.message.content ?? []) {
			const m = part.type === "text" ? part.text?.match(re) : null;
			if (m) found = m[0];
		}
	}
	return found;
};

const pathOutcome = (
	name: string,
	re: RegExp,
	parseJson: boolean,
): Outcome<unknown, string, Record<string, unknown>> & { name: string } =>
	({
		name,
		collector: {
			collect: (ctx: { branch: unknown[]; branchOffset?: number; skill: string }) => {
				const path = lastText(ctx, re);
				if (!path) return { kind: "fatal", message: `${ctx.skill} produced no path` };
				return { kind: "ok", artifacts: [{ handle: fsHandle(path), role: "primary" }] };
			},
		},
		parser: {
			parse: (ctx: { cwd: string; artifacts: Array<{ handle: { kind: string; path?: string } }> }) => {
				const path = ctx.artifacts[0]?.handle.path;
				const data = parseJson && path ? JSON.parse(readFileSync(join(ctx.cwd, path), "utf-8")) : {};
				return { kind: "ok", payload: { kind: name, data } };
			},
		},
	}) as unknown as Outcome<unknown, string, Record<string, unknown>> & { name: string };

const writeVerdict = (n: number, done: boolean): void => {
	mkdirSync(join(tmpDir, ".rpiv", "verdicts"), { recursive: true });
	writeFileSync(join(tmpDir, ".rpiv", "verdicts", `v${n}.json`), JSON.stringify({ done }));
};

const runRows = (): Array<Record<string, unknown>> => {
	const dir = join(tmpDir, ".rpiv", "workflows", "runs");
	const [file] = readdirSync(dir);
	return readFileSync(join(dir, file!), "utf-8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l));
};

const gated = (models: Workflow["models"]): Workflow => {
	const v: VerifySpec = verify({
		judge: judge({ skill: "grade", outcome: pathOutcome("verdict", JSON_PATH, true) }),
		done: (o: Output) => Boolean((o.data as { done?: boolean }).done),
		feedForward: ({ round }) => `fix round=${round}`,
		max: 3,
	});
	return {
		name: "gated",
		start: "build",
		stages: { build: produces({ outcome: pathOutcome("impl", MD, false), verify: v }), consume: acts() },
		edges: { build: "consume", consume: "stop" },
		models,
	} as Workflow;
};

const chainFor = () =>
	createMockSessionChain({
		cwd: tmpDir,
		steps: [
			{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/impl/i0.md")] },
			{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/v0.json")] },
			{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/impl/i1.md")] },
			{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/v1.json")] },
			{ branch: [mockAssistantMessage("wrote .rpiv/artifacts/impl/i2.md")] },
			{ branch: [mockAssistantMessage("verdict .rpiv/verdicts/v2.json")] },
			{ branch: [mockAssistantMessage("consumed")] },
		],
	});

const spawnedModels = (chain: ReturnType<typeof createMockSessionChain>): Array<string | undefined> =>
	(chain.ctx.spawnChild as unknown as { mock: { calls: Array<[{ model?: { model?: string } }]> } }).mock.calls.map(
		([o]) => o.model?.model,
	);

describe("runWorkflow — pins and failed-verify escalation", () => {
	it("a failed verify retries the producer one ladder step up, and each step is logged", async () => {
		writeVerdict(0, false);
		writeVerdict(1, false);
		writeVerdict(2, true);
		const chain = chainFor();

		const result = await runWorkflow(chain.ctx, {
			workflow: gated({ stages: { build: "haiku", consume: "sonnet" }, escalate: { ladder: LADDER } }),
			input: "x",
		});

		expect(result.success).toBe(true);
		// attempt/verify ×3 then consume: producers climb haiku → sonnet → opus; judges
		// and the consumer keep their stage's pin.
		expect(spawnedModels(chain)).toEqual(["haiku", "haiku", "sonnet", "haiku", "opus", "haiku", "sonnet"]);
		const escalations = runRows().filter((r) => r.type === "model-escalation");
		expect(escalations).toMatchObject([
			{ stage: "build", round: 1, from: "haiku", to: "sonnet", reason: "verdict failed in round 0" },
			{ stage: "build", round: 2, from: "haiku", to: "opus", reason: "verdict failed in round 1" },
		]);
	});

	it("without a ladder a failed verify retries on the same model and logs nothing", async () => {
		writeVerdict(0, false);
		writeVerdict(1, false);
		writeVerdict(2, true);
		const chain = chainFor();

		const result = await runWorkflow(chain.ctx, { workflow: gated({ stages: { build: "haiku" } }), input: "x" });

		expect(result.success).toBe(true);
		expect(spawnedModels(chain).slice(0, 6)).toEqual(["haiku", "haiku", "haiku", "haiku", "haiku", "haiku"]);
		expect(runRows().filter((r) => r.type === "model-escalation")).toEqual([]);
	});
});

describe("runWorkflow — grade → fix back-edge escalation (escalate.revisits)", () => {
	const fixLoop = (models: Workflow["models"]): Workflow => {
		let grades = 0;
		return {
			name: "laps",
			start: "plan",
			stages: {
				plan: produces({ outcome: pathOutcome("p", MD, false) }),
				grade: produces({ outcome: pathOutcome("g", MD, false) }),
				fix: produces({ outcome: pathOutcome("f", MD, false) }),
				done: acts(),
			},
			edges: {
				plan: "grade",
				grade: defineRoute(["fix", "done"], () => (++grades < 4 ? "fix" : "done")),
				fix: "grade",
				done: "stop",
			},
			models,
		} as Workflow;
	};
	const steps = (n: number) =>
		createMockSessionChain({
			cwd: tmpDir,
			steps: Array.from({ length: n }, (_, i) => ({
				branch: [mockAssistantMessage(`wrote .rpiv/artifacts/lap/s${i}.md`)],
			})),
		});

	it("each repeat fix lap climbs one ladder step; the first runs on the stage's pin", async () => {
		const chain = steps(9);
		const result = await runWorkflow(chain.ctx, {
			workflow: fixLoop({ stages: { fix: "haiku" }, escalate: { ladder: LADDER, revisits: ["fix"] } }),
			input: "x",
		});

		expect(result.error).toBeUndefined();
		// plan, grade, fix, grade, fix, grade, fix, grade, done
		const models = spawnedModels(chain);
		expect([models[2], models[4], models[6]]).toEqual(["haiku", "sonnet", "opus"]);
		expect(runRows().filter((r) => r.type === "model-escalation")).toMatchObject([
			{ stage: "fix", round: 1, from: "haiku", to: "sonnet" },
			{ stage: "fix", round: 2, from: "haiku", to: "opus" },
		]);
	});

	it("a stage not listed in revisits keeps its pin on every lap", async () => {
		const chain = steps(9);
		await runWorkflow(chain.ctx, {
			workflow: fixLoop({ stages: { fix: "haiku" }, escalate: { ladder: LADDER } }),
			input: "x",
		});
		const models = spawnedModels(chain);
		expect([models[2], models[4], models[6]]).toEqual(["haiku", "haiku", "haiku"]);
	});
});

describe("singleStageModel — only completed top-level visits count as laps", () => {
	it("ignores failed visits (a resume retry) and same-named loop-unit rows", () => {
		const file = stateFilePath(tmpDir, "r1");
		mkdirSync(join(file, ".."), { recursive: true });
		const row = (o: Record<string, unknown>) => JSON.stringify({ stageNumber: 1, ts: "t", ...o });
		writeFileSync(
			file,
			`${[
				JSON.stringify({ runId: "r1", workflow: "wf", input: "x", ts: "t" }),
				row({ stage: "fix", status: "completed" }),
				row({ stage: "fix", status: "failed" }),
				row({ stage: "fix", status: "completed", parent: "fix", unitIndex: 0 }),
			].join("\n")}\n`,
		);
		const run = {
			cwd: tmpDir,
			runId: "r1",
			workflow: wf({ stages: { fix: "haiku" }, escalate: { ladder: LADDER, revisits: ["fix"] } }),
		};
		expect(singleStageModel(run, "fix", "fix")).toEqual({ model: "sonnet" });
	});
});

describe("validateWorkflow — models", () => {
	const codes = (models: unknown): string[] =>
		validateWorkflow({ ...gated({}), models } as Workflow)
			.filter((i) => i.severity === "error")
			.map((i) => i.code);

	it("accepts pins on declared stages and a non-empty ladder", () => {
		expect(codes({ stages: { build: "haiku" }, escalate: { ladder: LADDER } })).toEqual([]);
	});

	it("rejects a pin on an undeclared stage (a typo would otherwise pin nothing)", () => {
		expect(codes({ stages: { biuld: "haiku" } })).toEqual(["models-stage-unknown"]);
	});

	it("rejects an empty pin and an empty or non-string ladder", () => {
		expect(codes({ stages: { build: "" } })).toEqual(["models-pin-invalid"]);
		expect(codes({ escalate: { ladder: [] } })).toEqual(["models-ladder-invalid"]);
		expect(codes({ escalate: { ladder: ["haiku", 3] } })).toEqual(["models-ladder-invalid"]);
		expect(codes({ escalate: { ladder: LADDER, revisits: ["nope"] } })).toEqual(["models-revisit-unknown"]);
	});
});
