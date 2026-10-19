import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runsDir } from "../state/paths.js";
import { acquireResumeLock } from "./resume-lock.js";
import { withRunLease } from "./run-lease.js";

let cwd: string | undefined;
afterEach(() => {
	if (cwd) rmSync(cwd, { recursive: true, force: true });
	cwd = undefined;
});

const setup = () => {
	cwd = mkdtempSync(join(tmpdir(), "rpiv-run-lease-"));
	mkdirSync(runsDir(cwd), { recursive: true });
	return cwd;
};

describe("withRunLease", () => {
	it("refuses without executing when another owner holds the run", async () => {
		const dir = setup();
		const release = acquireResumeLock(dir, "run-1");
		const execute = vi.fn(async () => ({ success: true, stagesCompleted: 1, runId: "run-1" }));
		try {
			const result = await withRunLease(dir, "run-1", execute);
			expect(execute).not.toHaveBeenCalled();
			expect(result).toMatchObject({ success: false, stagesCompleted: 0, runId: "run-1" });
			expect(result.error).toMatch(/run-1/);
		} finally {
			release();
		}
	});

	it("runs the execution under the lease and releases it afterwards", async () => {
		const dir = setup();
		const execute = vi.fn(async () => ({ success: true, stagesCompleted: 1, runId: "run-1" }));
		const result = await withRunLease(dir, "run-1", execute);
		expect(execute).toHaveBeenCalledOnce();
		expect(result.success).toBe(true);
		// Released: a later owner can acquire the same run.
		const release = acquireResumeLock(dir, "run-1");
		release();
	});
});
