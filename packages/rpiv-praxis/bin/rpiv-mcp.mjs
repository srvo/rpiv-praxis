#!/usr/bin/env node
// rpiv-mcp launcher: an MCP stdio server exposing rpiv workflows, steps and
// parked questions as tools. Loads through jiti for the same reason rpiv-wf does.
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { startServer } = await jiti.import("../mcp.ts");
await startServer();
