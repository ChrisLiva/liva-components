import { describe, expect, it } from "vitest";
import { cn } from "@/lib/utils";

describe("cn", () => {
	it("drops falsy class expressions", () => {
		expect(cn("a", false && "b")).toBe("a");
	});
});
