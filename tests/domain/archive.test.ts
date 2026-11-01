import { describe, expect, it } from 'vitest';
import {
  ARCHIVE_COLLECTIONS,
  buildCompanyArchive,
  canExportCompanyArchive,
  mergeCompanyArchive,
} from '../../src/domain/archive';
import {
  computeArchiveChecksum,
  sealCompanyArchive,
  verifyCompanyArchive,
} from '../../src/adapters/archive';
import { createSeedState, WORKSPACE_A, WORKSPACE_B } from '../../src/fixtures/seed';
import type { CompanyArchive } from '../../src/domain/archive';
import type { AppState } from '../../src/domain/schema';
import { createHarness } from './harness';

async function makeArchive(state: AppState) {
  const built = buildCompanyArchive(state, WORKSPACE_A, 'u-owner', '2026-11-01T10:00:00.000Z');
  if (!built.ok) throw new Error(built.error.message);
  return sealCompanyArchive(built.value);
}

function wsBRecords(state: AppState) {
  const records: Record<string, unknown[]> = {};
  for (const key of ARCHIVE_COLLECTIONS) {
    records[key] = (state[key] as Array<{ workspaceId?: string }>).filter(
      (record) => record.workspaceId === WORKSPACE_B,
    );
  }
  return records;
}

describe('company archive — scope, checksum and atomic isolation', () => {
  it('archives only one company and produces a stable canonical checksum', async () => {
    const state = createSeedState();
    const archive = await makeArchive(state);
    expect(archive.workspaceId).toBe(WORKSPACE_A);
    expect(archive.payload.workspace.id).toBe(WORKSPACE_A);

    for (const key of ARCHIVE_COLLECTIONS) {
      const records = archive.payload.collections[key]!;
      expect(Array.isArray(records), key).toBe(true);
      for (const record of records) {
        expect((record as { workspaceId?: string }).workspaceId, key).toBe(WORKSPACE_A);
      }
    }
    for (const key of Object.keys(archive.payload.idempotency)) {
      expect(key.startsWith(`${WORKSPACE_A}:`)).toBe(true);
    }
    for (const key of Object.keys(archive.payload.sourceEffects)) {
      expect(key.startsWith(`${WORKSPACE_A}:`)).toBe(true);
    }

    const again = await computeArchiveChecksum(archive);
    expect(again).toBe(archive.checksum);
    expect(archive.checksum).toMatch(/^[0-9a-f]{64}$/);
    const verified = await verifyCompanyArchive(archive);
    expect(verified.ok).toBe(true);
    if (verified.ok) expect(verified.checksum).toBe(archive.checksum);
  });

  it('rejects a tampered payload and a mismatched checksum without changing state', async () => {
    const state = createSeedState();
    const archive = await makeArchive(state);
    const tampered = structuredClone(archive);
    tampered.payload.workspace.name = 'Tampered synthetic company';
    const failedCheck = await verifyCompanyArchive(tampered);
    expect(failedCheck.ok).toBe(false);

    const wrongChecksum = structuredClone(archive);
    wrongChecksum.checksum = '0'.repeat(64);
    expect((await verifyCompanyArchive(wrongChecksum)).ok).toBe(false);

    const before = JSON.stringify(state);
    const rejected = await verifyCompanyArchive(tampered);
    expect(rejected.ok).toBe(false);
    expect(JSON.stringify(state)).toBe(before);
    expect(state.workspaces.find((workspace) => workspace.id === WORKSPACE_A)?.name).not.toBe(
      'Tampered synthetic company',
    );
    expect((await verifyCompanyArchive(archive)).ok).toBe(true);
  });

  it('rejects a mixed-company archive atomically', async () => {
    const state = createSeedState();
    const archive = await makeArchive(state);
    const foreignContact = state.contacts.find((contact) => contact.workspaceId === WORKSPACE_B)!;
    const mixed = structuredClone(archive);
    (mixed.payload.collections.contacts as unknown[]).push(structuredClone(foreignContact));
    mixed.checksum = await computeArchiveChecksum(mixed);

    const before = JSON.stringify(state);
    const merged = mergeCompanyArchive(state, mixed, 'u-owner', 'Synthetic restore', '2026-11-01T11:00:00.000Z', 'restore-2');
    expect(merged.ok).toBe(false);
    if (!merged.ok) expect(merged.error.code).toBe('VALIDATION');
    expect(JSON.stringify(state)).toBe(before);
  });

  it('restores only the archived company and leaves the other company untouched', async () => {
    const h = createHarness({ actorId: 'u-owner' });
    const archive = await makeArchive(h.state);

    h.runOk(
      {
        type: 'contact.create',
        input: { name: 'Synthetic Later Customer', roles: ['customer'], tin: '', address: '' },
      },
      { actorId: 'u-maker' },
    );
    h.runOk(
      {
        type: 'movement.receipt',
        input: {
          itemId: 'item-b-1',
          locationId: 'loc-b-main',
          occurredOn: '2026-10-20',
          quantityMilli: 500,
          unitCostCentavos: 10_000,
          sourceType: 'synthetic_receipt',
          sourceId: 'archive-isolation-b',
          effectKey: 'archive-isolation-b',
        },
      },
      { actorId: 'u-binv', workspaceId: WORKSPACE_B },
    );
    const companyBBefore = wsBRecords(h.state);
    expect(h.state.contacts.some((contact) => contact.name === 'Synthetic Later Customer')).toBe(true);
    expect(h.state.movements.some((movement) => movement.effectKey === 'archive-isolation-b')).toBe(true);

    const restored = h.runOk(
      {
        type: 'archive.restore',
        input: { archive, reason: 'Synthetic archive round trip', expectedChecksum: archive.checksum },
      },
      { actorId: 'u-owner' },
    );
    expect(restored.warnings.length).toBe(1);
    expect(h.state.contacts.some((contact) => contact.name === 'Synthetic Later Customer')).toBe(false);
    expect(h.state.movements.some((movement) => movement.effectKey === 'archive-isolation-b')).toBe(true);
    expect(wsBRecords(h.state)).toEqual(companyBBefore);
    expect(h.state.workspaces.find((workspace) => workspace.id === WORKSPACE_A)?.id).toBe(WORKSPACE_A);
    expect(h.state.archiveLog.filter((entry) => entry.action === 'restore')).toHaveLength(1);
    expect(h.state.archiveLog.find((entry) => entry.action === 'restore')?.workspaceId).toBe(WORKSPACE_A);
  });

  it('enforces archive and payroll-detail grants separately', async () => {
    const state = createSeedState();
    const membership = (userId: string) => state.memberships.find((candidate) => candidate.userId === userId)!;
    expect(canExportCompanyArchive(membership('u-owner'))).toBe(true);
    expect(canExportCompanyArchive(membership('u-accountant'))).toBe(false);
    expect(canExportCompanyArchive(membership('u-payroll'))).toBe(false);
    expect(canExportCompanyArchive(membership('u-maker'))).toBe(false);

    const h = createHarness({ actorId: 'u-maker' });
    const archive = await makeArchive(h.state);
    const denied = h.run({
      type: 'archive.restore',
      input: { archive, reason: 'Synthetic attempt', expectedChecksum: archive.checksum },
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe('FORBIDDEN');
    expect(h.state.archiveLog).toHaveLength(0);

    const wrongCompany = h.run(
      {
        type: 'archive.restore',
        input: { archive, reason: 'Synthetic cross-company attempt', expectedChecksum: archive.checksum },
      },
      { actorId: 'u-badmin', workspaceId: WORKSPACE_B },
    );
    expect(wrongCompany.ok).toBe(false);
    if (!wrongCompany.ok) expect(wrongCompany.error.code).toBe('FORBIDDEN');
    expect(h.state.archiveLog).toHaveLength(0);
  });
});

describe('R05 — archive numbering continuity', () => {
  it('verifies a legacy v1 archive checksum before migrating its company snapshot', async () => {
    const state = createSeedState();
    const archive = await makeArchive(state);
    const legacy = structuredClone(archive) as CompanyArchive;
    legacy.formatVersion = 1;
    delete legacy.payload.collections.numberingPolicies;
    const collections = legacy.payload.collections as Record<string, Array<Record<string, unknown>>>;
    for (const row of collections.contacts ?? []) delete row.contactNo;
    for (const row of collections.items ?? []) delete row.itemNo;
    for (const row of collections.bankAccounts ?? []) delete row.bankCode;
    for (const row of collections.movements ?? []) delete row.movementNo;
    for (const row of collections.bankStatements ?? []) delete row.statementNo;
    for (const row of collections.worksheets ?? []) delete row.worksheetNo;
    for (const row of collections.liquidations ?? []) delete row.liquidationNo;
    for (const row of collections.taxRecords ?? []) delete row.publicNo;
    legacy.checksum = await computeArchiveChecksum(legacy);
    const verified = await verifyCompanyArchive(legacy);
    expect(verified.ok).toBe(true);

    const h = createHarness({ actorId: 'u-owner' });
    const restored = h.runOk(
      {
        type: 'archive.restore',
        input: { archive: legacy, reason: 'Legacy synthetic archive restore', expectedChecksum: legacy.checksum },
      },
      { actorId: 'u-owner' },
    );
    expect(restored.documentType).toBe('archive');
    expect(h.state.journals.find((row) => row.id === 'jv-a-opening')?.lines[0].accountCode).toBe('A101');
    expect(h.state.sourceEffects[`${WORKSPACE_A}:opening:initial-equity`]).toBeDefined();
    expect(h.state.contacts.find((row) => row.id === 'contact-a-cust-1')?.contactNo).toBeTruthy();
    expect(h.state.numberingPolicies.some((policy) => policy.workspaceId === WORKSPACE_A)).toBe(true);
  });

  it('rejects a restored lower counter that would duplicate an existing code', async () => {
    const state = createSeedState();
    const archive = await makeArchive(state);
    const lowered = structuredClone(archive);
    const policy = lowered.payload.collections.numberingPolicies.find(
      (row) =>
        (row as { workspaceId: string }).workspaceId === WORKSPACE_A &&
        (row as { kind: string }).kind === 'account',
    ) as { nextNumber: number } | undefined;
    expect(policy).toBeDefined();
    if (policy) policy.nextNumber = 100;
    lowered.checksum = await computeArchiveChecksum(lowered);
    const verified = await verifyCompanyArchive(lowered);
    expect(verified.ok).toBe(true);
    const h = createHarness({ actorId: 'u-owner' });
    const denied = h.run(
      {
        type: 'archive.restore',
        input: { archive: lowered, reason: 'Unsafe lower counter', expectedChecksum: lowered.checksum },
      },
      { actorId: 'u-owner' },
    );
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.message).toMatch(/duplicate|unique/);
  });
});
