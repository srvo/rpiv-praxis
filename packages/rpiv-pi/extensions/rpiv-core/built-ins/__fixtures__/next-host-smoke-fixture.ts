import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Message,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
	type AgentSession,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	type ExtensionAPI,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { parseCommandArgs, registerArgsHandler } from "../../../../../rpiv-args/args.js";
import { LOADED_MARKER } from "../../../../../rpiv-args/index.js";
import { invalidateModelsConfigCache } from "../../models-config.js";
import { NEXT_APPROVAL_MARKER, type NextPreflightFacts, registerNextCommand } from "../../next-command.js";
import { registerSessionCapture } from "../../session-capture.js";
import { registerSkillBracket } from "../../skill-bracket.js";

export const PROVIDER = "rpiv-native-smoke";
export const OLD_TRANSCRIPT = "OLD_TRANSCRIPT_SENTINEL_NOT_FOR_TARGET";

export function smokeFooter(cwd: string, command: string): string {
	return [
		`**Next step:** \`${command}\``,
		`**Working directory:** \`${cwd}\``,
		`**Input artifact:** \`${join(cwd, "docs/a plan.md")}\``,
		"**Branch:** `y9nt-next-phase1`",
		"**Kata issue:** `rpiv-praxis#y9nt`",
		NEXT_APPROVAL_MARKER,
	].join("\n");
}

export async function createNativeSmokeFixture() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "rpiv-next-native-")));
	const cwd = join(root, "workspace");
	const agentDir = join(root, "agent");
	const sessionDir = join(root, "sessions");
	const xdg = join(root, "config");
	const skillDir = join(root, "skills/implement");
	for (const directory of [cwd, agentDir, sessionDir, skillDir, join(cwd, "docs"), join(xdg, "rpiv-pi")]) {
		mkdirSync(directory, { recursive: true });
	}
	const skillPath = join(skillDir, "SKILL.md");
	const setupFile = join(root, "setup-count.txt");
	const artifact = join(cwd, "docs/a plan.md");
	const command = '/skill:implement "docs/a plan.md" Phase 1';
	writeFileSync(artifact, "# Inert approved plan\nNo repository changes are authorized.\n");
	writeFileSync(
		skillPath,
		[
			"---",
			"name: implement",
			"description: Inert native-host smoke fixture only.",
			"disable-model-invocation: true",
			"---",
			"Do no work. This fixture only exercises host plumbing.",
			"FILE=$1; PHASE=$2 $3; ALL=$ARGUMENTS",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: literal rpiv-args input tokens
			"DIR=${SKILL_DIR}; SESSION=${SESSION_ID}",
			"```!",
			`printf 'setup\\n' >> '${setupFile}'`,
			"printf 'SETUP_OK\\n'",
			"```",
		].join("\n"),
	);
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({
			defaultProvider: PROVIDER,
			defaultModel: "baseline",
			defaultThinkingLevel: "low",
			compaction: { enabled: false },
			retry: { enabled: false },
			cacheWarming: "off",
		}),
	);
	writeFileSync(
		join(xdg, "rpiv-pi/models.json"),
		JSON.stringify({
			skills: { implement: { model: `${PROVIDER}/stage`, thinking: "high" } },
		}),
	);
	const previousCwd = process.cwd();
	const previousXdg = process.env.XDG_CONFIG_HOME;
	const marker = Symbol.for(LOADED_MARKER);
	const globals = globalThis as Record<symbol, unknown>;
	const previousMarker = globals[marker];
	process.chdir(cwd);
	process.env.XDG_CONFIG_HOME = xdg;
	invalidateModelsConfigCache();
	const calls: Array<{ model: string; reasoning: SimpleStreamOptions["reasoning"]; messages: Message[] }> = [];
	const inputs: Array<{ text: string; source: string; sessionId: string; cwd: string }> = [];
	const events: Array<{ sessionId: string; type: string }> = [];
	const starts: Array<{ sessionId: string; reason: string }> = [];
	const shutdowns: string[] = [];
	const errors: unknown[] = [];
	const notices: string[] = [];
	const sessions: AgentSession[] = [];
	const modelMutations: string[] = [];
	const thinkingMutations: string[] = [];
	const facts: Array<{ sessionId: string; persistedRequired: boolean }> = [];

	const factory: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
		const modelRuntime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: null,
			modelsStorePath: join(agentDir, "catalog.json"),
			allowModelNetwork: false,
			refreshOnCreate: false,
		});
		modelRuntime.registerProvider(PROVIDER, {
			api: "openai-completions",
			baseUrl: "http://inert.invalid",
			apiKey: "test-only-not-a-credential",
			models: ["baseline", "stage"].map((id) => ({
				id,
				name: id,
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 1024,
			})),
			streamSimple(model, context, options) {
				const index = calls.length;
				calls.push({ model: model.id, reasoning: options?.reasoning, messages: structuredClone(context.messages) });
				if (index > 2) throw new Error("Unexpected automatic next-stage execution");
				const stream = createAssistantMessageEventStream();
				const message: AssistantMessage = {
					role: "assistant",
					api: model.api,
					provider: model.provider,
					model: model.id,
					content: [],
					stopReason: "pending",
					timestamp: Date.now(),
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				};
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					if (index === 1) {
						const toolCall = { type: "toolCall" as const, id: "cwd-probe", name: "bash", arguments: {} };
						message.content.push(toolCall);
						stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
						toolCall.arguments = { command: "pwd" };
						stream.push({
							type: "toolcall_delta",
							contentIndex: 0,
							delta: '{"command":"pwd"}',
							partial: message,
						});
						stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
						message.stopReason = "toolUse";
					} else {
						const text =
							index === 0
								? `${OLD_TRANSCRIPT}\n${smokeFooter(cwd, command)}`
								: `Inert stage finished.\n${smokeFooter(cwd, '/skill:validate "docs/a plan.md" Phase 2')}`;
						const block = { type: "text" as const, text: "" };
						message.content.push(block);
						stream.push({ type: "text_start", contentIndex: 0, partial: message });
						block.text = text;
						stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
						stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
						message.stopReason = "stop";
					}
					stream.push({ type: "done", reason: message.stopReason, message });
					stream.end();
				});
				return stream;
			},
		});
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			modelRuntime,
			settingsManager: SettingsManager.create(cwd, agentDir),
			resourceLoaderOptions: {
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
				systemPrompt: "Inert native SDK test; never execute repository work.",
				additionalSkillPaths: [skillPath],
				extensionFactories: [
					(pi) => {
						// Observe calls without replacing SDK behavior or any production handler.
						const setModel = pi.setModel.bind(pi);
						pi.setModel = async (model) => {
							modelMutations.push(model.id);
							return setModel(model);
						};
						const setThinking = pi.setThinkingLevel.bind(pi);
						pi.setThinkingLevel = (level) => {
							thinkingMutations.push(level);
							setThinking(level);
						};
						registerSessionCapture(pi);
						registerSkillBracket(pi);
						registerNextCommand(pi, {
							parseCommandArgs,
							collectPreflightFacts: async (ctx, handoff, options): Promise<NextPreflightFacts> => {
								facts.push({
									sessionId: ctx.sessionManager.getSessionId(),
									persistedRequired: options?.requirePersistedSession !== false,
								});
								return {
									cwd: ctx.cwd,
									processCwd: process.cwd(),
									worktreeRoot: cwd,
									branch: handoff.branch,
									detached: false,
									sessionPersisted: ctx.sessionManager.getSessionFile() !== undefined,
									trustedProject: ctx.isProjectTrusted(),
									foregroundBusy: !ctx.isIdle(),
									queuedInput: ctx.hasPendingMessages(),
									laneStatuses: [],
									preflightRequired: true,
									preflightAvailable: true,
									preflightPassed: true,
									preflightArgs: ["--allow-dirty"],
									projectRegistered: true,
									issueRef: handoff.kataIssue,
									issueStatus: "open",
									issueReady: true,
									protectedBranch: false,
								};
							},
						});
						observeLifecycle(pi);
					},
					(pi) => {
						globals[marker] = true;
						registerArgsHandler(pi);
					},
					(pi) => {
						pi.on("input", (event, ctx) => {
							inputs.push({
								text: event.text,
								source: event.source,
								sessionId: ctx.sessionManager.getSessionId(),
								cwd: ctx.cwd,
							});
						});
					},
				],
			},
		});
		const result = await createAgentSessionFromServices({
			services,
			sessionManager,
			sessionStartEvent,
			model: modelRuntime.getModel(PROVIDER, "baseline"),
			thinkingLevel: "low",
			tools: ["bash"],
		});
		sessions.push(result.session);
		return { ...result, services, diagnostics: services.diagnostics };
	};
	function observeLifecycle(pi: ExtensionAPI) {
		pi.on("session_start", (event, ctx) => {
			starts.push({ sessionId: ctx.sessionManager.getSessionId(), reason: event.reason });
		});
		pi.on("session_shutdown", (_event, ctx) => {
			shutdowns.push(ctx.sessionManager.getSessionId());
		});
	}
	const runtime = await createAgentSessionRuntime(factory, {
		cwd,
		agentDir,
		sessionManager: SessionManager.create(cwd, sessionDir),
	});
	let unsubscribe: (() => void) | undefined;
	const bind = async (session: AgentSession) => {
		unsubscribe?.();
		unsubscribe = session.subscribe((event) => {
			events.push({ sessionId: session.sessionId, type: event.type });
		});
		await session.bindExtensions({
			onError: (error) => {
				errors.push(error);
			},
			commandContextActions: {
				waitForIdle: () => session.waitForIdle(),
				newSession: (options) => runtime.newSession(options),
				switchSession: (path, options) => runtime.switchSession(path, options),
				fork: (entryId, options) => runtime.fork(entryId, options),
				navigateTree: (entryId, options) => session.navigateTree(entryId, options),
				reload: () => session.reload(),
			},
		});
		// SDK's headless UI is intentionally inert; collect warnings as diagnostic evidence.
		const ui = session.extensionRunner.createContext().ui;
		ui.notify = (message) => {
			notices.push(message);
		};
	};
	runtime.setRebindSession(bind);
	await bind(runtime.session);
	return {
		root,
		cwd,
		agentDir,
		artifact,
		skillPath,
		skillDir,
		setupFile,
		command,
		runtime,
		calls,
		inputs,
		events,
		starts,
		shutdowns,
		errors,
		notices,
		sessions,
		modelMutations,
		thinkingMutations,
		facts,
		async cleanup() {
			unsubscribe?.();
			await runtime.dispose();
			await runtime.services.settingsManager.flush();
			process.chdir(previousCwd);
			if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
			else process.env.XDG_CONFIG_HOME = previousXdg;
			if (previousMarker === undefined) delete globals[marker];
			else globals[marker] = previousMarker;
			invalidateModelsConfigCache();
			rmSync(root, { recursive: true, force: true });
		},
	};
}
