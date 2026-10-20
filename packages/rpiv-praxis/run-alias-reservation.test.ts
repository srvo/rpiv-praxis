import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerRunAlias, reserveRunAlias, resolveRunAlias } from "./run-alias.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "rpiv-alias-reservation-"));
	roots.push(root);
	execFileSync("git", ["init", "-q", root], { stdio: "ignore" });
	const registry = join(root, ".git", "rpiv-workflow-aliases");
	mkdirSync(registry);
	return { root, registry, claim: join(registry, "shared.claim"), target: join(registry, "shared.json") };
}

describe("alias reservations", () => {
	it("allows one admission across independent OS processes", async () => {
		const f = fixture();
		const script = `
			import { reserveRunAlias } from ${JSON.stringify(new URL("./run-alias.ts", import.meta.url).href)};
			let release;
			process.on("message", (message) => {
				if (message === "start") {
					try {
						release = reserveRunAlias(${JSON.stringify(f.root)}, "shared");
						process.send({ acquired: true });
					} catch (error) {
						process.send({ acquired: false, error: error.message });
					}
				} else {
					release?.();
					process.disconnect();
				}
			});
			process.send({ ready: true });
		`;
		const children = Array.from({ length: 3 }, () => {
			const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
				stdio: ["ignore", "ignore", "pipe", "ipc"],
			});
			return { child, ready: once(child, "message"), exit: once(child, "exit") };
		});
		try {
			await Promise.all(children.map(({ ready }) => ready));
			const replies = children.map(({ child }) => {
				const reply = once(child, "message");
				child.send("start");
				return reply;
			});
			const results = (await Promise.all(replies)).map(
				([message]) => message as { acquired: boolean; error?: string },
			);
			expect(results.filter((result) => result.acquired)).toHaveLength(1);
			for (const loser of results.filter((result) => !result.acquired)) {
				expect(loser.error).toMatch(/repair.*originating/i);
			}
			expect(JSON.parse(readFileSync(f.claim, "utf8"))).toMatchObject({
				pid: expect.any(Number),
				token: expect.any(String),
			});
		} finally {
			for (const { child } of children) if (child.connected) child.send("stop");
			await Promise.all(children.map(({ exit }) => exit));
		}
		expect(existsSync(f.claim)).toBe(false);
	});

	it("releases only its own token and is idempotent across successor claims", () => {
		const f = fixture();
		const releaseFirst = reserveRunAlias(f.root, "shared")!;
		releaseFirst();
		const releaseSecond = reserveRunAlias(f.root, "shared")!;
		releaseFirst();
		expect(existsSync(f.claim)).toBe(true);
		releaseSecond();
		const releaseThird = reserveRunAlias(f.root, "shared")!;
		writeFileSync(f.claim, JSON.stringify({ token: "replacement" }));
		releaseThird();
		expect(JSON.parse(readFileSync(f.claim, "utf8"))).toEqual({ token: "replacement" });
	});

	it.each(["", "{", JSON.stringify({ pid: 99999999, cwd: "/removed", token: "abandoned" })])(
		"fails closed on an occupied claim, without stale or unreadable claim stealing (%s)",
		(record) => {
			const f = fixture();
			writeFileSync(f.claim, record);
			expect(() => reserveRunAlias(f.root, "shared")).toThrow(/choose.*name.*repair.*originating/i);
			expect(readFileSync(f.claim, "utf8")).toBe(record);
		},
	);

	it.each(["published", "stale", "unreadable"])("rechecks a %s final alias after acquiring its claim", (kind) => {
		const f = fixture();
		const release = reserveRunAlias(f.root, "shared")!;
		if (kind === "unreadable") writeFileSync(f.target, "{");
		else {
			const runs = join(f.root, ".rpiv", "workflows", "runs");
			mkdirSync(runs, { recursive: true });
			writeFileSync(join(runs, "run-1.jsonl"), "{}\n");
			expect(registerRunAlias(f.root, "shared", "run-1", "build")).toBe(true);
			if (kind === "stale") rmSync(join(runs, "run-1.jsonl"));
		}
		release();
		expect(() => reserveRunAlias(f.root, "shared")).toThrow(/final alias.*stale or unreadable/);
		expect(existsSync(f.claim)).toBe(false);
		expect(existsSync(f.target)).toBe(true);
		if (kind === "published") expect(resolveRunAlias(f.root, "shared")?.runId).toBe("run-1");
	});
});
