import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listRunAliases, registerRunAlias, resolveRunAlias } from "./run-alias.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) {
		try {
			chmodSync(join(root, "repo", ".git", "rpiv-workflow-aliases"), 0o755);
		} catch {
			// Not every test makes the registry read-only.
		}
		rmSync(root, { recursive: true, force: true });
	}
});

/** A Git repository whose `.git/rpiv-workflow-aliases` is the shared registry. */
function repo() {
	const root = mkdtempSync(join(tmpdir(), "rpiv-alias-registry-"));
	roots.push(root);
	const dir = join(root, "repo");
	mkdirSync(dir);
	const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
	git("init", "-q");
	git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "fixture");
	const registry = join(dir, ".git", "rpiv-workflow-aliases");
	return { root, dir, registry };
}

/** Give `cwd` a run state file so an alias may point at it. */
function run(cwd: string, runId: string) {
	const runs = join(cwd, ".rpiv", "workflows", "runs");
	mkdirSync(runs, { recursive: true });
	writeFileSync(join(runs, `${runId}.jsonl`), "{}\n");
}

describe("run alias registry — tolerance of foreign or damaged entries", () => {
	it("ignores entries whose shape is invalid or whose cwd is relative", () => {
		const f = repo();
		run(f.dir, "run-1");
		mkdirSync(f.registry, { recursive: true });
		writeFileSync(join(f.registry, "wrong-shape.json"), JSON.stringify({ name: "wrong-shape", runId: 7 }));
		writeFileSync(
			join(f.registry, "relative.json"),
			JSON.stringify({ name: "relative", runId: "run-1", cwd: "not/absolute", workflow: "b", updatedAt: "t" }),
		);
		expect(resolveRunAlias(f.dir, "wrong-shape")).toBeUndefined();
		expect(resolveRunAlias(f.dir, "relative")).toBeUndefined();
		expect(listRunAliases(f.dir)).toEqual([]);
	});

	it("treats a dangling registry symlink as absent rather than crashing the listing", () => {
		const f = repo();
		mkdirSync(f.registry, { recursive: true });
		symlinkSync(join(f.root, "absent"), join(f.registry, "dangling.json"));
		expect(resolveRunAlias(f.dir, "dangling")).toBeUndefined();
		expect(listRunAliases(f.dir)).toEqual([]);
	});

	it("lists valid aliases newest first", () => {
		const f = repo();
		run(f.dir, "run-old");
		run(f.dir, "run-new");
		mkdirSync(f.registry, { recursive: true });
		const row = (name: string, runId: string, updatedAt: string) =>
			JSON.stringify({ name, runId, cwd: f.dir, workflow: "build", updatedAt });
		writeFileSync(join(f.registry, "older.json"), row("older", "run-old", "2026-10-01T00:00:00.000Z"));
		writeFileSync(join(f.registry, "newer.json"), row("newer", "run-new", "2026-10-10T00:00:00.000Z"));
		expect(listRunAliases(f.dir).map((a) => a.name)).toEqual(["newer", "older"]);
	});

	it("returns an empty listing when the registry path is not a directory", () => {
		const f = repo();
		writeFileSync(f.registry, "not a directory");
		expect(listRunAliases(f.dir)).toEqual([]);
	});
});

describe("run alias publication", () => {
	it("refuses to publish an invalid name, an invalid run id, or a run with no state", () => {
		const f = repo();
		expect(registerRunAlias(f.dir, "bad name", "run-1", "build")).toBe(false);
		expect(registerRunAlias(f.dir, "ok", "bad/id", "build")).toBe(false);
		expect(registerRunAlias(f.dir, "ok", "run-missing", "build")).toBe(false);
	});

	// chmod cannot make a directory unwritable for root, so the failure cannot be produced there.
	it.skipIf(process.getuid?.() === 0)("reports a failed publication when the registry cannot be written", () => {
		const f = repo();
		run(f.dir, "run-1");
		mkdirSync(f.registry, { recursive: true });
		chmodSync(f.registry, 0o555); // read-only: the temp publication must fail
		expect(registerRunAlias(f.dir, "locked", "run-1", "build")).toBe(false);
		expect(resolveRunAlias(f.dir, "locked")).toBeUndefined();
	});
});
