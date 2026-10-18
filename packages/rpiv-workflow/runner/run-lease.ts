import type { RunWorkflowResult } from "../types.js";
import { acquireResumeLock, ResumeAlreadyRunningError } from "./resume-lock.js";

/** All writers, fresh or resumed, hold one lease through execution and disposal. */
export async function withRunLease(
	cwd: string,
	runId: string,
	execute: () => Promise<RunWorkflowResult>,
): Promise<RunWorkflowResult> {
	let release: () => void;
	try {
		release = acquireResumeLock(cwd, runId);
	} catch (error) {
		if (error instanceof ResumeAlreadyRunningError)
			return { stagesCompleted: 0, success: false, runId, error: error.message };
		throw error;
	}
	try {
		return await execute();
	} finally {
		release();
	}
}
