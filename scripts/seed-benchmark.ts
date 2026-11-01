#!/usr/bin/env node
/**
 * Deterministic benchmark fixture for the Fin Axis mockup.
 *
 * Everything is produced through `executeCommand` against the normal seed, so
 * master/transaction relationships, journals, source effects and opening
 * balances are valid rather than hand-assembled table rows. Company B stays in
 * the snapshot as the isolation company. No command here simulates concurrent
 * users.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeCommand } from '../src/domain/commands';
import type { CommandEnvelope, CommandResult, DomainCommand } from '../src/domain/commandTypes';
import { parseAppState, type AppState } from '../src/domain/schema';
import { createFixedClock } from '../src/domain/shared/clock';
import { createBaseSeedState, DEMO_NOW, DEMO_TODAY, WORKSPACE_A } from '../src/fixtures/seed';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'artifacts', 'benchmark');
const SEED_PATH = path.join(OUT_DIR, 'seed.json');
const MANIFEST_PATH = path.join(OUT_DIR, 'manifest.json');

const ACTOR = 'u-owner';
const CUSTOMERS = ['contact-a-cust-1', 'contact-a-cust-2'];
const VENDORS = ['contact-a-vend-1', 'contact-a-vend-2'];
const REVENUE_ACCOUNT = `acc-${WORKSPACE_A}-4010`;
const EXPENSE_ACCOUNT = `acc-${WORKSPACE_A}-6030`;
const INVENTORY_ACCOUNT = `acc-${WORKSPACE_A}-1200`;
const COGS_ACCOUNT = `acc-${WORKSPACE_A}-5010`;
const BANK_ACCOUNT = 'bank-a-1';
const DEDUCTION_SCHEDULE = 'ded-a-1';

const TARGET_EMPLOYEES = 25;
const TARGET_ITEMS = 100;
const TARGET_INVOICES = 300;
const TARGET_BILLS = 300;
const TARGET_BANK_ROWS = 1000;

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

function dateInNovember(dayOffset: number): string {
  const date = new Date(Date.UTC(2026, 10, 1));
  date.setUTCDate(date.getUTCDate() + dayOffset);
  return date.toISOString().slice(0, 10);
}

function fail(message: string): never {
  console.error(`seed-benchmark: ${message}`);
  process.exit(1);
}

let keyCounter = 0;
let state: AppState = createBaseSeedState();
const clock = createFixedClock({ nowIso: DEMO_NOW, today: DEMO_TODAY, seed: 'benchmark' });

function run(command: DomainCommand, label: string): CommandResult {
  keyCounter += 1;
  const envelope: CommandEnvelope = {
    workspaceId: WORKSPACE_A,
    actorId: ACTOR,
    idempotencyKey: `benchmark-${pad(keyCounter, 5)}`,
    expectedRevision: state.revision,
    command,
  };
  const outcome = executeCommand(state, envelope, clock);
  if (!outcome.ok) {
    fail(`${label} failed: ${outcome.error.code} — ${outcome.error.message}`);
  }
  state = outcome.value.state;
  return outcome.value.result;
}

async function main(): Promise<void> {
  // 25 employees: the three seeded employees plus 22 command-created ones.
  for (let index = 4; index <= TARGET_EMPLOYEES; index += 1) {
    run(
      {
        type: 'employee.create',
        input: {
          employeeNo: `EMP-${pad(index, 3)}`,
          name: `Benchmark Employee ${pad(index, 3)}`,
          monthlySalaryCentavos: 1_800_000 + index * 25_000,
          hiredOn: '2025-01-06',
          deductionScheduleId: DEDUCTION_SCHEDULE,
          branch: 'Main',
          department: 'Benchmark operations',
        },
      },
      `employee ${index}`,
    );
  }

  // 100 saleable items: the two seeded Company A items plus 98 more.
  for (let index = 3; index <= TARGET_ITEMS; index += 1) {
    run(
      {
        type: 'item.create',
        input: {
          sku: `BENCH-${pad(index, 3)}`,
          name: `Benchmark item ${pad(index, 3)}`,
          baseUnit: 'pc',
          inventoryAccountId: INVENTORY_ACCOUNT,
          cogsAccountId: COGS_ACCOUNT,
        },
      },
      `item ${index}`,
    );
  }

  // 300 posted invoices across the two synthetic customers.
  for (let index = 1; index <= TARGET_INVOICES; index += 1) {
    const invoiceDate = dateInNovember((index - 1) % 28);
    const dueDate = dateInNovember((index - 1) % 28 + 12);
    const created = run(
      {
        type: 'invoice.create',
        input: {
          customerContactId: CUSTOMERS[(index - 1) % CUSTOMERS.length]!,
          invoiceDate,
          dueDate,
          branch: 'Main',
          department: 'Benchmark services',
          taxTreatment: 'none',
          lines: [
            {
              description: `Synthetic benchmark service ${pad(index, 3)}`,
              quantityMilli: 1000 + ((index - 1) % 4) * 500,
              unitPriceCentavos: 50_000 + ((index - 1) % 25) * 1_000,
              accountId: REVENUE_ACCOUNT,
            },
          ],
        },
      },
      `invoice ${index} create`,
    );
    run({ type: 'invoice.post', input: { invoiceId: created.documentId } }, `invoice ${index} post`);
  }

  // 300 posted supplier bills across the two synthetic vendors.
  for (let index = 1; index <= TARGET_BILLS; index += 1) {
    const billDate = dateInNovember((index - 1) % 28);
    run(
      {
        type: 'bill.create',
        input: {
          vendorContactId: VENDORS[(index - 1) % VENDORS.length]!,
          supplierInvoiceNo: `BENCH-SI-${pad(index, 4)}`,
          billDate,
          dueDate: dateInNovember((index - 1) % 28 + 20),
          lines: [
            {
              description: `Synthetic benchmark purchase ${pad(index, 3)}`,
              accountId: EXPENSE_ACCOUNT,
              amountCentavos: 30_000 + ((index - 1) % 20) * 1_000,
              taxTreatment: 'none',
              ewtRateBp: 0,
            },
          ],
        },
      },
      `bill ${index}`,
    );
  }

  // 1,000 unique bank statement lines in one reviewed import.
  const bankRows = Array.from({ length: TARGET_BANK_ROWS }, (_, offset) => {
    const index = offset + 1;
    return {
      rowRef: `BENCH-BNK-${pad(index, 4)}`,
      valueDate: dateInNovember(offset % 28),
      description: `Synthetic benchmark bank line ${pad(index, 4)}`,
      direction: (index % 2 === 0 ? 'in' : 'out') as 'in' | 'out',
      amountCentavos: 10_000 + index * 17,
    };
  });
  run(
    {
      type: 'bankRow.import',
      input: { bankAccountId: BANK_ACCOUNT, sourceName: 'benchmark-bank-2026-11.csv', rows: bankRows },
    },
    'bank import',
  );

  // One error-free time import for all 25 employees so the browser benchmark can
  // measure payroll calculation without a duplicate period run.
  const employees = state.employees.filter(
    (employee) => employee.workspaceId === WORKSPACE_A && employee.status === 'active',
  );
  if (employees.length !== TARGET_EMPLOYEES) {
    fail(`expected ${TARGET_EMPLOYEES} active employees, found ${employees.length}`);
  }
  run(
    {
      type: 'time.import',
      input: {
        sourceName: 'benchmark-time-2026-11a.csv',
        rows: employees.map((employee) => ({
          employeeId: employee.id,
          bucket: 'ordinary_regular' as const,
          minutes: 5280,
        })),
      },
    },
    'time import',
  );

  const validated = parseAppState(state);
  if (!validated.ok) fail(`generated snapshot is invalid: ${validated.message}`);
  if (validated.state.workspaces.length !== 2) {
    fail(`expected the isolation company to remain, found ${validated.state.workspaces.length}`);
  }
  const counts = {
    workspaces: validated.state.workspaces.length,
    users: validated.state.users.length,
    employees: validated.state.employees.filter((row) => row.workspaceId === WORKSPACE_A).length,
    items: validated.state.items.filter((row) => row.workspaceId === WORKSPACE_A).length,
    invoices: validated.state.invoices.filter((row) => row.workspaceId === WORKSPACE_A).length,
    bills: validated.state.bills.filter((row) => row.workspaceId === WORKSPACE_A).length,
    bankRows: validated.state.bankRows.filter((row) => row.workspaceId === WORKSPACE_A).length,
    journals: validated.state.journals.filter((row) => row.workspaceId === WORKSPACE_A).length,
    timeImports: validated.state.timeImports.filter((row) => row.workspaceId === WORKSPACE_A).length,
    payrollRuns: validated.state.payrollRuns.filter((row) => row.workspaceId === WORKSPACE_A).length,
    isolationCompanyB: validated.state.workspaces.find((row) => row.id === 'ws-b')?.name ?? null,
    operators: ['u-accountant', 'u-maker', 'u-checker', 'u-payroll', 'u-inventory'].map((id) => {
      const user = validated.state.users.find((row) => row.id === id);
      return user ? user.name : id;
    }),
  };
  if (counts.employees !== TARGET_EMPLOYEES) fail(`employee count ${counts.employees}`);
  if (counts.items !== TARGET_ITEMS) fail(`item count ${counts.items}`);
  if (counts.invoices !== TARGET_INVOICES) fail(`invoice count ${counts.invoices}`);
  if (counts.bills !== TARGET_BILLS) fail(`bill count ${counts.bills}`);
  if (counts.bankRows !== TARGET_BANK_ROWS) fail(`bank row count ${counts.bankRows}`);

  const unbalanced = validated.state.journals.filter((journal) => {
    const debit = journal.lines.reduce((total, line) => total + line.debitCentavos, 0);
    const credit = journal.lines.reduce((total, line) => total + line.creditCentavos, 0);
    return debit !== credit;
  });
  if (unbalanced.length > 0) fail(`${unbalanced.length} unbalanced journal(s) generated`);

  // Minified on purpose: browser localStorage is the storage adapter, and the
  // fixture should stay as small as the validated snapshot allows.
  const json = JSON.stringify(validated.state);
  const checksum = createHash('sha256').update(json).digest('hex');
  const manifest = {
    generatedAt: DEMO_NOW,
    generator: 'scripts/seed-benchmark.ts',
    method: 'executeCommand against the standard seed; parseAppState revalidates the result',
    checksum,
    bytes: Buffer.byteLength(json),
    counts,
    note:
      'Synthetic benchmark fixture. No concurrent-user or production-scale claim is implied.',
  };
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(SEED_PATH, json, 'utf8');
  await fs.writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  console.log(
    `seed-benchmark: wrote ${counts.invoices} invoices, ${counts.bills} bills, ` +
      `${counts.bankRows} bank rows, ${counts.employees} employees, ${counts.items} items, ` +
      `${counts.journals} journals (${Buffer.byteLength(json)} bytes) to ${path.relative(ROOT, SEED_PATH)}`,
  );
  console.log(`seed-benchmark: sha256 ${checksum}`);
}

await main();
