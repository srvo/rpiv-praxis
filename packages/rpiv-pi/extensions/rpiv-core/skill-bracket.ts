/**
 * skill-bracket — standalone `/skill:<name>` model/effort override via the
 * input → agent_end event pair.
 *
 * Pi exposes no skill-scoped lifecycle event; skills are pure text-substitution
 * via `_expandSkillCommand` inside AgentSession.prompt(). The `input` event
 * fires BEFORE expansion; `agent_end` is the only reliable terminator (per
 * rpiv-warp/index.ts:127-176 comment).
 *
 * Contract:
 *  - Interactive raw skills use parseSkillInvocation; the one authorized
 *    replacement input is separately admitted from source="extension".
 *  - Parse skill name via parseSkillInvocation (both raw `/skill:foo` AND
 *    wrapped `<skill name="…">…</skill>`).
 *  - Arm ONLY on explicit config.skills?.[name] entry —
 *    defaults are not a trigger; only explicit per-skill entries arm.
 *  - All pi mutations wrapped in applyOrSkipIfStale (shared with session-capture.ts).
 *  - Single nullable arm slot — Pi serializes turns; concurrent input cannot
 *    fire while agent_end is pending.
 *  - Restore baseline ALWAYS at agent_end (setModel persists to disk).
 */

import {
	type ExtensionAPI,
	type ExtensionContext,
	type InputEvent,
	parseSkillBlock,
} from "@earendil-works/pi-coding-agent";
import { loadModelsConfig, type ModelThinkingLevelValue } from "./models-config.js";
import {
	authorizeNextInput,
	NEXT_RECEIPT_ENTRY,
	registerNextRestorer,
	restoreNextAttempt,
} from "./next-authorization.js";
import {
	applyEffectiveModel,
	applyOrSkipIfStale,
	type BaselineSnapshot,
	getCapturedModel,
	resolveModel,
	restoreBaseline,
} from "./session-capture.js";

const SKILL_PREFIX = "/skill:";

// Keep each active override keyed by its target session manager. The target-owned
// callback registry also lets `/next` restore if dispatch ends before agent_end.
interface ArmedSkillOverride {
	baseline: BaselineSnapshot;
	attemptId?: string;
	pi: ExtensionAPI;
}

const fallbackSessionKey = {};
let armedOverrides = new WeakMap<object, ArmedSkillOverride>();

/** Test reset — wired into test/setup.ts beforeEach. */
export function __resetSkillBracketState(): void {
	armedOverrides = new WeakMap();
}

/**
 * Parse the skill name from an input-event text. Handles BOTH raw
 * `/skill:<name>` (when rpiv-args hasn't transformed yet, or is uninstalled)
 * AND wrapped `<skill name="…" location="…">…</skill>` (post-transform).
 *
 * Tokenizes the raw form on the first whitespace (space/newline/tab) so
 * `/skill:commit\n` yields `name="commit"`, not `name="commit\n"`.
 */
export function parseSkillInvocation(text: string): { name: string } | undefined {
	if (text.startsWith(SKILL_PREFIX)) {
		const wsIdx = text.search(/\s/);
		const name = wsIdx === -1 ? text.slice(SKILL_PREFIX.length) : text.slice(SKILL_PREFIX.length, wsIdx);
		return name.length > 0 ? { name } : undefined;
	}
	const wrapped = parseSkillBlock(text);
	return wrapped ? { name: wrapped.name } : undefined;
}

export function registerSkillBracket(pi: ExtensionAPI): void {
	pi.on("input", async (event: InputEvent, ctx?: ExtensionContext) => {
		const nextInput = authorizeNextInput(pi, event, ctx);
		if (nextInput.kind === "handled") return { action: "handled" } as const;
		const authorization = nextInput.kind === "authorized" ? nextInput.authorization : undefined;
		const parsed = authorization
			? { name: authorization.stageName }
			: event.source === "interactive"
				? parseSkillInvocation(event.text)
				: undefined;
		if (!parsed) return { action: "continue" } as const;

		const config = loadModelsConfig();
		const override = config.skills?.[parsed.name];
		if (!override || (override.model === undefined && override.thinking === undefined)) {
			return { action: "continue" } as const;
		}

		const sessionKey = (ctx?.sessionManager ?? fallbackSessionKey) as object;
		try {
			await applyOrSkipIfStale(async () => {
				const baselineThinking = pi.getThinkingLevel() as ModelThinkingLevelValue;
				const baseline: BaselineSnapshot = {
					thinking: baselineThinking,
					model: getCapturedModel(),
					hasModelChange: false,
				};
				armedOverrides.set(sessionKey, { baseline, pi, attemptId: authorization?.attemptId });
				if (authorization && ctx) {
					registerNextRestorer(ctx.sessionManager, authorization.attemptId, async () => {
						armedOverrides.delete(sessionKey);
						await applyOrSkipIfStale(() => restoreBaseline(pi, baseline));
					});
				}
				if (override.model && resolveModel(override.model)) baseline.hasModelChange = true;
				const { hasModelChange } = await applyEffectiveModel(pi, {
					overrideModel: override.model,
					baselineModel: baseline.model,
					overrideThinking: override.thinking,
					baselineThinking,
					label: `/skill:${parsed.name}`,
					setBaselineModel: false,
				});
				baseline.hasModelChange = baseline.hasModelChange || hasModelChange;
			});
		} catch (error) {
			if (!authorization) {
				armedOverrides.delete(sessionKey);
				throw error;
			}
			try {
				await restoreNextAttempt(sessionKey, authorization.attemptId);
			} catch (restoreError) {
				console.error("[rpiv-next] failed to restore after skill model setup failure", restoreError);
			}
			try {
				pi.appendEntry(NEXT_RECEIPT_ENTRY, { attemptId: authorization.attemptId, status: "arming-failed" });
			} catch {
				// The initial accepted receipt already consumed this one-shot authorization.
			}
			console.error("[rpiv-next] skill model setup failed; cancelling authorized input", error);
			return { action: "handled" } as const;
		}
		return { action: "continue" } as const;
	});

	pi.on("agent_end", async (_event, ctx?: ExtensionContext) => {
		const sessionKey = (ctx?.sessionManager ?? fallbackSessionKey) as object;
		const armed = armedOverrides.get(sessionKey);
		if (!armed) return;
		if (armed.attemptId) {
			const restored = await restoreNextAttempt(sessionKey, armed.attemptId);
			if (restored) return;
		}
		armedOverrides.delete(sessionKey);
		await applyOrSkipIfStale(() => restoreBaseline(armed.pi, armed.baseline));
	});
}
