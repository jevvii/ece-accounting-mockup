# Fin Axis mockup — product direction (remediation)

Status: recorded 2026-11-01 for R01 of `../FIN-AXIS-UI-REMEDIATION-SPEC.md`.

## Mode and audience

**Operate.** Users are an accountant/approver, an entry clerk and payroll/inventory
operators. Success is: find a task, enter or review it, take the next permitted action,
and return to the right worklist with minimal distraction.

## Information architecture

`Main → app work area → filtered worklist → record/action`

- `#/home` is the default route and a plain app launcher.
- All nine app identities remain visible on Main with honest availability.
- Inside an app: one app context, task-local navigation, page title, breadcrumbs on
  deeper records, one page-level primary action, and record actions on record detail.
- A Main link and an **All apps** switcher remain available. There is no permanent
  nine-module navigation strip.
- Worklists expose real status filters whose counts come from authorized state.
- Reports keep exactly three accounting families: Trial Balance, Expenses, Sales.

## Visual and interaction direction

Restrained, conventional ERP: compact shared shell, native controls, plain labelled
forms/tables, numeric alignment, visible focus, 4.5:1 normal-text contrast, no decorative
dashboard, gradients, fake KPIs, chart library, new typeface or UI kit.

Keep one short **Local demo · Synthetic data** indicator. Move actor switching, demo date,
reset and role/grant diagnostics into an explicitly labelled **Demo controls** disclosure.
Errors stay visible near their operation; success is concise and non-obstructive.

## Business codes

Public business codes (account, contact, employee, item, location, asset and supported
documents) are display/search/export fields. Immutable internal IDs remain every
relationship, journal mapping, source-effect, idempotency receipt and route key. External
supplier invoice numbers, SKUs, TINs, bank references, certificate identifiers and serials
remain separate external fields.

Numbering is per company and record kind: `prefix + numeric sequence`, optional minimum
digits, positive increment. Account default `A100…`; employee `5000…`; contact `C100…`;
item `I100…`; location `L100…`; asset `FA100…`. Changes are privileged, reasoned, audited
and prospective. Existing codes and posted snapshots never change.

## Out of scope

No backend, production identity/MFA, bank feed, BIR filing, official invoice issuance,
deployment, paid service, customer data, new UI kit, chart library or framework migration.
