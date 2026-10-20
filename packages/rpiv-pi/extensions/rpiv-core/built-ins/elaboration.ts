/**
 * The elaborate stage's outcome: the `elaborations` bucket collector with a
 * parser that adds two body-derived facts beside the frontmatter, so the
 * skill contract's `outputSchema` can refuse a section the stitch would
 * mis-splice while the lane is still alive to fix it.
 */
import { readFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import {
	defineParser,
	isFailedOutput,
	type Outcome,
	type ParseContext,
	type RunView,
} from "@juicesharp/rpiv-workflow/registration";
import { frontmatterParser, rpivBucketOutcome } from "../artifact-collector.ts";
import { countHeadingsOutsideFences, forEachLineOutsideFences, openFenceLine } from "./markdown-fence.ts";
import { PLAN_PHASE_RE } from "./plan-phases.ts";

interface ElaborationStructure {
	/** `"balanced"`, or the diagnosis the contract's enum failure surfaces verbatim. */
	fence_walk: string;
	/** `## Phase N:` headings outside fences — the splice anchor count, contractually 1. */
	phase_headings: number;
}

/** Structural facts of one elaboration body under the shared fence walk. */
const elaborationStructure = (content: string): ElaborationStructure => {
	const open = openFenceLine(content);
	return {
		fence_walk:
			open === undefined
				? "balanced"
				: `open from line ${open} — a bare \`\`\` inside a \`\`\` block closes it; open and close the outer block with four backticks (\`\`\`\`)`,
		phase_headings: countHeadingsOutsideFences(content, PLAN_PHASE_RE),
	};
};

/** Frontmatter plus the derived structure; derived keys win over authored ones. */
const elaborationParser = defineParser<undefined, "artifact-md", Record<string, unknown>>({
	async parse(ctx: ParseContext<undefined>) {
		const base = await frontmatterParser.parse(ctx);
		const primary = ctx.artifacts[0];
		if (base.kind !== "ok" || primary?.handle.kind !== "fs") return base;
		const path = primary.handle.path;
		const content = readFileSync(isAbsolute(path) ? path : join(ctx.cwd, path), "utf-8");
		return {
			kind: "ok",
			payload: { kind: "artifact-md", data: { ...base.payload.data, ...elaborationStructure(content) } },
		};
	},
});

const elaborationOutcome: Outcome<unknown, "artifact-md", Record<string, unknown>> = {
	...rpivBucketOutcome("elaborations"),
	parser: elaborationParser,
};

/** The channel the elaborate fanout publishes on (`rpivBucketOutcome("elaborations")`). */
const ELABORATIONS_CHANNEL = "elaborations";

/**
 * Phases of `planContent` the elaborate fanout did NOT cover in this run — the
 * splice's coverage precondition. A phase is covered only by a non-failed
 * output on the elaborations channel whose artifact is
 * `<plan-basename>__phase-<N>.md`; a failed unit's sentinel or an absent output
 * is a gap (as is any failed sentinel on the channel). Reading the in-run
 * channel, not the disk, means another run's leftover elaboration file can
 * never stand in for a phase this run failed to elaborate. Empty ⇒ splice.
 */
const elaborationCoverageGaps = (state: RunView, planPath: string, planContent: string): string[] => {
	const stem = basename(planPath).replace(/\.md$/, "");
	const phases: number[] = [];
	forEachLineOutsideFences(planContent, (line) => {
		const m = /^## Phase (\d+):/.exec(line);
		if (m) phases.push(Number(m[1]));
	});
	const outputs = (state.named[ELABORATIONS_CHANNEL] ?? []).filter((o) => o !== undefined);
	const failed = outputs.filter((o) => isFailedOutput(o)).length;
	const covered = new Set<number>();
	for (const o of outputs) {
		if (isFailedOutput(o)) continue;
		for (const a of o.artifacts) {
			if (a.handle.kind !== "fs") continue;
			const name = basename(a.handle.path);
			const prefix = `${stem}__phase-`;
			const n = name.startsWith(prefix) && name.endsWith(".md") ? name.slice(prefix.length, -3) : "";
			if (/^\d+$/.test(n)) covered.add(Number(n));
		}
	}
	const gaps = phases.filter((n) => !covered.has(n)).map((n) => `phase ${n}`);
	if (failed > 0) gaps.push(`${failed} failed elaborate unit(s)`);
	return gaps;
};

export {
	type ElaborationStructure,
	elaborationCoverageGaps,
	elaborationOutcome,
	elaborationParser,
	elaborationStructure,
};
