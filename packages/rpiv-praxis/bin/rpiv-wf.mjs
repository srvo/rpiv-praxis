#!/usr/bin/env node
// rpiv-wf launcher. The workspace publishes raw TypeScript (no build step) and
// rpiv-workflow's own imports use `.js` specifiers for `.ts` files, so the CLI
// loads through jiti, the same loader Pi uses for these packages.
import { writeFileSync } from "node:fs";
import { createJiti } from "jiti";

// A closed pipe (`rpiv-wf steps | head`) is not an error worth a stack trace.
process.stdout.on("error", (err) => {
	if (err.code === "EPIPE") process.exit(0);
	throw err;
});

// Set by the MCP server for detached runs: record how this process ended, so
// `run_status` can tell a finished run from one still in progress.
const exitFile = process.env.RPIV_WF_EXIT_FILE;
if (exitFile) process.on("exit", (code) => writeFileSync(exitFile, `${code}\n`));

const jiti = createJiti(import.meta.url);
const { main, handleStopSignals } = await jiti.import("../cli.ts");
const controller = new AbortController();
// First SIGINT/SIGTERM/SIGHUP stops the run resumably; a second exits at once (still writing its terminal row).
handleStopSignals(controller);
process.exitCode = await main(process.argv.slice(2), undefined, { signal: controller.signal });
