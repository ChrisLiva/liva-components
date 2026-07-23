import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FeedbackButton } from "@/components/feedback/feedback-button";
import { captureViewport, includeInCapture } from "@/lib/feedback/capture";

// Base-ui-specific mechanism for the feedback dialog: the accent painting, the
// capture-hide marker, the `lc-` utility classes, and the trigger-cloning
// contract — things only this skin's markup can be asked about. The behaviour
// contract every skin shares lives in skin-conformance.test.tsx, queried
// semantically. (Below the imports because `shadcn add` strips every comment
// above a file's first import, so a header note never reaches a consumer.)

vi.mock("@/lib/feedback/capture", async (importActual) => ({
	...(await importActual<typeof import("@/lib/feedback/capture")>()),
	captureViewport: vi.fn(),
	afterPaint: () => Promise.resolve(),
	// includeInCapture is kept real (importActual, above): the capture-hide
	// contract test below asserts the dialog is excluded by the actual predicate.
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

describe("FeedbackButton (base-ui skin)", () => {
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

	it("carries the lc- accent utility classes on its popup", async () => {
		const user = userEvent.setup();
		render(<FeedbackButton onSubmit={onSubmit} />);

		const dialog = await open(user);
		// The classes the accent frame and its cross-kind transition hang off of;
		// the CSS behind them is shipped in the registry item's `css` field.
		expect(dialog.classList.contains("lc-accent-frame")).toBe(true);
		expect(dialog.classList.contains("lc-accent-shift")).toBe(true);
	});

	it("marks its own popup so the capture predicate leaves it out", async () => {
		const user = userEvent.setup();
		render(<FeedbackButton onSubmit={onSubmit} />);

		const dialog = await open(user);
		// The contract between this component and the capture module: the popup
		// carries data-capture-hide, and includeInCapture reads exactly that
		// marker. Asserting against the real predicate means renaming the marker
		// on either side — the attribute here or the selector there — fails here.
		expect(includeInCapture(dialog)).toBe(false);
	});

	it("wires the open handler onto a custom trigger, preserving its own onClick", async () => {
		const user = userEvent.setup();
		const clicked = vi.fn();
		render(
			<FeedbackButton
				onSubmit={onSubmit}
				trigger={
					<button type="button" onClick={clicked}>
						Open feedback
					</button>
				}
			/>,
		);

		await user.click(screen.getByRole("button", { name: "Open feedback" }));
		// The trigger's own handler runs, and the dialog still opens.
		expect(clicked).toHaveBeenCalledTimes(1);
		expect(await screen.findByRole("dialog")).not.toBeNull();
	});

	it("lets a custom trigger suppress the open with preventDefault", async () => {
		const user = userEvent.setup();
		render(
			<FeedbackButton
				onSubmit={onSubmit}
				trigger={
					<button type="button" onClick={(event) => event.preventDefault()}>
						Guarded
					</button>
				}
			/>,
		);

		await user.click(screen.getByRole("button", { name: "Guarded" }));
		expect(screen.queryByRole("dialog")).toBeNull();
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

	it("fires a silent auto-capture through the dialog's open-complete callback", async () => {
		const user = userEvent.setup();
		captureMock.mockRejectedValue(new Error("tainted canvas"));
		render(<FeedbackButton onSubmit={onSubmit} autoCapture />);

		// Base UI's onOpenChangeComplete fires in jsdom, so the armed auto-capture
		// runs — and its failure stays silent, per the core's silent contract.
		await open(user);
		await waitFor(() => expect(captureMock).toHaveBeenCalled());

		expect(screen.queryByRole("alert")).toBeNull();
		expect(
			screen.getByRole("button", { name: "Capture screenshot" }),
		).not.toBeNull();
	});
});
