import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateRunAlias, hasRunAliasEntry, listRunAliases, registerRunAlias, resolveRunAlias } from "./run-alias.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repoWithWorktree(): { root: string; first: string; second: string } {
	const root = mkdtempSync(join(tmpdir(), "rpiv-run-alias-"));
	roots.push(root);
	const first = join(root, "first");
	const second = join(root, "second");
	mkdirSync(first);
	const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });
	git(first, "init", "-q");
	git(first, "config", "user.email", "rpiv-test@example.invalid");
	git(first, "config", "user.name", "RPIV Test");
	writeFileSync(join(first, "README.md"), "fixture\n");
	git(first, "add", "README.md");
	git(first, "commit", "-qm", "fixture");
	git(first, "worktree", "add", "-qb", "second", second);
	return { root, first, second };
}

describe("cross-worktree RPIV run aliases", () => {
	it("generates a readable, bounded alias from workflow and topic", () => {
		expect(generateRunAlias("build", "Add dark mode", new Date("2026-10-18T12:34:56Z"), "a1b2")).toBe(
			"rpiv-build-add-dark-mode-20261018-123456-a1b2",
		);
		expect(generateRunAlias("inspect", "", new Date("2026-10-18T12:34:56Z"), "a1b2")).toBe(
			"rpiv-inspect-20261018-123456-a1b2",
		);
		expect(
			generateRunAlias(
				"a workflow name that is very long",
				"a topic that is also very long and must be bounded",
				new Date("2026-10-18T12:34:56Z"),
				"a1b2",
			).length,
		).toBeLessThanOrEqual(64);
	});

	it("resolves the original run and its artifacts from a sibling worktree", () => {
		const { first, second } = repoWithWorktree();
		mkdirSync(join(first, ".rpiv", "workflows", "runs"), { recursive: true });
		writeFileSync(join(first, ".rpiv", "workflows", "runs", "run-1.jsonl"), "{}\n");
		expect(registerRunAlias(first, "rpiv-build-topic-20261018-123456", "run-1", "build")).toBe(true);
		expect(resolveRunAlias(second, "rpiv-build-topic-20261018-123456")).toMatchObject({
			name: "rpiv-build-topic-20261018-123456",
			runId: "run-1",
			cwd: realpathSync(first),
			workflow: "build",
		});
		expect(listRunAliases(second)).toHaveLength(1);
	});

	it("does not overwrite an alias owned by a different run", () => {
		const { first, second } = repoWithWorktree();
		mkdirSync(join(first, ".rpiv", "workflows", "runs"), { recursive: true });
		writeFileSync(join(first, ".rpiv", "workflows", "runs", "run-1.jsonl"), "{}\n");
		expect(registerRunAlias(first, "shared", "run-1", "build")).toBe(true);
		expect(registerRunAlias(second, "shared", "run-2", "inspect")).toBe(false);
		expect(resolveRunAlias(second, "shared")?.runId).toBe("run-1");
	});

	it("ignores a stale pointer when its original run file is gone", () => {
		const { first, second } = repoWithWorktree();
		mkdirSync(join(first, ".rpiv", "workflows", "runs"), { recursive: true });
		writeFileSync(join(first, ".rpiv", "workflows", "runs", "run-1.jsonl"), "{}\n");
		expect(registerRunAlias(first, "old-run", "run-1", "build")).toBe(true);
		rmSync(join(first, ".rpiv", "workflows", "runs", "run-1.jsonl"));
		expect(hasRunAliasEntry(second, "old-run")).toBe(true);
		expect(resolveRunAlias(second, "old-run")).toBeUndefined();
	});
});
