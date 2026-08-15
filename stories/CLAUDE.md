# Data Stories — Rules

Rules for the public data-story site (`stories/`, deployed to https://stories.flawchess.com/ by `.github/workflows/pages.yml`). See `stories/README.md` for deployment/DNS details.

## Structure

- One directory per story: `stories/<slug>/index.html` (kebab-case slug = URL). Self-contained pages: inline CSS/JS, vanilla SVG charts, no CDNs or JS libraries. The only allowed external resource is Google Fonts (Fredoka, for the brand label).
- **Co-locate the technical report**: the report a story summarizes lives next to it as `stories/<slug>/<slug>-report.md` (short name, e.g. `two-pawns-up-report.md`), not under `reports/`. The story footer links to it via its GitHub blob URL.
- Add a card for every new story to `stories/index.html`, including its publication date.

## Header (must match the flawchess.com homepage)

- Logo + "FlawChess" label, with the tagline ("Engines are flawless, humans play FlawChess.") right-aligned.
- The label uses the homepage brand font: **Fredoka, weight 600**, `letter-spacing:-.02em` (load via Google Fonts).
- Logo and label are wrapped in a single `<a href="https://flawchess.com">`.
- Full-width fine grey bottom border: `border-bottom:1px solid var(--line)` on the header, with the flex content in an inner `.wrap` (header sits outside the page's `.wrap` so the line spans the viewport).

## Content & copy

- **Publication date is mandatory**: show it in the hero kicker as `<time datetime="YYYY-MM-DD">Month D, YYYY</time>`, and repeat it on the landing-page card.
- Plain-language copy for a non-technical audience ("two pawns up", not "200 cp").
- **Terminology must match the underlying technical report.** Don't invent story-side synonyms for defined terms (e.g. the report's "sustained lead" stays "sustained lead", not "wire-to-wire").
- **Em-dashes very sparingly** — at most one per page section; prefer commas, parentheses, colons, or semicolons.
- Every chart gets a `<details>` "View the data" table; all numbers live inline in the page (no fetches).

## Visual style

- FlawChess branding: brand brown `#8B5E3C`, cream background `#FAF7F0`, warm ink/line palette (see existing stories' `:root` tokens).
- **WDL colors**: win = green, loss = red, **draw = grey** (`#8A7F71`, the `--ink-3` warm grey). Never violet/purple for draws.
- Chart titles use a dedicated larger style (`.ctitle`, ~18px bold ink-2), clearly bigger than axis labels (14px `.axis`).
- Colorblind-safe series palettes; charts scroll horizontally on small screens (`figure{overflow-x:auto}` with a min-width inner div).
