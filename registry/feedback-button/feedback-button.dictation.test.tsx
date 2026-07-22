import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	type DictateFn,
	type DictationEmit,
	FeedbackButton,
} from "@/components/feedback/feedback-button";

// Tests for the dictation seam. They drive a fake engine rather than any real
// speech API, which is the point of the seam: the dialog's half of the contract
// is "start on press, write what you emit, stop exactly once", and all of that
// is observable without a microphone. (Below the imports because `shadcn add`
// strips every comment above a file's first import, so a header note never
// reaches a consumer.)

const MIC = /dictate your feedback/i;

/**
 * A hand-driven engine standing in for a real one: `emit` pushes transcripts
 * whenever a test wants them, and `stop` records that the dialog released it.
 *
 * `defer` holds the start open — an unanswered permission prompt, or a model
 * still downloading — until `arrive()`, so a test can act inside the window
 * where the run is live but the engine is not.
 */
function fakeEngine({
	defer = false,
	refuse = false,
	onStop,
}: {
	defer?: boolean;
	refuse?: boolean;
	/** What the engine reports from inside its own stopper, if anything. */
	onStop?: "ends" | "fails";
} = {}) {
	let emit: DictationEmit | null = null;
	let onFail: ((reason: unknown) => void) | null = null;
	let onEnded: (() => void) | null = null;
	let release: (() => void) | null = null;
	const stop = vi.fn(() => {
		if (onStop === "ends") onEnded?.();
		if (onStop === "fails") onFail?.(new Error("Torn down."));
	});
	const dictate: DictateFn = (next, reportFailure, reportEnd) => {
		emit = next;
		onFail = reportFailure;
		onEnded = reportEnd;
		// Refusing *after* taking the callbacks, which is the shape that matters:
		// an engine can hold `emit` and still fail to come up.
		if (refuse) {
			return Promise.reject(new Error("Microphone access was denied."));
		}
		if (!defer) return stop;
		return new Promise<() => void>((resolve) => {
			release = () => resolve(stop);
		});
	};
	return {
		dictate,
		stop,
		/** Push a transcript, wrapped so React flushes the resulting render. */
		say(text: string, final: boolean) {
			if (emit === null) throw new Error("engine was never started");
			const push = emit;
			act(() => push(text, final));
		},
		/** Report a failure the way a real engine's error event would. */
		fail(reason: unknown) {
			if (onFail === null) throw new Error("engine was never started");
			const report = onFail;
			act(() => report(reason));
		},
		/** Stop of the engine's own accord, the way a silence timeout would. */
		end() {
			if (onEnded === null) throw new Error("engine was never started");
			const report = onEnded;
			act(() => report());
		},
		/** Let a deferred start finish coming up. */
		async arrive() {
			if (release === null) throw new Error("engine was never started");
			const resolve = release;
			await act(async () => resolve());
		},
		get started() {
			return emit !== null;
		},
	};
}

const onSubmit = () => Promise.resolve();

async function open(user: ReturnType<typeof userEvent.setup>) {
	await user.click(screen.getByRole("button", { name: /send feedback/i }));
	return await screen.findByRole("dialog");
}

/** The message field's current text, which is what most assertions here read. */
function text() {
	const field = screen.getByRole("textbox", { name: /feedback message/i });
	return (field as HTMLTextAreaElement).value;
}

/** The microphone's pressed state as assistive technology reads it. */
function pressed() {
	return screen.getByRole("button", { name: MIC }).getAttribute("aria-pressed");
}

afterEach(cleanup);

describe("FeedbackButton dictation", () => {
	it("offers no microphone when no engine is supplied", async () => {
		const user = userEvent.setup();
		render(<FeedbackButton onSubmit={onSubmit} />);

		await open(user);
		expect(screen.queryByRole("button", { name: MIC })).toBeNull();
	});

	it("replaces provisional text and appends the final one", async () => {
		const user = userEvent.setup();
		const engine = fakeEngine();
		render(<FeedbackButton onSubmit={onSubmit} dictate={engine.dictate} />);

		await open(user);
		await user.click(screen.getByRole("button", { name: MIC }));
		await waitFor(() => expect(engine.started).toBe(true));

		// Each provisional emit supersedes the last rather than piling up.
		engine.say("the button", false);
		expect(text()).toBe("the button");
		engine.say("the button is", false);
		expect(text()).toBe("the button is");

		// A final commits, and the next phrase builds on top of it with the space
		// that speech does not carry.
		engine.say("The button is broken.", true);
		expect(text()).toBe("The button is broken.");
		engine.say("It never", false);
		expect(text()).toBe("The button is broken. It never");
		engine.say("It never opens.", true);
		expect(text()).toBe("The button is broken. It never opens.");
	});

	it("dictates into prose already typed without eating it", async () => {
		const user = userEvent.setup();
		const engine = fakeEngine();
		render(<FeedbackButton onSubmit={onSubmit} dictate={engine.dictate} />);

		await open(user);
		await user.type(
			screen.getByRole("textbox", { name: /feedback message/i }),
			"Steps:",
		);
		await user.click(screen.getByRole("button", { name: MIC }));
		await waitFor(() => expect(engine.started).toBe(true));

		engine.say("open the page.", true);
		expect(text()).toBe("Steps: open the page.");
	});

	it("keeps an edit made mid-run and commits after it", async () => {
		const user = userEvent.setup();
		const engine = fakeEngine();
		render(<FeedbackButton onSubmit={onSubmit} dictate={engine.dictate} />);

		await open(user);
		await user.click(screen.getByRole("button", { name: MIC }));
		await waitFor(() => expect(engine.started).toBe(true));

		engine.say("First thing.", true);
		// The reporter fixes up what landed while the engine is still listening.
		await user.type(
			screen.getByRole("textbox", { name: /feedback message/i }),
			" Also:",
		);
		expect(text()).toBe("First thing. Also:");

		// Their edit is the base now — the run must not rebuild over the top of it.
		engine.say("second thing.", true);
		expect(text()).toBe("First thing. Also: second thing.");
	});

	it("keeps what the reporter typed while the engine was still starting", async () => {
		const user = userEvent.setup();
		const engine = fakeEngine({ defer: true });
		render(<FeedbackButton onSubmit={onSubmit} dictate={engine.dictate} />);

		await open(user);
		await user.click(screen.getByRole("button", { name: MIC }));
		await waitFor(() => expect(engine.started).toBe(true));

		// Typed after the press but before the engine came up. The run began on a
		// blank field, so nothing but the drift check stands between these words
		// and the first emit rebuilding straight over them.
		await user.type(
			screen.getByRole("textbox", { name: /feedback message/i }),
			"Steps:",
		);
		await engine.arrive();

		engine.say("open the page.", true);
		expect(text()).toBe("Steps: open the page.");
	});

	it("reports pressed state and releases the engine on the second press", async () => {
		const user = userEvent.setup();
		const engine = fakeEngine();
		render(<FeedbackButton onSubmit={onSubmit} dictate={engine.dictate} />);

		await open(user);
		expect(pressed()).toBe("false");

		await user.click(screen.getByRole("button", { name: MIC }));
		await waitFor(() => expect(pressed()).toBe("true"));

		await user.click(screen.getByRole("button", { name: MIC }));
		expect(pressed()).toBe("false");
		expect(engine.stop).toHaveBeenCalledTimes(1);
	});

	it("still writes a final emitted while the engine drains", async () => {
		const user = userEvent.setup();
		const engine = fakeEngine();
		render(<FeedbackButton onSubmit={onSubmit} dictate={engine.dictate} />);

		await open(user);
		await user.click(screen.getByRole("button", { name: MIC }));
		await waitFor(() => expect(engine.started).toBe(true));
		engine.say("half a", false);
		await user.click(screen.getByRole("button", { name: MIC }));

		// A chunked transcriber flushes its tail from inside stop(); those are
		// words the reporter said before they pressed the button.
		engine.say("Half a sentence.", true);
		expect(text()).toBe("Half a sentence.");
	});

	it("releases the engine when the dialog is dismissed", async () => {
		const user = userEvent.setup();
		const engine = fakeEngine();
		render(<FeedbackButton onSubmit={onSubmit} dictate={engine.dictate} />);

		await open(user);
		await user.click(screen.getByRole("button", { name: MIC }));
		await waitFor(() => expect(engine.started).toBe(true));

		// Escape, rather than the cancel button: dismissal has several paths and
		// this is the one that bypasses every handler the form owns.
		await user.keyboard("{Escape}");
		await waitFor(() => expect(engine.stop).toHaveBeenCalledTimes(1));
	});

	it("drops a late emit from a run the reporter walked away from", async () => {
		const user = userEvent.setup();
		const engine = fakeEngine();
		render(<FeedbackButton onSubmit={onSubmit} dictate={engine.dictate} />);

		await open(user);
		await user.click(screen.getByRole("button", { name: MIC }));
		await waitFor(() => expect(engine.started).toBe(true));
		engine.say("Old report.", true);
		await user.keyboard("{Escape}");

		// A leaked engine emitting into the next report is the failure this
		// guards; the reopened dialog must be a blank form.
		engine.say("Straggler.", true);
		await open(user);
		expect(text()).toBe("");
	});

	it("surfaces a refused start on the form and returns the button to idle", async () => {
		const user = userEvent.setup();
		const denied: DictateFn = () =>
			Promise.reject(new Error("Microphone access was denied."));
		render(<FeedbackButton onSubmit={onSubmit} dictate={denied} />);

		await open(user);
		await user.click(screen.getByRole("button", { name: MIC }));

		expect((await screen.findByRole("alert")).textContent).toBe(
			"Microphone access was denied.",
		);
		expect(pressed()).toBe("false");
	});

	it("drops words from a run whose start was refused", async () => {
		const user = userEvent.setup();
		const engine = fakeEngine({ refuse: true });
		render(<FeedbackButton onSubmit={onSubmit} dictate={engine.dictate} />);

		await open(user);
		await user.click(screen.getByRole("button", { name: MIC }));
		expect((await screen.findByRole("alert")).textContent).toBe(
			"Microphone access was denied.",
		);

		// The engine took `emit` before its start failed. That run is over, so
		// its words have nowhere to go — the same rule every other ended run
		// follows.
		engine.say("leaked words.", true);
		expect(text()).toBe("");
	});

	it("leaves a refused start behind when the dialog reopens", async () => {
		const user = userEvent.setup();
		const denied: DictateFn = () =>
			Promise.reject(new Error("Microphone access was denied."));
		render(<FeedbackButton onSubmit={onSubmit} dictate={denied} />);

		await open(user);
		await user.click(screen.getByRole("button", { name: MIC }));
		expect((await screen.findByRole("alert")).textContent).toBe(
			"Microphone access was denied.",
		);

		await user.keyboard("{Escape}");
		await open(user);
		// A fresh report opens onto a clean form. The last run's refusal has
		// nothing to say about this one, and sitting first in the error chain it
		// would go on to hide a real send failure on the report being written.
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("reports a mid-run failure and keeps the words already transcribed", async () => {
		const user = userEvent.setup();
		const engine = fakeEngine();
		render(<FeedbackButton onSubmit={onSubmit} dictate={engine.dictate} />);

		await open(user);
		await user.click(screen.getByRole("button", { name: MIC }));
		await waitFor(() => expect(engine.started).toBe(true));
		engine.say("The export button", true);

		// A permission revoked after the run began, which for the browser's own
		// engine is how a blocked microphone actually arrives: the start resolved
		// fine and the refusal turns up later, on an error event.
		engine.fail(new Error("Microphone blocked."));

		expect((await screen.findByRole("alert")).textContent).toBe(
			"Microphone blocked.",
		);
		expect(pressed()).toBe("false");
		expect(engine.stop).toHaveBeenCalledTimes(1);
		// The failure costs the reporter the rest of the sentence, not the part
		// they already said.
		expect(text()).toBe("The export button");

		// And the run is discarded, not drained: a broken engine still pushing
		// words has no claim on the field.
		engine.say("Straggler.", true);
		expect(text()).toBe("The export button");
	});

	it("returns to idle, quietly, when the engine stops of its own accord", async () => {
		const user = userEvent.setup();
		const engine = fakeEngine();
		render(<FeedbackButton onSubmit={onSubmit} dictate={engine.dictate} />);

		await open(user);
		await user.click(screen.getByRole("button", { name: MIC }));
		await waitFor(() => expect(engine.started).toBe(true));
		engine.say("The export button does nothing.", true);

		// A silence timeout, which is the browser engine's own habit. Nothing
		// went wrong, so there is nothing to tell the reporter — but the button
		// must stop claiming to listen.
		engine.end();

		await waitFor(() => expect(pressed()).toBe("false"));
		expect(screen.queryByRole("alert")).toBeNull();
		expect(text()).toBe("The export button does nothing.");
		expect(engine.stop).toHaveBeenCalledTimes(1);

		// And it is over: a straggler from the ended run has no claim on the field.
		engine.say("Straggler.", true);
		expect(text()).toBe("The export button does nothing.");
	});

	it("still drains an engine that reports its end from inside its stopper", async () => {
		const user = userEvent.setup();
		const engine = fakeEngine({ onStop: "ends" });
		render(<FeedbackButton onSubmit={onSubmit} dictate={engine.dictate} />);

		await open(user);
		await user.click(screen.getByRole("button", { name: MIC }));
		await waitFor(() => expect(engine.started).toBe(true));
		engine.say("half a", false);
		await user.click(screen.getByRole("button", { name: MIC }));

		// The stopper fired `ended`, as a real engine's teardown does. The
		// reporter stopped this run themselves and is still owed its tail.
		engine.say("Half a sentence.", true);
		expect(text()).toBe("Half a sentence.");
	});

	it("keeps a teardown failure off a form the reporter already left", async () => {
		const user = userEvent.setup();
		const engine = fakeEngine({ onStop: "fails" });
		render(<FeedbackButton onSubmit={onSubmit} dictate={engine.dictate} />);

		await open(user);
		await user.click(screen.getByRole("button", { name: MIC }));
		await waitFor(() => expect(engine.started).toBe(true));

		// The engine throws on the way down, from inside the stopper the
		// reporter's own press just called. They ended this run deliberately;
		// its teardown is not their problem.
		await user.click(screen.getByRole("button", { name: MIC }));
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("ignores a failure from a run the reporter already ended", async () => {
		const user = userEvent.setup();
		const engine = fakeEngine();
		render(<FeedbackButton onSubmit={onSubmit} dictate={engine.dictate} />);

		await open(user);
		await user.click(screen.getByRole("button", { name: MIC }));
		await waitFor(() => expect(engine.started).toBe(true));
		await user.keyboard("{Escape}");
		await open(user);

		// The engine tears itself down long after the dialog closed. There is no
		// form left that this belongs to, so the report now on screen — a
		// different run entirely — must not wear it.
		//
		// Reported against the *reopened* form on purpose: fail it before the
		// reopen and `launch`'s own error clearing would wipe the evidence,
		// leaving the generation guard untested.
		engine.fail(new Error("Socket closed."));
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("stops an engine that fails while it is still starting", async () => {
		const user = userEvent.setup();
		const engine = fakeEngine({ defer: true });
		render(<FeedbackButton onSubmit={onSubmit} dictate={engine.dictate} />);

		await open(user);
		await user.click(screen.getByRole("button", { name: MIC }));
		await waitFor(() => expect(engine.started).toBe(true));

		// It fails before it ever finished coming up, so there is no stopper to
		// call yet — the run can only be ended by number.
		engine.fail(new Error("Model failed to load."));
		expect((await screen.findByRole("alert")).textContent).toBe(
			"Model failed to load.",
		);
		expect(pressed()).toBe("false");

		// The engine comes up anyway, with nobody holding it.
		await engine.arrive();
		await waitFor(() => expect(engine.stop).toHaveBeenCalledTimes(1));
	});

	it("stops an engine that arrives after the reporter gave up on it", async () => {
		const user = userEvent.setup();
		const stop = vi.fn();
		let release: (() => void) | null = null;
		// A start that hangs — a model download, or a permission prompt sitting
		// unanswered — so the stop press lands before there is anything to stop.
		const slow: DictateFn = () =>
			new Promise((resolve) => {
				release = () => resolve(stop);
			});
		render(<FeedbackButton onSubmit={onSubmit} dictate={slow} />);

		await open(user);
		await user.click(screen.getByRole("button", { name: MIC }));
		await waitFor(() => expect(release).not.toBeNull());
		await user.click(screen.getByRole("button", { name: MIC }));
		expect(pressed()).toBe("false");

		// The engine finally starts with nobody holding it. It has to be shut
		// down here or the microphone stays open for the rest of the session.
		await act(async () => {
			release?.();
		});
		await waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
	});
});
