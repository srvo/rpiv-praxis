import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { autoName, createTools, type McpDeps, registerTools } from "./mcp.js";
import { addPark, runsDir } from "./park-store.js";

function setup(execOut = { code: 0, stdout: "build\tthe big one\nvet\n", stderr: "" }) {
	const cwd = mkdtempSync(join(tmpdir(), "rpiv-mcp-"));
	const spawned: Array<{ args: string[]; log: string; exit: string }> = [];
	const deps: McpDeps = {
		cwd,
		rand: () => "abc123",
		spawnDetached: (args, log, exit) => spawned.push({ args, log, exit }),
		exec: vi.fn(async () => execOut),
	};
	return { cwd, spawned, deps, tools: createTools(deps) };
}

describe("autoName", () => {
	it("makes a valid, bounded run name", () => {
		expect(autoName("step", "code-review", "x1")).toBe("mcp-step-code-review-x1");
		expect(autoName("wf", "a/b c", "x1")).toBe("mcp-wf-a-b-c-x1");
		expect(autoName("wf", "y".repeat(100), "x1").length).toBeLessThanOrEqual(64);
	});
});

describe("starting runs", () => {
	it("run_step starts rpiv-wf step detached and returns a name to poll", async () => {
		const { cwd, spawned, tools } = setup();
		const r = await tools.run_step({ skill: "research", input: "how does x work", model: "opus", concurrency: 2 });
		expect(r).toEqual({ run: "mcp-step-research-abc123", state: "started", poll: expect.any(String) });
		expect(spawned[0]!.args).toEqual([
			"step",
			"research",
			"how does x work",
			"--name",
			"mcp-step-research-abc123",
			"--cwd",
			cwd,
			"--model",
			"opus",
			"--concurrency",
			"2",
		]);
		expect(spawned[0]!.log).toBe(join(runsDir(cwd), "mcp-step-research-abc123.mcp.log"));
	});

	it("run_workflow honours a given name and permission mode", async () => {
		const { spawned, tools } = setup();
		const r = await tools.run_workflow({ workflow: "ship", name: "dm", permission_mode: "auto" });
		expect(r.run).toBe("dm");
		expect(spawned[0]!.args).toEqual(
			expect.arrayContaining(["run", "ship", "--name", "dm", "--permission-mode", "auto"]),
		);
	});
});

describe("run_status", () => {
	it("reads progress from the files rpiv-wf writes", async () => {
		const { cwd, tools } = setup();
		mkdirSync(runsDir(cwd), { recursive: true });
		const status = (run: string) => tools.run_status({ run });
		expect((await status("nope")).state).toBe("unknown");

		writeFileSync(join(runsDir(cwd), "dm.mcp.log"), "line1\nline2\n");
		expect((await status("dm")).state).toBe("starting");

		writeFileSync(
			join(runsDir(cwd), "r1.jsonl"),
			'{"runId":"r1"}\n{"stage":"plan","status":"completed"}\nnot json\n',
		);
		writeFileSync(join(runsDir(cwd), "names.json"), JSON.stringify({ dm: "r1" }));
		const running = await status("dm");
		expect(running).toMatchObject({
			runId: "r1",
			state: "running",
			stages: [{ stage: "plan", status: "completed" }],
		});
		expect(running.log).toEqual(["line1", "line2"]);

		addPark(cwd, { runId: "r1", stage: "plan", prompt: "p", sessionId: "s", questions: [] });
		for (const [code, state] of [
			["75", "parked"],
			["0", "completed"],
			["1", "failed"],
			["130", "interrupted"],
			["9", "exited-9"],
		]) {
			writeFileSync(join(runsDir(cwd), "dm.mcp.exit"), `${code}\n`);
			expect((await status("dm")).state).toBe(state);
		}
		expect((await status("dm")).waiting).toHaveLength(1);
		expect((await status("r1")).state).toBe("not-started-here");
	});
});

describe("inbox, answer, listings", () => {
	it("inbox returns open parks; answer resumes detached or records only", async () => {
		const { cwd, spawned, deps, tools } = setup({ code: 0, stdout: "answered r1 #1: Blue\n", stderr: "" });
		addPark(cwd, { runId: "r1", workflow: "wf", stage: "pick", prompt: "p", sessionId: "s", questions: [] });
		expect((await tools.inbox({})).waiting).toMatchObject([{ runId: "r1", n: 1, stage: "pick" }]);

		expect(await tools.answer({ run: "dm", n: 1, choice: "Blue" })).toMatchObject({ state: "resuming" });
		expect(spawned[0]!.args.slice(0, 4)).toEqual(["answer", "dm", "1", "Blue"]);

		expect(await tools.answer({ run: "dm", n: 1, choice: "Blue", resume: false })).toMatchObject({
			state: "answered",
		});
		expect(vi.mocked(deps.exec).mock.calls[0]![0]).toEqual([
			"answer",
			"dm",
			"1",
			"Blue",
			"--no-resume",
			"--cwd",
			cwd,
		]);
	});

	it("list_workflows parses rpiv-wf list; list_steps reads skills in-process", async () => {
		const { tools } = setup({ code: 1, stdout: "build\tthe big one\nvet\n", stderr: "[error] pack broken\n" });
		expect(await tools.list_workflows({})).toEqual({
			workflows: [
				{ name: "build", description: "the big one" },
				{ name: "vet", description: undefined },
			],
			issues: ["[error] pack broken"],
			ok: false,
		});
		expect((await tools.list_steps({})).steps).toContainEqual({ name: "research", source: "rpiv", kind: "produces" });
	});
});

describe("MCP protocol", () => {
	it("exposes every tool with a schema and returns JSON text", async () => {
		const { tools } = setup();
		const server = new McpServer({ name: "rpiv", version: "1" });
		registerTools(server, tools, z);
		const [a, b] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "t", version: "1" });
		await Promise.all([server.connect(a), client.connect(b)]);
		const listed = (await client.listTools()).tools.map((t) => t.name).sort();
		expect(listed).toEqual([
			"answer",
			"inbox",
			"list_steps",
			"list_workflows",
			"run_status",
			"run_step",
			"run_workflow",
		]);
		const res = await client.callTool({ name: "run_step", arguments: { skill: "research" } });
		expect(JSON.parse((res.content as Array<{ text: string }>)[0]!.text).run).toBe("mcp-step-research-abc123");
		const bad = await client.callTool({ name: "answer", arguments: { run: "x", n: "one", choice: "y" } });
		expect(bad.isError).toBe(true);
		await client.close();
	});
});

describe("stale results", () => {
	it("clears a previous exit code before resuming, so status never reports the old result", async () => {
		const { cwd, tools } = setup();
		mkdirSync(runsDir(cwd), { recursive: true });
		writeFileSync(join(runsDir(cwd), "dm.mcp.exit"), "75\n");
		await tools.answer({ run: "dm", n: 1, choice: "Blue" });
		expect(existsSync(join(runsDir(cwd), "dm.mcp.exit"))).toBe(false);
		writeFileSync(join(runsDir(cwd), "dm.mcp.exit"), "1\n");
		await tools.run_step({ skill: "research", name: "dm" });
		expect(existsSync(join(runsDir(cwd), "dm.mcp.exit"))).toBe(false);
	});
});
