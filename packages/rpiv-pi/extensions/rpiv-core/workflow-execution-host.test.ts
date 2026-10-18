/**
 * workflow-execution-host tests — the root-gated provider registration hook.
 * The execution-host provider lives in a process-global,
 * last-writer-wins box; a detached child re-loading rpiv-core must NOT register
 * it (else the next /wf dispatches through the child instance). The hook gates on
 * session_start: ROOT launcher (hasUI + real ui) registers; a foreground child
 * (branded relay ui) and any non-UI session do not.
 */

import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the rpiv-workflow /startup seam so registration is observable without the
// real provider box — registerWorkflowExecutionHostProvider() imports it lazily.
const registerWorkflowExecutionHost = vi.fn();
vi.mock("@juicesharp/rpiv-workflow/startup", () => ({ registerWorkflowExecutionHost }));

import { createLaneRelayUiContext } from "./lane-relay-ui.ts";
import { SINGLE_UNIT_KEY } from "./run-lane-registry.ts";
import { registerWorkflowExecutionHostProviderHook } from "./workflow-execution-host.ts";

type SessionLifecycleHandler = (ev: unknown, ctx: unknown) => unknown | Promise<unknown>;

function makePi(): {
	pi: ExtensionAPI;
	sessionStart: () => SessionLifecycleHandler | undefined;
	sessionShutdown: () => SessionLifecycleHandler | undefined;
} {
	let startHandler: SessionLifecycleHandler | undefined;
	let shutdownHandler: SessionLifecycleHandler | undefined;
	const pi = {
		on: vi.fn((event: string, handler: SessionLifecycleHandler) => {
			if (event === "session_start") startHandler = handler;
			if (event === "session_shutdown") shutdownHandler = handler;
		}),
	} as unknown as ExtensionAPI;
	return {
		pi,
		sessionStart: () => startHandler,
		sessionShutdown: () => shutdownHandler,
	};
}

const REAL_UI = { notify: vi.fn(), setStatus: vi.fn() } as unknown as ExtensionUIContext;

beforeEach(() => {
	registerWorkflowExecutionHost.mockReset();
});
afterEach(() => {
	vi.restoreAllMocks();
});

describe("registerWorkflowExecutionHostProviderHook", () => {
	it("registers the provider on the ROOT launcher's session_start", async () => {
		const { pi, sessionStart } = makePi();
		registerWorkflowExecutionHostProviderHook(pi);
		await sessionStart()!({}, { hasUI: true, ui: REAL_UI });
		expect(registerWorkflowExecutionHost).toHaveBeenCalledTimes(1);
	});
	it("disposes the previous provider on re-registration and the final provider on session shutdown", async () => {
		const { pi, sessionStart, sessionShutdown } = makePi();
		const disposeFirst = vi.fn();
		const disposeSecond = vi.fn();
		registerWorkflowExecutionHost.mockReturnValueOnce(disposeFirst).mockReturnValueOnce(disposeSecond);
		registerWorkflowExecutionHostProviderHook(pi);
		await sessionStart()!({}, { hasUI: true, ui: REAL_UI });
		await sessionStart()!({}, { hasUI: true, ui: REAL_UI });
		expect(disposeFirst).toHaveBeenCalledOnce();
		expect(disposeSecond).not.toHaveBeenCalled();
		await sessionShutdown()!({}, { hasUI: true, ui: REAL_UI });
		expect(disposeSecond).toHaveBeenCalledOnce();
	});

	it("disposes a provider whose async registration finishes after shutdown", async () => {
		const { pi, sessionStart, sessionShutdown } = makePi();
		const dispose = vi.fn();
		registerWorkflowExecutionHost.mockReturnValueOnce(dispose);
		registerWorkflowExecutionHostProviderHook(pi);

		const start = sessionStart()!({}, { hasUI: true, ui: REAL_UI });
		await sessionShutdown()!({}, { hasUI: true, ui: REAL_UI });
		await start;

		expect(dispose).toHaveBeenCalledOnce();
	});

	it("does NOT register for a detached foreground child (branded relay ui)", async () => {
		const { pi, sessionStart } = makePi();
		registerWorkflowExecutionHostProviderHook(pi);
		const relay = createLaneRelayUiContext(REAL_UI, "child-run", SINGLE_UNIT_KEY);
		await sessionStart()!({}, { hasUI: true, ui: relay });
		expect(registerWorkflowExecutionHost).not.toHaveBeenCalled();
	});

	it("does NOT register for a non-UI session (background fanout child / headless)", async () => {
		const { pi, sessionStart } = makePi();
		registerWorkflowExecutionHostProviderHook(pi);
		await sessionStart()!({}, { hasUI: false, ui: undefined });
		expect(registerWorkflowExecutionHost).not.toHaveBeenCalled();
	});
});
