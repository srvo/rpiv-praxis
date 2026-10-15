import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunWorkflowResult } from "@juicesharp/rpiv-workflow";
import { describe, expect, it, vi } from "vitest";
import type { ClaudeHostDeps } from "./claude-host.js";
import { EXIT, main, type WorkflowApi } from "./cli.js";
import type { Kata } from "./kata.js";
import { addPark, readParks, runsDir, updatePark } from "./park-store.js";

function plugin(): string {
	const dir = mkdtempSync(join(tmpdir(), "rpiv-cli-plugin-"));
	mkdirSync(join(dir, "skills", "commit"), { recursive: true });
	writeFileSync(join(dir, "skills", "commit", "SKILL.md"), "---\nname: commit\n---\n");
	return dir;
}

function harness(result: RunWorkflowResult = { success: true, stagesCompleted: 2, runId: "r1" }) {
	const out: string[] = [];
	const err: string[] = [];
	const api: WorkflowApi = {
		loadWorkflows: vi.fn(async () => ({
			workflows: [{ name: "build", description: "the big one" }, { name: "mine" }],
		})),
		runWorkflowByName: vi.fn(async () => result),
		resumeWorkflowByRunId: vi.fn(async () => result),
	};
	const deps = { query: vi.fn(), forkSession: vi.fn() } as unknown as ClaudeHostDeps;
	const go = (args: string[], signal?: AbortSignal) =>
		main(args, { out: (l) => out.push(l), err: (l) => err.push(l) }, { api, deps, signal, kata: null });
	return { go, api, out, err };
}

describe("rpiv-wf", () => {
	it("lists workflows", async () => {
		const h = harness();
		expect(await h.go(["list"])).toBe(EXIT.ok);
		expect(h.out).toEqual(["build\tthe big one", "mine"]);
	});

	it("reports load issues on list and fails when any is an error", async () => {
		const h = harness();
		vi.mocked(h.api.loadWorkflows).mockResolvedValueOnce({
			workflows: [{ name: "build" }],
			issues: [
				{ severity: "warning", message: "w" },
				{ severity: "error", message: "pack broken" },
			],
		});
		expect(await h.go(["list"])).toBe(EXIT.failed);
		expect(h.err).toEqual(["[warning] w", "[error] pack broken"]);
	});

	it("runs a workflow with the joined input, a registry host and the requested name", async () => {
		const h = harness({ success: true, stagesCompleted: 3, runId: "r9", lastArtifact: "plan.md" });
		const code = await h.go(["run", "build", "add", "dark", "mode", "--name", "dm", "--plugin-dir", plugin()]);
		expect(code).toBe(EXIT.ok);
		const [ctx, name, input, opts] = vi.mocked(h.api.runWorkflowByName).mock.calls[0]!;
		expect([name, input]).toEqual(["build", "add dark mode"]);
		expect(ctx.maxConcurrency).toBe(4);
		expect(opts).toMatchObject({ name: "dm", trigger: { kind: "programmatic", source: "rpiv-praxis" } });
		expect((opts as { host: { getCommands(): unknown[] } }).host.getCommands()).toEqual([
			{ name: "skill:commit", source: "skill" },
		]);
		expect(h.out).toEqual(["completed (run r9): 3 stage(s)", "artifact: plan.md"]);
	});

	it("resumes by reference", async () => {
		const h = harness();
		expect(await h.go(["resume", "dm", "--plugin-dir", plugin(), "--concurrency", "2"])).toBe(EXIT.ok);
		const [ctx, ref] = vi.mocked(h.api.resumeWorkflowByRunId).mock.calls[0]!;
		expect(ref).toBe("dm");
		expect(ctx.maxConcurrency).toBe(2);
	});

	it("exits 1 with the runner's error on failure", async () => {
		const h = harness({ success: false, stagesCompleted: 1, runId: "r2", error: "gate failed" });
		expect(await h.go(["run", "build", "--plugin-dir", plugin()])).toBe(EXIT.failed);
		expect(h.err.at(-1)).toBe("failed (run r2) after 1 stage(s): gate failed");
	});

	it("exits 130 when interrupted", async () => {
		const ac = new AbortController();
		ac.abort();
		const h = harness({ success: false, stagesCompleted: 0 });
		expect(await h.go(["run", "build", "--plugin-dir", plugin()], ac.signal)).toBe(EXIT.interrupted);
	});

	it.each([
		[[]],
		[["run"]],
		[["resume"]],
		[["deploy", "x"]],
		[["run", "x", "--concurrency", "0"]],
		[["run", "x", "--permission-mode", "yolo"]],
		[["run", "x", "--bogus"]],
	])("rejects %j with a usage error", async (args) => {
		const h = harness();
		expect(await h.go(args)).toBe(EXIT.usage);
		expect(h.api.runWorkflowByName).not.toHaveBeenCalled();
	});

	it("refuses a plugin directory with no skills", async () => {
		const h = harness();
		const empty = mkdtempSync(join(tmpdir(), "rpiv-cli-empty-"));
		expect(await h.go(["run", "build", "--plugin-dir", empty])).toBe(EXIT.usage);
		expect(h.err.join()).toContain("export:hosts");
	});

	it("lists rpiv's built-ins through the real registration, without injection", async () => {
		const out: string[] = [];
		const cwd = mkdtempSync(join(tmpdir(), "rpiv-cli-real-"));
		expect(await main(["list", "--cwd", cwd], { out: (l) => out.push(l), err: () => {} })).toBe(EXIT.ok);
		expect(out.map((l) => l.split("\t")[0])).toEqual(expect.arrayContaining(["build", "ship", "vet", "polish"]));
	});

	it("builds the host on the real Claude Agent SDK when none is injected", async () => {
		const result = { success: true, stagesCompleted: 0 };
		const api = { ...harness().api, runWorkflowByName: vi.fn(async () => result) };
		const code = await main(["run", "x", "--plugin-dir", plugin()], { out: () => {}, err: () => {} }, { api });
		expect(code).toBe(EXIT.ok);
		expect(api.runWorkflowByName).toHaveBeenCalledOnce();
	});
});

describe("rpiv-wf parked questions", () => {
	const ask = { question: "Red or blue?", options: [{ label: "Red" }, { label: "Blue" }] };
	const project = () => {
		const cwd = mkdtempSync(join(tmpdir(), "rpiv-cli-park-"));
		mkdirSync(runsDir(cwd), { recursive: true });
		writeFileSync(join(runsDir(cwd), "r1.jsonl"), "{}\n");
		writeFileSync(join(runsDir(cwd), "names.json"), JSON.stringify({ shed: "r1" }));
		return cwd;
	};
	const park = (cwd: string) =>
		addPark(cwd, {
			runId: "r1",
			workflow: "wf",
			stage: "pick",
			prompt: "/skill:pick",
			sessionId: "s1",
			questions: [ask],
		});
	const io = () => {
		const out: string[] = [];
		const err: string[] = [];
		return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
	};

	it("inbox lists what is waiting, or says nothing is", async () => {
		const cwd = project();
		const a = io();
		expect(await main(["inbox", "--cwd", cwd], a.io)).toBe(EXIT.ok);
		expect(a.out).toEqual(["nothing waiting"]);
		park(cwd);
		const b = io();
		await main(["inbox", "--cwd", cwd], b.io);
		expect(b.out.join("\n")).toContain("Red or blue?");
	});

	it("answer --no-resume records the choice by number and closes the ticket", async () => {
		const cwd = project();
		addPark(cwd, { runId: "r1", prompt: "p", sessionId: "s", questions: [ask], kata: "ab12" } as never);
		const kata: Kata = { file: vi.fn(), close: vi.fn() };
		const h = harness();
		const a = io();
		const code = await main(["answer", "shed", "1", "2", "--no-resume", "--cwd", cwd], a.io, { api: h.api, kata });
		expect(code).toBe(EXIT.ok);
		expect(readParks(cwd, "r1")[0]).toMatchObject({ status: "answered", answer: "Blue" });
		expect(vi.mocked(kata.close).mock.calls[0]![0]).toMatchObject({ kata: "ab12", answer: "Blue" });
		expect(h.api.resumeWorkflowByRunId).not.toHaveBeenCalled();
	});

	it("answer resumes the run by id", async () => {
		const cwd = project();
		park(cwd);
		const h = harness();
		const code = await main(["answer", "shed", "1", "Red", "--cwd", cwd, "--plugin-dir", plugin()], io().io, {
			api: h.api,
			deps: { query: vi.fn(), forkSession: vi.fn() } as never,
			kata: null,
		});
		expect(code).toBe(EXIT.ok);
		expect(vi.mocked(h.api.resumeWorkflowByRunId).mock.calls[0]![1]).toBe("r1");
	});

	it("answer refuses an unknown or already delivered question", async () => {
		const cwd = project();
		park(cwd);
		const a = io();
		expect(await main(["answer", "shed", "7", "Red", "--cwd", cwd], a.io, { api: harness().api, kata: null })).toBe(
			EXIT.usage,
		);
		expect(await main(["answer", "nope", "1", "Red", "--cwd", cwd], a.io, { api: harness().api, kata: null })).toBe(
			EXIT.usage,
		);
		updatePark(cwd, "r1", 1, { status: "resumed" });
		expect(await main(["answer", "shed", "1", "Red", "--cwd", cwd], a.io, { api: harness().api, kata: null })).toBe(
			EXIT.usage,
		);
		expect(await main(["answer", "shed", "1", "--cwd", cwd], a.io, { api: harness().api, kata: null })).toBe(
			EXIT.usage,
		);
	});

	it("a run that parks exits 75 and prints the answer command", async () => {
		const cwd = project();
		const h = harness({ success: false, stagesCompleted: 0, runId: "r9" });
		vi.mocked(h.api.runWorkflowByName).mockImplementationOnce(async (ctx, _n, _i, opts) => {
			const o = opts as { lifecycle: { onWorkflowStart(c: unknown): void } };
			o.lifecycle.onWorkflowStart({ runId: "r9", workflow: "wf" });
			(ctx as unknown as { opts: { parking: { park(i: unknown): void } } }).opts.parking.park({
				prompt: "/skill:pick",
				sessionId: "s1",
				questions: [ask],
			});
			return { success: false, stagesCompleted: 0, runId: "r9" };
		});
		const a = io();
		const code = await main(["run", "wf", "--cwd", cwd, "--plugin-dir", plugin()], a.io, {
			api: h.api,
			deps: { query: vi.fn(), forkSession: vi.fn() } as never,
			kata: null,
		});
		expect(code).toBe(EXIT.parked);
		expect(a.out.at(-1)).toBe("parked: answer with `rpiv-wf answer r9 1 <choice>`");
		expect(readParks(cwd, "r9")).toHaveLength(1);
	});
});

describe("rpiv-wf steps", () => {
	const quiet = { out: () => {}, err: () => {} };

	it("step runs the skill's one-stage workflow with the joined input", async () => {
		const h = harness();
		const cwd = mkdtempSync(join(tmpdir(), "rpiv-cli-step-"));
		const code = await main(["step", "research", "how", "does", "x", "--cwd", cwd, "--plugin-dir", plugin()], quiet, {
			api: h.api,
			deps: { query: vi.fn(), forkSession: vi.fn() } as never,
			kata: null,
		});
		expect(code).toBe(EXIT.ok);
		const [, name, input] = vi.mocked(h.api.runWorkflowByName).mock.calls[0]!;
		expect([name, input]).toEqual(["step-research", "how does x"]);
	});

	it("step refuses an unknown skill", async () => {
		const h = harness();
		const err: string[] = [];
		const code = await main(
			["step", "no-such-skill", "--plugin-dir", plugin()],
			{ out: () => {}, err: (l) => err.push(l) },
			{
				api: h.api,
				kata: null,
			},
		);
		expect(code).toBe(EXIT.usage);
		expect(err.join()).toContain("rpiv-wf steps");
	});

	it("steps lists skills with their source and kind; list hides step workflows", async () => {
		const out: string[] = [];
		expect(await main(["steps"], { out: (l) => out.push(l), err: () => {} })).toBe(EXIT.ok);
		expect(out).toContain("research\trpiv\tproduces");
		const h = harness();
		vi.mocked(h.api.loadWorkflows).mockResolvedValueOnce({
			workflows: [{ name: "build" }, { name: "step-research" }],
		});
		await h.go(["list"]);
		expect(h.out).toEqual(["build"]);
	});
});
