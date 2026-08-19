# scripts/

- `check-citations.mjs` — validates wiki lesson `<Cite>` usage against `references.json` (`npm run check:citations`).
- `check-vt-hrpp-links.mjs` — checks VT HRPP links in the IRB module (`npm run check:irb-links`).
- `generate-quant-data.mjs` — regenerates the synthetic CSVs in `public/templates/` for the quantitative module.
- `publish-slides.mjs` — copies a Slide Studio deck export into `public/slides/<slug>/`.

## Note on `public/templates/pm-research-tracker.xlsx`

This workbook is **hand-maintained** — edit it in Excel/Sheets and commit the file.
It was originally emitted by a `build-pm-template.mjs` generator, but the workbook
outgrew it (Dashboard tab, rolling `EDATE` month columns, `TODAY()` cells, threaded
comments), so the generator was retired in Aug 2026 rather than kept as a stale
second source of truth. If you change the workbook, also update the shared Google
Sheet ("make a copy" link in the project-management module) to match.
