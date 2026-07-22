import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FeedbackButton } from "@/components/feedback/feedback-button";
import { captureViewport } from "@/lib/feedback/capture";

// Component-level tests for the dialog. The pipeline's own behaviour — phases,
// the bar, retries, idempotency — is pinned in feedback-button.test.tsx
// against the hook directly; everything here is something only the rendered
// dialog can be asked about. (Below the imports because `shadcn add` strips
// every comment above a file's first import, so a header note never reaches a
// consumer.)

vi.mock("@/lib/feedback/capture", () => ({
	captureViewport: vi.fn(),
	// The real one waits two frames; resolving straight away keeps the tests off
	// the frame clock. That an auto-capture is deferred at all is asserted
	// separately, against the real afterPaint, in capture.test.ts.
	afterPaint: () => Promise.resolve(),
}));

const captureMock = vi.mocked(captureViewport);

/** A send that always succeeds, for the cases that are not about sending. */
const onSubmit = () => Promise.resolve();

/** Open the dialog by clicking the trigger, and hand back the popup. */
async function open(
	user: ReturnType<typeof userEvent.setup>,
	trigger: RegExp | string = /send feedback/i,
) {
	await user.click(screen.getByRole("button", { name: trigger }));
	return await screen.findByRole("dialog");
}

beforeEach(() => {
	captureMock.mockReset();
});

// Vitest runs without globals here, so Testing Library never registers its own
// teardown — and a dialog left mounted portals into document.body, where the
// next test's queries still find it.
afterEach(cleanup);

describe("FeedbackButton", () => {
	it("paints the dialog in the selected kind's accent and repaints on a change", async () => {
		const user = userEvent.setup();
		render(<FeedbackButton onSubmit={onSubmit} />);

		const dialog = await open(user);
		expect(dialog.style.getPropertyValue("--lc-accent")).toBe(
			"oklch(0.62 0.19 35)",
		);

		await user.click(screen.getByRole("button", { name: "Idea" }));
		expect(dialog.style.getPropertyValue("--lc-accent")).toBe(
			"oklch(0.62 0.16 250)",
		);

		// Both stops stay bare var() references, which is the whole reason the
		// ring travels between accents instead of cutting to the new one.
		expect(dialog.style.getPropertyValue("--lc-accent-gradient")).toBe(
			"linear-gradient(135deg, var(--lc-accent), var(--lc-accent))",
		);
	});

	it("hides the toggle when one kind is offered and still files under it", async () => {
		const user = userEvent.setup();
		const submitted = vi.fn().mockResolvedValue(undefined);
		render(
			<FeedbackButton
				onSubmit={submitted}
				kinds={[{ value: "praise", label: "Praise", placeholder: "Say it" }]}
			/>,
		);

		await open(user);
		expect(screen.queryByRole("group", { name: "Feedback type" })).toBeNull();

		await user.type(screen.getByPlaceholderText("Say it"), "good sigil");
		await user.click(screen.getByRole("button", { name: "Send" }));

		await waitFor(() => expect(submitted).toHaveBeenCalled());
		expect(submitted.mock.calls[0][0]).toMatchObject({ type: "praise" });
	});

	it("renders a receipt from a string and from a function evaluated at render", async () => {
		const user = userEvent.setup();
		const { unmount } = render(
			<FeedbackButton
				onSubmit={onSubmit}
				copy={{ receipt: "build a531918" }}
			/>,
		);
		await open(user);
		expect(screen.getByText("build a531918")).not.toBeNull();
		unmount();

		let events = 3;
		render(
			<FeedbackButton
				onSubmit={onSubmit}
				copy={{ receipt: () => `carries ${events} events` }}
			/>,
		);
		await open(user);
		expect(screen.getByText("carries 3 events")).not.toBeNull();

		// "At render" is the claim: the line follows a value that moved after the
		// copy was handed over, which a receipt evaluated once could not do.
		events = 12;
		await user.click(screen.getByRole("button", { name: "Idea" }));
		expect(screen.getByText("carries 12 events")).not.toBeNull();
	});

	it("labels the trigger from triggerLabel while the heading keeps its own words", async () => {
		const user = userEvent.setup();
		render(
			<FeedbackButton
				onSubmit={onSubmit}
				copy={{ title: "Send Word", triggerLabel: "Feedback" }}
			/>,
		);

		// The glyph beside the label is aria-hidden, so the accessible name is
		// the label alone rather than "✦ Feedback".
		expect(screen.getByRole("button", { name: "Feedback" })).not.toBeNull();
		expect(screen.queryByRole("button", { name: "Send Word" })).toBeNull();

		const dialog = await open(user, "Feedback");
		expect(dialog.getAttribute("aria-label")).toBeNull();
		expect(screen.getByRole("heading", { name: "Send Word" })).not.toBeNull();
	});

	it("falls back to the title when no triggerLabel is given", async () => {
		const user = userEvent.setup();
		render(
			<FeedbackButton onSubmit={onSubmit} copy={{ title: "Send Word" }} />,
		);

		await open(user, "Send Word");
		expect(screen.getByRole("heading", { name: "Send Word" })).not.toBeNull();
	});

	it("renders a title node and still names the dialog from its words alone", async () => {
		const user = userEvent.setup();
		render(
			<FeedbackButton
				onSubmit={onSubmit}
				copy={{
					title: (
						<>
							<span aria-hidden="true" className="mr-1.5 select-none">
								✦
							</span>
							Send Word
						</>
					),
					triggerLabel: "Feedback",
				}}
			/>,
		);

		const dialog = await open(user, "Feedback");
		// Base UI points the popup's aria-labelledby at the title element, and the
		// name is computed from its subtree — so the aria-hidden glyph drops out
		// and the dialog is named "Send Word", not "✦ Send Word".
		expect(dialog.getAttribute("aria-labelledby")).not.toBeNull();
		expect(screen.getByRole("dialog", { name: "Send Word" })).toBe(dialog);
		// The glyph is on screen even though it is not in the name.
		expect(dialog.textContent).toContain("✦");
	});

	it("renders a receipt node returned by a receipt function", async () => {
		const user = userEvent.setup();
		render(
			<FeedbackButton
				onSubmit={onSubmit}
				copy={{
					receipt: () => (
						<>
							<span data-run="label">Carries</span> 12 events · build a531918
						</>
					),
				}}
			/>,
		);

		const dialog = await open(user);
		const receipt = dialog.querySelector('[data-slot="feedback-receipt"]');
		expect(receipt?.textContent).toBe("Carries 12 events · build a531918");
		// The markup seam is the point: the label is its own element, so it can be
		// styled apart from the hex SHA beside it.
		expect(receipt?.querySelector("[data-run]")?.textContent).toBe("Carries");
	});

	it("omits the receipt line when a receipt function returns nothing", async () => {
		const user = userEvent.setup();
		render(
			<FeedbackButton
				onSubmit={onSubmit}
				copy={{ receipt: () => undefined }}
			/>,
		);

		const dialog = await open(user);
		expect(dialog.querySelector('[data-slot="feedback-receipt"]')).toBeNull();
	});

	it("omits the receipt line when no receipt copy is given", async () => {
		const user = userEvent.setup();
		render(<FeedbackButton onSubmit={onSubmit} />);

		const dialog = await open(user);
		expect(dialog.querySelector('[data-slot="feedback-receipt"]')).toBeNull();
	});

	it("says nothing when an automatic capture fails", async () => {
		const user = userEvent.setup();
		captureMock.mockRejectedValue(new Error("tainted canvas"));
		render(<FeedbackButton onSubmit={onSubmit} autoCapture />);

		await open(user);
		await waitFor(() => expect(captureMock).toHaveBeenCalled());

		expect(screen.queryByRole("alert")).toBeNull();
		// The manual button is the retry path, so it has to still be there.
		expect(
			screen.getByRole("button", { name: "Capture screenshot" }),
		).not.toBeNull();
	});

	it("says so when a manual capture fails", async () => {
		const user = userEvent.setup();
		captureMock.mockRejectedValue(new Error("tainted canvas"));
		render(<FeedbackButton onSubmit={onSubmit} />);

		await open(user);
		await user.click(
			screen.getByRole("button", { name: "Capture screenshot" }),
		);

		expect((await screen.findByRole("alert")).textContent).toMatch(
			/wouldn't render to an image/i,
		);
	});

	it("refuses a capture over the size cap and reports its size", async () => {
		const user = userEvent.setup();
		captureMock.mockResolvedValue(new Uint8Array(11 * 1024 * 1024));
		render(<FeedbackButton onSubmit={onSubmit} />);

		await open(user);
		await user.click(
			screen.getByRole("button", { name: "Capture screenshot" }),
		);

		expect((await screen.findByRole("alert")).textContent).toBe(
			"That capture came to 11.0 MB — the limit is 10.0 MB.",
		);
		// Nothing was attached, so the capture control is still the way in.
		expect(
			screen.getByRole("button", { name: "Capture screenshot" }),
		).not.toBeNull();
	});

	it("silently drops an automatic capture that is over the cap", async () => {
		const user = userEvent.setup();
		captureMock.mockResolvedValue(new Uint8Array(11 * 1024 * 1024));
		render(<FeedbackButton onSubmit={onSubmit} autoCapture />);

		await open(user);
		await waitFor(() => expect(captureMock).toHaveBeenCalled());

		expect(screen.queryByRole("alert")).toBeNull();
		expect(
			screen.getByRole("button", { name: "Capture screenshot" }),
		).not.toBeNull();
	});

	it("leaves a reopened dialog alone when the abandoned send settles", async () => {
		const user = userEvent.setup();
		let deliver!: () => void;
		const inFlight = new Promise<void>((resolve) => {
			deliver = resolve;
		});
		render(<FeedbackButton onSubmit={() => inFlight} />);

		await open(user);
		await user.type(screen.getByRole("textbox"), "the first report");
		await user.click(screen.getByRole("button", { name: "Send" }));
		// Dismissed mid-send, then reopened onto a fresh report.
		await user.click(screen.getByRole("button", { name: "Cancel" }));
		await open(user);
		await user.type(screen.getByRole("textbox"), "the second report");

		deliver();
		// Past the completion hold, so a stale settlement would have had every
		// chance to repaint the dialog.
		await new Promise((resolve) => setTimeout(resolve, 700));

		expect(screen.queryByText("Feedback sent")).toBeNull();
		expect(screen.getByRole("textbox")).toHaveProperty(
			"value",
			"the second report",
		);
	});

	it("drops a capture that resolves onto a reopened dialog", async () => {
		const user = userEvent.setup();
		let deliver!: (bytes: Uint8Array) => void;
		captureMock.mockReturnValue(
			new Promise<Uint8Array>((resolve) => {
				deliver = resolve;
			}),
		);
		render(<FeedbackButton onSubmit={onSubmit} />);

		await open(user);
		await user.click(
			screen.getByRole("button", { name: "Capture screenshot" }),
		);
		// Dismissed with the clone still in flight, then reopened onto a fresh
		// form — and only now does the abandoned capture land. Delivering after
		// the reopen is the point: a capture settling *before* it would be masked
		// by launch()'s own reset, so the stale attachment only shows through when
		// it resolves onto the form that is already back on screen.
		await user.click(screen.getByRole("button", { name: "Cancel" }));
		await open(user);
		deliver(new Uint8Array(200 * 1024));
		// Let the late capture's continuation run and commit any state it would.
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(screen.queryByText(/Screenshot attached/)).toBeNull();
		expect(screen.queryByRole("alert")).toBeNull();
		expect(
			screen.getByRole("button", { name: "Capture screenshot" }),
		).not.toBeNull();
	});

	it("attaches a capture that fits and lets it be discarded", async () => {
		const user = userEvent.setup();
		captureMock.mockResolvedValue(new Uint8Array(200 * 1024));
		render(<FeedbackButton onSubmit={onSubmit} />);

		await open(user);
		await user.click(
			screen.getByRole("button", { name: "Capture screenshot" }),
		);

		expect(
			await screen.findByText("Screenshot attached (200 KB)"),
		).not.toBeNull();

		await user.click(
			screen.getByRole("button", { name: "Discard screenshot" }),
		);
		expect(
			screen.getByRole("button", { name: "Capture screenshot" }),
		).not.toBeNull();
	});
});
