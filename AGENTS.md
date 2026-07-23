# AGENTS.md

Guidance for agents working in this repo, and the recipe for porting the
feedback flow to a new design system.

## Shape of the repo

The feedback flow is a **headless core plus per-design-system skins**:

- `registry/feedback-core/` — `useFeedback`, the hook that owns every piece of
  state, transition, and guarantee (dialog open, compose draft, capture flow,
  send pipeline). Plus `feedback-defaults.ts` (copy + kinds) and
  `skin-contract.md`.
- `registry/feedback-skin-base-ui/` — the Base UI / shadcn skin.
- `registry/feedback-skin-antd/` — the native antd skin.
- `registry/screenshot-capture/`, `registry/diagnostics/`, `registry/scrub/` —
  lib helpers bundled into each installable item.
- `registry/skin-conformance.test.tsx` — the behaviour suite every skin passes.

Two installable registry items — `feedback-base-ui` and `feedback-antd` — each
bundle a skin, the core, and the lib helpers with **zero `registryDependencies`
and no test files**. Both target `@/components/feedback/feedback-button.tsx`, so
app code imports one path regardless of design system.

Behaviour is frozen in the core. Skins are markup only.

## Porting to a new design system

To add, say, a Material UI or Mantine skin:

1. **Copy `@/lib/feedback/*` verbatim.** The core, the defaults, and the lib
   helpers are design-system-agnostic — do not edit them. If a behaviour seems
   unreachable through `useFeedback`'s surface, that is a gap in the hook to
   raise, not logic to reimplement in your skin.
2. **Read `registry/feedback-core/skin-contract.md`.** It is the wiring rules,
   required visual states, primitive roles, and accessibility requirements in
   full.
3. **Study both existing skins.** `feedback-skin-base-ui` (multi-file, with an
   accent system and a `classNames` map) and `feedback-skin-antd` (single file,
   native look, theming instead of class hooks) bracket the range. The antd skin
   is the closer template for a single-file port.
4. **Write your skin as a single component** that calls `useFeedback` once and
   renders from `fb`. Bind the dialog to `fb.open` / `fb.setOpen` /
   `fb.notifyOpenComplete`, open with `fb.launch()`, read every string from
   `fb.copy`, mark the dialog surface `data-capture-hide`, and give the error
   line `role="alert"`.
5. **Register your skin in the conformance suite.** Add one entry to the `SKINS`
   array in `registry/skin-conformance.test.tsx` and run `pnpm test`. If a
   listed behaviour can't be expressed against your primitives, that is a gap in
   the skin, not a test to route around.

### Checklist

- [ ] No edits under `@/lib/feedback/`.
- [ ] No imports from another skin.
- [ ] Every string reads from `fb.copy`.
- [ ] Dialog named from `fb.copy.title`; decorative glyphs `aria-hidden`.
- [ ] Capture row and stage label are `aria-live`; error line is `role="alert"`.
- [ ] Icon-only controls have `aria-label`s from `fb.copy`.
- [ ] `data-capture-hide` on the dialog surface.
- [ ] Registered in `SKINS`; conformance suite green.
- [ ] `pnpm typecheck && pnpm test && pnpm lint` clean.

## Commands

```bash
pnpm typecheck        # tsc --noEmit
pnpm test             # vitest run
pnpm lint             # biome check .
pnpm build:registry   # shadcn build → public/r/*.json (commit the output)
pnpm storybook        # both skins render here
```

`public/r/` is the committed distributable; re-run `pnpm build:registry` and
commit its output in any change that touches registry sources.
`registry.build.test.ts` fails on drift; `registry.shape.test.ts` freezes the
no-`registryDependencies` / no-test-files / confined-targets shape.
