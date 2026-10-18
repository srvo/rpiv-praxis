import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runsDir } from "../state/paths.js";

interface Owner {
	pid: number;
	token: string;
}

export class ResumeAlreadyRunningError extends Error {
	constructor(runId: string) {
		super(`workflow run ${runId} is already executing`);
		this.name = "ResumeAlreadyRunningError";
	}
}

function readOwner(path: string): Owner | undefined {
	try {
		const row = JSON.parse(readFileSync(path, "utf8")) as Partial<Owner>;
		return Number.isInteger(row.pid) && typeof row.token === "string" ? (row as Owner) : undefined;
	} catch {
		return undefined;
	}
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** One atomic owner directory per run. Reclaim is separately serialized across stale-lock contenders. */
export function acquireResumeLock(cwd: string, runId: string): () => void {
	if (!runId || /[\\/\0]/.test(runId) || runId === "." || runId === "..") {
		throw new Error(`invalid workflow run ID for resume lock: ${JSON.stringify(runId)}`);
	}
	const root = join(runsDir(cwd), `${runId}.resume-lock`);
	const ownerFile = join(root, "owner.json");
	const ownerTemp = join(root, `.owner-${process.pid}-${randomUUID()}.tmp`);
	const reclaimDir = join(root, "reclaim");
	const owner = { pid: process.pid, token: randomUUID() };
	mkdirSync(root, { recursive: true });

	try {
		writeFileSync(ownerTemp, `${JSON.stringify(owner)}\n`, { flag: "wx" });
		for (;;) {
			try {
				// The complete owner record exists before this atomic hard-link claim.
				linkSync(ownerTemp, ownerFile);
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}

			const previous = readOwner(ownerFile);
			if (!previous || processIsAlive(previous.pid)) throw new ResumeAlreadyRunningError(runId);
			try {
				mkdirSync(reclaimDir);
			} catch {
				throw new ResumeAlreadyRunningError(runId);
			}
			try {
				const current = readOwner(ownerFile);
				if (!current || current.token !== previous.token || processIsAlive(current.pid))
					throw new ResumeAlreadyRunningError(runId);
				unlinkSync(ownerFile);
			} finally {
				rmSync(reclaimDir, { recursive: true, force: true });
			}
		}
	} finally {
		rmSync(ownerTemp, { force: true });
	}

	return () => {
		const current = readOwner(ownerFile);
		if (current?.token === owner.token) unlinkSync(ownerFile);
	};
}
