import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
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

	it("stores the context with the park and refreshes it from the turn's end (kata r923)", () => {
		const cwd = project();
		const kata: Kata = { file: vi.fn(() => "ab12"), close: vi.fn() };
		const rp = createRunParking({ cwd, kata, stop: vi.fn(), notify: () => {} });
		rp.lifecycle.onWorkflowStart!(lifecycleCtx);
		rp.parking.park({ prompt: "/skill:d", sessionId: "s1", questions: [ask], context: "the 5 issues" });
		expect(readParks(cwd, "r1")[0]!.context).toBe("the 5 issues");
		expect(vi.mocked(kata.file).mock.calls[0]![0].context).toBe("the 5 issues");
		rp.parking.noteContext!("other", "not mine");
		rp.parking.noteContext!("s1", "the 5 issues, in full");
		expect(readParks(cwd, "r1")[0]!.context).toBe("the 5 issues, in full");
	});

	it("records the stage the host says asked, not whichever started last (kata 79yy)", () => {
		const cwd = project();
		const rp = createRunParking({ cwd, stop: vi.fn(), notify: () => {} });
		rp.lifecycle.onWorkflowStart!(lifecycleCtx);
		rp.lifecycle.onStageStart!({ kind: "skill", name: "design (s1)", stageNumber: 1, skill: "d" }, lifecycleCtx);
		rp.lifecycle.onStageStart!({ kind: "skill", name: "design (s2)", stageNumber: 2, skill: "d" }, lifecycleCtx);
		rp.parking.park({ prompt: "/skill:d", sessionId: "s1", questions: [ask], stage: "design (s1)" });
		expect(readParks(cwd, "r1")[0]).toMatchObject({ stage: "design (s1)" });
	});

	it("record appends an audit row to the run log", () => {
		const cwd = project();
		const rp = createRunParking({ cwd, stop: vi.fn(), notify: () => {} });
		rp.lifecycle.onWorkflowStart!(lifecycleCtx);
		rp.parking.record!({ type: "checkpoint-auto-accepted", stage: "design-review", reason: "flag" });
		const rows = readFileSync(join(runsDir(cwd), "r1.jsonl"), "utf-8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l));
		expect(rows).toEqual([
			expect.objectContaining({ type: "checkpoint-auto-accepted", stage: "design-review", reason: "flag" }),
		]);
		expect(typeof rows[0].ts).toBe("string");
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
		rp.parking.park({
			prompt: "/skill:pick",
			stage: "pick",
			sessionId: "s1",
			sessionFile: "/f.jsonl",
			questions: [ask],
		});
		expect(rp.parking.answerFor("pick")).toBeUndefined();
		updatePark(cwd, "r1", 1, { status: "answered", answer: "Blue" });
		const got = rp.parking.answerFor("pick")!;
		expect(got).toMatchObject({ sessionId: "s1", sessionFile: "/f.jsonl" });
		expect(got.message).toContain("Answer: Blue");
		got.delivered();
		expect(readParks(cwd, "r1")[0]!.status).toBe("resumed");
		expect(rp.parking.answerFor("pick")).toBeUndefined();
		expect(createRunParking({ cwd, stop: () => {}, notify: () => {} }).parking.answerFor("x")).toBeUndefined();
	});
});

describe("usage baseline", () => {
	it("saves a parked session's cumulative usage and hands it back with the answer", () => {
		const cwd = project();
		const rp = createRunParking({ cwd, runId: "r1", stop: () => {}, notify: () => {} });
		rp.parking.park({ prompt: "/skill:pick", stage: "pick", sessionId: "s1", questions: [ask] });
		rp.parking.noteUsage!("other-session", { costUsd: 9, models: {} });
		rp.parking.noteUsage!("s1", { costUsd: 0.06, models: {} });
		expect(readParks(cwd, "r1")[0]!.usage).toEqual({ costUsd: 0.06, models: {} });
		updatePark(cwd, "r1", 1, { status: "answered", answer: "Blue" });
		expect(rp.parking.answerFor("pick")!.usage).toEqual({ costUsd: 0.06, models: {} });
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
