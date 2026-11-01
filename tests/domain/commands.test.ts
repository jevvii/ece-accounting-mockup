import { describe, expect, it } from 'vitest';
import { executeCommand } from '../../src/domain/commands';
import { createFixedClock } from '../../src/domain/shared/clock';
import { DEMO_NOW, DEMO_TODAY } from '../../src/fixtures/seed';
import type { DomainCommand } from '../../src/domain/commandTypes';
import { ACCOUNTS, createHarness } from './harness';

const CUSTOMER = 'contact-a-cust-1';

function invoiceCommand(overrides: Record<string, unknown> = {}): DomainCommand {
  return {
    type: 'invoice.create',
    input: {
      customerContactId: CUSTOMER,
      invoiceDate: '2026-11-01',
      dueDate: '2026-11-30',
      branch: 'HEAD OFFICE',
      department: 'SERVICES',
      taxTreatment: 'none',
      lines: [
        { description: 'Synthetic retry invoice', quantityMilli: 1000, unitPriceCentavos: 100_000, accountId: ACCOUNTS.revenue },
      ],
      ...overrides,
    },
  } as DomainCommand;
}

describe('G02 — idempotency and source-effect guards', () => {
  it('returns the stored result for an identical retry and never adds a second invoice', () => {
    const h = createHarness();
    const first = h.runOk(invoiceCommand(), { key: 'g02-key' });
    expect(h.state.invoices).toHaveLength(1);
    const revision = h.state.revision;

    const retried = h.runOk(invoiceCommand(), { key: 'g02-key' });
    expect(retried.documentId).toBe(first.documentId);
    expect(retried.summary).toBe(first.summary);
    expect(h.state.invoices).toHaveLength(1);
    expect(h.state.revision).toBe(revision);
  });

  it('rejects a reused key with a changed payload and keeps the original record', () => {
    const h = createHarness();
    const first = h.runOk(invoiceCommand(), { key: 'g02-key' });
    const revision = h.state.revision;

    const conflicted = h.run(invoiceCommand({ branch: 'BRANCH' }), { key: 'g02-key' });
    expect(conflicted.ok).toBe(false);
    if (!conflicted.ok) expect(conflicted.error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(h.state.revision).toBe(revision);
    expect(h.state.invoices).toHaveLength(1);
    expect(h.state.invoices[0]?.id).toBe(first.documentId);
    expect(h.state.invoices[0]?.branch).toBe('HEAD OFFICE');
  });

  it('rejects a new key that would repeat an already-posted source effect', () => {
    const h = createHarness();
    const created = h.runOk(invoiceCommand());
    h.runOk({ type: 'invoice.post', input: { invoiceId: created.documentId } }, { key: 'post-first' });
    const journals = h.state.journals.length;

    const repeat = h.run({ type: 'invoice.post', input: { invoiceId: created.documentId } }, { key: 'post-second' });
    expect(repeat.ok).toBe(false);
    if (!repeat.ok) expect(['CONFLICT', 'DUPLICATE_EFFECT']).toContain(repeat.error.code);
    expect(h.state.journals.length).toBe(journals);
  });
});

describe('command envelope and rejection atomicity', () => {
  it('leaves the previous snapshot object untouched on rejection', () => {
    const h = createHarness();
    const before = h.state;
    const invalid = h.run({
      type: 'invoice.create',
      input: {
        customerContactId: 'contact-does-not-exist',
        invoiceDate: '2026-11-01',
        dueDate: '2026-11-30',
        branch: 'HEAD OFFICE',
        department: 'SERVICES',
        taxTreatment: 'none',
        lines: [
          { description: 'Invalid synthetic invoice', quantityMilli: 1000, unitPriceCentavos: 100_000, accountId: ACCOUNTS.revenue },
        ],
      },
    });
    expect(invalid.ok).toBe(false);
    expect(h.state).toBe(before);
    expect(h.state.invoices).toHaveLength(0);
  });

  it('rejects a stale expected revision', () => {
    const h = createHarness();
    const stale = h.run(invoiceCommand(), { expectedRevision: h.state.revision + 10 });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe('STALE_REVISION');
    expect(h.state.invoices).toHaveLength(0);

    const fresh = h.runOk(invoiceCommand(), { expectedRevision: h.state.revision });
    expect(fresh.documentId).not.toBe('');
  });

  it('requires a non-empty idempotency key, actor and workspace', () => {
    const h = createHarness();
    const clock = createFixedClock({ nowIso: DEMO_NOW, today: DEMO_TODAY, seed: 'command' });
    const base = {
      workspaceId: 'ws-a',
      actorId: 'u-accountant',
      idempotencyKey: 'k',
      command: invoiceCommand(),
    };
    for (const envelope of [
      { ...base, idempotencyKey: '   ' },
      { ...base, workspaceId: '' },
      { ...base, actorId: '' },
    ]) {
      const result = executeCommand(h.state, envelope, clock);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('VALIDATION');
    }
  });

  it('rejects an actor with no membership in the selected company', () => {
    const h = createHarness();
    const denied = h.run(invoiceCommand(), { actorId: 'u-badmin', workspaceId: 'ws-a' });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe('FORBIDDEN');
    expect(h.state.invoices).toHaveLength(0);
  });
});

describe('maintenance mode', () => {
  it('blocks ordinary writes and archive restore, while allowing the window to be ended', () => {
    const h = createHarness({ actorId: 'u-owner' });
    h.runOk({ type: 'maintenance.set', input: { active: true, note: 'Synthetic maintenance window' } });
    expect(h.state.workspaces.find((workspace) => workspace.id === 'ws-a')?.settings.maintenance.active).toBe(true);

    const blocked = h.run(invoiceCommand(), { actorId: 'u-accountant' });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error.code).toBe('MAINTENANCE_ACTIVE');
    expect(h.state.invoices).toHaveLength(0);

    const restoreBlocked = h.run(
      {
        type: 'archive.restore',
        input: { archive: {}, reason: 'Synthetic attempt', expectedChecksum: '0' },
      },
      { actorId: 'u-owner' },
    );
    expect(restoreBlocked.ok).toBe(false);
    if (!restoreBlocked.ok) expect(restoreBlocked.error.code).toBe('MAINTENANCE_ACTIVE');

    h.runOk({ type: 'maintenance.set', input: { active: false, note: 'Synthetic maintenance complete' } });
    expect(h.state.workspaces.find((workspace) => workspace.id === 'ws-a')?.settings.maintenance.active).toBe(false);
    h.runOk(invoiceCommand(), { actorId: 'u-accountant' });
    expect(h.state.invoices).toHaveLength(1);
    expect(h.state.auditEvents.some((event) => event.action === 'maintenance.start')).toBe(true);
    expect(h.state.auditEvents.some((event) => event.action === 'maintenance.end')).toBe(true);
  });
});
