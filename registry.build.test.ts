import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// `public/r/` is committed because it is the only install path a consumer has —
// `shadcn add` points at those files in a local clone. So it has to stay in step
// with the `registry/` sources it is built from.

const committed = "public/r";
const output = mkdtempSync(join(tmpdir(), "liva-registry-"));

execFileSync("node_modules/.bin/shadcn", ["build", "--output", output], {
	stdio: "pipe",
});

afterAll(() => {
	rmSync(output, { recursive: true, force: true });
});

const jsonFiles = (dir: string) =>
	readdirSync(dir)
		.filter((name) => name.endsWith(".json"))
		.sort();

describe("built registry", () => {
	it("has the same items committed as a fresh build produces", () => {
		expect(jsonFiles(committed)).toEqual(jsonFiles(output));
	});

	for (const name of jsonFiles(output)) {
		it(`has ${name} committed at its built content`, () => {
			const fresh = readFileSync(join(output, name), "utf8");
			// Fails when `registry/` changed without a follow-up `pnpm build:registry`.
			expect(readFileSync(join(committed, name), "utf8")).toBe(fresh);
		});
	}
});
