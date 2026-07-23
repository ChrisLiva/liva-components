# Skin contract

A skin is a single component that binds the headless core
(`@/lib/feedback/use-feedback`) to one design system's primitives. It owns
markup and nothing else: every piece of state, every transition, and every
guarantee lives in `useFeedback`. Two skins ship — `feedback-skin-base-ui`
(Base UI / shadcn) and `feedback-skin-antd` (native antd) — and they are the
worked examples this contract describes.

The executable half of this contract is `registry/skin-conformance.test.tsx`.
A skin is correct when it passes that suite; this document explains why each
rule is there.

## Wiring rules

Call `useFeedback(options)` once and render from the returned `fb`.

- **Controlled dialog.** Bind the dialog's open state to `fb.open`, its
  dismissal to `fb.setOpen(false)` (Escape, overlay, Cancel all route here),
  and its open-complete callback to `fb.notifyOpenComplete`. Do not keep your
  own open state.
- **Trigger opens with `fb.launch()`**, never `setOpen(true)`. `launch` resets
  the form, stamps a fresh report, and arms auto-capture; `setOpen` is only the
  dismissal path.
- **Every string comes from `fb.copy`.** Never hardcode a label, an
  `aria-label`, an error, or a placeholder. `fb.copy` is fully merged, so every
  key is present. Attachment size and the size-cap limit are formatted with
  `formatSize` (exported beside the hook) and passed into `fb.copy.attached` /
  `fb.copy.tooLarge`.
- **The screenshot preview is `fb.screenshotUrl`.** Never build your own object
  URL from `fb.screenshot`; the hook owns that blob URL's lifecycle.
- **Send with `fb.send()`; gate it in the UI**, not in the hook. Disable the
  send control when `fb.sending` or `fb.message.trim() === ""`.

## Required visual states

The skin must be able to show all of these, driven entirely by `fb`:

- **compose** (`fb.phase === "compose"`) — kind picker, message field, capture
  control, actions.
- **sending** (`fb.sending`) — inputs disabled, a progress bar reading
  `fb.percent`, and the `fb.stage` label.
- **sent** (`fb.phase === "sent"`) — a confirmation with one way out.
- **error** (`fb.error !== null`) — a single error line. `fb.error` already
  resolves the priority (a capture error sits over a stale send error); render
  it verbatim.
- **capturing** (`fb.capturing`) — the capture control reads as pending
  (`fb.copy.capturingLabel`) rather than idle.

## Primitive roles

Your design system needs, at minimum:

| Role | What it must do |
|---|---|
| Trigger button | Calls `fb.launch()`; accessible name is the label alone |
| Modal / dialog | Controlled `open`, a dismissal callback, and an **open-complete callback** wired to `fb.notifyOpenComplete` |
| Multiline input | Bound to `fb.message` / `fb.setMessage` |
| Single-select group | Bound to `fb.kind` / `fb.setKind`; hidden when `fb.kinds.length <= 1` |
| Progress indicator | Reads `fb.percent` (0–100) |

The open-complete callback matters: auto-capture fires from it (via
`fb.notifyOpenComplete`), so a primitive with no "finished opening" signal
cannot support auto-capture. In jsdom this callback fires for Base UI but not
for antd's Modal, which is why the silent-auto-capture contract is pinned in
the core hook test rather than the conformance suite.

## Accessibility requirements

- The **dialog is named from `fb.copy.title`** — whatever element you render it
  in, the dialog's accessible name must be the title's words. Decorative glyphs
  inside a title node carry `aria-hidden`, so the name stays the words alone.
- The **error line is `role="alert"`**.
- The **capture row is an `aria-live="polite"` region**, so an attachment
  appearing is announced. The **stage label under the progress bar is also
  `aria-live`**, so a long send speaks even when unfocused.
- **Icon-only controls carry an `aria-label`** from `fb.copy` (retake, discard).
  Some icon sets inject their own `aria-label`; hide the glyph (`aria-hidden`)
  so it does not join the control's name.
- The **kind group carries `fb.copy.kindGroupLabel`**; the message field carries
  `fb.copy.messageLabel`.
- **Decorative glyphs are `aria-hidden`.**

## Rules

- **No cross-skin imports.** A skin depends only on `@/lib/feedback/*` and its
  own design system. It never imports another skin.
- **`data-capture-hide` on the dialog surface.** `lib/feedback/capture` drops
  any node marked `data-capture-hide` from its screenshot; without it, every
  capture is a picture of the feedback form.
- **No core edits.** Behaviour is frozen in `useFeedback`. If a behaviour seems
  unreachable through the surface, that is a gap in the hook to raise — not a
  reason to reimplement logic in a skin.
