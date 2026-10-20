import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import registerRpivCore from "./index.ts";

describe("/next core registration", () => {
	it("registers the command after the session capture and skill bracket hooks", () => {
		const calls: string[] = [];
		const pi = new Proxy(
			{},
			{
				get: (_target, property: string) => {
					if (property === "registerCommand") return (name: string) => calls.push(`command:${name}`);
					if (property === "on")
						return (event: string) => {
							calls.push(`on:${event}`);
							return () => {};
						};
					if (property === "getCommands") return () => [];
					if (property === "getFlag") return () => undefined;
					return vi.fn();
				},
			},
		) as unknown as ExtensionAPI;

		registerRpivCore(pi);

		const next = calls.indexOf("command:next");
		expect(next).toBeGreaterThan(calls.indexOf("on:session_start"));
		expect(next).toBeGreaterThan(calls.lastIndexOf("on:input"));
	});
});
