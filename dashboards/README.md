# FlawChess Data Stories (GitHub Pages)

Public, interactive data stories published at **https://flawchess.github.io/flawchess/**.
This directory is the site root: it is deployed automatically by
`.github/workflows/pages.yml` on every push to `main` that touches `dashboards/**`.

## Layout

```
dashboards/
  index.html          # landing page listing all stories
  logo.png            # shared FlawChess logo (stories reference ../logo.png)
  two-pawns-up/       # one directory per story -> flawchess.github.io/flawchess/two-pawns-up/
    index.html        # self-contained page: inline CSS/JS, vanilla SVG charts, no CDNs
```

## Adding a story

1. Create `dashboards/<slug>/index.html` (kebab-case slug; it becomes the URL).
   Keep it self-contained: inline styles/scripts, no external dependencies, and put
   the underlying numbers in the page (plus a `<details>` data table per chart).
2. Add a card for it in `dashboards/index.html`.
3. Link the technical report it summarizes (usually under `reports/`) in its footer.
4. Iterate locally by opening the file in a browser, then commit and push to `main` —
   the Pages workflow deploys it (~1 min). Check the run with `gh run list`.

Conventions: FlawChess branding (brand brown `#8B5E3C`, cream background), plain-language
copy for a non-technical audience ("two pawns up", not "200 cp"), validated
colorblind-safe chart palettes, and a link back to the technical report for details.
