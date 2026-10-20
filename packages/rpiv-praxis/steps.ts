/**
 * Steps: any one skill run as a one-stage workflow, so a single step gets
 * what a full run gets — output checking against the skill's contract, a run
 * log, parking, and resume — without writing a pack.
 *
 *   rpiv-wf step research "how does auth refresh work?"   → workflow `step-research`
 *
 * Built from public rpiv-workflow API only. A step workflow is registered in
 * the process that runs (or resumes) THAT step, never for `run`/`list`: the
 * runner refuses to start while any catalog workflow has a load error, so a
 * step must never be able to break an ordinary run.
 *
 * Stage kind follows the skill's own `contract:`: a `produces` skill gets a
 * produces stage, whose outcome the loader derives from its artifactKind; a
 * kind the derivation has no bucket for gets rpiv-pi's generic markdown
 * outcome; everything else (side-effect skills, project skills without a
 * contract) runs as an acts stage.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";
import { rpivPiRoot, skillFiles } from "./rpiv-support.ts";
import { claudeConfigDir } from "./transcript.ts";

export const STEP_PREFIX = "step-";
export const stepWorkflowName = (skill: string): string => `${STEP_PREFIX}${skill}`;
export const stepSkill = (workflow: string): string | undefined =>
	workflow.startsWith(STEP_PREFIX) ? workflow.slice(STEP_PREFIX.length) : undefined;

export interface StepSkill {
	name: string;
	filePath: string;
	source: "rpiv" | "project" | "user";
	kind: "produces" | "side-effect" | "none";
	artifactKind?: string;
}

function contractOf(filePath: string): { kind?: unknown; artifactKind?: unknown } {
	try {
		const fm = /^---\n([\s\S]*?)\n---/.exec(readFileSync(filePath, "utf8"));
		const produces = (parse(fm?.[1] ?? "") as { contract?: { produces?: Record<string, unknown> } } | null)?.contract
			?.produces;
		return {
			kind: produces?.kind,
			artifactKind: (produces?.meta as { artifactKind?: unknown } | undefined)?.artifactKind,
		};
	} catch {
		return {};
	}
}

/** Every skill a step can run: rpiv's own, then project and user skills (first name wins). */
export function stepSkills(cwd: string, configDir = claudeConfigDir()): StepSkill[] {
	const out = new Map<string, StepSkill>();
	const sources: Array<[StepSkill["source"], string]> = [
		["rpiv", join(rpivPiRoot(), "skills")],
		["project", join(cwd, ".claude", "skills")],
		["user", join(configDir, "skills")],
	];
	for (const [source, dir] of sources) {
		for (const { name, filePath } of skillFiles(dir)) {
			if (out.has(name)) continue;
			const c = contractOf(filePath);
			const kind = c.kind === "produces" || c.kind === "side-effect" ? c.kind : "none";
			out.set(name, {
				name,
				filePath,
				source,
				kind,
				...(typeof c.artifactKind === "string" ? { artifactKind: c.artifactKind } : {}),
			});
		}
	}
	return [...out.values()];
}

const rpivCore = (file: string): string => pathToFileURL(join(rpivPiRoot(), "extensions", "rpiv-core", file)).href;

/** Register the one-stage workflow for `skill`. Undefined when no such skill exists. */
export async function registerStep(skill: string, cwd: string, configDir?: string): Promise<StepSkill | undefined> {
	const found = stepSkills(cwd, configDir).find((s) => s.name === skill);
	if (!found || !existsSync(found.filePath)) return undefined;
	const reg = await import("@juicesharp/rpiv-workflow/registration");
	const startup = await import("@juicesharp/rpiv-workflow/startup");
	let stage: ReturnType<typeof reg.acts> | ReturnType<typeof reg.produces>;
	if (found.kind === "produces") {
		const { BUCKET_BY_KIND } = await import(rpivCore("outcome-derivation.ts"));
		const mapped = found.artifactKind !== undefined && found.artifactKind in BUCKET_BY_KIND;
		if (mapped) stage = reg.produces();
		else {
			const { rpivArtifactMdOutcome } = await import(rpivCore("artifact-collector.ts"));
			stage = reg.produces({ outcome: rpivArtifactMdOutcome });
		}
	} else {
		stage = reg.acts();
	}
	const workflow = reg.defineWorkflow({
		name: stepWorkflowName(skill),
		description: `One step: /skill:${skill}`,
		start: skill,
		stages: { [skill]: stage },
		edges: { [skill]: "stop" },
	});
	startup.registerBuiltInsProvider(() => startup.registerBuiltIns([workflow]));
	return found;
}
