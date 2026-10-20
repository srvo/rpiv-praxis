/**
 * rpiv-mcp — rpiv workflows, single steps, and parked questions as MCP tools,
 * so any agent (Claude Code, Codex, Hermes, …) can drive and fan out rpiv work.
 *
 *   list_workflows · list_steps · run_workflow · run_step · run_status · inbox · answer
 *
 * A thin layer over the `rpiv-wf` CLI: anything that runs a model starts
 * `rpiv-wf` as a detached process and returns a run name at once; the agent
 * polls `run_status`. One code path for people and agents, so a workflow
 * behaves the same whichever started it. Quick reads (steps, inbox, status)
 * answer in-process from the files rpiv-wf writes.
 *
 * Detached runs log to `.rpiv/workflows/runs/<name>.mcp.log`; the launcher
 * writes its exit code to `<name>.mcp.exit` when it ends.
 */

import { execFile, spawn as nodeSpawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openParks, readParks, resolveRunId, runsDir } from "./park-store.ts";
import { resolveRunAlias } from "./run-alias.ts";
import { stepSkills } from "./steps.ts";

export const CLI_BIN = join(dirname(fileURLToPath(import.meta.url)), "bin", "rpiv-wf.mjs");

/** rpiv-wf exit code → what a polling agent should make of it. */
export const EXIT_STATE: Record<number, string> = {
	0: "completed",
	1: "failed",
	2: "usage-error",
	75: "parked",
	76: "stopped-budget",
	124: "stopped-timeout",
	130: "interrupted",
};

export interface McpDeps {
	/** Start `rpiv-wf <args>` detached, stdout+stderr to `log`, exit code to `exitFile`. */
	spawnDetached(args: string[], log: string, exitFile: string): void;
	/** Run `rpiv-wf <args>` to completion and capture its output. */
	exec(args: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
	cwd: string;
	rand(): string;
}

export interface RunOptions {
	cwd?: string;
	name?: string;
	model?: string;
	permission_mode?: string;
	concurrency?: number;
}

const statusFiles = (cwd: string, name: string) => ({
	log: join(runsDir(cwd), `${name}.mcp.log`),
	exit: join(runsDir(cwd), `${name}.mcp.exit`),
});

/** A valid run name (`[A-Za-z_][A-Za-z0-9_-]*`, ≤ 64) for a detached run nobody named. */
export function autoName(kind: string, target: string, rand: string): string {
	return `mcp-${kind}-${target}`.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 55) + `-${rand}`;
}

function runFlags(o: RunOptions, cwd: string): string[] {
	return [
		"--cwd",
		cwd,
		...(o.model ? ["--model", o.model] : []),
		...(o.permission_mode ? ["--permission-mode", o.permission_mode] : []),
		...(o.concurrency ? ["--concurrency", String(o.concurrency)] : []),
	];
}

function tail(file: string, lines: number): string[] {
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8").trimEnd().split("\n").slice(-lines);
}

function stageRows(cwd: string, runId: string): Array<{ stage: string; status: string }> {
	const file = join(runsDir(cwd), `${runId}.jsonl`);
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.split("\n")
		.flatMap((l) => {
			try {
				const r = JSON.parse(l) as { stage?: unknown; status?: unknown };
				return typeof r.stage === "string" ? [{ stage: r.stage, status: String(r.status) }] : [];
			} catch {
				return [];
			}
		});
}

export function createTools(deps: McpDeps) {
	const cwdOf = (o: { cwd?: string }) => resolve(o.cwd ?? deps.cwd);

	function start(kind: "run" | "step", target: string, input: string | undefined, o: RunOptions) {
		const cwd = cwdOf(o);
		const name = o.name ?? autoName(kind === "run" ? "wf" : "step", target, deps.rand());
		mkdirSync(runsDir(cwd), { recursive: true });
		const files = statusFiles(cwd, name);
		rmSync(files.exit, { force: true });
		const args = [kind, target, ...(input ? [input] : []), "--name", name, ...runFlags(o, cwd)];
		deps.spawnDetached(args, files.log, files.exit);
		return { run: name, state: "started", poll: `run_status { "run": "${name}" }` };
	}

	return {
		async list_workflows(o: { cwd?: string }) {
			const r = await deps.exec(["list", "--cwd", cwdOf(o)]);
			const workflows = r.stdout
				.split("\n")
				.filter(Boolean)
				.map((l) => {
					const [name, ...d] = l.split("\t");
					return { name, description: d.join("\t") || undefined };
				});
			return { workflows, issues: r.stderr.split("\n").filter(Boolean), ok: r.code === 0 };
		},

		async list_steps(o: { cwd?: string }) {
			return { steps: stepSkills(cwdOf(o)).map(({ name, source, kind }) => ({ name, source, kind })) };
		},

		async run_workflow(o: RunOptions & { workflow: string; input?: string }) {
			return start("run", o.workflow, o.input, o);
		},

		async run_step(o: RunOptions & { skill: string; input?: string }) {
			return start("step", o.skill, o.input, o);
		},

		async run_status(o: { run: string; cwd?: string }) {
			const requested = cwdOf(o);
			// Same order as the CLI (cli.ts resume/answer): a local run wins, and a shared
			// alias is consulted only when no local run has this name. A shared alias points
			// at the worktree that owns the run state, so a sibling must redirect there too.
			const local = resolveRunId(requested, o.run);
			const alias = local === undefined ? resolveRunAlias(requested, o.run) : undefined;
			const cwd = alias?.cwd ?? requested;
			const files = statusFiles(cwd, o.run);
			const runId = alias?.runId ?? local;
			const code = existsSync(files.exit) ? Number(readFileSync(files.exit, "utf8").trim()) : undefined;
			const state =
				code !== undefined
					? (EXIT_STATE[code] ?? `exited-${code}`)
					: existsSync(files.log)
						? runId
							? "running"
							: "starting"
						: runId
							? "not-started-here"
							: "unknown";
			const waiting = runId ? readParks(cwd, runId).filter((p) => p.status !== "resumed") : [];
			return {
				run: o.run,
				runId: runId ?? null,
				state,
				...(alias ? { origin: alias.cwd } : {}),
				stages: runId ? stageRows(cwd, runId) : [],
				waiting: waiting.map(({ n, stage, questions, status, kata }) => ({ n, stage, questions, status, kata })),
				log: tail(files.log, 15),
			};
		},

		async inbox(o: { cwd?: string }) {
			return {
				waiting: openParks(cwdOf(o)).map(
					({ runId, n, workflow, stage, questions, status, askedAt, answer, kata }) => ({
						runId,
						n,
						workflow,
						stage,
						questions,
						status,
						askedAt,
						answer,
						kata,
					}),
				),
			};
		},

		async answer(o: RunOptions & { run: string; n: number; choice: string; resume?: boolean }) {
			const cwd = cwdOf(o);
			const base = ["answer", o.run, String(o.n), o.choice];
			if (o.resume === false) {
				const r = await deps.exec([...base, "--no-resume", "--cwd", cwd]);
				return { run: o.run, state: r.code === 0 ? "answered" : "error", output: (r.stdout + r.stderr).trim() };
			}
			mkdirSync(runsDir(cwd), { recursive: true });
			const files = statusFiles(cwd, o.run);
			rmSync(files.exit, { force: true });
			deps.spawnDetached([...base, ...runFlags(o, cwd)], files.log, files.exit);
			return { run: o.run, state: "resuming", poll: `run_status { "run": "${o.run}" }` };
		},
	};
}

/** Real process wiring: detached `node rpiv-wf.mjs`, surviving the MCP server. */
export function nodeDeps(cwd = process.cwd()): McpDeps {
	return {
		cwd,
		rand: () => Math.random().toString(36).slice(2, 8),
		spawnDetached(args, log, exitFile) {
			const fd = openSync(log, "a");
			const child = nodeSpawn(process.execPath, [CLI_BIN, ...args], {
				detached: true,
				stdio: ["ignore", fd, fd],
				env: { ...process.env, RPIV_WF_EXIT_FILE: exitFile },
			});
			child.unref();
		},
		exec: (args) =>
			new Promise((done) => {
				execFile(process.execPath, [CLI_BIN, ...args], { timeout: 120_000 }, (err, stdout, stderr) => {
					const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
					done({ code, stdout: String(stdout), stderr: String(stderr) });
				});
			}),
	};
}

export async function startServer(deps: McpDeps = nodeDeps()): Promise<void> {
	const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
	const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
	const { z } = await import("zod");
	const server = new McpServer({ name: "rpiv", version: "1" });
	registerTools(server, createTools(deps), z);
	await server.connect(new StdioServerTransport());
}

type Tools = ReturnType<typeof createTools>;

/** Register every tool with its schema. Exported for the in-memory protocol test. */
export function registerTools(server: any, tools: Tools, z: typeof import("zod").z): void {
	const json = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });
	const cwd = z.string().optional().describe("Project directory (default: the server's working directory)");
	const runOpts = {
		cwd,
		name: z.string().optional().describe("Run name to resume or poll by (default: generated)"),
		model: z.string().optional().describe("Claude model for every stage"),
		permission_mode: z
			.enum(["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"])
			.optional()
			.describe("Claude Code permission mode for each stage (default auto)"),
		concurrency: z.number().int().positive().optional().describe("Parallel fan-out units (default 4)"),
	};
	const tool = (name: keyof Tools, description: string, inputSchema: Record<string, unknown>) =>
		server.registerTool(name, { description, inputSchema }, async (args: any) => json(await tools[name](args)));

	tool("list_workflows", "List rpiv workflows available in the project (built-ins plus project packs).", { cwd });
	tool("list_steps", "List skills that run_step can run on their own, with source (rpiv/project/user) and kind.", {
		cwd,
	});
	tool(
		"run_workflow",
		"Start an rpiv workflow in the background. Returns a run name at once; poll run_status. A stage that needs a person parks the run (state 'parked'); answer it with `answer`.",
		{
			...runOpts,
			workflow: z.string().describe("Workflow name, e.g. ship, vet, build"),
			input: z.string().optional(),
		},
	);
	tool(
		"run_step",
		"Run ONE rpiv skill as a single checked, logged, resumable step in the background (e.g. research, quick-plan, code-review, validate). Returns a run name; poll run_status.",
		{ ...runOpts, skill: z.string().describe("Skill name from list_steps"), input: z.string().optional() },
	);
	tool(
		"run_status",
		"State of a run started here (running | completed | failed | parked | interrupted), its stages, any waiting question, and the log tail.",
		{ run: z.string().describe("Run name or id"), cwd },
	);
	tool("inbox", "Questions parked runs are waiting on, oldest first.", { cwd });
	tool("answer", "Answer a parked question and resume its run in the background (resume=false only records it).", {
		...runOpts,
		run: z.string().describe("Run name or id"),
		n: z.number().int().positive().describe("Question number from inbox"),
		choice: z.string().describe("Option number, option label, or free text"),
		resume: z.boolean().optional(),
	});
}
