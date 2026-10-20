/**
 * Stage-window freshness for rpiv's artifact collectors (kata mykj): a path is
 * collected only when the file was written inside the stage window, so a stale
 * last mention or another run's same-named file is never collected.
 */

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BranchEntry } from "@juicesharp/rpiv-workflow/registration";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rpivArtifactCollector, rpivBucketCollector, writtenInStageWindow } from "./artifact-collector.ts";

describe("stage-window freshness (kata mykj)", () => {
	let tmpDir: string;
	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-fresh-"));
		mkdirSync(join(tmpDir, ".rpiv", "artifacts", "plans"), { recursive: true });
	});
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	const asst = (text: string): BranchEntry => ({
		type: "message",
		message: { role: "assistant", content: [{ type: "text", text }] },
	});
	const write = (rel: string, mtimeMs: number) => {
		writeFileSync(join(tmpDir, rel), "---\nstatus: ok\n---\n");
		utimesSync(join(tmpDir, rel), mtimeMs / 1000, mtimeMs / 1000);
	};
	const collectCtx = (branch: BranchEntry[], stageStartedAtMs: number | undefined) => ({
		cwd: tmpDir,
		runId: "t",
		stageIndex: 0,
		state: {} as never,
		branch,
		branchOffset: undefined,
		snapshot: undefined,
		skill: "plan",
		...(stageStartedAtMs !== undefined ? { stageStartedAtMs } : {}),
	});
	const start = Date.now();
	const STALE = start - 3_600_000;

	it("writtenInStageWindow: fresh, stale, missing, and no-window", () => {
		write(".rpiv/artifacts/plans/new.md", start + 1000);
		write(".rpiv/artifacts/plans/old.md", STALE);
		const ctx = { cwd: tmpDir, stageStartedAtMs: start };
		expect(writtenInStageWindow(".rpiv/artifacts/plans/new.md", ctx)).toBe(true);
		expect(writtenInStageWindow(".rpiv/artifacts/plans/old.md", ctx)).toBe(false);
		expect(writtenInStageWindow(".rpiv/artifacts/plans/ghost.md", ctx)).toBe(false);
		expect(writtenInStageWindow(".rpiv/artifacts/plans/old.md", { cwd: tmpDir })).toBe(true);
	});

	it("a stale last-mentioned path loses to the fresh one the agent wrote", async () => {
		write(".rpiv/artifacts/plans/new.md", start + 1000);
		write(".rpiv/artifacts/plans/old.md", STALE);
		const branch = [asst("Wrote .rpiv/artifacts/plans/new.md"), asst("Prior plan: .rpiv/artifacts/plans/old.md")];
		const result = await rpivBucketCollector("plans").collect(collectCtx(branch, start) as never);
		expect(result).toMatchObject({ kind: "ok", artifacts: [{ handle: { path: ".rpiv/artifacts/plans/new.md" } }] });
	});

	it("the disk fallback refuses another run's file with the same basename", async () => {
		write(".rpiv/artifacts/plans/old.md", STALE);
		const branch = [asst("Saved as `plans/old.md`")]; // mangled prefix → basename fallback
		const result = await rpivArtifactCollector.collect(collectCtx(branch, start) as never);
		expect(result.kind).toBe("fatal");
	});

	it("without a stage window the old behavior holds (stale path collected)", async () => {
		write(".rpiv/artifacts/plans/old.md", STALE);
		const branch = [asst("Prior plan: .rpiv/artifacts/plans/old.md")];
		const result = await rpivBucketCollector("plans").collect(collectCtx(branch, undefined) as never);
		expect(result.kind).toBe("ok");
	});
});
