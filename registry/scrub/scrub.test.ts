import { describe, expect, it } from "vitest";

import { scrub } from "@/lib/feedback/scrub";

describe("scrub", () => {
	it("drops credential-named keys anywhere in the tree", () => {
		const result = scrub({
			userId: "user_123",
			authToken: "abc",
			nested: { apiKey: "k", clerkSession: "s", note: "keep me" },
			list: [{ password: "p", label: "visible" }],
		});

		expect(result).toEqual({
			userId: "user_123",
			nested: { note: "keep me" },
			list: [{ label: "visible" }],
		});
	});

	it("redacts a JWT-shaped string value even under an innocent key", () => {
		const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.s3cr3t-Sig_nature";
		expect(scrub({ payload: jwt })).toEqual({ payload: "[redacted]" });
		// A plain string that isn't JWT-shaped is left alone.
		expect(scrub({ payload: "just a message" })).toEqual({
			payload: "just a message",
		});
	});

	it("redacts a JWT embedded inside a larger string (log line or URL)", () => {
		const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.abc_def-ghi";
		// A console line captured into the diagnostics buffer.
		expect(
			scrub({ message: `request failed Authorization: Bearer ${jwt}` }),
		).toEqual({ message: "request failed Authorization: Bearer [redacted]" });
		// Clerk appends the session JWT to the URL on a dev instance.
		expect(
			scrub({ url: `http://localhost:3000/?__clerk_db_jwt=${jwt}` }),
		).toEqual({ url: "http://localhost:3000/?__clerk_db_jwt=[redacted]" });
	});

	it("leaves benign dotted strings intact (no false-positive redaction)", () => {
		expect(scrub({ v: "1.2.3", mod: "react.dom.client" })).toEqual({
			v: "1.2.3",
			mod: "react.dom.client",
		});
	});

	it("preserves identity fields the report needs", () => {
		const identity = { userId: "user_123", email: "a@b.com", fullName: "Ada" };
		expect(scrub(identity)).toEqual(identity);
	});

	it("does not mutate its input", () => {
		const input = { authToken: "abc", keep: "yes" };
		scrub(input);
		expect(input).toEqual({ authToken: "abc", keep: "yes" });
	});

	it("passes primitives and null through unchanged", () => {
		expect(scrub(42)).toBe(42);
		expect(scrub(null)).toBeNull();
		expect(scrub(true)).toBe(true);
	});
});
