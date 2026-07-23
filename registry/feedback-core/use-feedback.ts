import { useCallback, useEffect, useRef, useState } from "react";
import { afterPaint, captureViewport } from "@/lib/feedback/capture";
import {
	DEFAULT_COPY,
	DEFAULT_KINDS,
	type FeedbackCopy,
	type FeedbackKind,
	type FeedbackReport,
} from "@/lib/feedback/feedback-defaults";

// The headless core of the feedback flow: one hook, `useFeedback`, that owns
// everything a skin renders from — dialog open state, the compose draft (kind,
// message, screenshot), the capture flow, and the send pipeline — and holds no
// markup of its own. A skin binds this to a design system; two ship (base-ui,
// antd) and more are a port away. See skin-contract.md next to this file.
//
// Vendor this and read it, but edit it with care: the guarantees a skin leans
// on live here, not in the JSX. The send pipeline is folded in as private
// machinery (useSendPipeline, unexported below) so there is one hook to wire,
// not two.
//
// Expected to change: the pacing constants (trickle interval, ceiling, jump
// size, completion hold) and MAX_SCREENSHOT_BYTES, to match your transport.
//
// Not expected to change without care:
//   - The generation guards. Only the current attempt may move the UI — a late
//     progress() from a leaked request cannot nudge a finished bar, and an
//     attempt the reporter walked away from cannot drag the dialog into `sent`
//     or post an error over the report they are writing now. The same discipline
//     covers capture: a clone that resolves after a close/reopen is dropped.
//   - The retry stamp. A retry reuses the first attempt's `submittedAt`, so a
//     server keying on it collapses the resend onto one row.
//   - The blob-URL lifecycle. `screenshotUrl` is revoked when the bytes change
//     or the hook unmounts; a skin must not build its own object URL.

export type {
	FeedbackCopy,
	FeedbackKind,
	FeedbackReport,
} from "@/lib/feedback/feedback-defaults";

/** Where the flow is: composing a report, sending it, or done. */
export type FeedbackPhase = "compose" | "sending" | "sent";

/**
 * What the compose form owns. The pipeline supplies the other two fields of a
 * {@link FeedbackReport} — the diagnostic manifest and the submit stamp.
 */
export type FeedbackDraft = Pick<
	FeedbackReport,
	"type" | "message" | "screenshotPng"
>;

/**
 * Report the stage a long send has reached, e.g. `"Uploading screenshot…"`.
 * The label is shown under the bar and the bar advances toward its ceiling.
 * Calling this after the send has settled is a no-op, always.
 */
export type ProgressFn = (label: string) => void;

/** Inputs to {@link useSendPipeline}. */
type SendPipelineOptions = {
	/**
	 * Deliver the report. Rejecting returns the flow to `compose` with the
	 * rejection's message surfaced; resolving completes the bar and lands in
	 * `sent`. Call the supplied `progress` as often as the transport can say
	 * something useful — a send that never calls it still animates.
	 */
	onSubmit: (report: FeedbackReport, progress: ProgressFn) => Promise<void>;
	/**
	 * Gather the diagnostic manifest that rides along, already serialized and
	 * scrubbed. Runs at the head of every attempt (including a retry), so the
	 * manifest describes the browser at send time. Omit to send no context.
	 */
	collectContext?: () => string | null | Promise<string | null>;
	/**
	 * Override the strings this hook produces: `collectingLabel` (the first
	 * stage), `progressLabel` (held when the consumer never calls `progress`),
	 * and `errorFallback` (used when a rejection carries no usable message).
	 */
	copy?: Partial<FeedbackCopy>;
};

/** Everything the send pipeline surfaces to the flow above it. */
type SendPipeline = {
	/** Which phase the flow is in. */
	phase: FeedbackPhase;
	/** Bar fill, 0–100. Zero outside a send; exactly 100 once one succeeds. */
	percent: number;
	/** Current stage label; empty string outside a send. */
	stage: string;
	/** Message from the last failed attempt, or null. */
	error: string | null;
	/** The stamp the current report will carry, or null before the first send. */
	submittedAt: number | null;
	/** Run the pipeline. Ignored while a send is already in flight. */
	send: (draft: FeedbackDraft) => Promise<void>;
	/** Discard all send state, so the next `send` starts a fresh report. */
	reset: () => void;
};

// Where the bar starts, so it is visible the instant a send begins.
const START_PERCENT = 8;
// The bar's self-driven ceiling. It approaches this asymptotically and only
// ever reaches 100 because the send actually finished — an honest bar never
// claims a completion it hasn't observed.
const CEILING = 90;
// How often the bar advances on its own.
const TRICKLE_INTERVAL_MS = 200;
// Each tick closes this fraction of the gap to the ceiling, which is what
// makes the motion decelerate: constant time, shrinking distance.
const TRICKLE_FRACTION = 0.08;
// A progress() call is worth a visible jump — several ticks' worth.
const STAGE_FRACTION = 0.35;
// How long a full bar is held before the sent phase replaces it, so the
// completion registers instead of flashing past.
const COMPLETE_HOLD_MS = 450;

/** Close `fraction` of the distance from `from` to the ceiling. */
function toward(from: number, fraction: number): number {
	return from + (CEILING - from) * fraction;
}

/** A rejection's own message, or the generic fallback when it hasn't one. */
function messageFor(reason: unknown, fallback: string): string {
	return reason instanceof Error && reason.message.trim() !== ""
		? reason.message
		: fallback;
}

/**
 * Own the send half of a feedback dialog: phases, a self-advancing progress
 * bar, stage labels, and errors. Private to this file — a consumer wires
 * {@link useFeedback}, which folds this in.
 *
 * Call `reset()` when the dialog opens: that clears the previous outcome and
 * releases the stamp, so the next send files a new report rather than
 * retrying the last one.
 */
function useSendPipeline(options: SendPipelineOptions): SendPipeline {
	const [phase, setPhase] = useState<FeedbackPhase>("compose");
	const [percent, setPercent] = useState(0);
	const [stage, setStage] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [submittedAt, setSubmittedAt] = useState<number | null>(null);

	// Read at send time rather than captured, so `send` stays referentially
	// stable while still seeing the caller's latest closures.
	const optionsRef = useRef(options);
	useEffect(() => {
		optionsRef.current = options;
	});

	// The mechanism behind "only the current attempt may move the UI": every
	// attempt takes a generation number, and settling — or a reset, or a later
	// send — increments the counter. The `progress` handed to `onSubmit` and
	// both of the attempt's own settle paths compare their captured number
	// against the counter and do nothing once they differ, so a leaked callback
	// or an abandoned promise is inert no matter how long it takes to arrive.
	const generation = useRef(0);
	// Covers the whole in-flight window, including the completion hold — a
	// state flag would lag a synchronous double-click.
	const busy = useRef(false);
	const stampRef = useRef<number | null>(null);
	const trickle = useRef<ReturnType<typeof setInterval> | null>(null);
	const hold = useRef<ReturnType<typeof setTimeout> | null>(null);

	const stopClocks = useCallback(() => {
		if (trickle.current !== null) clearInterval(trickle.current);
		if (hold.current !== null) clearTimeout(hold.current);
		trickle.current = null;
		hold.current = null;
	}, []);

	useEffect(() => stopClocks, [stopClocks]);

	const reset = useCallback(() => {
		generation.current += 1;
		stopClocks();
		busy.current = false;
		stampRef.current = null;
		setPhase("compose");
		setPercent(0);
		setStage("");
		setError(null);
		setSubmittedAt(null);
	}, [stopClocks]);

	const send = useCallback(
		async (draft: FeedbackDraft) => {
			if (busy.current) return;
			busy.current = true;

			generation.current += 1;
			const run = generation.current;
			const copy = { ...DEFAULT_COPY, ...optionsRef.current.copy };

			// Held across attempts: a retry must reach the server with the
			// original stamp or it files a second row.
			const stamp = stampRef.current ?? Date.now();
			stampRef.current = stamp;
			setSubmittedAt(stamp);

			setError(null);
			setPhase("sending");
			setStage(copy.collectingLabel);
			setPercent(START_PERCENT);

			stopClocks();
			const ownTrickle = setInterval(() => {
				if (generation.current !== run) return;
				setPercent((p) => toward(p, TRICKLE_FRACTION));
			}, TRICKLE_INTERVAL_MS);
			trickle.current = ownTrickle;

			/**
			 * Settle once. This run's own trickle is always cleared, whoever it
			 * belongs to now; everything else happens only while this run is still
			 * the current one. `false` means the run was superseded — by a reset or
			 * a later send — and the caller must touch no state at all, or a send
			 * the reporter walked away from redraws the dialog over the report they
			 * are writing now.
			 */
			const finish = (): boolean => {
				clearInterval(ownTrickle);
				if (trickle.current === ownTrickle) trickle.current = null;
				if (generation.current !== run) return false;
				generation.current += 1;
				stopClocks();
				return true;
			};

			try {
				const collect = optionsRef.current.collectContext;
				const contextJson = collect ? await collect() : null;
				if (generation.current === run) setStage(copy.progressLabel);

				await optionsRef.current.onSubmit(
					{ ...draft, contextJson, submittedAt: stamp },
					(label) => {
						if (generation.current !== run) return;
						setStage(label);
						setPercent((p) => toward(p, STAGE_FRACTION));
					},
				);

				if (!finish()) return;
				setPercent(100);
				hold.current = setTimeout(() => {
					busy.current = false;
					setPhase("sent");
				}, COMPLETE_HOLD_MS);
			} catch (reason) {
				if (!finish()) return;
				busy.current = false;
				setPercent(0);
				setStage("");
				setPhase("compose");
				setError(messageFor(reason, copy.errorFallback));
			}
		},
		[stopClocks],
	);

	return { phase, percent, stage, error, submittedAt, send, reset };
}

/**
 * Cap an attachment rather than let it fail the whole report.
 *
 * The rule: pick the largest raw PNG whose *encoded* size still clears
 * whatever your transport accepts, then set this below it. Encodings inflate —
 * base64 by about a third — and the manifest rides in the same request, so the
 * raw ceiling is meaningfully lower than the request limit. 10 MiB suits a
 * 16 MiB base64 request cap; retune it against your own server the moment you
 * know that number, because the failure it prevents is a report the reporter
 * already wrote being rejected whole.
 */
const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;

/**
 * Bytes as a short human string, for the attachment row and the size error. A
 * skin renders it into `copy.attached(...)`; the hook renders it into the
 * size-cap error itself.
 */
export function formatSize(bytes: number): string {
	return bytes >= 1024 * 1024
		? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
		: `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Inputs to {@link useFeedback}. */
export type UseFeedbackOptions = {
	/**
	 * Deliver the assembled report. The only required option. Rejecting returns
	 * the dialog to compose with the rejection's message shown; resolving lands
	 * it in the sent phase. Call the supplied `progress` as the transport learns
	 * something — a send that never calls it still animates.
	 */
	onSubmit: (report: FeedbackReport, progress: ProgressFn) => Promise<void>;
	/**
	 * Gather the diagnostic manifest that rides along, already serialized and
	 * scrubbed. Runs at the head of every attempt, so it describes the browser
	 * at send time. Omit and `report.contextJson` is null.
	 */
	collectContext?: SendPipelineOptions["collectContext"];
	/**
	 * The kinds offered in the picker, each with its own accent and placeholder.
	 * Exactly one kind hides the picker entirely and files every report under
	 * it; an empty list falls back to {@link DEFAULT_KINDS}.
	 * @default DEFAULT_KINDS
	 */
	kinds?: readonly FeedbackKind[];
	/**
	 * Copy overrides, merged over {@link DEFAULT_COPY} key by key, so supplying
	 * one string leaves the rest alone.
	 */
	copy?: Partial<FeedbackCopy>;
	/**
	 * Capture the page automatically when the dialog opens, so the reporter has
	 * an attachment without asking for one. Failures are silent.
	 * @default false
	 */
	autoCapture?: boolean;
};

/**
 * Everything a skin renders from and drives the flow through. The skin owns
 * only markup; every piece of state and every transition lives here.
 */
export type Feedback = {
	/** Whether the dialog is open. */
	open: boolean;
	/** Which phase the flow is in. */
	phase: FeedbackPhase;
	/** True during a send — inputs lock and the progress bar shows. */
	sending: boolean;
	/** The resolved kind list the skin renders; never empty. */
	kinds: readonly FeedbackKind[];
	/** The currently selected kind. */
	kind: FeedbackKind;
	/** The prose written so far. */
	message: string;
	/** The attached PNG bytes, or null when nothing is attached. */
	screenshot: Uint8Array | null;
	/** A blob URL for the thumbnail, or null; lifecycle managed by the hook. */
	screenshotUrl: string | null;
	/** True while a capture is in flight. */
	capturing: boolean;
	/** Bar fill, 0–100. */
	percent: number;
	/** Current stage label. */
	stage: string;
	/** The one error line to show, or null. Capture errors take priority. */
	error: string | null;
	/** Fully merged copy — every key present; skins read all strings here. */
	copy: FeedbackCopy;
	/** Open onto an empty form; the next send stamps a fresh report. */
	launch: () => void;
	/** The dismissal path; retires any capture still in flight. */
	setOpen: (next: boolean) => void;
	/** Wire to the dialog's open-complete callback; fires the armed auto-capture. */
	notifyOpenComplete: (open: boolean) => void;
	/** Select a kind by value. */
	setKind: (value: string) => void;
	/** Replace the prose. */
	setMessage: (value: string) => void;
	/** Take (or retake) a capture, surfacing failures. */
	capture: () => void;
	/** Drop the attachment. */
	discardScreenshot: () => void;
	/** Start the send. */
	send: () => void;
};

/**
 * The headless feedback flow: a compose draft, a capture flow, and a staged
 * send, with no markup. A skin renders the returned {@link Feedback}.
 *
 * ```tsx
 * const fb = useFeedback({
 *   onSubmit: async (report, progress) => {
 *     progress("Uploading…");
 *     await api.submitReport(report);
 *   },
 * });
 * ```
 */
export function useFeedback(options: UseFeedbackOptions): Feedback {
	const {
		onSubmit,
		collectContext,
		autoCapture = false,
		kinds = DEFAULT_KINDS,
		copy: copyOverrides,
	} = options;

	const copy = { ...DEFAULT_COPY, ...copyOverrides };
	// An empty list would leave the dialog with nothing to file under, so it
	// falls back rather than rendering a form that cannot produce a report.
	const resolvedKinds = kinds.length > 0 ? kinds : DEFAULT_KINDS;

	const [open, setOpenState] = useState(false);
	const [type, setType] = useState(resolvedKinds[0].value);
	const [message, setMessage] = useState("");
	const [screenshot, setScreenshot] = useState<Uint8Array | null>(null);
	const [screenshotUrl, setScreenshotUrl] = useState<string | null>(null);
	const [capturing, setCapturing] = useState(false);
	// An auto-capture waiting for the dialog to finish opening. A ref, not state:
	// nothing renders from it, and it is read inside a dialog callback.
	const armed = useRef(false);
	const [captureError, setCaptureError] = useState<string | null>(null);
	// The generation guard for `capture`, the one async path in the compose
	// half: every open and every close bumps the counter, and a capture captures
	// it at the top and drops its result if it no longer matches — so a clone
	// that resolves after the reporter closed or reopened the dialog can't
	// attach a screenshot of the wrong page, or an error, onto a fresh form.
	const captureRun = useRef(0);

	const pipeline = useSendPipeline({ onSubmit, collectContext, copy });

	const kind =
		resolvedKinds.find((option) => option.value === type) ?? resolvedKinds[0];

	// The preview is a blob URL that has to be released, so it is derived here
	// rather than built inline. Absent createObjectURL — a non-browser render
	// target — the attachment row simply has no thumbnail.
	useEffect(() => {
		if (screenshot === null || typeof URL.createObjectURL !== "function") {
			setScreenshotUrl(null);
			return;
		}
		// The cast is the DOM lib's SharedArrayBuffer caveat, not a real
		// mismatch: captureViewport only ever returns a plain, non-shared view.
		const url = URL.createObjectURL(
			new Blob([screenshot as BlobPart], { type: "image/png" }),
		);
		setScreenshotUrl(url);
		return () => {
			URL.revokeObjectURL(url);
		};
	}, [screenshot]);

	/**
	 * Attach the page behind the dialog.
	 *
	 * `silent` is the whole difference between the two ways this is reached, and
	 * the asymmetry is deliberate. A manual capture is something the reporter
	 * asked for and is waiting on, so a failure has to be said out loud. An
	 * automatic one they never asked for; an error about it would be the first
	 * thing they read in a dialog they opened to write a sentence, about a
	 * nicety, when the manual button sitting right there is the retry. So the
	 * automatic path swallows both failure modes — a render that throws and a
	 * capture over the size cap — and leaves the form as if it had never run.
	 */
	const capture = useCallback(
		async (silent: boolean) => {
			// Captured before the await; the clone can outlive the dialog it was
			// taken for, and a `run` that no longer matches means the reporter has
			// moved on.
			const run = captureRun.current;
			const current = () => captureRun.current === run;
			if (!silent) setCaptureError(null);
			setCapturing(true);
			try {
				const bytes = await captureViewport();
				if (!current()) return;
				if (bytes.length > MAX_SCREENSHOT_BYTES) {
					if (!silent) {
						setCaptureError(
							copy.tooLarge(
								formatSize(bytes.length),
								formatSize(MAX_SCREENSHOT_BYTES),
							),
						);
					}
					return;
				}
				setScreenshot(bytes);
			} catch {
				if (current() && !silent) setCaptureError(copy.captureFailed);
			} finally {
				if (current()) setCapturing(false);
			}
		},
		// copy is re-created each render but its strings only change when the
		// caller changes `copy`; capture reads them lazily inside the closure.
		[copy.tooLarge, copy.captureFailed],
	);

	/** Open onto an empty form; the next send stamps a fresh report. */
	const launch = () => {
		pipeline.reset();
		// Retires any capture still in flight from a prior open, so its result
		// can't land on the fresh form this opens onto.
		captureRun.current += 1;
		setType(resolvedKinds[0].value);
		setMessage("");
		setScreenshot(null);
		setCapturing(false);
		setCaptureError(null);
		setOpenState(true);
		// Armed here, fired from notifyOpenComplete once the dialog has finished
		// animating open. The clone blocks the main thread for as long as it runs,
		// so starting it in this tick freezes the dialog's own enter animation and
		// the open reads as a stall — deferring by a frame is not enough, because
		// the animation spans many. `capturing` is still set synchronously, so the
		// footer reads as pending from the first frame rather than flashing the
		// attach button and swapping.
		if (autoCapture) {
			armed.current = true;
			setCapturing(true);
		}
	};

	/** The dismissal path — Escape, the overlay, the Cancel button all pass here. */
	const setOpen = (next: boolean) => {
		// The one place to retire a capture still in flight before it can attach
		// to whatever the dialog shows next.
		if (!next) captureRun.current += 1;
		setOpenState(next);
	};

	/**
	 * Run the armed auto-capture, now that nothing is animating for it to block.
	 *
	 * `afterPaint` buys one more frame so the animation's last frame is on screen
	 * before the main thread goes away, and — the reason it is a raced timeout
	 * rather than a bare rAF — settles even if the tab is hidden by now, which
	 * would otherwise pause frame callbacks and strand the capture forever.
	 */
	const notifyOpenComplete = (isOpen: boolean) => {
		if (!isOpen || !armed.current) return;
		armed.current = false;
		void afterPaint().then(() => capture(true));
	};

	const send = () => {
		setCaptureError(null);
		void pipeline.send({ type, message, screenshotPng: screenshot });
	};

	return {
		open,
		phase: pipeline.phase,
		sending: pipeline.phase === "sending",
		kinds: resolvedKinds,
		kind,
		message,
		screenshot,
		screenshotUrl,
		capturing,
		percent: pipeline.percent,
		stage: pipeline.stage,
		// Capture error takes priority: it is the direct result of something the
		// reporter just did, and it sits over any stale send error.
		error: captureError ?? pipeline.error,
		copy,
		launch,
		setOpen,
		notifyOpenComplete,
		setKind: setType,
		setMessage,
		capture: () => void capture(false),
		discardScreenshot: () => setScreenshot(null),
		send,
	};
}
