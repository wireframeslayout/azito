<ui_design_principles>
Build UI to a production standard. Two rules come first.

## 1. Always make modern design choices
- Aim for a polished, production-quality result. Do not ship simplified,
  prototype-looking UI, and do not cut corners on visual quality.
- Apply current interface craft: clear visual hierarchy, deliberate spacing and
  typography scale, restrained color, smooth and purposeful motion, and attention
  to detail in alignment and density.

## 2. Build for reuse — verify before you create
- Before implementing any component, search the codebase for an existing one that
  fits (base components and domain components, e.g. under the UI components
  directory). Reuse it if it exists.
- If none fits, create the component at the right altitude: extract a reusable
  base component (generic, props-driven) or a domain component (feature-specific,
  composed from base components) rather than inlining one-off markup.
- Treat every component as something that will be reused. Keep them controlled,
  props-driven, and free of hidden coupling so other screens can adopt them.

## Design system adherence (no ad-hoc styles)
- Use only the project's existing design tokens (CSS variables) and components.
  Do not hardcode raw values — colors, spacing, font sizes, radii, shadows — and
  do not invent a new styling approach. Detect the existing tokens/components
  first, then build within them.
- Add new dependencies only when explicitly approved.

## Cover every state
- For each interactive element, define default, hover, focus, active, disabled,
  loading, empty, and error states. Do not leave loading/empty/error implicit.

## Visual and structural quality
- Visual hierarchy: guide the eye with size, contrast, and spacing; place the most
  important element where attention lands first.
- Typography: a clear scale (heading/body/caption) with readable line-height.
- Spacing: use whitespace to group and separate; keep rhythm consistent.
- Responsive: define breakpoint behavior; no horizontal scroll at 320px or 200% zoom.
- Motion: purposeful easing; honor prefers-reduced-motion.
- For dense, dark dev-tool UIs: manage information density and hierarchy
  deliberately; show urgent → context → detail in that order.

## Accessibility (WCAG 2.2 AA)
- Contrast: 4.5:1 for normal text, 3:1 for large text.
- Focus: a visible focus indicator with 3:1 contrast against its surroundings.
- Keyboard: every function operable by keyboard; logical focus order; no traps.
- Semantics: correct heading nesting, semantic HTML, labels associated with
  inputs, ARIA only where HTML is insufficient, status messages via aria-live.
</ui_design_principles>
