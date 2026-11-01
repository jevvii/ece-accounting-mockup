# Decisions

Short records of implementation choices, synthetic fixture policy, and choices still open for
production. "Implemented" means it exists in this mockup and has a test; it does not mean it is
approved for live use.

## Implemented mockup choices

### D-01 — One snapshot and one command seam

**Decision:** `AppState` is a schema-versioned plain object. `executeCommand(state, envelope, clock)`
is the only write path; success returns a new snapshot and result, rejection returns a typed
error and leaves the original object untouched. Screens never mutate state.

**Reason:** Makes audit, idempotency, atomic failure and cross-company checks enforceable in one
place. Tests can exercise the production seam without React.

**Affected:** `src/domain/commands.ts`, all domain modules, `tests/domain/commands.test.ts`.

### D-02 — Zod at persistence, import and restore boundaries

**Decision:** `parseAppState` validates the complete snapshot on load, import and restore.
Schema version 1 is explicit; unsupported versions are reported, not migrated by guesswork.

**Reason:** Browser storage is untrusted input. Silent coercion would corrupt balances.

**Affected:** `src/domain/schema.ts`, `src/adapters/storage.ts`, `tests/domain/persistence.test.ts`.

### D-03 — Integer arithmetic and explicit rounding

**Decision:** Centavos, milli-units, minutes and basis points are integers. Half-up rounding is
performed only when a calculator/posting boundary requires it. Display formatting does not
feed calculations. Transient `BigInt` is allowed inside helpers; persisted state stays JSON.

**Reason:** Avoid float drift and make golden values reproducible.

**Affected:** `src/domain/shared/money.ts`, `tests/domain/money.test.ts`, G07/G11.

### D-04 — Two duplicate guards

**Decision:** Keep a request-key receipt (`workspaceId:idempotencyKey` + payload hash) and a
business source-effect map (`workspaceId:effectKey`). A retry returns the stored result; a
changed payload with the same key conflicts; a new key cannot repeat an existing effect.

**Reason:** A UI retry, a second tab and a business action are different risks. One guard does
not cover both.

**Affected:** `executeCommand`, `ledger.effectRecordKey`, `tests/domain/commands.test.ts`, G02.

### D-05 — Immutable posted records with linked corrections

**Decision:** Posted invoices, journals, payroll runs and depreciation posts are not edited.
Corrections are reversal, credit-note, refund, return or adjustment documents linked to the
original. Reversals must fall in an open period and carry a reason.

**Reason:** Preserves an auditable trail and makes period controls meaningful.

**Affected:** `ledger.reverseJournal`, `billing.reverseInvoice`, `payroll.reversePayroll`,
`tests/domain/ledger.test.ts`, G14.

### D-06 — Workspace is the legal company

**Decision:** The `Company` label on fixed assets means the acquisition vendor/brand. Asset
ownership is the workspace. Every query filters by workspace; commands require an active
membership in the selected workspace.

**Reason:** Avoids the common accounting-UI ambiguity between a vendor brand and a tenant.

**Affected:** `src/domain/shared/access.ts`, `src/app/screens/AssetsScreen.tsx`, G15.

### D-07 — Explicit grants for payroll detail and archive export

**Decision:** Payroll-detail and archive access are separate booleans on the membership, not
implied by company admin or accountant roles. Archive export also requires payroll-detail when
the company has payroll data.

**Reason:** A company administrator is not automatically entitled to payslips or to an archive
containing them. This is a data-minimisation boundary.

**Affected:** `payroll.payrollDetailVisible`, `archive.canExportCompanyArchive`,
`tests/domain/access.test.ts`, `tests/domain/archive.test.ts`.

### D-08 — Native dialogs and hash routing

**Decision:** Use native `<dialog>` for forms and confirmations, and a small hash router for the
nine MAIN destinations. No router or state library.

**Reason:** Keeps dependencies and abstraction low, preserves deep links across reloads, and
gets focus trapping/Escape behaviour from the browser.

**Affected:** `src/app/App.tsx`, `src/app/router.ts`, `src/app/components.tsx`.

### D-09 — Save before commit; one write tab

**Decision:** A command result is committed to visible state only after the storage adapter
accepts it. A failed write keeps the previous screen state and reports failure. Storage events
from another tab set a reload-required banner that blocks writes.

**Reason:** localStorage is not transactional and cannot support concurrent writers. The mockup
must not pretend it is a multiuser database.

**Affected:** `src/app/useApp.tsx`, `src/adapters/storage.ts`, `tests/domain/persistence.test.ts`.

### D-10 — Company-only archive with canonical checksum

**Decision:** The archive builder collects only workspace-scoped collections, serialises a
canonical signing body and hashes it with SHA-256. Restore validates schema, checksum, workspace
and record ownership, then merges only that workspace atomically.

**Reason:** Gives a real integrity check without a backend or encryption claim.

**Affected:** `src/domain/archive.ts`, `tests/domain/archive.test.ts`, admin e2e.

### D-11 — Deterministic demo seed and benchmark fixture

**Decision:** The seed is fixed (Company A/B, users, accounts, policies). The benchmark fixture is
created only through `executeCommand` from that seed and revalidated with `parseAppState`. The
generator writes a manifest with counts and a checksum.

**Reason:** Prevents impossible master/transaction rows and makes timings reproducible.

**Affected:** `src/fixtures/seed.ts`, `scripts/seed-benchmark.ts`, `benchmark/benchmark.spec.ts`.

### D-12 — Benchmark is opt-in and explicitly single-operator

**Decision:** `benchmark/` is outside the default Playwright discovery. It measures ordinary
list/detail against 2,000 ms and report/payroll calculation against 30,000 ms, records median and
maximum, and states that it is not a five-user concurrency test.

**Reason:** The dataset is large enough to slow routine test runs, and a local browser timing is
not a production service-level claim.

**Affected:** `playwright.benchmark.config.ts`, `artifacts/benchmark/results.json`.

### D-13 — Dependency-free checkpoint

**Decision:** `scripts/checkpoint.mjs` validates the essential STATE shape, hashes source/config/
lock/test/fixture files, writes STATE via temporary file + rename, and regenerates `HANDOFF.md`.

**Reason:** Continuation must survive context loss without an orchestration dependency. The
fingerprint records coverage, not test success.

**Affected:** `scripts/checkpoint.mjs`, `docs/STATE.json`, `HANDOFF.md`.

### D-14 — Numbering is a domain service with per-company policies

**Decision:** A single `domain/numbering.ts` registry owns prefixes, counters, padding and
allocation for 25 record kinds. Policies live in the snapshot per workspace and kind; codes are
allocated inside the same command draft as the record. Manual codes are allowed only when the
policy enables an override for that kind. Policy edits require a role, a reason, an audit event
and a version bump; they are prospective.

**Reason:** Document generation previously used ad-hoc counts. One service prevents duplicate
or racing counters, keeps company scopes separate, and keeps historical codes stable while
public numbering becomes configurable.

**Affected:** `src/domain/numbering.ts`, `src/domain/migration.ts`, `src/domain/schema.ts`, all
create/import/posting domain modules, Admin numbering UI, `tests/domain/numbering.test.ts`,
`tests/e2e/numbering.spec.ts`.

### D-15 — Schema v2 keeps the storage key and migrates in place

**Decision:** The localStorage key remains `fin-axis-mockup:app-state:v1`; the snapshot's
`schemaVersion` is 2. Loading version 1 clones the raw object, builds policies, backfills only
missing public numbers in stable ID order, validates the candidate and only then writes it.
Company archives carry `formatVersion: 2`, and legacy version-1 archives pass through the same
migration before merge.

**Reason:** Renaming the key would strand existing browser snapshots. A pure, deterministic
migration preserves IDs, balances, posted codes and source effects while adding numbering
without a global renumber. Raw data is exported rather than replaced on failure.

**Affected:** `src/domain/migration.ts`, `src/adapters/storage.ts`, `src/domain/archive.ts`,
`tests/domain/persistence.test.ts`, `tests/domain/archive.test.ts`.

### D-16 — Routed pages, not ARIA tabs

**Decision:** App pages are real hash links with `aria-current="page"`; local ARIA tab widgets
are not used for routed work. Main is the launcher, and All apps is an on-demand menu. Inline
drafts are guarded by a shared Continue editing / Discard flow.

**Reason:** Native links preserve reload, Back/Forward, deep links and keyboard behavior
without reimplementing a tab contract.

**Affected:** `src/app/router.ts`, `src/app/navigation.tsx`, `src/app/App.tsx`, screen page
navigation.

### D-021 — 3-Layer Swiss Industrial Print / Archival Accounting Ledger token system and strict dash-free master data coding

**Decision:**
1. CSS architecture adopts a strict 3-Layer design token model: Primitive (`--primitive-ink-*`, `--primitive-paper-*`, `--primitive-navy-*`, `--primitive-emerald-*`, `--primitive-ochre-*`, `--primitive-crimson-*`, typography hairlines) → Semantic (`--bg-canvas`, `--bg-surface`, `--text-main`, `--border-*`, `--accent-*`, `--ok-*`, `--warn-*`, `--danger-*`, `--radius: 0px`) → Component (`--shell-*`, `--panel-*`, `--table-*`, `--tab-*`, `--badge-*`).
2. Typography eradicates generic overused sans fonts (Inter removed) in favor of high-legibility enterprise grotesk and tabular numerals (`IBM Plex Sans`, `Archivo`, `IBM Plex Mono`).
3. Geometry strictly enforces brutalist archival accounting ledger ergonomics: 0px radius on all controls/panels/modals/badges, heavy framing rules, hard 3px drop shadows for floating modals/drawers (`3px 3px 0 var(--border-strong)`), zero blurred gradients.
4. Master data coding across all modules strictly forbids dashes between initial letter and sequential numbers (`A100`, `C100`, `5000`, `I100`, `L100`, `FA100`, `B100`). Fixed assets standardise on `FA100` (`prefix: 'FA'`, `startNumber: 100`, `minDigits: 0`). Validation in `domain/numbering.ts` rejects any dash (`-`) or underscore (`_`) in master data prefixes. Seed SKUs updated to `W100`, `S200`, `B100`.

**Reason:** ERP users in accounting, billing, and inventory require high information density, unambiguous glyph distinctions, rapid numerical scanability, and standard dash-free identifier codes aligned with SAP/NetSuite/Fiori conventions and physical voucher stamp aesthetics. Eliminates anti-slop detector findings (`overused-font`, `border-accent-on-rounded`).

**Affected:** `src/styles.css`, `src/domain/numbering.ts`, `src/fixtures/seed.ts`, `src/domain/queries.ts`, `src/app/screens/InventoryScreen.tsx`, `src/app/screens/CashScreen.tsx`, `docs/DESIGN.md`, `tests/domain/assets.test.ts`, `tests/domain/numbering.test.ts`, `tests/e2e/inventory-assets.spec.ts`, `tests/e2e/keyboard.spec.ts`.

### D-022 — Product rename to ECE Accounting with backward-compatible storage and archive keys

**Decision:** Active application surfaces, document titles, brand emblem (`ECE`), print headers, CSV export filenames (`ece-accounting-*`), and company archive envelopes (`ece-accounting-company-archive`) use the product name **ECE Accounting**. Fixed Asset master codes remain `FA100` (`FA` = Fixed Asset), the localStorage key remains `fin-axis-mockup:app-state:v1`, and company archive restore accepts both `ece-accounting-company-archive` and legacy `fin-axis-company-archive`.

**Reason:** Fulfils the owner's ECE Accounting product rename while preserving existing browser snapshots, Fixed Asset numbering conventions, and historical company archives.

**Affected:** `index.html`, `package.json`, `src/app/App.tsx`, `src/app/router.ts`, `src/domain/archive.ts`, `src/domain/commands.ts`, `src/adapters/archive.ts`, module screens, `README.md`, `AGENTS.md`, `CLAUDE.md`, `docs/DESIGN.md`.

### D-023 — Whole-journal five-book source provenance and Trial Balance by source book

**Decision:** Each posted journal carries versioned `sourceProvenance` assigning the whole balanced journal to one of five books (`sales`, `collections`, `purchases`, `cash_disbursements`, `journals`). Generic reversals (`journal_reversal`, `bank_clearing_undo`) inherit the root original journal's book via `reversalOf` traversal. Inventory valuation movements, opening balances, payroll accruals, depreciation, and compound advance liquidations remain whole in `journals`. Legacy unknown or broken provenance is classified into `journals` with `provisional: true` and surfaced in `classificationExceptions`. The Trial Balance displays the five source Debit/Credit groups (10 money columns) plus a separate net closing balance reconciliation strip and interactive cell drill-through.

**Reason:** Ensures every source book column group is independently balanced (`Debit === Credit`) without splitting compound journals across books or silently dropping legacy entries.

**Affected:** `src/domain/schema.ts`, `src/domain/ledger.ts`, `src/domain/cash.ts`, `src/domain/migration.ts`, `src/domain/queries.ts`, `src/app/screens/ReportsScreen.tsx`, `tests/domain/ece-trial-balance-oracle.test.ts`, `tests/e2e/ece-accounting.spec.ts`.

### D-024 — Connected synthetic demo dataset (`ece-accounting-demo-v1`) and atomic validate-before-save reset

**Decision:** `src/fixtures/seed.ts` separates `createBaseSeedState()` (clean base seed for isolated domain unit tests and the 1,000-bank-row benchmark) from `createSeedState()` (`DEMO_FIXTURE_VERSION = 'ece-accounting-demo-v1'`, deterministic connected dataset built through `executeCommand` across all 9 apps and all 5 source books, digest `10ca638b99fa5c8138cf86af0b9c9805`). `resetState` in `src/adapters/storage.ts` validates the candidate snapshot in memory (`validateStateSnapshot`) before executing a single atomic `storage.setItem(STORAGE_KEY, payload)` call, never calling `removeItem` before `setItem` or `localStorage.clear()`.

**Reason:** Demonstrates realistic connected transactions and dash-free master conventions immediately on load or refresh, while guaranteeing that storage quota or validation failures never wipe the user's prior snapshot or unrelated host keys.

**Affected:** `src/fixtures/seed.ts`, `src/adapters/storage.ts`, `src/app/useApp.tsx`, `src/app/App.tsx`, `scripts/seed-benchmark.ts`, `tests/domain/harness.ts`, `tests/domain/ece-demo-refresh.test.ts`, `tests/e2e/ece-accounting.spec.ts`.


## Synthetic fixture policies (not law)

- The 12% VAT profile is a wiring fixture, not a statement that a transaction is VAT-able.
- The time matrix and premium percentages are demo inputs; they are not verified against the
  current Labor Code, DOLE issuances or company policy.
- The annual tax schedule (zero through PHP 100,000, then 10% of excess) and deduction
  schedules are invented fixtures.
- The 13th-month divisor/eligibility inputs are explicit; no statutory entitlement is inferred.
- Company B's opening value, cutover date and payroll expiry are synthetic scenario data.
- No BIR form, certificate number or official invoice is claimed to be valid.

## Still-open production decisions

These are intentionally not implemented and would require owner/accountant/legal decisions:

1. Production identity, MFA, session management and server-side authorization.
2. Real tenant isolation and hosted transactional storage; concurrency and conflict policy.
3. Encrypted database/object backups, key management, restore drills and customer delivery.
4. Live bank feeds/templates, statement matching policy and reconciliation approvals.
5. Current statutory payroll/tax tables, rounding policy by jurisdiction, and effective dates.
6. BIR/provider duties, official invoice/certificate issuance, filing and certification.
7. Production retention/legal hold, audit export and privacy/data-subject workflows.
8. Specialized industry workflows, multi-currency/forex, and consolidation.
9. Production support, monitoring, incident response, cost and service-level commitments.
10. Accountant sign-off of the demo policies and acceptance of the mockup's limitations.

## Unresolved conflicts

No direct conflict between the approved product baseline and this smaller mockup was found.
The mockup deliberately omits production controls rather than faking them.

## Owner review: policy-authoritative masters and monthly reports

The owner explicitly supersedes the earlier prospective-only rule for **master** public codes. Active company/kind policy controls current master labels and new allocations. Load/restore reconciliation preserves valid reservations and deterministically replaces nonconforming/duplicate labels. An approved prefix/start/padding/increment change rebases the selected current master collection in stable record order. Reconciliation aligns the counter to the increment grid, and preserves immutable IDs, issued-document numbers, posted financial snapshots and external references. Loading saved legacy data persists the repaired candidate; it does not reset transactions. Authorized policy saves preview/apply current master changes and audit the mapping. Document numbering remains prospective. Imported/restored/current fixtures are reconciled through the same service.

Trial Balance now defaults to a calendar month picker and cumulative month-end mode, with previous/next/current-month shortcuts and a separate Monthly activity mode. Activity source columns exclude earlier journals, while Net Closing display/export uses cumulative closing totals. Custom As-of/range remain available. Month/date calculations are shared pure functions and the same scope drives screen/CSV/print/drill-through.

Review corrections also cover explicit payroll-detail grants including inherited reversals, exact supported source/journal links, bank-clearing target identity (including recoverable legacy audit provenance), company-scoped editor remounting and monotonic reset revisions. No financial amounts or posting dates were rewritten. Legacy clearing target identity without any scoped source/audit evidence cannot be invented; preserve its known book and surface/reference the available exact journal.


### GitHub Pages preparation — standalone repository

Publish only the contents of `mockup/` as a separate repository. Relative Vite asset paths and existing hash routes support repository URLs without server rewrites. The independent accounting oracle is copied byte-for-byte to `tests/fixtures/trial-balance-oracle.json` so checks no longer depend on the parent workbook project; changes to that oracle must keep its parent research copy consistent when both are present. The prepared workflow verifies before deploying `dist/`. Public/private repository choice and actual publication remain user actions; no deployment is claimed. Instructions are in `docs/GITHUB-PAGES.md`.
