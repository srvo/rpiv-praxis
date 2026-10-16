/**
 * The pre-push hook must not run the suite inside git's hook environment
 * (kata h7sc). Git exports GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE into every hook
 * it runs; from a linked worktree GIT_DIR points at the worktree's private
 * gitdir, so any `git init`/`git commit` a test fixture performs lands in the
 * REAL repository and moves the branch being pushed to fixture commits
 * (`seed`/`init`/`baseline`). On 2026-10-16 that is exactly what happened while
 * pushing this repo from a worktree: the branch tip was replaced and 58-66
 * git-dependent tests failed against the repo they accidentally wrote to.
 *
 * These tests drive `.husky/pre-push` for real, with a stub `npm` that performs
 * the fixture git-init+commit that caused the corruption, run with GIT_DIR
 * pointed at a decoy repository. The hook must scrub the environment before it
 * invokes npm, so the fixture commit lands in the stub's own scratch directory
 * and the repository being pushed is left exactly where it was.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HOOK = join(REPO_ROOT, ".husky", "pre-push");

/** Run git in `cwd` and return trimmed stdout. */
const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();

describe(".husky/pre-push scrubs git's hook environment (kata h7sc)", () => {
	let root: string;
	let decoy: string;
	let scratch: string;
	let bin: string;
	let probe: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "rpiv-hook-env-"));
		decoy = join(root, "decoy");
		scratch = join(root, "scratch");
		bin = join(root, "bin");
		probe = join(root, "probe.txt");
		mkdirSync(decoy, { recursive: true });
		mkdirSync(bin, { recursive: true });

		// A real repository for the leaked GIT_DIR to point at — the stand-in for
		// the repository being pushed.
		git(decoy, "init", "-q");
		writeFileSync(join(decoy, "README.md"), "decoy\n");
		git(decoy, "add", "README.md");
		git(decoy, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "decoy base");

		// Stand-in for `npm run coverage`: reproduces what the suite's
		// git-dependent fixtures do (git init + commit in a scratch directory)
		// and records the git environment it was handed, then succeeds so the
		// hook continues to its own success path.
		writeFileSync(
			join(bin, "npm"),
			`${[
				"#!/bin/sh",
				"printf 'GIT_DIR=%s\\n' \"$(printenv GIT_DIR || echo '<unset>')\" > \"$PROBE\"",
				"printf 'GIT_WORK_TREE=%s\\n' \"$(printenv GIT_WORK_TREE || echo '<unset>')\" >> \"$PROBE\"",
				"printf 'GIT_INDEX_FILE=%s\\n' \"$(printenv GIT_INDEX_FILE || echo '<unset>')\" >> \"$PROBE\"",
				'mkdir -p "$SCRATCH"',
				'cd "$SCRATCH"',
				"git init -q .",
				"git -c user.email=t@t -c user.name=t commit -q --allow-empty -m fixture",
				"exit 0",
			].join("\n")}\n`,
		);
		chmodSync(join(bin, "npm"), 0o755);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("unsets the git hook env before the suite runs, so a fixture commit cannot touch the pushed repo", () => {
		const decoyHeadBefore = git(decoy, "rev-parse", "HEAD");

		execFileSync("sh", [HOOK], {
			cwd: REPO_ROOT,
			encoding: "utf-8",
			env: {
				...process.env,
				PATH: `${bin}:${process.env.PATH ?? ""}`,
				PROBE: probe,
				SCRATCH: scratch,
				// Exactly what git exports when it runs a hook from a linked worktree.
				GIT_DIR: join(decoy, ".git"),
				GIT_WORK_TREE: decoy,
				GIT_INDEX_FILE: join(decoy, ".git", "index"),
			},
		});

		// The hook scrubbed git's environment before npm ran.
		const seen = existsSync(probe) ? readFileSync(probe, "utf-8") : "";
		expect(seen).toContain("GIT_DIR=<unset>");
		expect(seen).toContain("GIT_WORK_TREE=<unset>");
		expect(seen).toContain("GIT_INDEX_FILE=<unset>");

		// The fixture commit landed in the stub's own scratch repo...
		expect(existsSync(join(scratch, ".git"))).toBe(true);
		// ...and the repository being pushed is untouched: same tip, one commit,
		// still a normal (non-bare) checkout.
		expect(git(decoy, "rev-parse", "HEAD")).toBe(decoyHeadBefore);
		expect(git(decoy, "log", "--oneline").split("\n")).toHaveLength(1);
		expect(git(decoy, "config", "core.bare")).toBe("false");
	});
});
