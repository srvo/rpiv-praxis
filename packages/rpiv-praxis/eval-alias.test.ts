import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newTrialAttempt, trialRunAlias } from "./eval.js";
import { registerRunAlias, reserveRunAlias } from "./run-alias.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** One enclosing Git repo, so every eval directory beneath it shares one alias registry. */
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "rpiv-eval-alias-"));
	roots.push(root);
	const repo = join(root, "repo");
	mkdirSync(repo);
	const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
	git("init", "-q");
	git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "fixture");
	return { repo, root };
}

const trial = (dir: string, variant = "base") => ({ variant: { name: variant } as never, repeat: 1, dir });

/** Give a trial working copy a run state file, then publish its shared alias as a finished attempt would. */
function publish(workDir: string, name: string, runId: string) {
	const runs = join(workDir, ".rpiv", "workflows", "runs");
	mkdirSync(runs, { recursive: true });
	writeFileSync(join(runs, `${runId}.jsonl`), "{}\n");
	expect(registerRunAlias(workDir, name, runId, "build")).toBe(true);
}

describe("eval attempt identity", () => {
	it("gives every attempt a fresh suffix, even at the same instant", () => {
		const a = newTrialAttempt(1_000);
		const b = newTrialAttempt(1_000);
		expect(a).not.toBe(b);
		expect(a).toMatch(/^[0-9a-z]+$/);
	});

	it("names an attempt after its trial and attempt, within the alias limit", () => {
		const name = trialRunAlias(trial("/x/trials/base__1"), "abc123");
		expect(name).toBe("eval-base-1-abc123");
		const long = trialRunAlias({ variant: { name: "v".repeat(80) } as never, repeat: 12, dir: "/x" }, "zz9zz9");
		expect(long.length).toBeLessThanOrEqual(64);
		expect(long.endsWith("-zz9zz9")).toBe(true);
		expect(long).toMatch(/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/);
	});
});

describe("eval attempts against the shared alias registry", () => {
	it("a rerun is admitted after an earlier attempt published its alias", () => {
		// Before this change the rerun reused the first attempt's name, so the registry
		// still held its final entry and the reservation was refused.
		const f = fixture();
		const trialDir = join(f.repo, "eval-results", "s1", "trials", "base__1");
		const first = trialRunAlias(trial(trialDir), newTrialAttempt(1));
		publish(join(trialDir, "work"), first, "run-1");

		// --continue removes the half-finished trial and starts a new attempt.
		rmSync(trialDir, { recursive: true, force: true });
		mkdirSync(join(trialDir, "work"), { recursive: true });
		const second = trialRunAlias(trial(trialDir), newTrialAttempt(2));

		expect(second).not.toBe(first);
		const release = reserveRunAlias(join(trialDir, "work"), second);
		expect(release).toBeTypeOf("function");
		release?.();
	});

	it("independently planned evals of the same variant do not collide", () => {
		const f = fixture();
		const a = trialRunAlias(
			trial(join(f.repo, "eval-results", "scratch-1", "trials", "base__1")),
			newTrialAttempt(1),
		);
		const b = trialRunAlias(
			trial(join(f.repo, "eval-results", "scratch-2", "trials", "base__1")),
			newTrialAttempt(1),
		);
		expect(a).not.toBe(b);
		const releaseA = reserveRunAlias(f.repo, a);
		try {
			const releaseB = reserveRunAlias(f.repo, b);
			expect(releaseB).toBeTypeOf("function");
			releaseB?.();
		} finally {
			releaseA?.();
		}
	});
});
