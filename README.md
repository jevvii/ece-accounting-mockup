# ECE Accounting mockup

A browser-local, synthetic-data functional mockup of **ECE Accounting**, a Philippine accounting hub
with independently usable Payroll and Inventory. It is built with React, TypeScript, Vite,
plain CSS, Zod and Papa Parse. It is **not** the production product, not a hosted service, and
not evidence of BIR, payroll, banking or security compliance.

The fixed label **LOCAL DEMO · SYNTHETIC DATA** is shown in the shell and on printed output.
All companies, people, TINs, bank accounts and rates are invented fixtures.

## Prerequisites

- Node.js **≥ 22.12** (observed during acceptance: Node v26.8.1, npm 12.0.2)
- A Chromium-based browser for the Playwright acceptance suite
- No database, backend, account or network service is required

Exact observed versions and machine details are in [`docs/ENVIRONMENT.md`](docs/ENVIRONMENT.md).

## Install

```bash
cd mockup
npm ci
npx playwright install chromium   # only if the matching browser binary is absent
```

`package-lock.json` is authoritative. Do not upgrade dependencies casually; if you do, record
the reason in `docs/DECISIONS.md` and re-run `npm run verify`.

## Run

```bash
npm run dev
```

Open <http://127.0.0.1:5173>. The Vite server binds only to `127.0.0.1:5173` with a strict port.
Production bundle: `npm run build`, then `npm run preview` at <http://127.0.0.1:4173>.

To share the static mockup on GitHub Pages, follow [the deployment walkthrough](docs/GITHUB-PAGES.md).
The included workflow assumes the contents of this directory are the root of their own
repository; it runs `npm run verify` before publishing `dist/`.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Local Vite server on `127.0.0.1:5173` |
| `npm run typecheck` | `tsc --noEmit` with the strict project config |
| `npm test` | Finite Vitest run over domain/integration tests |
| `npm run build` | Vite production bundle in `dist/` |
| `npm run test:e2e` | Playwright real-browser acceptance (separate from Vitest) |
| `npm run verify` | Typecheck → Vitest → build → Playwright; nonzero if any step fails |
| `npm run checkpoint` | Validate `docs/STATE.json`, fingerprint sources, regenerate `HANDOFF.md` |
| `npm run seed:benchmark` | Generate the deterministic benchmark snapshot |
| `npm run benchmark` | Regenerate the snapshot and run the opt-in browser benchmark |

The benchmark is opt-in because its fixture is about 2.5 MB and each sample reloads it.
Results are written to `artifacts/benchmark/results.json`.

## Navigation and URLs

`#/home` (Main) is the default page. It lists the nine work areas once; opening one shows only
that app's task pages, worklists and records. **All apps** in the header repeats the nine
entries on demand, and **Main** returns to the launcher. There is no permanent nine-module
navigation strip.

Routes are ordinary hash links, for example `#/billing/invoices`,
`#/billing/invoices/new`, `#/admin/numbering` and `#/purchases/approvals`.
Record routes use immutable record IDs, not business codes, so a numbering-policy change cannot
break a saved URL. Reload and Back/Forward keep the route; closing a record returns to its
filtered worklist. Unknown routes show a Page not found state rather than falling back to an app.

Page changes set the document title and focus the page heading. The skip link moves focus to
the main landmark without changing the hash route. Navigation links carry
`aria-current="page"`. Inline drafts (Admin numbering and master imports) ask **Continue
editing** or **Discard changes** before navigation, company/actor switching, or browser close.

## Demo actors and companies

Use the **Demo actor** and **Company** selects in the header. Access is membership-scoped:
only companies where the selected actor has an active membership appear.

| Actor | Role in Company A (`ws-a`, Northwind Services Demo) |
|---|---|
| Rosa Mendoza | Company admin + accountant; no payroll detail |
| Paolo Garcia | AP/AR clerk (maker) |
| Elena Bautista | Independent approver (accountant) |
| Nina Torres | Payroll officer; payroll detail granted |
| Rico Alvarez | Inventory officer |
| Victor Lim | Company admin; payroll detail and archive grants |

Company B (`ws-b`, Bayanihan Trading Demo) has its own administrator, payroll officer and
inventory officer. Accounting starts inactive. Its payroll entitlement expires on
2026-12-31 and its inventory has a proposed cutover at an approved opening value of
PHP 1,000.00. Company B data is the isolation fixture; Company A actors cannot see it.

### Reset the synthetic fixture

Click **Reset demo data** in the page header and confirm. This clears the browser snapshot and
reloads the deterministic seed. Alternatively clear this localStorage key and reload:

```text
fin-axis-mockup:app-state:v1
```

The app never silently reseeds corrupt data. If parsing fails it shows a recovery screen with
raw-data export, confirmed reset, or reload.

## Core scenarios

Every write goes through one typed command seam. Posted financial records are immutable;
corrections use linked reversals, credit notes or adjustments. Closed periods reject posting.

1. **Invoice → receipt → reports.** Billing and Collection → *New invoice*. Fill a line and
   choose *Save and post*. The detail dialog shows the source journal. Then *New receipt*,
   allocate to the invoice (excess becomes explicit unapplied credit). Reports → Trial Balance
   should stay balanced, and Billing → Aging shows the remaining balance.
2. **Bill → approval → payment.** Purchases and Disbursement → *New bill*, then *Request
   payment*. Switch to a different approver (Elena Bautista) and approve. A requester cannot
   approve their own request. The maker can then release payment after approval. Cash
   Management can match the resulting outgoing-clearing payment to an imported bank line.
3. **Bank CSV.** Cash Management → *Import CSV*. Download the template, preview rows, and
   confirm. Re-importing the same rows adds no effects. Matches are suggestions until reviewed;
   undo requires a reason and posts a linked reversal once.
4. **Inventory.** Inventory → receive stock at a location, issue it, transfer between the two
   locations, or record a customer/supplier return or count. The company-wide moving-average
   pool is the valuation source; a location may not go negative.
5. **Payroll.** Payroll → import an approved time CSV, calculate a semi-monthly run, switch
   actor, approve independently, post, then pay. Payslips and exports require the payroll-detail
   grant. The 13th-month, annualization, final-pay and draft 2316 worksheets save explicit inputs.
6. **Fixed assets.** Fixed Assets → *New asset*. Required labels include Company vendor/brand,
   Purchase Date, Item Description, Supplier, Serial No., Account, Cost, Useful life for Year,
   Depreciation per month and per day. Calculate a month, approve as a second user, then post.
   Full-month posting is exactly the monthly amount, not 30 × the daily display.
7. **Reports and Other.** Reports contains Trial Balance, Expense and Sales plus CSV/print.
   Other contains manual journal drafts/approval/posting, period close/reopen with reasons,
   VAT/EWT/FWT registers and the Form 2307 register.
8. **Admin.** Admin manages contacts, accounts, members, roles, payroll-detail/archive grants,
   product entitlements and maintenance. It also exports/restores a company-only archive and
   performs Company B's accounting activation.
9. **Numbering.** Admin → *Numbering* lists the 25 supported record kinds for the active
   company, the current prefix, next value, minimum digits and increment. A company
   administrator (or the owning payroll/inventory role for those products) can change one
   series with a reason. Changes are audited and prospective: existing codes, posted documents
   and snapshots do not change. Defaults include accounts `A100`, `A101`, employees `5000`,
   `5001`, and invoices `INV-0001`; minimum digits are an explicit policy choice and numbers are
   never truncated. Manual codes are available only when the series enables that override.

### Print / save as PDF

Report and invoice views have a **Print** action backed by print CSS. The browser's print
dialog can save a PDF. Only the print stylesheet and browser dialog were exercised; no server-side
PDF renderer was tested or is included. Printed output keeps the synthetic-data label.

### Export and restore

- CSV exports are generated in the browser and downloaded.
- Admin → archive prepares a single-company JSON archive with a manifest and SHA-256 checksum.
  Restore previews the archive, requires a reason, and rejects checksum mismatches, foreign
  company records or mixed-company payloads without mutating state.
- Archive export requires an explicit archive grant **and** payroll-detail access when the
  company has payroll data, so an ordinary admin cannot bypass the payroll-detail restriction.

## Browser storage and the one-write-tab rule

State lives only in this browser's `localStorage` under `fin-axis-mockup:app-state:v1`.
The storage key keeps its original name for continuity; the stored snapshot is schema version 2
and is migrated deterministically from version 1 on load. There is no server, account, sync or
multi-user transaction. Clearing site data removes it. Storage is not encrypted; do not enter
real customer or payroll records.

Migration preserves internal IDs, posted balances, historical codes, snapshots, source-effect
keys and idempotency receipts. Only public numbers that did not exist in version 1 are
backfilled. The raw stored snapshot is retained on a corrupt, unsupported or exhausted series;
the app never silently resets it.

Use **one write tab at a time**. A second tab detects the storage event and asks the operator
to reload before further writes. Two tabs are not simulated as five concurrent users, and this
storage event is not a substitute for a transactional database or server-side tenant isolation.

## Implemented modules

- `src/domain/` — pure schema, money/date/quantity/time helpers, access, ledger, billing,
  purchases/advances, cash/bank reconciliation, inventory, payroll, assets, reports, admin,
  archive, and the single `executeCommand` seam.
- `src/adapters/` — localStorage persistence, CSV, company archive checksum, print helpers.
- `src/app/` — header/navigation, nine MAIN destinations, screens, native dialogs, hash routing.
- `src/fixtures/seed.ts` — deterministic demo companies, users, policies and golden fixtures.
- `tests/domain/` — Vitest against the production command/query seam.
- `tests/e2e/` — Playwright browser flows, including a keyboard-only create/approve path.
- `benchmark/` — opt-in measured browser benchmark.

## Explicit production gaps

Not implemented and not simulated: real identity/MFA, server-side authorization or tenant
isolation, hosted multi-user transactions, encrypted database/object backups, backup delivery,
live bank feeds or bank-specific templates, BIR filing or official invoice/certificate issuance,
current statutory tax/payroll rates, professional certification, production retention, and
specialized industry workflows.

Missing production policies are represented by clearly labelled **synthetic fixture policies**
(for example the demo tax schedule and time matrix), not guessed law. The demo rates and
thresholds are not approval for live payroll or tax use.

## Resume with another agent

1. Read `AGENTS.md`, `tasks/todo.md`, `docs/STATE.json` and `HANDOFF.md`.
2. Inspect the actual files before trusting the recorded state.
3. Run `npm ci` if `node_modules` is absent, then the focused check for the unfinished task.
4. Record observed exits/results, run `npm run checkpoint`, and continue the next dependency.

`HANDOFF.md` is generated by the checkpoint script; do not edit it by hand. The source
fingerprint proves which files were covered, not that tests passed.

## Evidence

- `docs/ACCEPTANCE.md` — acceptance mapping, commands, actual results and measurements
- `docs/BUSINESS-RULES.md` — rules to domain functions/tests
- `docs/DECISIONS.md` — implemented choices and open production decisions
- `docs/ENVIRONMENT.md` — observed machine/tool versions
- `artifacts/screenshots/` — browser screenshots
- `artifacts/benchmark/results.json` — benchmark method, dataset and timings
- `artifacts/logs/` — saved command output

## Master codes and monthly Trial Balance

Numbering policies govern existing and new master codes. Reload once after this update: saved numeric account codes such as 1010 reconcile to the current A100 series without clearing transactions or changing record IDs/posted financial snapshots. Admin → Numbering shows Starting number and Next code separately, previews current master-code changes and reserves the next available value. Manual codes, when enabled, must be unused valid outputs of the same policy. Issued transaction/document numbers retain their historical values.

Reports → Trial balance defaults to **Month end**. Pick **Reporting month** or use Previous month / This month / Next month. Month end includes openings and all posted history through that month's last day. Choose **Monthly activity** for that month's source-book postings; closing balances still include earlier history. Custom As-of and activity ranges remain available. CSV and print use the selected scope.
