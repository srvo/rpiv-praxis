import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLI_BIN, nodeDeps, startServer } from "./mcp.ts";

// Replace only the stdio transport: a real server must not read this test process's stdin.
const started = vi.hoisted(() => ({ count: 0 }));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
	StdioServerTransport: class {
		onmessage?: (message: unknown) => void;
		onclose?: () => void;
		onerror?: (error: Error) => void;
		async start() {
			started.count += 1;
		}
		async close() {}
		async send() {}
	},
}));

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("nodeDeps — real process wiring", () => {
	it("exec runs the rpiv-wf binary and returns its exit code and output", async () => {
		const deps = nodeDeps(process.cwd());
		const result = await deps.exec(["--help"]);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("usage:");
		expect(result.stderr).toBe("");
	});

	it("exec reports a usage error exit code from an unknown command", async () => {
		const result = await nodeDeps(process.cwd()).exec(["definitely-not-a-command"]);
		expect(result.code).not.toBe(0);
		expect(result.stdout + result.stderr).toMatch(/usage|unknown|error/i);
	});

	it("spawnDetached starts rpiv-wf in the background, logging to the given file", async () => {
		const dir = mkdtempSync(join(tmpdir(), "rpiv-mcp-spawn-"));
		dirs.push(dir);
		const log = join(dir, "run.mcp.log");
		const exit = join(dir, "run.mcp.exit");
		nodeDeps(dir).spawnDetached(["--help"], log, exit);
		await vi.waitFor(() => expect(readFileSync(log, "utf8")).toContain("usage:"), { timeout: 20_000 });
		expect(CLI_BIN).toMatch(/rpiv-wf\.mjs$/);
	});
});

describe("startServer — stdio wiring", () => {
	it("connects a real MCP server to the stdio transport", async () => {
		const dir = mkdtempSync(join(tmpdir(), "rpiv-mcp-start-"));
		dirs.push(dir);
		const before = started.count;
		await startServer({
			cwd: dir,
			rand: () => "abc123",
			spawnDetached: vi.fn(),
			exec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
		});
		expect(started.count).toBe(before + 1);
	});
});
