import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunWorkflowResult } from "@juicesharp/rpiv-workflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClaudeHostDeps } from "./claude-host.ts";
import { EXIT, main, type WorkflowApi } from "./cli.ts";
import { hasRunAliasEntry, resolveRunAlias } from "./run-alias.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "rpiv-alias-admission-"));
	roots.push(root);
	const first = join(root, "first");
	const second = join(root, "second");
	mkdirSync(first);
	const git = (...args: string[]) => execFileSync("git", args, { cwd: first, stdio: "ignore" });
	git("init", "-q");
	git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "fixture");
	git("worktree", "add", "-qb", "second", second);
	const registry = join(first, ".git", "rpiv-workflow-aliases");
	mkdirSync(registry);
	const plugin = join(root, "plugin");
	mkdirSync(join(plugin, "skills", "commit"), { recursive: true });
	writeFileSync(join(plugin, "skills", "commit", "SKILL.md"), "---\nname: commit\n---\n");
	return { root, first, second, registry, plugin };
}

type Run = WorkflowApi["runWorkflowByName"];
const success: RunWorkflowResult = { success: true, stagesCompleted: 1, runId: "run-1" };
function harness(plugin: string, run: Run = async () => success) {
	const out: string[] = [];
	const err: string[] = [];
	const api: WorkflowApi = {
		loadWorkflows: vi.fn(),
		runWorkflowByName: vi.fn(run),
		resumeWorkflowByRunId: vi.fn(),
	};
	const deps = { query: vi.fn(), forkSession: vi.fn() } as unknown as ClaudeHostDeps;
	const go = (cwd: string) =>
		main(
			["run", "build", "topic", "--name", "shared", "--cwd", cwd, "--plugin-dir", plugin],
			{ out: (line) => out.push(line), err: (line) => err.push(line) },
			{ api, deps, kata: null },
		);
	return { go, api, out, err };
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function publish(cwd: string, opts: object) {
	const runs = join(cwd, ".rpiv", "workflows", "runs");
	mkdirSync(runs, { recursive: true });
	writeFileSync(join(runs, "run-1.jsonl"), "{}\n");
	await (opts as { lifecycle: { onWorkflowStart(ctx: never): unknown } }).lifecycle.onWorkflowStart({
		cwd,
		runId: "run-1",
		workflow: "build",
		totalStages: 1,
		state: {},
	} as never);
}

describe("shared alias admission before workflow dispatch", () => {
	it("admits only one sibling CLI while the first API is paused before workflow-start", async () => {
		const f = fixture();
		const entered = deferred();
		const gate = deferred();
		let calls = 0;
		const h = harness(f.plugin, async (ctx, _name, _input, opts) => {
			if (++calls === 1) {
				entered.resolve();
				await gate.promise;
				await publish(ctx.cwd, opts);
			}
			return success;
		});
		const first = h.go(f.first);
		await entered.promise;
		try {
			expect(await h.go(f.second)).toBe(EXIT.usage);
			expect(calls).toBe(1);
			expect(h.err.join("\n")).toMatch(/claim|reserv/i);
			expect(h.err.join("\n")).toMatch(/origin|originating/i);
			expect(h.err.join("\n")).toMatch(/repair/i);
		} finally {
			gate.resolve();
			await first;
		}
		expect(resolveRunAlias(f.second, "shared")?.runId).toBe("run-1");
		expect(await h.go(f.second)).toBe(EXIT.usage);
		expect(calls).toBe(1);
	});

	it.each(["missing-run", "unreadable", "dangling"])("refuses a %s final alias before API entry", async (kind) => {
		const f = fixture();
		const target = join(f.registry, "shared.json");
		if (kind === "dangling") symlinkSync(join(f.root, "absent"), target);
		else
			writeFileSync(
				target,
				kind === "unreadable"
					? "{"
					: JSON.stringify({
							name: "shared",
							runId: "gone",
							cwd: f.first,
							workflow: "build",
							updatedAt: "today",
						}),
			);
		const h = harness(f.plugin);
		expect(await h.go(f.second)).toBe(EXIT.usage);
		expect(h.api.runWorkflowByName).not.toHaveBeenCalled();
		expect(h.err.join("\n")).toMatch(/stale|unreadable/i);
		expect(h.err.join("\n")).toMatch(/choose.*name/i);
		expect(h.err.join("\n")).toMatch(/repair.*origin/i);
	});

	it.each(["rejected", "thrown"])("releases its reservation after a %s API", async (kind) => {
		const f = fixture();
		const h = harness(f.plugin, async () => {
			if (kind === "thrown") throw new Error("API exploded");
			return { success: false, stagesCompleted: 0, error: "rejected" };
		});
		if (kind === "thrown") await expect(h.go(f.first)).rejects.toThrow("API exploded");
		else expect(await h.go(f.first)).toBe(EXIT.failed);
		const retry = harness(f.plugin, async (ctx, _name, _input, opts) => {
			await publish(ctx.cwd, opts);
			return success;
		});
		expect(await retry.go(f.second)).toBe(EXIT.ok);
		expect(retry.api.runWorkflowByName).toHaveBeenCalledOnce();
		expect(retry.out).toContain("run alias: shared");
	});

	it("keeps a published alias after the API throws", async () => {
		const f = fixture();
		const h = harness(f.plugin, async (ctx, _name, _input, opts) => {
			await publish(ctx.cwd, opts);
			throw new Error("after start");
		});
		await expect(h.go(f.first)).rejects.toThrow("after start");
		expect(hasRunAliasEntry(f.second, "shared")).toBe(true);
		expect(resolveRunAlias(f.second, "shared")?.runId).toBe("run-1");
		const retry = harness(f.plugin);
		expect(await retry.go(f.second)).toBe(EXIT.usage);
		expect(retry.api.runWorkflowByName).not.toHaveBeenCalled();
	});

	it("does not advertise an alias when workflow-start publication fails", async () => {
		const f = fixture();
		const h = harness(f.plugin, async (_ctx, _name, _input, opts) => {
			writeFileSync(join(f.registry, "shared.json"), "{");
			await (opts as { lifecycle: { onWorkflowStart(ctx: never): unknown } }).lifecycle.onWorkflowStart({
				cwd: f.first,
				runId: "run-1",
				workflow: "build",
				totalStages: 1,
				state: {},
			} as never);
			return success;
		});
		expect(await h.go(f.first)).toBe(EXIT.ok);
		expect(h.err.join("\n")).toContain("could not share run alias");
		expect(h.out).not.toContain("run alias: shared");
	});

	it("allows a non-Git local run without announcing a shared alias", async () => {
		const f = fixture();
		const h = harness(f.plugin, async (_ctx, _name, _input, opts) => {
			await publish(f.root, opts);
			return success;
		});
		expect(await h.go(f.root)).toBe(EXIT.ok);
		expect(h.api.runWorkflowByName).toHaveBeenCalledOnce();
		expect(h.out).not.toContain("run alias: shared");
	});
});
