import { existsSync, readFileSync } from "node:fs";
import { verifyShipManifest } from "@juicesharp/rpiv-test-utils";
import { describe, expect, it } from "vitest";

describe("publish manifest", () => {
	it("`package.json` `files` array covers every production .ts module across the tree", () => {
		expect(verifyShipManifest(import.meta.url).missing).toEqual([]);
	});

	it("excludes the native /next smoke fixture and tests from publication", () => {
		const manifest = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
		expect(manifest.files).toContain("!**/*.test.ts");
		expect(manifest.files).toContain("!extensions/rpiv-core/built-ins/__fixtures__/");
		expect(
			existsSync(
				new URL("./extensions/rpiv-core/built-ins/__fixtures__/next-host-smoke-fixture.ts", import.meta.url),
			),
		).toBe(true);
	});
});
