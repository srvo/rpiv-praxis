/**
 * The built-in commit stages' outcome: `gitCommitOutcome`, except that a
 * commit stage which made no commit while the run's work is still uncommitted
 * FAILS instead of recording success.
 *
 * Upstream's `gitCommitOutcome` reports "HEAD did not move" as an honest
 * `noOp: true` and the stage completes. That is right for a stage with nothing
 * to commit and wrong for one that tried and could not: two monocloud `build`
 * runs (2026-10-16_19-30-04-6bc9, 2026-10-16_20-09-38-e301) ended "workflow
 * complete" with every file still uncommitted, because the repo's pre-commit
 * hook rejected the commit and the skill's `NOT COMMITTED:` line lived only in
 * the stage transcript. The run log recorded the base sha as the "commit".
 *
 * The rule: HEAD unchanged AND a dirty path inside the run's scope ⇒ fatal
 * (the stage halts; resume re-runs it once the cause is fixed). The scope is
 * the dirty set minus engine bookkeeping (`.rpiv/`, `thoughts/`) and, when the
 * stage threads a run-start baseline (`build`, `ship`), minus the paths that
 * were already dirty before the run. `vet`/`polish` have no usable baseline
 * (vet's lists the very changes under review), so every non-bookkeeping dirty
 * path is in scope there. A clean scope is still an honest no-op, and so is a
 * stage that ran outside a git repo (`baselineMissing`).
 */

import {
	type BranchEntry,
	type CollectContext,
	type GitCommitData,
	type GitHeadSnapshot,
	gitCommitCollector,
	gitCommitParser,
	type Outcome,
	type RunView,
} from "@juicesharp/rpiv-workflow/registration";
import { gitDirtyEntries, goalBaselinePath, readGoalBaseline, SCOPE_BOOKKEEPING_DIRS } from "./goal-baseline.js";

/** How many uncommitted paths the failure message names before eliding. */
const MAX_LISTED_PATHS = 10;

/** The skill's own explanation line (commit SKILL.md, Step 3/4). */
const NOT_COMMITTED_RE = /^\s*NOT COMMITTED:\s*(.+)$/m;

/** Dirty paths that belong to this run: not bookkeeping, not pre-existing. */
const uncommittedInScope = (cwd: string, state: RunView, useBaseline: boolean): string[] => {
	const baseline = new Set(useBaseline ? readGoalBaseline(goalBaselinePath(state), cwd) : []);
	return gitDirtyEntries(cwd)
		.map((e) => e.path)
		.filter((p) => !baseline.has(p) && !SCOPE_BOOKKEEPING_DIRS.has(p.split("/")[0] ?? ""));
};

/**
 * The commit session's `NOT COMMITTED:` explanation, latest first. Scans every
 * assistant text part from the stage's branch offset; `undefined` when the
 * session never wrote one (or the host passed no transcript).
 */
const notCommittedReason = (branch: readonly BranchEntry[], offset = 0): string | undefined => {
	for (let i = branch.length - 1; i >= Math.max(offset, 0); i--) {
		const entry = branch[i];
		if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
		for (const part of entry.message.content ?? []) {
			const m = part.type === "text" && typeof part.text === "string" ? NOT_COMMITTED_RE.exec(part.text) : null;
			if (m?.[1]) return m[1].trim();
		}
	}
	return undefined;
};

/** The failure message: what did not happen, what is left, and the last stated cause. */
const noCommitMessage = (skill: string, headSha: string, paths: readonly string[], reason: string | undefined) => {
	const listed = paths.slice(0, MAX_LISTED_PATHS).join(", ");
	const more = paths.length > MAX_LISTED_PATHS ? `, … (+${paths.length - MAX_LISTED_PATHS} more)` : "";
	return (
		`${skill}: commit stage made no commit (HEAD still ${headSha.slice(0, 10)}); ` +
		`${paths.length} file${paths.length === 1 ? "" : "s"} uncommitted in the run's scope: ${listed}${more}; ` +
		`last error: ${reason ?? "the commit session gave no NOT COMMITTED: reason"}. ` +
		"Fix the cause (e.g. a failing git hook), then resume the run to re-run the commit stage."
	);
};

/**
 * Build the commit outcome. `baseline: true` subtracts the run-start snapshot
 * (build/ship, matching `COMMIT_BASELINE_PROMPT`); `false` for vet/polish.
 */
const runCommitOutcome = (opts: {
	baseline: boolean;
}): Outcome<GitHeadSnapshot | undefined, "git-commit", GitCommitData> => ({
	collector: {
		snapshot: gitCommitCollector.snapshot,
		async collect(ctx: CollectContext<GitHeadSnapshot | undefined>) {
			const collected = await gitCommitCollector.collect(ctx);
			if (collected.kind === "fatal") return collected;
			const meta = collected.artifacts[0]?.meta as { noOp?: unknown; baselineMissing?: unknown; headSha?: unknown };
			if (meta?.noOp !== true || meta.baselineMissing === true) return collected;
			const paths = uncommittedInScope(ctx.cwd, ctx.state, opts.baseline);
			if (paths.length === 0) return collected;
			const headSha = typeof meta.headSha === "string" ? meta.headSha : "";
			return {
				kind: "fatal",
				message: noCommitMessage(ctx.skill, headSha, paths, notCommittedReason(ctx.branch, ctx.branchOffset)),
			};
		},
	},
	parser: gitCommitParser,
});

/** Build's and ship's commit: the run-start baseline fences pre-existing dirt. */
const BASELINE_COMMIT_OUTCOME = runCommitOutcome({ baseline: true });
/** Vet's and polish's commit: no baseline (vet's lists the changes under review). */
const REVIEWED_COMMIT_OUTCOME = runCommitOutcome({ baseline: false });

export { BASELINE_COMMIT_OUTCOME, notCommittedReason, REVIEWED_COMMIT_OUTCOME, runCommitOutcome };
