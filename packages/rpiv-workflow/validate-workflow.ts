/**
 * Load-time graph validation for `Workflow` objects — the thin orchestrator.
 *
 * Catches the wiring mistakes a TS type system can't reach on its own:
 * unknown edge sources/targets, unreachable stages, missing terminals,
 * predicate functions that return targets outside the stage set.
 *
 * `validateWorkflow` returns a flat array of `WorkflowValidationIssue`s —
 * each carrying a machine-readable `code` (the stable contract — filter and
 * assert on codes, never message text), structured `params`, and prose
 * rendered by the ONE renderer in `validate/issue.ts`. Errors are problems
 * that would crash the runner; warnings are shapes that work but probably
 * aren't what the author intended. The load pipeline can choose to halt on
 * any error and surface warnings non-fatally.
 *
 * No I/O, no throws — purely a graph walk + predicate probe.
 *
 * Module map (mirrors the `load/` decomposition):
 *   ./validate/issue.ts           — codes, params, severity table, reporter, renderer
 *   ./validate/graph.ts           — graph topology (names, edges, reachability)
 *   ./validate/stage-rules.ts     — per-stage semantics + named-channel wiring
 *   ./validate/contract-compat.ts — skill-contract / JSON-Schema compatibility
 */

import type { Workflow } from "./api.ts";
import type { SkillContractMap } from "./skill-contract.ts";
import { checkEdgeSchemaCompat, checkPredicateSchemas, checkReadsChannelCompat } from "./validate/contract-compat.ts";
import {
	checkEdgeKeys,
	checkEdgeTargets,
	checkMissingEdges,
	checkReachability,
	checkStartStage,
	checkWorkflowName,
} from "./validate/graph.ts";
import { issueReporter, type WorkflowValidationIssue } from "./validate/issue.ts";
import {
	checkFanoutReadHint,
	checkFanoutSource,
	checkReadsReferences,
	checkStageSemantics,
	fanoutPublishedChannels,
	publishedNamesOf,
} from "./validate/stage-rules.ts";

export type {
	ValidationIssueCode,
	ValidationIssueParamsOf,
	WorkflowValidationIssue,
} from "./validate/issue.ts";

/** `models` (pack-level pins + escalation ladder): pins name declared stages, ids are non-empty strings. */
function checkModels(w: Workflow, r: ReturnType<typeof issueReporter>): void {
	const models = w.models as { stages?: unknown; escalate?: { ladder?: unknown; revisits?: unknown } } | undefined;
	if (models === undefined) return;
	const stages = models.stages;
	if (stages !== undefined && stages !== null && typeof stages === "object") {
		for (const [stage, model] of Object.entries(stages)) {
			if (!w.stages[stage]) r.report("models-stage-unknown", { stage });
			if (typeof model !== "string" || model.length === 0) r.report("models-pin-invalid", { stage });
		}
	}
	if (models.escalate !== undefined) {
		const ladder = models.escalate?.ladder;
		const ok =
			Array.isArray(ladder) && ladder.length > 0 && ladder.every((m) => typeof m === "string" && m.length > 0);
		if (!ok) r.report("models-ladder-invalid");
		const revisits = models.escalate?.revisits;
		if (revisits !== undefined) {
			for (const stage of Array.isArray(revisits) ? revisits : [revisits]) {
				if (typeof stage !== "string" || !w.stages[stage])
					r.report("models-revisit-unknown", { stage: String(stage) });
			}
		}
	}
}

/**
 * Validate one workflow. Aggregates all issues; never short-circuits. Caller
 * decides what's fatal — `severity === "error"` is the runner-blocking set.
 */
export function validateWorkflow(
	workflow: Workflow,
	opts?: { skillContracts?: SkillContractMap },
): WorkflowValidationIssue[] {
	const issues: WorkflowValidationIssue[] = [];
	const label = typeof workflow.name === "string" && workflow.name.length > 0 ? workflow.name : "(anonymous)";
	const r = issueReporter(label, issues);

	checkWorkflowName(workflow, r);
	checkStartStage(workflow, r);
	checkEdgeKeys(workflow, r);
	checkEdgeTargets(workflow, r);
	checkMissingEdges(workflow, r);
	// Skip reachability when an EdgeFn lacks `.targets` — the BFS would emit
	// "unreachable from start" cascades whose root cause is the metadata error
	// already reported. Gated on the issue CODE (machine-readable).
	if (!issues.some((i) => i.code === "edge-fn-no-targets")) checkReachability(workflow, r);

	checkStageSemantics(workflow, r);
	checkModels(workflow, r);

	// The publisher set is computed ONCE and threaded to both consumers.
	const published = publishedNamesOf(workflow);
	checkReadsReferences(workflow, published, r);
	checkFanoutSource(workflow, published, r);
	checkFanoutReadHint(workflow, fanoutPublishedChannels(workflow), r);

	checkPredicateSchemas(workflow, r, opts?.skillContracts);
	checkEdgeSchemaCompat(workflow, r, opts?.skillContracts);
	checkReadsChannelCompat(workflow, r, opts?.skillContracts);

	return issues;
}
