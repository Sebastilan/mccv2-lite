# Third-Party Notices

MCC (mcc-lite) itself is MIT licensed (see `LICENSE`). The browser front end ships the following third-party files **unmodified**, exactly as released upstream. Every file below was checked byte-for-byte (2026-11-18) against the named upstream package. Full license texts are in `web/lib/LICENSE.txt` and `web/vendor/LICENSE.txt`.

| Library | Version | License | Files in this repo | Upstream |
|---|---|---|---|---|
| KaTeX | 0.16.11 | MIT | `web/lib/katex.min.js`, `katex.min.css`, `auto-render.min.js` | https://github.com/KaTeX/KaTeX (npm `katex`) |
| KaTeX fonts | 0.16.11 | MIT | `web/lib/fonts/` — **not in the repo**; copied from `node_modules/katex/dist/fonts` by `npm install` (postinstall) | npm `katex` |
| mermaid | 10.9.1 | MIT | `web/lib/mermaid.min.js` | https://github.com/mermaid-js/mermaid (npm `mermaid`) |
| marked | 4.3.0 | MIT | `web/lib/marked.min.js` | https://github.com/markedjs/marked (npm `marked`) |
| highlight.js | 11.9.0 | BSD-3-Clause | `web/lib/highlight.min.js` | https://github.com/highlightjs/highlight.js (npm `@highlightjs/cdn-assets`) |
| PDF.js | 3.11.174 | Apache-2.0 | `web/vendor/pdf.min.js`, `pdf.worker.min.js` | https://github.com/mozilla/pdf.js (npm `pdfjs-dist`) |
| SheetJS Community Edition | 0.20.3 | Apache-2.0 | `web/vendor/xlsx.full.min.js` | https://cdn.sheetjs.com/xlsx-0.20.3/ |
| mammoth | 1.8.0 | BSD-2-Clause | `web/vendor/mammoth.browser.min.js` | https://github.com/mwilliamson/mammoth.js (npm `mammoth`) |
| docx-preview | 0.3.5 | Apache-2.0 | `web/vendor/docx-preview.min.js` | https://github.com/VolodymyrBaydalka/docxjs (npm `docx-preview`) |
| JSZip | 3.10.1 | MIT or GPL-3.0 (dual), used under MIT | `web/vendor/jszip.min.js` | https://github.com/Stuk/jszip (npm `jszip`) |

Notes
- Minified bundles (notably mermaid and mammoth) contain their own bundled dependencies; those are distributed by upstream under the terms stated in each upstream package.
- Server-side npm dependencies (`better-sqlite3`, `esbuild`, `ws`, `katex`) are installed by `npm install` and are not vendored; their licenses come with them in `node_modules/`.