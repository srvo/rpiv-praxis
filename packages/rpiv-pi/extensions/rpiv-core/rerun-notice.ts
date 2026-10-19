import type { RunWorkflowResult } from "@juicesharp/rpiv-workflow";

/**
 * The message a `r` rerun should surface, or undefined when it must stay quiet.
 *
 * Rerun resumes a terminal run. An unsuccessful result reaches the callback from
 * two different places, and only one of them is silent:
 *
 *  - In-run failures come back WITH a `termination` outcome. The stage machinery
 *    already notified the person, so repeating the error here would double-notify.
 *  - Pre-run refusals (unknown run, unloadable workflow) and lease refusals
 *    (`withRunLease` — another writer owns the run) have NO `termination`. Nothing
 *    else tells the person why their press did nothing, so they are surfaced.
 *
 * Gating on `runId === undefined` alone hid the lease refusal, because that
 * refusal also carries the runId. Gating on `termination` keeps in-run failures
 * silent without hiding it.
 */
export function rerunRefusal(result: RunWorkflowResult): string | undefined {
	if (result.success || result.termination !== undefined) return undefined;
	return result.error || undefined;
}
