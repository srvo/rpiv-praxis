import {
	type ExtensionAPI,
	type ExtensionContext,
	type InputEvent,
	parseSkillBlock,
} from "@earendil-works/pi-coding-agent";
import type { RPIV_STAGE_NAMES } from "./pipeline-pointer.js";

type CommandIdentity = { name: string; source?: string; sourceInfo?: { path?: string } };
const NEXT_COMMANDS_KEY = Symbol.for("@juicesharp/rpiv-pi/next-target-commands");
type TargetCommandRegistry = WeakMap<object, () => readonly CommandIdentity[]>;
function targetCommandRegistry(): TargetCommandRegistry {
	const globals = globalThis as Record<symbol, unknown>;
	if (!globals[NEXT_COMMANDS_KEY]) globals[NEXT_COMMANDS_KEY] = new WeakMap();
	return globals[NEXT_COMMANDS_KEY] as TargetCommandRegistry;
}
export function registerNextTargetCommands(manager: object, getCommands: () => readonly CommandIdentity[]): void {
	targetCommandRegistry().set(manager, getCommands);
}
export function getNextTargetCommands(manager: object): readonly CommandIdentity[] | undefined {
	return targetCommandRegistry().get(manager)?.();
}
export function hasNextCommandCollision(commands: readonly CommandIdentity[], stageName: string): boolean {
	return commands.some((command) => command.name === `skill:${stageName}` && command.source !== "skill");
}
export const NEXT_AUTHORIZATION_ENTRY = "rpiv_next_authorization";
export const NEXT_RECEIPT_ENTRY = "rpiv_next_receipt";

export interface NextAuthorization {
	attemptId: string;
	sourceSessionId: string;
	sourceSessionFile: string;
	sourceEntryId: string;
	targetSessionId?: string;
	command: string;
	stageName: (typeof RPIV_STAGE_NAMES)[number];
	skillPath: string;
	inputArtifact: string;
	inputArtifactSha256: string;
	workingDirectory: string;
	branch: string;
	kataIssue: string;
	requiresTokenSubstitution: boolean;
}

interface AuthorizationEntry {
	type?: string;
	customType?: string;
	data?: NextAuthorization | { attemptId?: string; status?: string };
}

const NEXT_RESTORERS_KEY = Symbol.for("@juicesharp/rpiv-pi/next-target-restorers");
type NextRestorerRegistry = WeakMap<object, Map<string, () => Promise<void>>>;

function nextRestorerRegistry(): NextRestorerRegistry {
	const globalState = globalThis as Record<symbol, unknown>;
	let registry = globalState[NEXT_RESTORERS_KEY] as NextRestorerRegistry | undefined;
	if (!registry) {
		registry = new WeakMap();
		globalState[NEXT_RESTORERS_KEY] = registry;
	}
	return registry;
}

export function registerNextRestorer(sessionManager: object, attemptId: string, restore: () => Promise<void>): void {
	const registry = nextRestorerRegistry();
	const restorers = registry.get(sessionManager) ?? new Map<string, () => Promise<void>>();
	restorers.set(attemptId, restore);
	registry.set(sessionManager, restorers);
}

export async function restoreNextAttempt(sessionManager: object, attemptId: string): Promise<boolean> {
	const registry = nextRestorerRegistry();
	const restorers = registry.get(sessionManager);
	const restore = restorers?.get(attemptId);
	if (!restore || !restorers) return false;
	// Remove before awaiting so agent_end and dispatch-finally cannot restore twice.
	restorers.delete(attemptId);
	if (restorers.size === 0) registry.delete(sessionManager);
	await restore();
	return true;
}

function pendingNextAuthorizations(ctx?: ExtensionContext): NextAuthorization[] {
	if (!ctx) return [];
	const entries = ctx.sessionManager.getEntries() as AuthorizationEntry[];
	const receipts = new Set(
		entries
			.filter((entry) => entry.type === "custom" && entry.customType === NEXT_RECEIPT_ENTRY)
			.map((entry) => entry.data?.attemptId)
			.filter((attemptId): attemptId is string => typeof attemptId === "string"),
	);
	return entries
		.filter((entry) => entry.type === "custom" && entry.customType === NEXT_AUTHORIZATION_ENTRY)
		.map((entry) => entry.data as NextAuthorization | undefined)
		.filter(
			(data): data is NextAuthorization =>
				!!data && typeof data.attemptId === "string" && !receipts.has(data.attemptId),
		);
}

function matchesNextAuthorization(text: string, authorization: NextAuthorization): boolean {
	const command = authorization.command.match(/^\/skill:([a-z][a-z0-9-]*)(?: +([\s\S]*))?$/);
	if (!command || command[1] !== authorization.stageName) return false;
	const expectedTail = (command[2] ?? "").trim();
	const raw = text.match(/^\/skill:([a-z][a-z0-9-]*)(?: +([\s\S]*))?$/);
	if (raw) return raw[1] === authorization.stageName && (raw[2] ?? "").trim() === expectedTail;
	const wrapped = parseSkillBlock(text);
	if (!wrapped || wrapped.name !== authorization.stageName || wrapped.location !== authorization.skillPath)
		return false;
	let observedTail = (wrapped.userMessage ?? "").trim();
	if (authorization.requiresTokenSubstitution && observedTail.startsWith("Skill input:")) {
		observedTail = observedTail.slice("Skill input:".length).trim();
	}
	return observedTail === expectedTail;
}
function matchesInstalledNextSkill(pi: Pick<ExtensionAPI, "getCommands">, authorization: NextAuthorization): boolean {
	try {
		if (hasNextCommandCollision(pi.getCommands(), authorization.stageName)) return false;
		const matches = pi
			.getCommands()
			.filter(
				(command) =>
					command.source === "skill" &&
					(command.name === authorization.stageName || command.name === `skill:${authorization.stageName}`),
			);
		return matches.length === 1 && matches[0]!.sourceInfo?.path === authorization.skillPath;
	} catch {
		return false;
	}
}

export type NextInputAuthorization =
	| { kind: "unrelated" }
	| { kind: "authorized"; authorization: NextAuthorization }
	| { kind: "handled" };

export function authorizeNextInput(
	pi: Pick<ExtensionAPI, "appendEntry" | "getCommands">,
	event: InputEvent,
	ctx?: ExtensionContext,
): NextInputAuthorization {
	if (event.source !== "extension") return { kind: "unrelated" };
	const authorizations = pendingNextAuthorizations(ctx);
	if (authorizations.length === 0) return { kind: "unrelated" };
	if (authorizations.length !== 1) {
		for (const authorization of authorizations) {
			try {
				pi.appendEntry(NEXT_RECEIPT_ENTRY, { attemptId: authorization.attemptId, status: "rejected" });
			} catch {
				// The handled result still prevents ambiguous input reaching the model.
			}
		}
		return { kind: "handled" };
	}
	const authorization = authorizations[0]!;
	const accepted =
		authorization.targetSessionId === ctx?.sessionManager.getSessionId() &&
		matchesInstalledNextSkill(pi, authorization) &&
		matchesNextAuthorization(event.text, authorization);
	try {
		pi.appendEntry(NEXT_RECEIPT_ENTRY, {
			attemptId: authorization.attemptId,
			sourceSessionId: authorization.sourceSessionId,
			sourceEntryId: authorization.sourceEntryId,
			status: accepted ? "accepted" : "rejected",
		});
	} catch {
		return { kind: "handled" };
	}
	return accepted ? { kind: "authorized", authorization } : { kind: "handled" };
}
