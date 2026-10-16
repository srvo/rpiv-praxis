/**
 * Pack-level model policy (`Workflow.models`): per-stage pins and the
 * escalate-on-failed-verdict ladder. Pure resolution plus one telemetry write;
 * the host applies the resulting `ModelSelection` at child creation.
 */

import type { ModelSelection } from "./host.js";
import { nowIso } from "./internal-utils.js";
import type { Workflow } from "./stage-def.js";
import { appendModelEscalation, readAllStages } from "./state/index.js";

type ModelRun = { cwd: string; runId: string; workflow: Workflow; resolveModel?: ResolveModel };
type ResolveModel = (id: { workflow: string; stage: string; skill: string }) => ModelSelection | undefined;

/**
 * A stage's base model: its pin (keeping any `thinking` the run resolver set),
 * else the run's `resolveModel` (e.g. a run-wide `--model`), else undefined
 * (host default).
 */
export function baseStageModel(
	workflow: Workflow,
	resolveModel: ResolveModel | undefined,
	stage: string,
	skill: string,
): ModelSelection | undefined {
	const resolved = resolveModel?.({ workflow: workflow.name, stage, skill });
	const pin = workflow.models?.stages?.[stage];
	return pin ? { ...resolved, model: pin } : resolved;
}

/**
 * The model for a produce round that follows `failedRounds` failed verdicts:
 * `failedRounds` steps up the ladder from the base model's position (a base
 * not on the ladder sits below it), capped at the top. `undefined` when no
 * ladder is configured or the round is not an escalation.
 */
export function escalatedModel(
	workflow: Workflow,
	base: ModelSelection | undefined,
	failedRounds: number,
): string | undefined {
	const ladder = workflow.models?.escalate?.ladder;
	if (!ladder || ladder.length === 0 || failedRounds < 1) return undefined;
	const at = base?.model === undefined ? -1 : ladder.indexOf(base.model);
	return ladder[Math.min(at + failedRounds, ladder.length - 1)];
}

/**
 * Resolve a loop unit's model, escalating an assess/verify produce round that
 * follows a failed verdict and recording the step as a `model-escalation` row.
 */
export function unitModel(
	run: ModelRun,
	unit: { stage: string; skill: string; unitLabel: string; loopKind: string; role: string; round: number },
): ModelSelection | undefined {
	const base = baseStageModel(run.workflow, run.resolveModel, unit.stage, unit.skill);
	if (unit.loopKind !== "assess" || unit.role !== "produce") return base;
	const target = escalatedModel(run.workflow, base, unit.round);
	if (target === undefined || target === base?.model) return base;
	appendModelEscalation(run.cwd, run.runId, {
		type: "model-escalation",
		ts: nowIso(),
		stage: unit.stage,
		unit: unit.unitLabel,
		round: unit.round,
		from: base?.model ?? null,
		to: target,
		reason: `verdict failed in round ${unit.round - 1}`,
	});
	return { ...base, model: target };
}

/**
 * Resolve a single stage's model. A stage listed in `escalate.revisits` (the
 * fix half of a grade → fix back-edge) climbs one ladder step per completed
 * earlier visit in this run, read from the run log so it survives resume.
 */
export function singleStageModel(run: ModelRun, stage: string, skill: string): ModelSelection | undefined {
	const base = baseStageModel(run.workflow, run.resolveModel, stage, skill);
	if (!run.workflow.models?.escalate?.revisits?.includes(stage)) return base;
	const visits = readAllStages(run.cwd, run.runId).filter(
		(r) => r.stage === stage && r.parent === undefined && r.status === "completed",
	).length;
	const target = escalatedModel(run.workflow, base, visits);
	if (target === undefined || target === base?.model) return base;
	appendModelEscalation(run.cwd, run.runId, {
		type: "model-escalation",
		ts: nowIso(),
		stage,
		round: visits,
		from: base?.model ?? null,
		to: target,
		reason: `grade failed again after ${visits} completed ${stage} visit(s)`,
	});
	return { ...base, model: target };
}
