# Chess Data Stories — Rules

Rules for the public data-story site (`stories/`, deployed to https://stories.flawchess.com/ by `.github/workflows/pages.yml`). See `stories/README.md` for deployment/DNS details.

The blog is named **Chess Data Stories** (not "FlawChess Data Stories"): use that name in page `<title>`s, the header label, and bylines.

## Structure

- One directory per story: `stories/<slug>/index.html` (kebab-case slug = URL). Self-contained pages: inline CSS/JS, vanilla SVG charts, no CDNs or JS libraries. The only allowed external resource is Google Fonts (Fredoka, for the brand label).
- **Co-locate the technical report**: the report a story summarizes lives next to it as `stories/<slug>/<slug>-report.md` (short name, e.g. `two-pawns-up-report.md`), not under `reports/`. The story footer links to it via its GitHub blob URL.
- Add a card for every new story to `stories/index.html`, including its publication date.

## SEO & sharing (required for every story)

- **Head tags**: unique `<title>`, `<meta name="description">`, `<link rel="canonical">`, full Open Graph set (`og:type=article`, `og:site_name`, `og:title`, `og:description`, `og:url`, `og:image` + width/height, `article:published_time`, `article:author`) and Twitter Card (`summary_large_image`), plus a JSON-LD `Article` block (`isPartOf` the Chess Data Stories `Blog`, author Adrian Imfeld, publisher FlawChess). Copy the block from `two-pawns-up/index.html`.
- **Social card**: a 1200×630 `social-card.png` in the story directory, referenced with an **absolute** `https://stories.flawchess.com/...` URL (scrapers don't resolve relative og:image paths). Render it from a brand-styled HTML card via headless Chrome (`google-chrome --headless=new --window-size=1200,630 --screenshot=...`); show the story headline and its hero stat(s).
- **Sitemap**: add the story URL to `stories/sitemap.xml` (and bump the landing page's `lastmod`). Update the landing page's JSON-LD `blogPost` list too.
- **Landmarks**: page content lives in `<main class="wrap">`.

## Header (must match the flawchess.com homepage)

- Logo + "FlawChess" label, with the tagline ("Engines are flawless, humans play FlawChess.") right-aligned.
- The label uses the homepage brand font: **Fredoka, weight 600**, `letter-spacing:-.02em` (load via Google Fonts).
- Logo and label are wrapped in a single `<a href="https://flawchess.com">`.
- After the brand link, a "Chess Data Stories" blog-title label (`.sect`: same Fredoka style, brand brown, thin left border) linking to the stories index (`./` from the landing page, `../` from a story page). Below 560px, `.name` and `.sect` shrink to 19px and the tagline hides.
- Full-width fine grey bottom border: `border-bottom:1px solid var(--line)` on the header, with the flex content in an inner `.wrap` (header sits outside the page's `.wrap` so the line spans the viewport).

## Content & copy

- **Publication date is mandatory**: show it in the hero kicker as `<time datetime="YYYY-MM-DD">Month D, YYYY</time>`, and repeat it on the landing-page card.
- Plain-language copy for a non-technical audience ("two pawns up", not "200 cp").
- **Terminology must match the underlying technical report.** Don't invent story-side synonyms for defined terms (e.g. the report's "sustained lead" stays "sustained lead", not "wire-to-wire").
- **Em-dashes very sparingly** — at most one per page section; prefer commas, parentheses, colons, or semicolons.
- Every chart gets a `<details>` "View the data" table; all numbers live inline in the page (no fetches).
- **Story footer, in order** (copy the markup from `two-pawns-up/index.html`): the "About this analysis" box (methodology, report link, data fineprint), then the **FlawChess card** (`.promo`: logo + Fredoka brand name + tagline, a short pitch **tailored to the story's topic** (2–3 sentences naming the features that answer the question the story just raised; NO feature-bullet grid — a full feature list reads as an ad and undermines the story's credibility), the flawchess.com CTA button, "All features free · no signup required · open source"), then the **author card** (`.author`: circular photo `stories/author.jpg` (shared asset, CSS `border-radius:50%`), name "Adrian Imfeld", short bio, LinkedIn (https://www.linkedin.com/in/aimfeld/) + GitHub (https://github.com/aimfeld) links). The CTA button lives in the FlawChess card only, not in the About box. The landing page keeps only the one-line footer byline, not the full cards.

## Visual style

- FlawChess branding: brand brown `#8B5E3C`, cream background `#FAF7F0`, warm ink/line palette (see existing stories' `:root` tokens).
- **WDL colors**: win = green, loss = red, **draw = grey** (`#8A7F71`, the `--ink-3` warm grey). Never violet/purple for draws.
- **Chart anatomy, top to bottom: title → legend/controls → plot.** The title is an HTML element above the chart (`.ctitle`, ~18px bold ink-2, clearly bigger than 14px `.axis` labels), never drawn inside the SVG (HTML wraps natively on narrow screens). The legend (or toggle buttons acting as one) sits between the title and the `<figure>`, so readers get the color key before the marks. Captions/source notes go below the chart.
- Prefer direct labeling over a legend where it fits (e.g. end-of-line series labels on wide screens); order legend items to match the visual order of the series.
- Colorblind-safe series palettes.
- **Charts must be mobile friendly with no horizontal scrolling**: re-render each SVG at the container width on resize (viewBox width = container width so font sizes stay true), and drop end-of-line series labels in favor of a legend below ~700px. Only the "View the data" tables may scroll horizontally.
