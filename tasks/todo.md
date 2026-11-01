# Fin Axis mockup — authoritative task checklist

Single source of task status. Stable IDs. Update only with observed evidence.
`npm run checkpoint` validates `docs/STATE.json` and fingerprints the sources; it does not
prove a check passed. Evidence paths live under `artifacts/`.

Status key: `[ ]` not done · `[x]` done with observed evidence · `[!]` blocked/partial (say why).

All items below are checked from the 2026-11-01 implementation and its recorded evidence.
The final full run is `artifacts/logs/m12-verify-final.txt` (exit 0).

## M01 — Environment, scaffold, continuation, plain shell

### M01.1 Inspect environment
- [x] Record OS, Node, npm, installed Playwright browser revisions.
- [x] Confirm the project root has no pre-existing `mockup/` work to preserve.
- **Acceptance:** `docs/ENVIRONMENT.md` contains observed values, not memory.
- **Evidence:** `docs/ENVIRONMENT.md`.

### M01.2 Scaffold and dependency lock
- [x] React/TS/Vite app, strict tsconfig, Vitest/Playwright separation.
- [x] Scripts: dev, typecheck, test, build, test:e2e, verify, checkpoint, seed:benchmark.
- [x] `package-lock.json` committed in the working tree.
- **Acceptance:** `npm ci`-compatible lock; `npm run typecheck` and `npm run build` exit 0.
- **Evidence:** `artifacts/logs/m12-verify-final.txt` (typecheck + build sections).

### M01.3 Continuation files and checkpoint script
- [x] AGENTS.md, CLAUDE.md, tasks/plan.md, tasks/todo.md, docs/STATE.json.
- [x] Dependency-free checkpoint validates STATE, fingerprints sources atomically, writes HANDOFF.
- [x] Re-run checkpoint after touching a source file; fingerprint changes.
- **Acceptance:** checkpoint exit 0; invalid STATE rejected; no hand-edited HANDOFF divergence.
- **Evidence:** `docs/STATE.json`, `HANDOFF.md`, `artifacts/logs/m12-verify-final.txt`.

### M01.4 Plain shell
- [x] Compact header with active company, demo actor, entitlements, saved/error state,
      persistent LOCAL DEMO · SYNTHETIC DATA label.
- [x] Nine MAIN destinations, hash navigation, deep links survive reload.
- [x] Accessible focus, labelled controls, no marketing landing page.
- **Acceptance:** browser start shows shell and nine destinations; deep link reload works.
- **Evidence:** `artifacts/screenshots/smoke-billing.png`, `tests/e2e/navigation.spec.ts`.

## M02 — Shared kernel, state/access, service invoice

### M02.1 Money/date/quantity/time helpers
- [x] Integer centavos parsing with explicit precision errors; half-up rounding at boundaries.
- [x] Quantity (milli-units), minutes, exact rational factors; date-only validation.
- **Acceptance:** rejection cases for bad precision, overflow, invalid dates; no float totals.
- **Evidence:** `tests/domain/money.test.ts`.

### M02.2 State, access, ledger
- [x] Schema-versioned `AppState`; Zod validation at storage/restore/import boundaries.
- [x] Workspaces A/B, named users, roles, entitlements, payroll-detail and archive grants.
- [x] Seeded demo COA, periods, opening journals (bank/equity 10,000), fixture policies.
- [x] Balanced journal posting, immutable posted entries, linked reversal.
- **Acceptance:** unbalanced/unknown-account/cross-workspace journals rejected; reversal balances.
- **Evidence:** `tests/domain/ledger.test.ts`, `tests/domain/access.test.ts`.

### M02.3 Command seam
- [x] Discriminated command union; typed success/rejection; unchanged snapshot on rejection.
- [x] Idempotency receipt: replay returns same result; changed payload is a typed conflict.
- [x] Independent source-effect key guard.
- **Acceptance:** G02 exactly: no duplicate on retry/new key; conflict on changed payload.
- **Evidence:** `tests/domain/commands.test.ts`.

### M02.4 Billing slice (service invoice)
- [x] Create/edit draft invoice with customer, dates, branch/department, description,
      quantity/rate, explicit tax treatment and account mapping.
- [x] Post creates balanced AR/revenue/tax journal once; locks financial fields.
- [x] List, detail, outstanding balance, source journal link, print with DEMO banner.
- [x] Browser flow persists after reload.
- **Acceptance:** G01, G13 numbers exact; invalid/closed posting rejected.
- **Evidence:** `tests/domain/billing.test.ts`, `artifacts/screenshots/billing-invoice-posted.png`.

## M03 — Receipts, allocation, credits, AR aging

- [x] Partial and multi-invoice receipts; unapplied excess tracked explicitly.
- [x] Credit note linked and posting under approved mapping.
- [x] Returned-payment/refund correction preserves settlement links and reversal history.
- [x] AR aging as of selected date; posted customer snapshot survives master edits.
- [x] Browser receipt flow with allocation.
- **Acceptance:** allocations cannot exceed invoice balance; excess → unapplied; aging ties out.
- **Evidence:** `tests/domain/billing-receipts.test.ts`, e2e billing flow.

## M04 — Purchases, disbursement, advances

- [x] PO → receipt/service acceptance → bill → RFP → approval → settlement with partials.
- [x] Non-PO expense bill; receipt-clearing policy for stock (GRNI); mismatch blocked.
- [x] Duplicate supplier invoice flag; material payment/beneficiary change invalidates approval.
- [x] Maker cannot self-approve; independent checker in seed.
- [x] Advance release → liquidation → unused return / excess reimbursement; aging.
- **Acceptance:** G03–G05 numbers exact; RFP creates no expense; no double recognition.
- **Evidence:** `tests/domain/purchases.test.ts`, `tests/domain/advances.test.ts`.

## M05 — Bank CSV import and reconciliation

- [x] Generic synthetic CSV template, file/preview, row errors, duplicate detection.
- [x] Explainable match suggestions (reference/date/amount), reviewed allocation.
- [x] Cash-in/out clearing; matched bank event clears control once; direct bank entries link only.
- [x] Undo with reason; linked reversal in open period; history preserved.
- [x] Amount mismatch and duplicate import demonstrated.
- **Acceptance:** G17: duplicate adds no effects, mismatch unresolved, undo reverses once.
- **Evidence:** `tests/domain/cash.test.ts`, `tests/e2e/cash.spec.ts` (in-app CSV template).

## M06 — Inventory standalone, valuation, controls

- [x] Items (one base unit), two locations, receipt/issue/transfer/source-linked returns/count.
- [x] Company-wide per-item moving weighted average pool; exact residual on full issue.
- [x] Negative location blocked; out-of-order valued movement rejected.
- [x] Return/count approval with reason; stock valuation and movement history.
- [x] Standalone data entry/export without Accounting; one owner per movement.
- **Acceptance:** G06/G07 numbers exact; conservation property test.
- **Evidence:** `tests/domain/inventory.test.ts`, `tests/e2e/inventory-assets.spec.ts`, `artifacts/screenshots/inventory-stock-valuation.png`.

## M07 — Payroll

- [x] Employees, versioned demo policies, approved-time CSV with disjoint buckets validation.
- [x] Semi-monthly run, calculation preview/errors, independent approval, protected register/payslip.
- [x] Native journal (salary/employer expense, net, deductions, liabilities), payment once.
- [x] Explicit hour basis/divisor, proration/rounding settings; missing settings block.
- [x] Extended: 13th month, annualization with prior employer, draft 2316 view/export,
      final-pay worksheet; all calculate/export.
- [x] Payroll-detail grant protects payslips and exports; summary omits identities.
- **Acceptance:** G08–G10b exact; RD/OT/ND/SH/LG combinations kept distinct; repeat post blocked.
- **Evidence:** `tests/domain/payroll.test.ts`, `tests/e2e/payroll.spec.ts`, `artifacts/screenshots/payroll-calculated.png`.

## M08 — Fixed assets

- [x] Required labels exactly: Company (vendor/brand), Purchase Date, Item Description,
      Supplier, Serial No., Account, Cost, Useful life for Year, Depreciation per month,
      Depreciation per day.
- [x] Explicit residual, depreciation start, month/day convention; missing policy surfaces.
- [x] Straight-line schedule, lapsing, carrying amount; approved monthly batch posts once.
- **Acceptance:** G11: 2,000 monthly, 66.67 daily display, posting not 30 × 66.67; repeat blocked.
- **Evidence:** `tests/domain/assets.test.ts`, `tests/e2e/inventory-assets.spec.ts`, `artifacts/screenshots/assets-depreciation-posted.png`.

## M09 — Reports and Other (journals, periods, tax)

- [x] Trial Balance beginning/transactions/ending with totals; Expense (per invoice/vendor,
      purchases vs reimbursement); Sales (per invoice/client); posted records, date filters.
- [x] Source drill-through, CSV export, print view.
- [x] Manual journal draft/approval/post/reversal; period close/reopen with reason/audit.
- [x] VAT/EWT/FWT transaction register, summaries, CSV; creditable vs final withholding distinct.
- [x] Form 2307 creditable certificate register with pending/missing state; forex future-scope note.
- **Acceptance:** G12/G14/G19 numbers exact; TB reconciles with journals; no extra report families.
- **Evidence:** `tests/domain/reports.test.ts`, `tests/domain/tax.test.ts`, `artifacts/screenshots/reports-trial-balance.png`.

## M10 — Entitlements, seats, standalone, cutover, onboarding

- [x] Role/data grants per module; named seats; headcount does not consume seats.
- [x] Expiry → read-only/export, writes blocked; unavailable product actions clearly unavailable.
- [x] Standalone Payroll/Inventory usable without Accounting entitlement or GL.
- [x] Accounting activation: cutover preview, COA mapping, opening reconciliation, approval,
      prospective posting; historical movement IDs retained; no replay.
- [x] Master/opening CSV onboarding: template download, preview, row errors, duplicate checks,
      balanced/reconciled totals, approval, atomic import.
- **Acceptance:** G15/G16; expired write rejected; cross-company injected IDs rejected.
- **Evidence:** `tests/domain/admin.test.ts`, `tests/e2e/admin.spec.ts`.

## M11 — Persistence, archive, maintenance

- [x] Reload survives valid edits; corrupt/unsupported schema → recovery screen, raw export,
      confirmed reset; no silent reseed.
- [x] Company-only JSON archive: manifest, canonical checksum, restore preview, sanity checks,
      authorized atomic restore with reason/audit.
- [x] Checksum mismatch/mixed-company rejected without changing state.
- [x] Maintenance window config + activation; normal writers blocked; authorized export/validate
      remains; completion recorded. Plaintext synthetic boundary documented.
- **Acceptance:** G18; archive round trip; ordinary admin cannot bypass payroll-detail archive scope.
- **Evidence:** `tests/domain/persistence.test.ts`, `tests/domain/archive.test.ts`.

## M12 — Browser acceptance, benchmark, review, docs

- [x] All nine destinations + deep-link/reload; no console/page errors.
- [x] Flows: invoice→receipt; bill→approval→settlement→bank; advance; inventory; payroll;
      asset; each report; tax register.
- [x] Maker/checker denied self-approval; payroll-detail denial; second-company denial;
      standalone; activation; expired read-only.
- [x] Reload after edit; failed import/restore intact; company archive export/restore;
      maintenance blocks writes.
- [x] Keyboard create/approve path; narrow viewport; labels/focus/tables.
- [x] Screenshots: billing/source journal, payment approval, stock valuation, payroll
      calculation, asset schedule, trial balance, maintenance/restore preview.
- [x] Benchmark 25 employees/100 items/300 invoices/300 bills/1,000 bank lines + isolation
      company; median/max timings vs 2 s / 30 s targets with method/environment.
- [x] Quality review; README, BUSINESS-RULES, DECISIONS, ACCEPTANCE, ENVIRONMENT, HANDOFF.
- [x] Final `npm run verify` on the final source fingerprint.
- **Acceptance:** all required evidence recorded; limitations honest; no fabricated pass.
- **Evidence:** `docs/ACCEPTANCE.md`, `artifacts/screenshots/`, `artifacts/benchmark/results.json`, `artifacts/logs/m12-verify-final.txt`, `HANDOFF.md`.

## R01–R08 — UI, navigation and numbering remediation

Contract: `../FIN-AXIS-UI-REMEDIATION-SPEC.md`. Historical M01–M12 evidence is preserved
above and is not evidence for remediation source.

### R01 Baseline and contract
- [x] Re-read AGENTS/CLAUDE/todo/plan/STATE/HANDOFF/BUSINESS-RULES, full spec, reviews,
      ERP research; recompute baseline fingerprint; record direction/code scope/migration.
- **Acceptance:** baseline evidence and limitations recorded before edits; no re-scaffold.

### R02 Typed routes and navigation seam
- [x] Home/app/page/record/action/query route union; legacy aliases; not-found state.
- [x] Reload, Back/Forward, filtered-list return; title/focus; skip link; router tests.
- **Acceptance:** nested routes and legacy links behave; unknown routes never open Billing.

### R03 Main launcher and compact shell
- [x] `#/home` nine app entries with honest availability; no permanent nine-app strip.
- [x] Compact header, one demo indicator, Demo controls disclosure, All apps switcher.
- **Acceptance:** desktop/mobile/keyboard/access states; Main is the default route.

### R04 Route existing work and drill-through
- [x] All route-map pages reachable with existing data/actions; record details.
- [x] Exact authorized journal/source links; filters/record context survive return.
- **Acceptance:** every module-map row usable; old financial flows still work.
- **Evidence:** typed app/page/record routes; Billing invoice and Purchases bill/advance detail
  routes; report source links use exact record IDs; `tests/app/router.test.ts`,
  `tests/e2e/navigation.spec.ts` Back/Forward + reload coverage.

### R05 Numbering and migration
- [x] One numbering registry/service; per-company/per-kind policies; safe allocation,
      preview, collision and exhaustion rules; privilege/audit/prospective change.
- [x] Schema v2 with pure deterministic v1→v2 migration and v1 archive route; preserve
      IDs, balances, historical codes, posted snapshots, source keys and idempotency.
- **Acceptance:** focused domain tests for examples, retries, concurrency-in-command,
      collisions, permissions, migration and archive preservation.
- **Evidence:** `src/domain/numbering.ts`, `src/domain/migration.ts`, schema v2, archive
  format v2 with legacy merge; `tests/domain/numbering.test.ts` (8),
  `tests/domain/archive.test.ts` and `tests/domain/persistence.test.ts` pass.

### R06 Numbering UI and generator coverage
- [x] Admin → Numbering configure/preview/errors/permission states.
- [x] All supported master/document create/import paths allocate through the service;
      standalone payroll/inventory series; company B independence; archive continuity.
- **Acceptance:** UI preview/create/reload; registry/path coverage; grants/archives tested.
- **Evidence:** `src/app/screens/AdminScreen.tsx` (25-kind table, kind selector, preview,
  prospective warning, read-only/inactive states, audit reason); conditional manual overrides
  for account/employee/location; `src/adapters/csv.ts` templates use current codes;
  `tests/e2e/numbering.spec.ts` (2 browser tests: GL0700 create/reload/A100 preserved;
  Company B E9000 vs Company A 5003 and read-only role); domain generator coverage in
  `tests/domain/numbering.test.ts`, `archive.test.ts`, `persistence.test.ts`.

### R07 Copy, accessibility and layout
- [x] Business-facing copy; Field ids/descriptions/invalid; error summary and focus.
- [x] Real links with `aria-current`; one outcome region; 390×844/200%/table containment.
- **Acceptance:** real-browser/keyboard evidence; before/after screenshots; no clipped
      essential controls.
- **Evidence:** `src/app/components.tsx` Field links hint/error via `aria-describedby` and sets
  `aria-invalid`; `forms.ts` uses domain date validation and focuses the first invalid field;
  toasts are in-flow and focus the error (`role="alert"`); routed links carry `aria-current`;
  unsaved inline drafts guarded (`navigation.tsx`); `tests/e2e/accessibility.spec.ts` (4 tests:
  field focus/linkage, contrast ≥ 4.5, 200% proxy 640×450 with contained table, draft
  Continue/Discard). Screenshots `remediation-*` regenerated by e2e.

### R08 Full verification and handoff
- [x] Current-source `npm run verify` and `npm run benchmark`; remediation screenshots.
- [x] README/BUSINESS-RULES/DECISIONS/ACCEPTANCE updated; fresh fingerprint/HANDOFF.
- **Evidence:** `artifacts/logs/r08-verify.txt` (exit 0; 19 test files / 134 tests; 36 browser
  tests; build warning only), `artifacts/logs/r08-benchmark.txt` and
  `artifacts/benchmark/results.json` (exit 0; all targets met), `artifacts/logs/r08-impeccable-detect.json`
  (2 accepted warnings documented in ACCEPTANCE), regenerated `remediation-*.png`; README,
  BR-29–BR-31, D-14–D-16 and the remediation acceptance section updated.
- **Acceptance:** actual results recorded; limitations honest; no fabricated pass.

### R09 Industrial Brutalist System Tokens Redesign, Jakob's Law ERP Ergonomics & Dash-Free Master Data Coding
- [x] 3-Layer Swiss Industrial Print / Archival Accounting Ledger token system (Primitive → Semantic → Component) in `src/styles.css`.
- [x] Eradicate `border-radius` (strict 90° geometry `0px`), atmospheric drop shadows (`3px 3px 0 var(--border-strong)` hard shadow), and gradients.
- [x] Anti-slop clean scan: eliminate `overused-font` (replace Inter with IBM Plex Sans / Archivo) and `border-accent-on-rounded` (rectangular inverted brutalist tabs). `impeccable detect` reports 0 findings.
- [x] Strict no-dash master data coding across Accounting, Core, Payroll, Inventory (`A100`, `C100`, `5000`, `I100`, `L100`, `FA100`, `B100`); validation rejects dashes in master kinds; fixed asset prefix updated to `FA` starting at 100 (`FA100`); inventory item SKUs updated (`W100`, `S200`, `B100`).
- [x] Jakob's Law ERP ergonomics: Fiori/Fusion/NetSuite/Eye-share dense accounting layout, tabular mono figures, crisp grid lines, clear module coding badges (`I100 · W100`, `B100`).
- **Evidence:** `artifacts/logs/r09-impeccable-detect.json` (0 warnings / 0 findings), `npm run typecheck` (exit 0), `npm test` (19 files / 135 tests exit 0), `npm run build` (exit 0), `npx playwright test` (36 tests exit 0), `npm run benchmark` (exit 0; all 5 targets met).
- **Acceptance:** Full verification passes with zero warnings, zero regressions, clean anti-slop scan, and verified continuation checkpoint.

## ECE01–ECE08 — ECE Accounting Scope Amendment

Contract: `../ECE-ACCOUNTING-SCOPE-AMENDMENT.md`, `../ECE-ACCOUNTING-TRIAL-BALANCE-FIXTURE.json`, `../ECE-ACCOUNTING-SOURCE-REPORT-REVIEW.md`. Historical M01–M12 and R01–R09 evidence is preserved above.

### ECE01 Baseline, scope and agent registration — Argon
- [x] Recompute baseline fingerprint (`02e88aa188cbde32c9d9306319e4c9f90bc583ba7e1952bfa6803c44abb5fbcc` over 93 files); inspect `agy models` (`gemini-3.8-flash-high` / `Gemini 3.8 Flash (High)`); register custom agents (`ece-ledger-source`, `ece-demo-refresh`, `ece-brand-report-ui`, `ece-independent-qa`); record file ownership and frozen contracts in `docs/ORCHESTRATION.json`.
- **Acceptance:** Baseline facts, resolved custom agents/models, and file ownership recorded before edits.
- **Evidence:** `docs/ORCHESTRATION.json`, `docs/STATE.json`.

### ECE02 Posting-source metadata/classifier/migration — `ece-ledger-source`
- [x] Enumerate all posting source types; add versioned five-book provenance contract (`sales`, `collections`, `purchases`, `cash_disbursements`, `journals`) to `schema.ts` and `ledger.ts`; preserve clearing target provenance in `cash.ts` and reversal chain provenance in `reverseJournal`; backfill legacy journals in `migration.ts` and surface unknown/broken provenance as provisional `journals` with review exception.
- **Acceptance:** All known source types mapped; reversal/clearing undo provenance preserved; focused unit tests pass.
- **Evidence:** `src/domain/schema.ts`, `src/domain/ledger.ts`, `src/domain/cash.ts`, `src/domain/migration.ts`, `tests/domain/ece-trial-balance-oracle.test.ts` (11/11 pass).

### ECE03 Source-book report query and oracle — `ece-ledger-source`
- [x] Implement five-book Trial Balance query/DTO and cell drill-through query in `queries.ts`; verify exact `ECE-ACCOUNTING-TRIAL-BALANCE-FIXTURE.json` oracle values, zero-net account visibility (`AP`), gross vs. net totals, cutoff before/after reversal, company isolation, and unknown provenance exceptions.
- **Acceptance:** Exact fixture oracle totals/row cells and date/isolation/drill-through tests pass.
- **Evidence:** `src/domain/queries.ts`, `tests/domain/ece-trial-balance-oracle.test.ts` (11/11 pass), `tests/domain/reports.test.ts` (3/3 pass).

### ECE04 Versioned data/numbering refresh and atomic reset — `ece-demo-refresh`
- [x] Build deterministic versioned connected synthetic dataset (`ece-accounting-demo-v1`) populating all 9 apps and all 5 source books via real command/numbering paths while keeping `createBaseSeedState()` for isolated domain/benchmark harnesses; fix `adapters/storage.ts:resetState` so replacement is validated in memory before a single atomic `setItem` (no delete-before-save or `localStorage.clear()`).
- **Acceptance:** Fixture manifest, numbering enforcement (`A100…`, `C100…`, `5000…`, `I100…`, `L100…`, `FA100…`, `B100…`), and reset/storage failure tests pass.
- **Evidence:** `src/fixtures/seed.ts` (`DEMO_FIXTURE_VERSION = 'ece-accounting-demo-v1'`, digest `10ca638b99fa5c8138cf86af0b9c9805`), `src/adapters/storage.ts`, `tests/domain/ece-demo-refresh.test.ts` (7/7 pass).

### ECE05 Product rename and active documentation — `ece-brand-report-ui`
- [x] Rename active product surfaces, shell wordmark/emblem (`ECE` / `ECE Accounting`), page titles, archive format/filenames (`ece-accounting-*` with legacy `fin-axis-company-archive` restore compatibility), CSV filenames, print headers, and active docs (`README.md`, `AGENTS.md`, `CLAUDE.md`, `docs/DESIGN.md`, `package.json`, `index.html`), while preserving `FA100` Fixed Asset codes and `fin-axis-mockup:app-state:v1` storage key compatibility.
- **Acceptance:** Active surfaces and docs reflect ECE Accounting; no financial-ID or `FA100` prefix rewrites.
- **Evidence:** `index.html`, `package.json`, `src/app/router.ts`, `src/domain/archive.ts`, `src/adapters/archive.ts`, module screens, `tests/app/router.test.ts` (7/7 pass), `tests/domain/archive.test.ts` (7/7 pass).

### ECE06 Report UI/CSV/print and refresh controls — `ece-brand-report-ui`
- [x] Replace Beginning/Transactions/Ending in `ReportsScreen.tsx` with the five-book Debit/Credit Trial Balance (`Sales Report`, `Collections`, `Purchases`, `Cash Disbursements`, `Journals`), `As of` date scope, book totals, gross totals, separate net balance reconciliation summary, cell drill-through dialog with source/journal links, 10-measure CSV export, and print header; add `Refresh demo data` with scope explanation and confirmation in `App.tsx` / `useApp.tsx`.
- **Acceptance:** Screen, CSV, and print consume one DTO with exact parity; `Refresh demo data` is discoverable and confirmed.
- **Evidence:** `src/app/screens/ReportsScreen.tsx`, `src/app/App.tsx`, `src/app/useApp.tsx` (`npm run typecheck` exit 0, `npm run build` exit 0).

### ECE07 Integration and actual demo refresh — Argon + assigned worker
- [x] Integrate shared files; refresh the actual accessible browser context via the app's `Refresh demo data` flow and record fixture version/hash, counts, timestamp, and browser context.
- **Acceptance:** All writers checkpointed; accessible browser refreshed and context recorded.
- **Evidence:** `artifacts/ece/demo-refresh-manifest.json`, `artifacts/screenshots/ece/ece-refresh-demo-confirm.png`, `tests/e2e/ece-accounting.spec.ts`.

### ECE08 Independent QA, fixes and final evidence — `ece-independent-qa` + owners
- [x] Run independent QA across oracle, financial regressions, atomic reset failure, code enforcement, company/role isolation, reversal/clearing provenance, drill-through, CSV/print, keyboard/mobile, full `npm run verify`, and `npm run benchmark`; capture fresh screenshots under `artifacts/screenshots/ece/` and evidence under `artifacts/ece/`; final checkpoint.
- **Acceptance:** All current-source checks, benchmark, and browser evidence pass with zero unresolved required items.
- **Evidence:** `artifacts/logs/ece-verify.txt` (exit 0; 21 Vitest files / 153 tests; 40 Playwright E2E tests), `artifacts/logs/ece-benchmark.txt` (exit 0; all 5 targets met), `artifacts/ece/qa-report.json`, `artifacts/screenshots/ece/*.png`.


## Incomplete / blocked register

| ID | Status | Reason | Exact blocker / next command |
|---|---|---|---|
| ECE12 | blocked verification | Local sockets, Chromium sandbox startup and tsx IPC denied | In a permitted terminal: `npm run verify` then `npm run benchmark` from `mockup/` |

## ECE09–ECE12 — owner review corrections

- [x] ECE09: Make numbering policies authoritative for all seven existing/new master kinds, with stored-state reconciliation, validated manual selection, safe counters and policy-change preview/audit. Preserve immutable IDs and posted financial snapshots.
- [x] ECE10: Add easy calendar-month selection/navigation; distinguish month-end cumulative from monthly activity and keep CSV/print/drill-through scope consistent.
- [x] ECE11: Correct exact source links, payroll-detail redaction, bank-clearing provenance and reset revision safety found during review; add focused regression tests.
- [!] ECE12: Run appropriate checks, record current-source results/limitations, update requirements/docs and generate a truthful handoff.

ECE09–ECE11 evidence: `artifacts/logs/review-final-verify.txt` (TypeScript, 24 domain files / 169 tests, build pass). ECE12 overall `verify` exits 1 at webServer startup; current browser/benchmark acceptance remains pending. See `../../ECE-ACCOUNTING-POST-EXECUTION-REVIEW.md`.


## PAGES01 — GitHub Pages preparation

- [x] Relative asset base; standalone oracle fixture; GitHub Actions workflow checks `npm run verify` before uploading only `dist/`; root and repository walkthroughs. No repository initialization or publishing performed.
- [x] Current TypeScript, 24 domain files / 169 tests, and build passed; YAML/asset/fixture checks passed (`artifacts/logs/pages-preparation-results.json`, `artifacts/logs/pages-workflow-check.txt`).
- [ ] Actual GitHub workflow run, deployed URL and hosted repository-path smoke checks. Follow `docs/GITHUB-PAGES.md`. ECE12 browser/benchmark acceptance remains pending.
