import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTools, type McpDeps } from "./mcp.ts";
import { runsDir } from "./park-store.ts";
import { registerRunAlias } from "./run-alias.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A repository with an origin worktree and a sibling, sharing one alias registry. */
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "rpiv-mcp-alias-"));
	roots.push(root);
	const origin = join(root, "origin");
	const sibling = join(root, "sibling");
	mkdirSync(origin);
	const git = (...args: string[]) => execFileSync("git", args, { cwd: origin, stdio: "ignore" });
	git("init", "-q");
	git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "fixture");
	git("worktree", "add", "-qb", "sibling", sibling);
	return { root, origin, sibling };
}

function tools(cwd: string) {
	const deps: McpDeps = {
		cwd,
		rand: () => "abc123",
		spawnDetached: vi.fn(),
		exec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
	};
	return createTools(deps);
}

/** Write the run state the origin worktree owns, then publish a shared alias for it. */
function publishInOrigin(origin: string, name: string, runId: string) {
	mkdirSync(runsDir(origin), { recursive: true });
	writeFileSync(
		join(runsDir(origin), `${runId}.jsonl`),
		`${JSON.stringify({ runId })}\n${JSON.stringify({ stage: "plan", status: "completed" })}\n`,
	);
	writeFileSync(join(runsDir(origin), `${name}.mcp.log`), "launching\n");
	expect(registerRunAlias(origin, name, runId, "build")).toBe(true);
}

describe("run_status resolves shared run aliases", () => {
	it("reports the originating worktree's run from a sibling worktree", async () => {
		const f = fixture();
		publishInOrigin(f.origin, "shared", "run-1");

		const status = await tools(f.sibling).run_status({ run: "shared" });

		// The alias redirects: the sibling must see the origin's run, not null.
		expect(status.runId).toBe("run-1");
		expect(status.state).not.toBe("unknown");
		expect(status.state).not.toBe("not-started-here");
		expect(status.stages).toEqual([{ stage: "plan", status: "completed" }]);
	});

	it("still reports a local run in the queried worktree unchanged", async () => {
		const f = fixture();
		mkdirSync(runsDir(f.sibling), { recursive: true });
		writeFileSync(join(runsDir(f.sibling), "local.jsonl"), '{"runId":"local"}\n');
		writeFileSync(join(runsDir(f.sibling), "names.json"), JSON.stringify({ plain: "local" }));
		writeFileSync(join(runsDir(f.sibling), "plain.mcp.log"), "line1\n");

		expect(await tools(f.sibling).run_status({ run: "plain" })).toMatchObject({
			runId: "local",
			state: "running",
		});
	});

	it("prefers a local run over a shared alias of the same name, as the CLI does", async () => {
		const f = fixture();
		publishInOrigin(f.origin, "shared", "run-origin");
		// The sibling owns its own run that is also called "shared" via names.json.
		mkdirSync(runsDir(f.sibling), { recursive: true });
		writeFileSync(join(runsDir(f.sibling), "local-run.jsonl"), '{"runId":"local-run"}\n');
		writeFileSync(join(runsDir(f.sibling), "names.json"), JSON.stringify({ shared: "local-run" }));
		writeFileSync(join(runsDir(f.sibling), "shared.mcp.log"), "local\n");

		const status = await tools(f.sibling).run_status({ run: "shared" });

		expect(status.runId).toBe("local-run");
		expect(status.origin).toBeUndefined();
	});

	it("takes an explicit cwd over the daemon cwd", async () => {
		const f = fixture();
		publishInOrigin(f.origin, "shared", "run-1");
		const status = await tools(f.root).run_status({ run: "shared", cwd: f.sibling });
		expect(status.runId).toBe("run-1");
		expect(status.stages).toHaveLength(1);
	});
});
