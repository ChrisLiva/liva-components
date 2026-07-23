import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FeedbackButton as BaseUiFeedbackButton } from "@/components/feedback/feedback-button";
import { captureViewport } from "@/lib/feedback/capture";
import type { UseFeedbackOptions } from "@/lib/feedback/use-feedback";

// The executable half of the skin contract: one behaviour suite every skin
// must pass, run against each registered skin via describe.each. These tests
// query only what a reporter can perceive — roles, accessible names, visible
// text — never a data-slot, a class, or an inline style, so a skin passes by
// behaving right rather than by mirroring base-ui's markup. Skin-specific
// mechanism (base-ui's accent painting and capture-hide marker; antd's Modal
// and Segmented details) lives beside each skin instead.
//
// Register a new skin by adding one entry to SKINS. If a listed behaviour can't
// be expressed against your primitives, that is a gap in the skin, not a test
// to route around — see skin-contract.md.

vi.mock("@/lib/feedback/capture", async (importActual) => ({
	...(await importActual<typeof import("@/lib/feedback/capture")>()),
	captureViewport: vi.fn(),
	// The real one waits two frames; resolving straight away keeps the tests off
	// the frame clock. That an auto-capture is deferred at all is asserted
	// separately, against the real afterPaint, in capture.test.ts.
	afterPaint: () => Promise.resolve(),
}));

const captureMock = vi.mocked(captureViewport);

/** The logic props every skin shares; the conformance suite touches only these. */
type SkinProps = Pick<
	UseFeedbackOptions,
	"onSubmit" | "collectContext" | "autoCapture" | "kinds" | "copy"
> & {
	icon?: ReactNode;
	trigger?: ReactNode;
};

/** A skin under test: a display name and its FeedbackButton component. */
type Skin = {
	name: string;
	FeedbackButton: (props: SkinProps) => ReactNode;
};

const SKINS: Skin[] = [
	{ name: "base-ui", FeedbackButton: BaseUiFeedbackButton },
];

/** A send that always succeeds, for the cases that are not about sending. */
const onSubmit = () => Promise.resolve();

beforeEach(() => {
	captureMock.mockReset();
});

// Vitest runs without globals here, so Testing Library never registers its own
// teardown — and a dialog left mounted portals into document.body, where the
// next test's queries still find it.
afterEach(cleanup);

describe.each(SKINS)("$name skin", ({ FeedbackButton }) => {
	/** Open the dialog by clicking the trigger, and hand back the popup. */
	async function open(
		user: ReturnType<typeof userEvent.setup>,
		trigger: RegExp | string = /send feedback/i,
	) {
		await user.click(screen.getByRole("button", { name: trigger }));
		return await screen.findByRole("dialog");
	}

	it("opens onto a fresh form on every launch", async () => {
		const user = userEvent.setup();
		render(<FeedbackButton onSubmit={onSubmit} />);

		await open(user);
		await user.type(screen.getByRole("textbox"), "a first draft");
		await user.click(screen.getByRole("button", { name: "Cancel" }));

		await open(user);
		expect(screen.getByRole("textbox")).toHaveProperty("value", "");
	});

	it("selects a kind and files the report under it", async () => {
		const user = userEvent.setup();
		const submitted = vi.fn().mockResolvedValue(undefined);
		render(<FeedbackButton onSubmit={submitted} />);

		await open(user);
		await user.click(screen.getByRole("button", { name: "Idea" }));
		// The placeholder follows the selected kind.
		expect(
			screen.getByPlaceholderText("What would you like this to do?"),
		).not.toBeNull();

		await user.type(screen.getByRole("textbox"), "a better sigil");
		await user.click(screen.getByRole("button", { name: "Send" }));

		await waitFor(() => expect(submitted).toHaveBeenCalled());
		expect(submitted.mock.calls[0][0]).toMatchObject({ type: "idea" });
	});

	it("hides the picker for a single kind and still files under it", async () => {
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

	it("gates send until the message has content", async () => {
		const user = userEvent.setup();
		render(<FeedbackButton onSubmit={onSubmit} />);

		await open(user);
		const send = screen.getByRole("button", { name: "Send" });
		expect(send).toHaveProperty("disabled", true);

		await user.type(screen.getByRole("textbox"), "something to say");
		expect(send).toHaveProperty("disabled", false);
	});

	it("attaches a capture that fits, then retakes and discards it", async () => {
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

		// Retake replaces the attachment with a fresh capture of a new size.
		captureMock.mockResolvedValue(new Uint8Array(150 * 1024));
		await user.click(screen.getByRole("button", { name: "Retake screenshot" }));
		expect(
			await screen.findByText("Screenshot attached (150 KB)"),
		).not.toBeNull();

		await user.click(
			screen.getByRole("button", { name: "Discard screenshot" }),
		);
		expect(
			screen.getByRole("button", { name: "Capture screenshot" }),
		).not.toBeNull();
	});

	it("refuses a capture over the size cap and names its size", async () => {
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

	it("says nothing when an automatic capture throws", async () => {
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

	it("silently drops an automatic capture over the cap", async () => {
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

	it("shows a capture error over a stale send error", async () => {
		const user = userEvent.setup();
		render(
			<FeedbackButton
				onSubmit={() => Promise.reject(new Error("server said no"))}
			/>,
		);

		await open(user);
		await user.type(screen.getByRole("textbox"), "the report");
		await user.click(screen.getByRole("button", { name: "Send" }));
		expect((await screen.findByRole("alert")).textContent).toBe(
			"server said no",
		);

		// A capture that fails now takes priority over the lingering send error.
		captureMock.mockRejectedValue(new Error("tainted canvas"));
		await user.click(
			screen.getByRole("button", { name: "Capture screenshot" }),
		);
		await waitFor(() =>
			expect(screen.getByRole("alert").textContent).toMatch(
				/wouldn't render to an image/i,
			),
		);
	});

	it("locks the inputs while a send is in flight", async () => {
		const user = userEvent.setup();
		let deliver!: () => void;
		render(
			<FeedbackButton
				onSubmit={() =>
					new Promise<void>((resolve) => {
						deliver = resolve;
					})
				}
			/>,
		);

		await open(user);
		await user.type(screen.getByRole("textbox"), "the report");
		await user.click(screen.getByRole("button", { name: "Send" }));

		expect(screen.getByRole("textbox")).toHaveProperty("disabled", true);
		// The dialog stays dismissable mid-send.
		expect(screen.getByRole("button", { name: "Cancel" })).toHaveProperty(
			"disabled",
			false,
		);

		deliver();
	});

	it("shows the sent view after a successful send", async () => {
		const user = userEvent.setup();
		render(<FeedbackButton onSubmit={onSubmit} />);

		await open(user);
		await user.type(screen.getByRole("textbox"), "the report");
		await user.click(screen.getByRole("button", { name: "Send" }));

		expect(await screen.findByText("Feedback sent")).not.toBeNull();
		expect(screen.getByRole("button", { name: "Done" })).not.toBeNull();
	});

	it("leaves a reopened dialog alone when an abandoned send settles", async () => {
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
		// form — and only now does the abandoned capture land.
		await user.click(screen.getByRole("button", { name: "Cancel" }));
		await open(user);
		deliver(new Uint8Array(200 * 1024));
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(screen.queryByText(/Screenshot attached/)).toBeNull();
		expect(screen.queryByRole("alert")).toBeNull();
		expect(
			screen.getByRole("button", { name: "Capture screenshot" }),
		).not.toBeNull();
	});

	it("names the trigger from triggerLabel while the heading keeps its own words", async () => {
		const user = userEvent.setup();
		render(
			<FeedbackButton
				onSubmit={onSubmit}
				copy={{ title: "Send Word", triggerLabel: "Feedback" }}
			/>,
		);

		// The decorative glyph is hidden, so the accessible name is the label
		// alone rather than "✦ Feedback".
		expect(screen.getByRole("button", { name: "Feedback" })).not.toBeNull();
		expect(screen.queryByRole("button", { name: "Send Word" })).toBeNull();

		await open(user, "Feedback");
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

	it("names the dialog from a title node's words alone", async () => {
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
		// The aria-hidden glyph drops out of the computed name, but is on screen.
		expect(screen.getByRole("dialog", { name: "Send Word" })).toBe(dialog);
		expect(dialog.textContent).toContain("✦");
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
});
