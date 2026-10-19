import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { createMockPi, createMockUI } from "@juicesharp/rpiv-test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { showLaneConsole } from "./lane-console.js";
import { __resetLaneSwitcher, registerLaneSwitcher } from "./lane-switcher.js";
import { __resetRunLaneRegistry, recordRun } from "./run-lane-registry.js";

// The `r` rerun is the lane console's onRerun: capture it from the console call and
// drive the real session-start closure. Only the console and the runner are mocked.
vi.mock("./lane-console.js", () => ({ showLaneConsole: vi.fn() }));
const { resumeWorkflowByRunId } = vi.hoisted(() => ({ resumeWorkflowByRunId: vi.fn() }));
vi.mock("@juicesharp/rpiv-workflow/runner", () => ({ resumeWorkflowByRunId }));

const mockShowLaneConsole = vi.mocked(showLaneConsole);

type LanesHandler = (args: string, ctx: { hasUI: boolean; ui: ExtensionUIContext }) => Promise<void>;
type SessionStartHandler = (
	event: unknown,
	ctx: { hasUI?: boolean; ui?: ExtensionUIContext; cwd?: string },
) => Promise<void>;

function register(): { lanes: LanesHandler; sessionStart: SessionStartHandler } {
	const { pi, captured } = createMockPi();
	registerLaneSwitcher(pi as unknown as ExtensionAPI);
	return {
		lanes: captured.commands.get("lanes")?.handler as unknown as LanesHandler,
		sessionStart: captured.events.get("session_start")?.[0] as unknown as SessionStartHandler,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	__resetRunLaneRegistry();
	__resetLaneSwitcher();
});

/** Mount the launcher, open the console, and return the rerun callback the console received. */
async function openedRerun() {
	const { lanes, sessionStart } = register();
	recordRun("run-1", "ship");
	const ui = createMockUI() as unknown as ExtensionUIContext;
	await sessionStart(undefined, { hasUI: true, ui, cwd: "/proj" });
	mockShowLaneConsole.mockResolvedValue(undefined);
	await lanes("", { hasUI: true, ui });
	const onRerun = mockShowLaneConsole.mock.calls[0]![3] as (runId: string) => void;
	vi.mocked(ui.notify).mockClear();
	return { ui, onRerun };
}

describe("lane-switcher — `r` rerun callback (caller boundary)", () => {
	it("surfaces a lease refusal that carries the runId", async () => {
		const { ui, onRerun } = await openedRerun();
		resumeWorkflowByRunId.mockResolvedValue({
			success: false,
			stagesCompleted: 0,
			runId: "run-1",
			error: "another RPIV writer already holds the lease for run-1",
		});
		onRerun("run-1");
		await vi.waitFor(() =>
			expect(ui.notify).toHaveBeenCalledWith("another RPIV writer already holds the lease for run-1", "error"),
		);
	});

	it("surfaces a pre-run refusal with no runId", async () => {
		const { ui, onRerun } = await openedRerun();
		resumeWorkflowByRunId.mockResolvedValue({ success: false, stagesCompleted: 0, error: "run not found" });
		onRerun("run-1");
		await vi.waitFor(() => expect(ui.notify).toHaveBeenCalledWith("run not found", "error"));
	});

	it("stays silent on an in-run failure that the stage machinery already notified", async () => {
		const { ui, onRerun } = await openedRerun();
		resumeWorkflowByRunId.mockResolvedValue({
			success: false,
			stagesCompleted: 1,
			runId: "run-1",
			error: "research produced no assistant message",
			termination: { status: "failed", error: "research produced no assistant message" },
		});
		onRerun("run-1");
		await vi.waitFor(() => expect(resumeWorkflowByRunId).toHaveBeenCalledWith(expect.anything(), "run-1"));
		await new Promise((done) => setTimeout(done, 0));
		expect(ui.notify).not.toHaveBeenCalled();
	});

	it("stays silent when the resume succeeds", async () => {
		const { ui, onRerun } = await openedRerun();
		resumeWorkflowByRunId.mockResolvedValue({ success: true, stagesCompleted: 2, runId: "run-1" });
		onRerun("run-1");
		await vi.waitFor(() => expect(resumeWorkflowByRunId).toHaveBeenCalledWith(expect.anything(), "run-1"));
		await new Promise((done) => setTimeout(done, 0));
		expect(ui.notify).not.toHaveBeenCalled();
	});

	it("reports a rejected resume instead of dropping it", async () => {
		const { ui, onRerun } = await openedRerun();
		resumeWorkflowByRunId.mockRejectedValue(new Error("disk gone"));
		onRerun("run-1");
		await vi.waitFor(() => expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("resume failed"), "error"));
	});
});
