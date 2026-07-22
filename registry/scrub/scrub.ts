const SENSITIVE_KEY = /token|secret|key|jwt|clerk|__session|password|auth/i;

// Deep-scrubs a value tree, dropping credential-named keys and redacting
// JWT-shaped strings wherever they appear. Vendor this alongside anything
// that assembles a diagnostic/report payload from browser state (console
// history, network logs, URLs) before it leaves the browser.
//
// Expected to change: SENSITIVE_KEY and JWT_SHAPED are the two knobs. Add a
// key-name substring to SENSITIVE_KEY for a new credential shape (e.g. a
// different auth provider's cookie name); add a sibling to JWT_SHAPED (with
// its own REDACTED-style replacement) for a differently-shaped secret, such
// as an API key or connection string.
//
// Not expected to change: the recursion shape (string / array / object /
// primitive) and that scrub never mutates its input — callers rely on being
// able to scrub a value and still use the original afterward.

// Privacy scrubber for the feedback diagnostic manifest. A report bundles
// console/error history, which can incidentally capture a session token or an
// auth header. This strips those before the manifest ever leaves the browser.
//
// Two rules, applied together over the whole structure:
//   1. Drop any object key whose name suggests a credential.
//   2. Redact any string value shaped like a JWT, wherever it appears.

// Key names that signal a credential. Substring, case-insensitive: "authToken",
// "X-Api-Key" and "__session" all match. Kept deliberately broad — a dropped
// benign field costs nothing, a leaked credential costs a lot.

// A JWT: three base64url segments joined by dots, with a header that always
// begins "eyJ" (base64 of `{"`). Global and unanchored so it redacts a token
// embedded ANYWHERE in a string — inside a log line ("Bearer eyJ…"), a URL
// (Clerk's ?__clerk_db_jwt=eyJ…), or a stringified object — not only a value
// that is wholly a JWT. The "eyJ" prefix is what keeps it from eating benign
// dotted strings like "1.2.3" or "react.dom.client".
const JWT_SHAPED = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;

const REDACTED = "[redacted]";

/**
 * Deep-copy `value`, dropping credential-named keys and redacting JWT-shaped
 * strings. Pure: never mutates its input. Objects created with a null prototype
 * or exotic classes are walked as plain records — the manifest is plain data.
 */
export function scrub(value: unknown): unknown {
	if (typeof value === "string") {
		return value.replace(JWT_SHAPED, REDACTED);
	}
	if (Array.isArray(value)) {
		return value.map(scrub);
	}
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, v] of Object.entries(value)) {
			if (SENSITIVE_KEY.test(key)) continue;
			out[key] = scrub(v);
		}
		return out;
	}
	return value;
}
