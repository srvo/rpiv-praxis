/**
 * Commit-stage dispatch for the built-in workflows: `/skill:commit` with
 * `--reviewed` exactly when the gate that routed the run here passed, plus the
 * scope fence (`--baseline` or `--evidence`) the skill needs to commit without
 * asking.
 */

import { handleToString, type PromptFn, type RunView } from "@juicesharp/rpiv-workflow/registration";
import { goalBaselinePath } from "./goal-baseline.js";
import { latestFsArtifact } from "./shared.js";

/**
 * The commit skill's "this change already cleared the run's review gate" flag.
 * With it the skill commits without asking for confirmation, which an
 * unattended run (no one to answer) needs: without it a headless commit stage
 * asks in chat, commits nothing, and `gitCommitOutcome` records a no-op.
 */
const REVIEWED_FLAG = "--reviewed";

/**
 * Commit dispatch. `reviewed` reads the gate result that routed the run here,
 * never the workflow's identity, so a commit reached any other way (a custom
 * edge, a red unit advanced by policy) still asks for confirmation.
 *
 * `baseline` threads the run-start snapshot so the commit skill fences
 * pre-existing dirt off the commit — `git-changes.mjs` takes the path as a
 * flag, so there is no fixed rendezvous file for concurrent/repeat runs to
 * clobber. Prompt-dispatched deliberately: the inherited rolling primary (the
 * validation or review report path) was reaching the skill as a meaningless
 * message-hint argument anyway.
 */
const commitPrompt =
	(opts: {
		baseline: boolean;
		reviewed: (state: RunView) => boolean;
		/** The artifact that says what this run changed, for a commit with no baseline to fence by. */
		evidence?: (state: RunView) => string | undefined;
	}): PromptFn =>
	({ state }) => {
		const parts = ["/skill:commit"];
		if (opts.reviewed(state)) parts.push(REVIEWED_FLAG);
		const baseline = opts.baseline ? goalBaselinePath(state) : undefined;
		if (baseline) parts.push(`--baseline ${baseline}`);
		const evidence = opts.evidence?.(state);
		if (evidence) parts.push(`--evidence ${evidence}`);
		return parts.join(" ");
	};

/** The latest validate verdict passed — the only route into build's and ship's commit. */
const validationPassed = (state: RunView): boolean =>
	(state.named.validation?.at(-1)?.data as { verdict?: unknown } | undefined)?.verdict === "pass";

/** The latest code review left zero blockers — the only route into vet's and polish's commit. */
const reviewClean = (state: RunView): boolean =>
	(state.named.reviews?.at(-1)?.data as { blockers_count?: unknown } | undefined)?.blockers_count === 0;

/** Build's and ship's commit: baseline-fenced, reviewed when validate passed. */
const COMMIT_BASELINE_PROMPT: PromptFn = commitPrompt({ baseline: true, reviewed: validationPassed });

/**
 * Vet's and polish's commit: reviewed when the last code review is clean. No
 * baseline: vet's run-start snapshot lists the very changes it was asked to
 * review, and fencing them off would commit nothing. The clean review rides
 * as `--evidence` instead: its scope is what the commit may take, and a fresh
 * commit session has no other way to tell this run's work from unrelated dirt.
 */
const REVIEWED_COMMIT_PROMPT: PromptFn = commitPrompt({
	baseline: false,
	reviewed: reviewClean,
	evidence: (state) => {
		const review = latestFsArtifact(state, "reviews");
		return review?.handle.kind === "fs" ? handleToString(review.handle) : undefined;
	},
});

export { COMMIT_BASELINE_PROMPT, commitPrompt, REVIEWED_COMMIT_PROMPT };
