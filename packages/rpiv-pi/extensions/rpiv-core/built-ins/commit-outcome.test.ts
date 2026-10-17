/**
 * commit-outcome.test.ts — a built-in commit stage that made no commit while
 * the run's work is still dirty must FAIL, not record a no-op success. Runs
 * 2026-10-16_19-30-04-6bc9 and 2026-10-16_20-09-38-e301 ended "workflow
 * complete" with the whole implementation uncommitted: a pre-commit hook
 * rejected the commit, the skill said `NOT COMMITTED:` in its transcript, and
 * `gitCommitOutcome` logged the base sha as the commit.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunView } from "@juicesharp/rpiv-workflow";
import { type BranchEntry, fs as fsHandle } from "@juicesharp/rpiv-workflow/registration";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findWorkflow } from "../workflow-test-harness.js";
import { BASELINE_COMMIT_OUTCOME, notCommittedReason, REVIEWED_COMMIT_OUTCOME } from "./commit-outcome.js";

const hasGit = (() => {
	try {
		execFileSync("git", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
})();

const BASELINE_REL = ".rpiv/artifacts/goal/baseline-t.json";

const stateWithBaseline = {
	named: {
		goal: [
			{
				artifacts: [
					{ handle: fsHandle(".rpiv/artifacts/goal/goal-t.md") },
					{ handle: fsHandle(BASELINE_REL), role: "baseline" },
				],
				data: {},
				kind: "md",
				meta: {},
			},
		],
	},
} as unknown as RunView;

const assistantSays = (text: string): BranchEntry => ({
	type: "message",
	message: { role: "assistant", content: [{ type: "text", text }] },
});

describe.runIf(hasGit)("built-in commit outcome", () => {
	let cwd: string;
	const git = (...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });
	const write = (rel: string, body = "x\n") => {
		mkdirSync(join(cwd, rel, ".."), { recursive: true });
		writeFileSync(join(cwd, rel), body);
	};
	const run = async (
		outcome: typeof BASELINE_COMMIT_OUTCOME,
		stage: () => void,
		opts: { branch?: BranchEntry[]; state?: RunView } = {},
	) => {
		const base = { cwd, runId: "r", stageIndex: 0, state: opts.state ?? stateWithBaseline };
		const snapshot = await outcome.collector.snapshot?.(base);
		stage();
		return outcome.collector.collect({ ...base, snapshot, branch: opts.branch ?? [], skill: "commit" });
	};

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "rpiv-commit-outcome-"));
		git("init", "-q");
		git("config", "user.email", "t@example.com");
		git("config", "user.name", "t");
		git("config", "commit.gpgsign", "false");
		write("README.md");
		git("add", "README.md");
		git("commit", "-q", "-m", "init");
		write(BASELINE_REL, JSON.stringify({ paths: ["pre-existing.txt"] }));
		write("pre-existing.txt");
	});
	afterEach(() => rmSync(cwd, { recursive: true, force: true }));

	it("fails when HEAD did not move and the run's work is uncommitted, naming files and the skill's reason", async () => {
		const result = await run(
			BASELINE_COMMIT_OUTCOME,
			() => {
				write("src/feature.py");
				write("src/feature_test.py");
			},
			{ branch: [assistantSays("Trying.\n\nNOT COMMITTED: the pre-commit smell-diff gate rejected the change.")] },
		);
		expect(result.kind).toBe("fatal");
		const message = result.kind === "fatal" ? result.message : "";
		expect(message).toMatch(/commit stage made no commit/);
		expect(message).toMatch(/2 files uncommitted in the run's scope: src\/feature\.py, src\/feature_test\.py/);
		expect(message).toMatch(/last error: the pre-commit smell-diff gate rejected the change\./);
		// Pre-existing dirt and engine bookkeeping are not the run's work.
		expect(message).not.toMatch(/pre-existing\.txt|\.rpiv\//);
	});

	it("says so when the session gave no NOT COMMITTED: reason", async () => {
		const result = await run(BASELINE_COMMIT_OUTCOME, () => write("src/a.py"));
		expect(result.kind === "fatal" && result.message).toMatch(/1 file uncommitted.*no NOT COMMITTED: reason/);
	});

	it("is an honest no-op when only pre-existing dirt and bookkeeping remain", async () => {
		const result = await run(BASELINE_COMMIT_OUTCOME, () => write(".rpiv/artifacts/validation/v.md"));
		expect(result.kind).toBe("ok");
		expect(result.kind === "ok" && result.artifacts[0]?.meta).toMatchObject({ noOp: true });
	});

	it("passes when the stage committed, even with unrelated dirt left over", async () => {
		const result = await run(BASELINE_COMMIT_OUTCOME, () => {
			write("src/a.py");
			git("add", "src/a.py");
			git("commit", "-q", "-m", "feat: a");
			write("src/leftover.py");
		});
		expect(result.kind).toBe("ok");
		expect(result.kind === "ok" && result.artifacts[0]?.meta).toMatchObject({ noOp: false, subject: "feat: a" });
	});

	it("vet/polish (no baseline) count every non-bookkeeping dirty path, including run-start dirt", async () => {
		const result = await run(REVIEWED_COMMIT_OUTCOME, () => undefined, {
			state: { named: {} } as unknown as RunView,
		});
		expect(result.kind === "fatal" && result.message).toMatch(
			/1 file uncommitted in the run's scope: pre-existing\.txt/,
		);
	});
});

describe("notCommittedReason", () => {
	it("returns the latest NOT COMMITTED: line from assistant text after the offset", () => {
		const branch = [
			assistantSays("NOT COMMITTED: old"),
			{ type: "message", message: { role: "user", content: [{ type: "text", text: "NOT COMMITTED: user" }] } },
			assistantSays("Done.\nNOT COMMITTED: new reason"),
		] as BranchEntry[];
		expect(notCommittedReason(branch)).toBe("new reason");
		expect(notCommittedReason(branch.slice(0, 2), 1)).toBeUndefined();
	});
});

describe("built-in commit stages use the guarded outcome", () => {
	it.each([
		["build", BASELINE_COMMIT_OUTCOME],
		["ship", BASELINE_COMMIT_OUTCOME],
		["vet", REVIEWED_COMMIT_OUTCOME],
		["polish", REVIEWED_COMMIT_OUTCOME],
	])("%s", (wf, outcome) => {
		expect((findWorkflow(wf).stages.commit as { outcome?: unknown } | undefined)?.outcome).toBe(outcome);
	});
});
