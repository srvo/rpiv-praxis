import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BranchEntry } from "@juicesharp/rpiv-workflow";
import { describe, expect, it } from "vitest";
import {
	claudeConfigDir,
	locateSessionFile,
	projectDirName,
	readSessionBranch,
	stampStop,
	userEntry,
} from "./transcript.js";

describe("stampStop", () => {
	it("stamps the last assistant entry at or after the turn start", () => {
		const branch: BranchEntry[] = [
			{ type: "message", message: { role: "assistant", content: [] } },
			userEntry("go"),
			{ type: "message", message: { role: "assistant", content: [] } },
		];
		stampStop(branch, "stop", 1);
		expect(branch[2]!.message!.stopReason).toBe("stop");
		expect(branch[0]!.message!.stopReason).toBeUndefined();
	});

	it("never stamps an earlier turn's reply", () => {
		const branch: BranchEntry[] = [{ type: "message", message: { role: "assistant", content: [] } }, userEntry("go")];
		stampStop(branch, "error", 1);
		expect(branch).toHaveLength(3);
		expect(branch[0]!.message!.stopReason).toBeUndefined();
	});
});

describe("session files", () => {
	function store() {
		const config = mkdtempSync(join(tmpdir(), "claude-config-"));
		const mk = (dir: string, id: string, body = "") => {
			mkdirSync(join(config, "projects", dir), { recursive: true });
			writeFileSync(join(config, "projects", dir, `${id}.jsonl`), body);
			return join(config, "projects", dir, `${id}.jsonl`);
		};
		return { config, mk };
	}

	it("encodes a cwd the way Claude Code names project directories", () => {
		expect(projectDirName("/tmp/a.b/c_d")).toBe("-tmp-a-b-c-d");
	});

	it("prefers the stage's own project directory when an id exists in several", () => {
		const { config, mk } = store();
		mk("-aaa-launcher", "same-id");
		const own = mk(projectDirName("/work/proj"), "same-id");
		expect(locateSessionFile("same-id", config, "/work/proj")).toBe(own);
	});

	it("falls back to any project directory, and to undefined", () => {
		const { config, mk } = store();
		const other = mk("-elsewhere", "id-1");
		expect(locateSessionFile("id-1", config, "/work/proj")).toBe(other);
		expect(locateSessionFile("missing", config)).toBeUndefined();
		expect(locateSessionFile("", config)).toBeUndefined();
		expect(locateSessionFile("x", join(config, "nope"))).toBeUndefined();
	});

	it("reads the SDK session chain and skips sidechains, metadata and bad lines", async () => {
		const { config, mk } = store();
		const id = "22222222-2222-4222-8222-222222222222";
		const rows = [
			JSON.stringify({ type: "user", uuid: "u1", parentUuid: null, sessionId: id, message: { content: "hi" } }),
			JSON.stringify({
				type: "assistant",
				uuid: "a1",
				parentUuid: "u1",
				sessionId: id,
				message: { content: [{ type: "text", text: "yo" }] },
			}),
			JSON.stringify({
				type: "assistant",
				uuid: "sub",
				parentUuid: "a1",
				parent_tool_use_id: "toolu",
				isSidechain: true,
				sessionId: id,
				message: { content: [{ type: "text", text: "sub" }] },
			}),
			JSON.stringify({
				type: "user",
				uuid: "u2",
				parentUuid: "a1",
				sessionId: id,
				message: { content: [{ type: "tool_result", content: "r" }] },
			}),
			JSON.stringify({ type: "queue-operation" }),
			"{not json",
			"",
		];
		const previous = process.env.CLAUDE_CONFIG_DIR;
		process.env.CLAUDE_CONFIG_DIR = config;
		try {
			const branch = (await readSessionBranch(mk("-p", id, rows.join("\n"))))!;
			expect(branch.map((e) => [e.message?.role, e.message?.content?.[0]?.type])).toEqual([
				["user", "text"],
				["assistant", "text"],
				["user", "tool_result"],
			]);
		} finally {
			if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
			else process.env.CLAUDE_CONFIG_DIR = previous;
		}
	});

	it("reads only the SDK-selected parentUuid chain after a transcript rewind", async () => {
		const { config, mk } = store();
		const id = "11111111-1111-4111-8111-111111111111";
		const rows = [
			{ type: "user", uuid: "u1", parentUuid: null, sessionId: id, message: { content: "start" } },
			{
				type: "assistant",
				uuid: "a1",
				parentUuid: "u1",
				sessionId: id,
				message: { content: [{ type: "text", text: "wrote .rpiv/artifacts/abandoned.md" }] },
			},
			{ type: "user", uuid: "u2", parentUuid: "u1", sessionId: id, message: { content: "revise it" } },
			{
				type: "assistant",
				uuid: "a2",
				parentUuid: "u2",
				sessionId: id,
				message: { content: [{ type: "text", text: "active answer" }] },
			},
		];
		const previous = process.env.CLAUDE_CONFIG_DIR;
		process.env.CLAUDE_CONFIG_DIR = config;
		try {
			const branch = await readSessionBranch(mk("-p", id, rows.map((row) => JSON.stringify(row)).join("\n")));
			expect(branch?.map((entry) => entry.message?.role)).toEqual(["user", "user", "assistant"]);
			expect(JSON.stringify(branch)).not.toContain("abandoned.md");
		} finally {
			if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
			else process.env.CLAUDE_CONFIG_DIR = previous;
		}
	});
	it("returns undefined for an unreadable file", async () => {
		expect(await readSessionBranch("/nonexistent/file.jsonl")).toBeUndefined();
	});

	it("honours CLAUDE_CONFIG_DIR", () => {
		expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: "/cfg" })).toBe("/cfg");
		expect(claudeConfigDir({})).toMatch(/\.claude$/);
	});
});
