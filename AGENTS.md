# ECE Accounting mockup — shared operating rules

This directory is a **browser-local synthetic functional mockup** of ECE Accounting. It is not the
production pilot, not statutory software, and not completion of the approved PHP60,000 scope.
Read `../FIN-AXIS-MOCKUP-CLAUDE-PROMPT.md` for the full build specification and
`../FIN-AXIS-CONSOLIDATED-SPECIFICATION.md` for approved product context.

## Reading order before editing

1. This file.
2. `tasks/todo.md` (authoritative checklist) and the active section of `tasks/plan.md`.
3. `docs/STATE.json` and `HANDOFF.md` (current cursor, edit intent, known failures).
4. `docs/BUSINESS-RULES.md`, `docs/DECISIONS.md` when touching a rule.
5. The feature's domain module and its tests.

If `mockup/` already has work, continue it. Do not scaffold over it.

## Commands

```bash
npm ci                 # install exactly from package-lock.json
npm run dev            # http://127.0.0.1:5173
npm run typecheck      # tsc --noEmit (bundling is not type checking)
npm test               # Vitest domain/integration run (single pass)
npm run build          # Vite production bundle
npm run test:e2e       # Playwright real-browser acceptance
npm run verify         # typecheck + tests + build + browser suite
npm run checkpoint     # validate STATE, fingerprint sources, regenerate HANDOFF
npm run seed:benchmark # deterministic benchmark fixture (see README)
```

## Invariants (do not weaken)

- **Workspace = one legal company.** The Fixed Asset field called **Company** is the
  acquisition vendor/brand, never the ownership key. Asset ownership is the workspace.
- **Money is integer PHP centavos.** Quantities are integer thousandths of one base unit.
  Time is integer minutes. No floating-point ledger totals. Round half-up to a centavo only
  at the explicit calculation/posting boundary.
- **All state changes pass through `executeCommand`** in `src/domain/commands.ts`. React
  handlers call commands; they never mutate state. Queries are read-only and authorization-aware.
- **Idempotency is two-layered:** a request key receipt, plus an independent business
  source-effect key (`invoice-post:…`, `payroll-post:…`). A new request key must not repeat
  a source effect. A reused key with a different payload is a typed conflict.
- **Posted financial records are immutable.** Corrections are linked reversals/adjustments
  in an open period. Closed-period posting is rejected.
- **Maker ≠ checker** on restricted settlement, manual journals, payroll approval and
  bank-detail changes. A combined role does not let one person approve their own step.
- **Payroll detail is protected** by an explicit grant. Company admin does not impliedly
  see payslips. Exports and archives obey the same restriction.
- **Cross-company isolation** applies to queries, detail routes, exports, archives and
  commands. No invitation means no access.
- **One active write tab.** Browser localStorage is not a transactional multiuser database.
  The app detects external writes and asks the operator to reload.
- **Synthetic data only.** Company A/B, invented people, no real TINs, bank credentials or
  customer records. Demo fixture approval is not accountant approval.
- **No fake production controls.** No pretend MFA, encryption, bank feed, BIR filing,
  official invoice issuance, deployment or backup delivery.

## Structure and boundaries

- `src/domain/` — pure business rules and the command seam. No React, DOM, storage or
  browser APIs. Domain modules own their rules; screens must not do accounting math.
- `src/adapters/` — localStorage persistence, CSV parse/export, archive checksum, print.
- `src/features/` — screens call domain commands/queries only.
- `src/ui/` — a few shared labelled form/table primitives, not a design system.
- `tests/domain/` — Vitest against the production command/query seam.
- `tests/e2e/` — Playwright real-browser flows; no state injection for business steps.

Do not add a backend, auth provider, UI kit, CSS framework, global state library, ORM,
generated API layer, chart library, LLM feature or speculative adapter hierarchy.

## Checkpoint protocol

Before a bounded task, update `docs/STATE.json` with `activeTaskId`, intended files and a
concrete `nextAction`. After the change, run the focused check, record the **actual** result
in `tasks/todo.md` and `docs/STATE.json`, then run `npm run checkpoint`. Never record a
check as passing without observing exit code 0. Preserve failures honestly.

## Known scope gaps

Production identity/MFA, server-side tenant isolation, hosted transactions, encrypted
customer backups, live bank templates, BIR/provider duties, current statutory rates,
filing/certification, production retention and specialized industry workflows are out of
scope. They are documented in `README.md` and `docs/DECISIONS.md`; do not simulate them.
