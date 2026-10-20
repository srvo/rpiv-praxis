import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	addPark,
	answeredParkFor,
	answerMessage,
	formatPark,
	openParks,
	type Park,
	readParks,
	resolveChoice,
	resolveRunId,
	runsDir,
	updatePark,
} from "./park-store.ts";

const project = () => {
	const cwd = mkdtempSync(join(tmpdir(), "rpiv-park-"));
	mkdirSync(runsDir(cwd), { recursive: true });
	return cwd;
};
const q = {
	question: "Red or blue?",
	header: "Color",
	options: [{ label: "Red", description: "warm" }, { label: "Blue" }],
};
const base = { runId: "r1", workflow: "wf", stage: "pick", prompt: "/skill:pick", sessionId: "s1", questions: [q] };

describe("park store", () => {
	it("numbers parks per run and reads them back", () => {
		const cwd = project();
		expect(addPark(cwd, base, new Date("2026-01-01T00:00:00Z"))).toMatchObject({ n: 1, status: "waiting" });
		expect(addPark(cwd, base).n).toBe(2);
		expect(readParks(cwd, "r1").map((p) => p.n)).toEqual([1, 2]);
		expect(readParks(cwd, "nope")).toEqual([]);
	});

	it("tolerates a corrupt sidecar", () => {
		const cwd = project();
		writeFileSync(join(runsDir(cwd), "r1.parked.json"), "{broken");
		expect(readParks(cwd, "r1")).toEqual([]);
		writeFileSync(join(runsDir(cwd), "r1.parked.json"), '{"parks": 3}');
		expect(readParks(cwd, "r1")).toEqual([]);
	});

	it("lists open parks across runs, oldest first, and drops delivered ones", () => {
		const cwd = project();
		addPark(cwd, { ...base, runId: "r2" }, new Date("2026-01-02T00:00:00Z"));
		addPark(cwd, base, new Date("2026-01-01T00:00:00Z"));
		addPark(cwd, { ...base, runId: "r3" }, new Date("2026-01-03T00:00:00Z"));
		updatePark(cwd, "r3", 1, { status: "resumed" });
		expect(openParks(cwd).map((p) => p.runId)).toEqual(["r1", "r2"]);
		expect(openParks(join(cwd, "missing"))).toEqual([]);
	});

	it("matches answered parks by stable stage identity, independent of prompt text, and consumes repeated parks in order", () => {
		const cwd = project();
		addPark(cwd, { ...base, stage: "build (phase-1)", prompt: "the first prompt" });
		addPark(cwd, { ...base, stage: "build (phase-1)", prompt: "a repeated prompt" });
		addPark(cwd, { ...base, stage: "review", prompt: "the first prompt" });
		updatePark(cwd, "r1", 2, { status: "answered", answer: "answer-2" });
		updatePark(cwd, "r1", 3, { status: "answered", answer: "answer-3" });
		expect(answeredParkFor(cwd, "r1", "build (phase-1)")).toBeUndefined();
		updatePark(cwd, "r1", 1, { status: "answered", answer: "answer-1" });
		expect(answeredParkFor(cwd, "r1", "build (phase-1)")?.n).toBe(1);
		updatePark(cwd, "r1", 1, { status: "resumed" });
		expect(answeredParkFor(cwd, "r1", "build (phase-1)")?.n).toBe(2);
		expect(answeredParkFor(cwd, "r1", "other-stage")).toBeUndefined();
	});
	it("finds only an answered park with the same stage identity", () => {
		const cwd = project();
		addPark(cwd, base);
		expect(answeredParkFor(cwd, "r1", "pick")).toBeUndefined();
		updatePark(cwd, "r1", 1, { status: "answered", answer: "Blue" });
		expect(answeredParkFor(cwd, "r1", "other")).toBeUndefined();
		expect(answeredParkFor(cwd, "r1", "pick")?.answer).toBe("Blue");
		expect(updatePark(cwd, "r1", 9, { answer: "x" })).toBeUndefined();
	});

	it("resolves a run name through names.json", () => {
		const cwd = project();
		writeFileSync(join(runsDir(cwd), "r1.jsonl"), "{}\n");
		writeFileSync(join(runsDir(cwd), "names.json"), JSON.stringify({ shed: "r1" }));
		expect(resolveRunId(cwd, "r1")).toBe("r1");
		expect(resolveRunId(cwd, "shed")).toBe("r1");
		expect(resolveRunId(cwd, "other")).toBeUndefined();
		expect(resolveRunId(join(cwd, "x"), "shed")).toBeUndefined();
	});
});

describe("answers", () => {
	const park = { ...base, n: 1, status: "waiting", askedAt: "t" } as Park;

	it("accepts an option number, a label in any case, or free text", () => {
		expect(resolveChoice(park, "2")).toBe("Blue");
		expect(resolveChoice(park, " red ")).toBe("Red");
		expect(resolveChoice(park, "9")).toBe("9");
		expect(resolveChoice(park, "green, actually")).toBe("green, actually");
		expect(resolveChoice({ ...park, questions: [] }, "1")).toBe("1");
	});

	it("tells the resumed stage the question and the answer", () => {
		const msg = answerMessage({ ...park, answer: "Blue" });
		expect(msg).toContain("- Red or blue?");
		expect(msg).toContain("Answer: Blue");
	});

	it("prints the park's context in the inbox entry (kata r923)", () => {
		const text = formatPark({ ...park, context: "Issues:\n1. schema has two owners" });
		expect(text).toContain("  context:\n    Issues:\n    1. schema has two owners");
		expect(text.indexOf("context:")).toBeLessThan(text.indexOf("Red or blue?"));
	});

	it("formats an inbox entry with options, answer and ticket", () => {
		const text = formatPark({ ...park, answer: "Blue", kata: "ab12" });
		expect(text).toContain("r1 #1  wf › pick");
		expect(text).toContain("kata ab12");
		expect(text).toContain("[Color] Red or blue?");
		expect(text).toContain("1) Red — warm");
		expect(text).toContain("2) Blue");
		expect(text).toContain("answer: Blue");
	});
});
