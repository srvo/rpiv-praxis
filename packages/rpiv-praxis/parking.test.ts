import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Kata } from "./kata.js";
import { readParks, runsDir, updatePark } from "./park-store.js";
import { createRunParking, toQuestions } from "./parking.js";

const project = () => {
	const cwd = mkdtempSync(join(tmpdir(), "rpiv-parking-"));
	mkdirSync(runsDir(cwd), { recursive: true });
	return cwd;
};
const ask = { question: "Red or blue?", options: [{ label: "Red" }, { label: "Blue" }] };
const lifecycleCtx = { runId: "r1", workflow: "wf" } as never;

describe("createRunParking", () => {
	it("records the stage the runner announced, files a ticket, and stops the run", () => {
		const cwd = project();
		const stop = vi.fn();
		const kata: Kata = { file: vi.fn(() => "ab12"), close: vi.fn() };
		const rp = createRunParking({ cwd, kata, stop, notify: () => {} });
		rp.lifecycle.onWorkflowStart!(lifecycleCtx);
		rp.lifecycle.onStageStart!({ kind: "skill", name: "pick", stageNumber: 1, skill: "pick" }, lifecycleCtx);
		rp.parking.park({ prompt: "/skill:pick", sessionId: "s1", questions: [ask] });
		expect(stop).toHaveBeenCalledOnce();
		expect(readParks(cwd, "r1")[0]).toMatchObject({ stage: "pick", workflow: "wf", kata: "ab12", sessionId: "s1" });
		expect(rp.parked()).toHaveLength(1);
		expect(vi.mocked(kata.file).mock.calls[0]![1]).toBe("rpiv-wf answer r1 1 <choice>");
	});

	it("still stops the run when it cannot park (no run id yet)", () => {
		const cwd = project();
		const stop = vi.fn();
		const notes: string[] = [];
		createRunParking({ cwd, stop, notify: (m) => notes.push(m) }).parking.park({
			prompt: "p",
			sessionId: "s",
			questions: [],
		});
		expect(stop).toHaveBeenCalledOnce();
		expect(notes[0]).toContain("without parking");
	});

	it("hands an answered park back once, then marks it delivered", () => {
		const cwd = project();
		const rp = createRunParking({ cwd, runId: "r1", stop: () => {}, notify: () => {} });
		rp.parking.park({ prompt: "/skill:pick", sessionId: "s1", sessionFile: "/f.jsonl", questions: [ask] });
		expect(rp.parking.answerFor("/skill:pick")).toBeUndefined();
		updatePark(cwd, "r1", 1, { status: "answered", answer: "Blue" });
		const got = rp.parking.answerFor("/skill:pick")!;
		expect(got).toMatchObject({ sessionId: "s1", sessionFile: "/f.jsonl" });
		expect(got.message).toContain("Answer: Blue");
		got.delivered();
		expect(readParks(cwd, "r1")[0]!.status).toBe("resumed");
		expect(rp.parking.answerFor("/skill:pick")).toBeUndefined();
		expect(createRunParking({ cwd, stop: () => {}, notify: () => {} }).parking.answerFor("x")).toBeUndefined();
	});
});

describe("usage baseline", () => {
	it("saves a parked session's cumulative usage and hands it back with the answer", () => {
		const cwd = project();
		const rp = createRunParking({ cwd, runId: "r1", stop: () => {}, notify: () => {} });
		rp.parking.park({ prompt: "/skill:pick", sessionId: "s1", questions: [ask] });
		rp.parking.noteUsage!("other-session", { costUsd: 9, models: {} });
		rp.parking.noteUsage!("s1", { costUsd: 0.06, models: {} });
		expect(readParks(cwd, "r1")[0]!.usage).toEqual({ costUsd: 0.06, models: {} });
		updatePark(cwd, "r1", 1, { status: "answered", answer: "Blue" });
		expect(rp.parking.answerFor("/skill:pick")!.usage).toEqual({ costUsd: 0.06, models: {} });
	});
});

describe("toQuestions", () => {
	it("keeps question, header, labelled options and multiSelect; drops junk", () => {
		expect(
			toQuestions([
				{ question: "Q", header: "H", multiSelect: true, options: [{ label: "A", description: "d" }, { nope: 1 }] },
				{ question: 3 },
				null,
				{ question: "Bare" },
			]),
		).toEqual([
			{ question: "Q", header: "H", options: [{ label: "A", description: "d" }], multiSelect: true },
			{ question: "Bare", options: [] },
		]);
		expect(toQuestions("x")).toEqual([]);
	});
});
