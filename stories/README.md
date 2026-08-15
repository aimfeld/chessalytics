# FlawChess Data Stories (GitHub Pages)

Public, interactive data stories published at **https://stories.flawchess.com/**
(GitHub Pages with a custom domain; `flawchess.github.io/flawchess/*` 301-redirects there).
This directory is the site root: it is deployed automatically by
`.github/workflows/pages.yml` on every push to `main` that touches `stories/**`.

DNS: `stories` CNAME `flawchess.github.io` in Cloudflare, **DNS-only (grey cloud)** —
GitHub provisions and renews the TLS certificate itself, which requires seeing the
CNAME directly; Pages is already a CDN, so proxying adds nothing. The custom domain
is set in the repo's Pages settings (`gh api repos/flawchess/flawchess/pages`), not
via a CNAME file (that mechanism is for branch-based builds, not workflow deploys).

## Layout

```
stories/
  index.html          # landing page listing all stories
  logo.png            # shared FlawChess logo (stories reference ../logo.png)
  two-pawns-up/       # one directory per story -> flawchess.github.io/flawchess/two-pawns-up/
    index.html        # self-contained page: inline CSS/JS, vanilla SVG charts, no CDNs
    two-pawns-up-report.md  # the technical report the story summarizes
```

## Adding a story

1. Create `stories/<slug>/index.html` (kebab-case slug; it becomes the URL).
   Keep it self-contained: inline styles/scripts, no external dependencies, and put
   the underlying numbers in the page (plus a `<details>` data table per chart).
2. Add a card for it in `stories/index.html`.
3. Co-locate the technical report it summarizes as `stories/<slug>/<slug>-report.md`
   and link it (GitHub blob URL) in the story footer.
4. Iterate locally by opening the file in a browser, then commit and push to `main` —
   the Pages workflow deploys it (~1 min). Check the run with `gh run list`.

Conventions: see `stories/CLAUDE.md` for the full ruleset (branding/header, publication
dates, terminology, chart styling, report co-location).
