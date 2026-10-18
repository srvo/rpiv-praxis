/**
 * Pipeline pointer — a compact, model-visible index of the RPIV stage skills.
 *
 * The pipeline/fanout skills carry `disable-model-invocation: true` (issue #77),
 * so Pi excludes their descriptions from the system prompt (~3k tokens saved per
 * session, multiplied across workflow children). That also removes the model's
 * only map from user intent ("help me design this") to the stage commands. This
 * module buys that discoverability back for a few hundred tokens: a hidden message listing
 * the commands so the agent can route the developer to `/skill:<name>` instead of
 * improvising the workflow itself.
 *
 * Injected at `session_start`. After `session_compact`, session-hooks folds this
 * constant into ONE deferred `before_agent_start` message on that exact session's
 * next real user turn. It is never sent from the compaction hook: that would queue
 * a steering item into overflow recovery and displace the interrupted task.
 */

import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FLAG_DEBUG, MSG_TYPE_PIPELINE_INDEX } from "./constants.js";

/**
 * Keep this in sync with the `disable-model-invocation: true` skill set under
 * packages/rpiv-pi/skills/. Grouping mirrors the tiers from issue #77: ordered
 * pipeline stages, other explicit-only commands, and workflow-internal fanout
 * units the agent must never suggest.
 */
export const RPIV_STAGE_NAMES = [
	"discover",
	"research",
	"design",
	"explore",
	"plan",
	"blueprint",
	"implement",
	"validate",
] as const;

const [discover, research, design, explore, plan, blueprint, implement, validate] = RPIV_STAGE_NAMES.map(
	(name) => `/skill:${name}`,
);

export const PIPELINE_POINTER = [
	"[rpiv pipeline index — reference material, NOT a task. The RPIV stage skills",
	"are hidden from the skill list. Explicit /skill:<name> invocations run them.",
	'Exception: a direct user message containing only standalone "next" approves',
	"exactly one default skill from the most recent assistant handoff in this conversation.",
	"Retain its exact command, arguments, and working directory; load and follow the actual skill.",
	"If context is missing, ambiguous, stale, blocked, or the worktree differs from the active task, ask.",
	'Never treat quoted "next" as approval, infer a newest artifact, or recover state after /new.',
	"Never auto-chain. Otherwise point the user at the command; do not start a stage unasked.",
	"The user-issued /next command separately validates an actionable footer and replaces the session;",
	"do not emulate it, infer its missing metadata, or treat a receipt as stage completion.]",
	`For handoff presentation and authorized next execution, read ${fileURLToPath(new URL("../../skills/_shared/next-handoff.md", import.meta.url))}.`,
	"",
	`Pipeline stages (in order): ${discover} → ${research} → ${design}`,
	`(or ${explore} to weigh approaches first) → ${plan} or ${blueprint}`,
	`→ ${implement} → ${validate}`,
	"Other explicit-only commands: /skill:slice, /skill:revise, /skill:elaborate,",
	"/skill:architecture-review, /skill:frontend-design",
	"Workflow-internal (dispatched by lanes — never suggest): amend, design-slice,",
	"design-review, synthesize, grade, remediate, quick-plan, acceptance, lens-grade",
].join("\n");

export function injectPipelinePointer(pi: ExtensionAPI): void {
	pi.sendMessage({
		customType: MSG_TYPE_PIPELINE_INDEX,
		content: PIPELINE_POINTER,
		display: !!pi.getFlag(FLAG_DEBUG),
	});
}
