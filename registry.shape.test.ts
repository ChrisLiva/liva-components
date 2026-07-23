import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Permanent structural guards on the shipped item JSONs — the invariants that
// keep the overwrite incident from ever coming back. registry.build.test.ts
// proves public/r/ matches a fresh build; this proves the build itself stays
// within the contract, so a future edit that re-adds a registryDependency, a
// test file, or a stray target fails here rather than in a consumer's project.

const committed = "public/r";

type RegistryFile = { path?: string; target?: string };
type RegistryItem = {
	name: string;
	registryDependencies?: unknown;
	files?: RegistryFile[];
	css?: unknown;
};

/** The built item JSONs, keyed by item name (registry.json is the index). */
const items: RegistryItem[] = readdirSync(committed)
	.filter((name) => name.endsWith(".json") && name !== "registry.json")
	.map((name) => JSON.parse(readFileSync(join(committed, name), "utf8")));

describe("built registry items", () => {
	it("ship exactly the two skins", () => {
		expect(items.map((item) => item.name).sort()).toEqual([
			"feedback-antd",
			"feedback-base-ui",
		]);
	});

	for (const item of items) {
		describe(item.name, () => {
			it("declares no registryDependencies", () => {
				// The whole point: nothing gets written into the consumer's
				// components/ui/, so no customized primitive is ever flattened.
				expect(item.registryDependencies ?? []).toEqual([]);
			});

			it("ships no test files", () => {
				const tests = (item.files ?? []).filter(
					(file) =>
						file.path?.includes(".test.") || file.target?.includes(".test."),
				);
				expect(tests).toEqual([]);
			});

			it("targets only lib/feedback and components/feedback", () => {
				for (const file of item.files ?? []) {
					expect(file.target).toMatch(
						/^@(lib\/feedback|components\/feedback)\//,
					);
				}
			});
		});
	}

	it("carries the lc- css only on the Base UI skin", () => {
		const withCss = items
			.filter((item) => item.css !== undefined)
			.map((i) => i.name);
		expect(withCss).toEqual(["feedback-base-ui"]);
	});
});
