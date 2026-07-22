export type DiagnosticEvent = {
	kind: "log" | "warn" | "error" | "window-error" | "rejection" | "rpc-error";
	message: string;
	at: number;
};

// Bounded ring buffer of client-side diagnostic events (console output,
// uncaught errors/rejections, and anything else a consumer records) plus a
// manifest assembler that folds that history together with page facts and a
// caller-supplied extra bag. Vendor this alongside a feedback/bug-report flow
// that wants a "what was happening in the browser" history to attach to a
// report.
//
// Expected to change: CAPACITY (how many recent events survive) and
// MAX_MESSAGE (how long a single message is allowed to be) are the two
// buffer knobs. Which console levels installDiagnostics patches ("log",
// "warn", "error") is a third — trim or extend that array per consumer. What
// goes into collectContext's `extra` bag is entirely the caller's call: an
// identity, a build stamp, feature flags, anything the report should carry —
// this module has no opinion and no type for it.
//
// Not expected to change: the DiagnosticEvent shape, the ring-buffer
// eviction (oldest event drops first once CAPACITY is exceeded), and the
// page.url comment below — query/hash can carry auth tokens a scrubber may
// not recognize, so only origin+pathname are ever recorded.

// Keep the last N events; a report needs the recent tail, not the whole session.
const CAPACITY = 50;
// Cap a single message so one enormous object can't bloat the manifest.
const MAX_MESSAGE = 2000;

const buffer: DiagnosticEvent[] = [];

/**
 * Append one event to the ring buffer, evicting the oldest once CAPACITY is
 * exceeded. Exported so a consumer can feed the buffer from its own
 * transport/error plumbing — e.g. an RPC client's error interceptor:
 *
 *   const recordRpcErrors = (next) => async (req) => {
 *     try { return await next(req); }
 *     catch (err) { record("rpc-error", `${req.method.name}: ${err}`); throw err; }
 *   };
 */
export function record(kind: DiagnosticEvent["kind"], message: string): void {
	buffer.push({ kind, message: message.slice(0, MAX_MESSAGE), at: Date.now() });
	if (buffer.length > CAPACITY) buffer.shift();
}

/**
 * Number of events currently buffered — lets a consumer compose a receipt
 * line ("carries N events") without parsing the manifest to count them.
 */
export function eventCount(): number {
	return buffer.length;
}

// console args arrive as unknown[]; render them to one string without throwing
// on a circular object (JSON.stringify would).
function stringifyArgs(args: unknown[]): string {
	return args
		.map((a) => {
			if (typeof a === "string") return a;
			try {
				return JSON.stringify(a);
			} catch {
				return String(a);
			}
		})
		.join(" ");
}

let installed = false;

/**
 * Patch console + window error hooks so the ring buffer fills from page load.
 * Browser-guarded and idempotent — safe to call in shared boot code that also
 * runs under SSR (where it no-ops).
 */
export function installDiagnostics(): void {
	if (installed || typeof window === "undefined") return;
	installed = true;

	for (const level of ["log", "warn", "error"] as const) {
		const original = console[level];
		console[level] = (...args: unknown[]) => {
			record(level, stringifyArgs(args));
			original.apply(console, args);
		};
	}

	window.addEventListener("error", (e) => {
		record("window-error", e.message || String(e.error));
	});
	window.addEventListener("unhandledrejection", (e) => {
		record("rejection", String(e.reason));
	});
}

/**
 * Assemble the diagnostic manifest: page facts, the recent event tail, and
 * whatever the caller passes in `extra` — identity, a build stamp, feature
 * flags, anything else the report should carry. This module has no opinion
 * and no type for `extra`; it only owns `page` and `events`. The caller
 * scrubs the result before it goes on the wire — collectContext gathers,
 * scrub() sanitizes.
 *
 * Merge precedence: `extra` is spread first, then `page`/`events` are set on
 * top, so the module's own facts always win over a same-named key in
 * `extra`. That keeps a report's page/event data intact even if a caller's
 * bag happens to use one of those names; every other key in `extra` passes
 * through untouched.
 */
export function collectContext(
	extra?: Record<string, unknown>,
): Record<string, unknown> {
	return {
		...extra,
		page: {
			// origin + pathname only: the query/hash can carry auth tokens (an
			// auth provider may append a session token or handshake param to the
			// URL on a dev instance), and a non-JWT-shaped token there would slip
			// past the scrubber. The path is all a report needs anyway.
			url:
				typeof location !== "undefined"
					? location.origin + location.pathname
					: "",
			userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
			viewport:
				typeof window !== "undefined"
					? { width: window.innerWidth, height: window.innerHeight }
					: null,
		},
		events: buffer.slice(),
	};
}
