# The Expense Tracker

A private expense tracker that runs entirely in your browser. Import CSV files from
your bank and cards, sort transactions into your own categories, and see real monthly
totals and averages. The app never sends your data anywhere: there's no server, no
account, and no tracking.

## Privacy

- The app's code contains no way to send data: no uploads, no analytics, no requests
  to other sites.
- On top of that, the page carries a Content-Security-Policy (top of `index.html`) that
  tells the browser to block every kind of connection a page can open (fetch, XHR,
  WebSocket, beacons, images, fonts, frames, forms, workers). It also turns on Trusted
  Types and refuses to run inside another site's frame. Direct peer-to-peer connections
  (WebRTC) are switched off at startup, because a policy in the page itself can't block
  them, nor can it stop the page from navigating away. The app does neither.
- The app saves data only in this browser. A backup file holds everything and isn't
  password-protected, so keep it somewhere safe, like a bank statement.
- Fonts and libraries are stored in this repository. The page loads nothing from
  Google, a CDN, or any other site.
- To check for yourself: open the app, press F12, choose the Network tab, and use the
  app. Every request listed comes from the app's own address.

## Where data lives

- Everything is saved in the browser's IndexedDB storage for this site's address.
  Keep the address the same, or saved data won't follow.
- Host the app on an address it doesn't share with any other site. Browsers let every
  page on the same address read each other's saved data, and all of a GitHub user's
  `username.github.io/...` sites share one address. So publish it from its own GitHub
  account or organization (as `name.github.io`), or on its own domain or subdomain.
- Updating the code never touches saved data. Record shapes carry a version number;
  upgrades for older data go in `js/migrations.js`, and storage layout changes go in
  `js/db.js`. Both only ever get new steps appended.
- "Save backup" saves an Excel file: a Report sheet per year and every transaction, plus
  a hidden, checksummed copy of everything. "Restore from backup" reads only that hidden
  copy and checks it completely before replacing anything, so edits made in Excel are
  never restored. Older .json backups still restore.

## Publishing

`node tools/build-site.mjs site` copies only what the app needs (no tests, tools, or
demo data) into `site/`; that folder's contents are what gets published.

## Project layout

| Path | What it holds |
| --- | --- |
| `index.html` | The page and its network lock |
| `tour.html`, `css/tour.css`, `media/` | The 2-minute tour video and its page (no scripts; it may only load its own files) |
| `css/app.css` | Styles, built on the Marigold palette |
| `js/app.js` | Start-up and the page shell |
| `js/model.js` | Record shapes, validation, money and date helpers |
| `js/db.js` | IndexedDB access and storage layout steps |
| `js/store.js` | In-memory data, written through to storage |
| `js/migrations.js` | Upgrades for older data and backups |
| `js/backup.js` | Backup files |
| `js/protection.js` | Network lock check, persistent storage, private-window hint |
| `js/csv.js` | Reads CSV files and recognizes bank column layouts |
| `js/vendors.js` | Cleans vendor names, memos, and check numbers |
| `js/locations.js`, `js/cities-data.js` | Finds city and state; the US city list ships with the app |
| `js/dedupe.js` | Recognizes transactions that are already saved |
| `js/hints.js` | Card-payment and transfer matching between accounts |
| `js/importer.js` | Import flow, accounts, duplicate review, vendor renames |
| `js/import-ui.js`, `js/accounts-ui.js`, `js/dom.js` | Import and accounts screens |
| `js/sorting-ui.js` | The sorting page: inbox bars, year tabs, search, sort, selection, category grid, drag-and-drop, open boxes, Edit Categories |
| `js/sorting-actions.js` | Moving (with undo), splits, "Counts toward", and category edits, reorder, and delete |
| `js/move-menu.js` | The "Move to…" menu: type to filter, arrow keys, Enter |
| `js/report-data.js` | The Report's arithmetic: monthly totals, averages (including yearly and twice-a-year costs), months covered by imports, flags, and the "Is it paid twice a year?" question |
| `js/report-ui.js` | The Report page: the table by category or vendor, notices, flags, and the drawer that shows the transactions behind any number |
| `js/excel.js` | The backup file: an Excel workbook with a Report sheet per year, every transaction, and a hidden, checksummed copy of everything for restoring |
| `js/xlsx-read.js` | Reads that hidden copy back using only the browser's built-in unzip and XML tools, so files re-saved by Excel or other programs still restore |
| `js/categories.js` | Creating categories, starter suggestions, counts per year |
| `js/demo.js` | Invented demo data for the preview build only (not published) |
| `vendor/` | ExcelJS (for the export stage) and the city list's license |
| `fonts/` | Hanken Grotesk, with its license |
| `tests/` | Browser tests (`python3 tests/stage1_test.py`; stages 2 to 6 need `CHECKING_CSV` and `CARD_CSV` pointing at real exports, which are never stored here). `tests/fixtures/` holds invented files in other banks' formats. `node tests/report_math_test.mjs` checks the report's arithmetic on edge cases. |
| `tools/build-preview.mjs` | Builds a one-file preview for Claude's preview window |
| `tools/tour/` | Re-records the tour video from the demo files: `record.py` drives the published build, `cards.py` draws the captions, `retime.py` speeds up chosen stretches, `narrate.py` voices `script.json` (pronunciation fixes in `fixes.json`), `sync.py` fits the recording to the narration, `encode_vo.sh` mixes in the music ("Disco Sunday", Audio Library Plus) and assembles `media/tour.mp4` (paths inside point at a scratch folder) |

## Publishing

Upload the repository to GitHub and turn on Pages (Settings → Pages → deploy from the
main branch). Open the site in Chrome, Edge, or Firefox and bookmark it.
