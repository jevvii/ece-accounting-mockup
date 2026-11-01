# Fin Axis mockup — implementation plan

## Overview

A React + TypeScript + Vite single-page mockup of a Philippine accounting hub with
independently usable Payroll and Inventory. Browser-local, synthetic data, plain UI.
The domain core is pure and synchronous; every write passes through one typed command
seam. The build follows the owner-approved prompt `../FIN-AXIS-MOCKUP-CLAUDE-PROMPT.md`.

## Status

Implemented and verified on 2026-11-01. `npm run verify` exited 0 with 115 domain/integration
tests and 26 browser tests. The opt-in benchmark passed all targets. See
`docs/ACCEPTANCE.md`, `artifacts/benchmark/results.json` and `HANDOFF.md`.

## Architecture decisions

1. **One snapshot, one command seam.** `AppState` is a schema-versioned plain object.
   `executeCommand(snapshot, envelope, clock)` returns a typed success (next snapshot +
   result) or rejection with the original snapshot untouched. All screens use it.
2. **Domain modules own their rules.** `ledger`, `billing`, `purchases`, `cash`,
   `inventory`, `payroll`, `assets`, `admin`, `reports`; shared money/date/result/access
   helpers live in `shared/`. No React, DOM or storage inside `domain/`.
3. **Integer arithmetic only.** Centavos, milli-units, minutes and rational multipliers.
   Half-up rounding only at named calculation/posting boundaries. Transient BigInt is
   allowed in helpers; JSON state stays number/string.
4. **Two duplicate guards.** Request-key idempotency receipts plus business source-effect
   keys. Both are tested (G02, G11 repeat post, payroll repeat posting, CSV re-import).
5. **One persistence adapter.** localStorage with Zod validation, corrupt-state recovery
   screen, raw-data export, confirmed reset, storage-event detection for second tabs.
   Commands persist the whole next candidate; a failed write keeps visible state unchanged.
6. **Explicit authorization data.** Named users, workspace memberships, combinable roles,
   product entitlements, a separate payroll-detail grant and a privileged archive grant.
   Queries filter by workspace and scope. This is simulation, not authentication.
7. **Synthetic fixture policies.** Effective-dated, versioned, labelled
   `DEMO … NOT VERIFIED CURRENT STATUTORY RATES`. Golden cases are encoded as independent
   expected numbers in tests, not derived from the implementation.
8. **Continuation is a feature.** `docs/STATE.json`, `tasks/todo.md`, a dependency-free
   checkpoint script and generated `HANDOFF.md`; every slice checkpoints before/after.

## Dependency order

```text
M01 scaffold + checkpoint + shell
 └─ M02 shared kernel, state/access, ledger, service invoice (G01/G02/G13)
     ├─ M03 receipts/credits/AR aging
     ├─ M04 purchases/RFP/advances (G03–G05)
     ├─ M05 bank CSV import/reconciliation (G17)
     ├─ M06 inventory standalone/valuation (G06/G07)
     ├─ M07 payroll (G08–G10b)
     ├─ M08 fixed assets (G11)
     └─ M09 reports/Other journals/tax (G12/G14/G19)
         └─ M10 entitlements/cutover/onboarding (G15/G16)
             └─ M11 persistence/archive/maintenance (G18)
                 └─ M12 browser acceptance, benchmark, review, docs
```

M02 establishes the shared validation/access/persistence invariants that later slices
reuse. M10/M11 finish broader workflows rather than postponing those invariants.

## Task list

### Phase 1 — Foundation
- [x] M01.1 Inspect environment; record Node/npm/OS/browser facts.
- [x] M01.2 Scaffold package/config/scripts and lock dependencies.
- [x] M01.3 Create continuation files and dependency-free checkpoint script.
- [x] M01.4 Plain app shell, navigation, header, demo label.

### Checkpoint: Foundation
- [x] App starts; typecheck/build pass; checkpoint round-trips STATE/HANDOFF.

### Phase 2 — Core finance
- [x] M02.1 Shared money/date/result/rational helpers + tests.
- [x] M02.2 State schema, demo seed (A/B), access model, ledger posting/reversal.
- [x] M02.3 Command seam with idempotency + source-effect guards.
- [x] M02.4 Billing slice: draft → post → journal, list/detail/print; G01/G02/G13.
- [x] M03 Receipts, partial/multi allocation, unapplied excess, credit/refund, AR aging.
- [x] M04 Purchases: PO/receipt/bill/RFP/payment clearing, duplicate checks, advances.
- [x] M05 Bank CSV import, suggestions, matching/clearing, reconciliation undo.
- [x] M06 Inventory: items, locations, receipt/issue/transfer/return/count, valuation.
- [x] M07 Payroll: policies, time CSV, run/preview/approve/post, payslips, worksheets.
- [x] M08 Fixed assets: register, straight-line schedule, monthly batch, approval/post.
- [x] M09 Reports (TB/Expense/Sales), Other journals/periods, VAT/EWT/FWT, 2307.
- [x] M10 Entitlements/seats, standalone behaviour, activation/cutover, CSV onboarding.
- [x] M11 Persistence recovery, company archive/restore, maintenance mode.
- [x] M12 Browser acceptance, benchmark measurement, quality review, docs, handoff.

## Remediation phase — R01–R08 (owner-authorized 2026-11-01)

Authoritative contract: `../FIN-AXIS-UI-REMEDIATION-SPEC.md`, with independent reviews
`../FIN-AXIS-UI-REVIEW-VISUAL.md` and `../FIN-AXIS-UI-REVIEW-TECHNICAL.md`, and
`../FIN-AXIS-ERP-UX-RESEARCH.md`. M01–M12 remain historically complete at fingerprint
`6413ff02b2ea2ee0044bc4e240ffc0487111958d733006cbdcaa58085100ad89`; that baseline is not
evidence for changed source.

Direction recorded at R01: Operate mode, **Main → app work area → filtered worklist →
record/action**. Plain compact forms/tables, native controls, no decorative dashboard or
new UI kit. Business codes are public display/search fields; immutable internal IDs remain
the only relationship keys. Numbering changes are prospective and audited.

Dependency order:

```text
R01 baseline + direction + migration contract
 └─ R02 typed Home/app/task/record routes + navigation seam
     ├─ R03 Main launcher + compact shared/module shell
     ├─ R04 route existing work + exact source drill-through
     └─ R05 numbering service + schema v1→v2 migration
         ├─ R06 Admin Numbering + create/import/generator coverage
         └─ R07 copy/Field/error/focus/table/narrow cleanup
             └─ R08 full regression, benchmark, independent review, handoff
```

Slice contract: before each R edit update `docs/STATE.json`; run the focused check; record
the observed result; run `npm run checkpoint`. Do not weaken original financial assertions.
Old browser passes do not verify new source.

### R01 — Baseline and contract
- Re-read AGENTS/CLAUDE/todo/plan/STATE/HANDOFF/BUSINESS-RULES, the full remediation spec,
  both reviews and ERP research.
- Records: baseline fingerprint, current checks/limitations, selected direction, code scope,
  migration contract. No re-scaffold.

### R02 — Routes and navigation seam
- Typed route union/registry: Home, app/page, record ID, action and query; legacy module
  aliases; clear not-found state; no silent Billing fallback.
- URL-backed page/record/filter state; Back/Forward/reload; title and focus on committed
  page change; skip link does not route.

### R03 — Main launcher and compact shell
- `#/home` with nine uniform app entries, honest availability, compact shared header,
  one synthetic-demo indicator, Demo controls disclosure, All apps switcher, no permanent
  nine-module strip.

### R04 — Route existing work and drill-through
- Every route-map page reachable and populated from existing data/actions. Record detail
  pages, filtered-list return, exact authorized source links, context on company/actor
  change.

### R05 — Numbering and migration
- `src/domain/numbering.ts` registry/policy/allocation/preview/validation; per-company
  series; schema v2; pure deterministic v1→v2 migration; archive v1 route; preserve IDs,
  historical codes, posted account-code snapshots, source effects and idempotency.

### R06 — Numbering UI and all supported generators
- Admin → Numbering configure/preview/error; create/import forms show next code; every
  supported master/document path allocates through the service; standalone permissions;
  company B independence; archives carry series.

### R07 — Copy, accessibility, layout
- Business-facing messages; Field ids/`aria-describedby`/`aria-invalid`; error summary and
  focus; real links with `aria-current`; one outcome region; 390×844/200% zoom/table
  containment; no clipped controls.

### R08 — Verification and handoff
- Current-source `npm run verify` and `npm run benchmark`; remediation screenshots;
  updated README/BUSINESS-RULES/DECISIONS/ACCEPTANCE; fresh fingerprint/HANDOFF; honest
  remaining limitations.

## ECE Accounting Scope Amendment Phase — ECE01–ECE08 (owner-authorized 2026-11-01)

Authoritative contract: `../ECE-ACCOUNTING-SCOPE-AMENDMENT.md`, `../ECE-ACCOUNTING-TRIAL-BALANCE-FIXTURE.json`, and `../ECE-ACCOUNTING-SOURCE-REPORT-REVIEW.md`. Historical M01–M12 and R01–R09 remain preserved at baseline fingerprint `02e88aa188cbde32c9d9306319e4c9f90bc583ba7e1952bfa6803c44abb5fbcc` (93 files).

Coordinator: **Argon 4**. Custom agents configured for **Gemini 3.8 Flash High** (`gemini-3.8-flash-high` via `define_subagent` / `invoke_subagent` `Model: "flash"`):
- `ece-ledger-source`: Owns `ECE02` and `ECE03` (five-book posting provenance contract, deterministic migration backfill, source-book Trial Balance DTO, cell drill-through query, and `ECE-ACCOUNTING-TRIAL-BALANCE-FIXTURE.json` oracle tests).
- `ece-demo-refresh`: Owns `ECE04` (versioned connected demo seed `ece-accounting-demo-v1` across all 9 apps and 5 source books, numbering reservation proof, and atomic validate-before-save `resetState` in `adapters/storage.ts`).
- `ece-brand-report-ui`: Owns `ECE05` and `ECE06` (rename active surfaces/exports/docs to **ECE Accounting**, five-book Trial Balance UI/CSV/print/drill-through in `ReportsScreen.tsx`, and `Refresh demo data` control in `App.tsx`).
- `ece-independent-qa`: Owns `ECE08` (independent contract/code verification, Playwright browser verification, screenshots in `artifacts/screenshots/ece/`, and final regression checks).

```text
ECE01 baseline + agent registration + ORCHESTRATION.json (Argon 4)
 └─ ECE02 posting-source metadata/classifier/migration (ece-ledger-source)
     ├─ ECE03 source-book Trial Balance query & oracle (ece-ledger-source)
     ├─ ECE04 versioned connected demo seed & atomic reset (ece-demo-refresh)
     └─ ECE05 product rename & active documentation (ece-brand-report-ui)
         └─ ECE06 Trial Balance UI/CSV/print & refresh controls (ece-brand-report-ui)
             └─ ECE07 integration & actual browser demo refresh (Argon 4 + worker)
                 └─ ECE08 independent QA, fixes, benchmark & final handoff (ece-independent-qa)
```

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Dependency versions drift or mismatch | Build/test blocked | Pin exact versions, keep lockfile, record in ENVIRONMENT.md |
| Playwright browser binary missing | E2E blocked | Check cache first; report exact blocker if install fails |
| Payroll formulas flatten RD/OT/ND/SH/LG | Wrong money | Bucket-based matrix + independent golden numbers |
| Double effects through retries/imports | Wrong balances | Idempotency receipt + source-effect keys + negative tests |
| localStorage corrupted between sessions | Data loss | Zod validation, raw export, recovery screen, confirmed reset |
| Scope creep into ERP features | Incomplete core | Nine MAIN destinations only; documented future scope |

## Open questions (deliberately not blocking)

- Live statutory rates, official filing/provider route, production identity/MFA,
  bank templates and customer archive delivery remain production decisions. The mockup
  uses named synthetic fixtures and documents the gap instead of guessing.

## Owner review follow-up: authoritative numbering and monthly reporting

The owner explicitly supersedes prospective-only master coding: current master display codes must agree with their policy, while posted document/journal snapshots and immutable IDs remain preserved. Implement ECE09 in bounded domain/migration/UI slices; ECE10 month controls use the existing date-scoped ledger query; ECE11 fixes independently reviewed material report/provenance/reset defects. ECE12 verifies actual results and updates the handoff. No usable Git repository exists; preserve source evidence with fingerprints and a temporary read-only baseline copy.
