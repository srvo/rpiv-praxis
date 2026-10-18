import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runsDir } from "../state/paths.js";
import { acquireResumeLock, ResumeAlreadyRunningError } from "./resume-lock.js";

let cwd: string;
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

const setup = () => {
	cwd = mkdtempSync(join(tmpdir(), "rpiv-resume-lock-"));
	mkdirSync(runsDir(cwd), { recursive: true });
};

describe("per-run resume lock", () => {
	it("admits one owner and lets a later owner enter after release", () => {
		setup();
		const release = acquireResumeLock(cwd, "run-1");
		expect(() => acquireResumeLock(cwd, "run-1")).toThrow(ResumeAlreadyRunningError);
		release();
		const second = acquireResumeLock(cwd, "run-1");
		expect(() => acquireResumeLock(cwd, "run-1")).toThrow(ResumeAlreadyRunningError);
		second();
	});

	it("recovers an owner whose process no longer exists", () => {
		setup();
		const root = runsDir(cwd);
		mkdirSync(join(root, "run-2.resume-lock"), { recursive: true });
		const ownerFile = join(root, "run-2.resume-lock", "owner.json");
		writeFileSync(ownerFile, JSON.stringify({ pid: 2_147_483_647, token: "dead" }));
		const release = acquireResumeLock(cwd, "run-2");
		expect(JSON.parse(readFileSync(ownerFile, "utf8"))).toMatchObject({ pid: process.pid });
		release();
	});
	it("keeps an aged live owner locked", () => {
		setup();
		const root = join(runsDir(cwd), "run-3.resume-lock");
		mkdirSync(root, { recursive: true });
		const ownerFile = join(root, "owner.json");
		writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, token: "live" }));
		const old = new Date(Date.now() - 60_000);
		utimesSync(ownerFile, old, old);
		expect(() => acquireResumeLock(cwd, "run-3")).toThrow(ResumeAlreadyRunningError);
	});
	it("rejects traversal run IDs before creating a lock path", () => {
		setup();
		expect(() => acquireResumeLock(cwd, "../../../../outside")).toThrow(/invalid workflow run ID/);
		expect(() => readFileSync(join(cwd, "outside.resume-lock", "owner.json"))).toThrow();
	});
});
