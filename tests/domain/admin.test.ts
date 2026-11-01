import { describe, expect, it } from 'vitest';
import { accountBalance, journalCreditTotal, journalDebitTotal } from '../../src/domain/ledger';
import { entitlementStatus, resolveAccess } from '../../src/domain/shared/access';
import type { DomainCommand } from '../../src/domain/commandTypes';
import { DEMO_TODAY, WORKSPACE_A, WORKSPACE_B } from '../../src/fixtures/seed';
import { ACCOUNTS, createHarness } from './harness';

type Harness = ReturnType<typeof createHarness>;
type MastersInput = Extract<DomainCommand, { type: 'masters.import' }>['input'];

function mastersInput(overrides: Partial<MastersInput> = {}): MastersInput {
  return {
    contacts: [],
    items: [],
    openings: [],
    postingDate: '2026-11-10',
    approvalNote: 'Synthetic approved onboarding import',
    ...overrides,
  };
}

function wsBCutover(h: Harness) {
  return h.state.workspaces.find((workspace) => workspace.id === WORKSPACE_B)!.settings.cutover!;
}

describe('membership administration', () => {
  it('lets a company admin change roles and grants with an audit entry', () => {
    const h = createHarness({ actorId: 'u-owner' });
    h.runOk({
      type: 'membership.update',
      input: { userId: 'u-maker', roles: ['accountant'], payrollDetail: true, archiveGrant: true, active: true },
    });
    const membership = h.state.memberships.find(
      (candidate) => candidate.userId === 'u-maker' && candidate.workspaceId === WORKSPACE_A,
    )!;
    expect(membership.roles).toEqual(['accountant']);
    expect(membership.payrollDetail).toBe(true);
    expect(membership.archiveGrant).toBe(true);
    expect(membership.active).toBe(true);
    expect(h.state.auditEvents.some((event) => event.action === 'membership.update')).toBe(true);
  });

  it('refuses non-admins, empty roles, and removing your own admin access', () => {
    const maker = createHarness({ actorId: 'u-maker' });
    const denied = maker.run({
      type: 'membership.update',
      input: { userId: 'u-maker', roles: ['accountant'], payrollDetail: false, archiveGrant: false, active: true },
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe('FORBIDDEN');

    const h = createHarness({ actorId: 'u-owner' });
    const empty = h.run({
      type: 'membership.update',
      input: { userId: 'u-maker', roles: [], payrollDetail: false, archiveGrant: false, active: true },
    });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error.code).toBe('VALIDATION');

    const selfDemotion = h.run({
      type: 'membership.update',
      input: { userId: 'u-owner', roles: ['accountant'], payrollDetail: true, archiveGrant: true, active: true },
    });
    expect(selfDemotion.ok).toBe(false);
    if (!selfDemotion.ok) expect(selfDemotion.error.code).toBe('FORBIDDEN');
    const selfDeactivate = h.run({
      type: 'membership.update',
      input: { userId: 'u-owner', roles: ['company_admin'], payrollDetail: true, archiveGrant: true, active: false },
    });
    expect(selfDeactivate.ok).toBe(false);
    if (!selfDeactivate.ok) expect(selfDeactivate.error.code).toBe('FORBIDDEN');
  });

  it('deactivates a member, frees the seat, and blocks the former member', () => {
    const h = createHarness({ actorId: 'u-owner' });
    h.runOk({
      type: 'membership.update',
      input: { userId: 'u-maker', roles: ['ap_ar_clerk'], payrollDetail: false, archiveGrant: false, active: false },
    });
    const seat = h.state.seats.find((candidate) => candidate.id === 'seat-a-2')!;
    expect(seat.assignedUserId).toBeNull();
    const membership = h.state.memberships.find(
      (candidate) => candidate.userId === 'u-maker' && candidate.workspaceId === WORKSPACE_A,
    )!;
    expect(membership.active).toBe(false);
    expect(resolveAccess(h.state, 'u-maker', WORKSPACE_A, DEMO_TODAY).ok).toBe(false);
    const blocked = h.run(
      {
        type: 'invoice.create',
        input: {
          customerContactId: 'contact-a-cust-1',
          invoiceDate: '2026-11-01',
          dueDate: '2026-11-30',
          branch: 'HEAD OFFICE',
          department: 'SERVICES',
          taxTreatment: 'none',
          lines: [{ description: 'Synthetic blocked sale', quantityMilli: 1000, unitPriceCentavos: 1000, accountId: ACCOUNTS.revenue }],
        },
      },
      { actorId: 'u-maker' },
    );
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error.code).toBe('FORBIDDEN');
  });
});

describe('entitlement administration', () => {
  it('turns Accounting off and back on, refusing writes while inactive', () => {
    const h = createHarness({ actorId: 'u-owner' });
    h.runOk({ type: 'entitlement.update', input: { product: 'accounting', active: false, expiresOn: null } });
    expect(
      entitlementStatus(h.state.workspaces.find((workspace) => workspace.id === WORKSPACE_A)!.entitlements.accounting, DEMO_TODAY),
    ).toBe('inactive');

    const blocked = h.run(
      {
        type: 'contact.create',
        input: { name: 'Synthetic Blocked Contact', tin: '', address: 'Synthetic address', roles: ['customer'] },
      },
      { actorId: 'u-accountant' },
    );
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error.code).toBe('NOT_ENTITLED');
    expect(h.state.contacts.some((contact) => contact.name === 'Synthetic Blocked Contact')).toBe(false);

    h.runOk({ type: 'entitlement.update', input: { product: 'accounting', active: true, expiresOn: null } });
    h.runOk(
      {
        type: 'contact.create',
        input: { name: 'Synthetic Restored Contact', tin: '', address: 'Synthetic address', roles: ['customer'] },
      },
      { actorId: 'u-accountant' },
    );
    expect(h.state.contacts.some((contact) => contact.name === 'Synthetic Restored Contact')).toBe(true);
  });

  it('keeps data readable but blocks a write after an expiry date', () => {
    const h = createHarness({ actorId: 'u-owner' });
    h.runOk({ type: 'entitlement.update', input: { product: 'payroll', active: true, expiresOn: '2026-10-31' } });
    const workspace = h.state.workspaces.find((candidate) => candidate.id === WORKSPACE_A)!;
    expect(entitlementStatus(workspace.entitlements.payroll, DEMO_TODAY)).toBe('expired');
    expect(h.state.employees.length).toBeGreaterThan(0);

    const blocked = h.run(
      {
        type: 'time.import',
        input: { sourceName: 'expired-admin.csv', rows: [{ employeeId: 'emp-a-001', bucket: 'ordinary_ot', minutes: 60 }] },
      },
      { actorId: 'u-payroll' },
    );
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error.code).toBe('ENTITLEMENT_EXPIRED');
    expect(h.state.employees.length).toBeGreaterThan(0);
  });

  it('rejects invalid expiry dates and non-admin entitlement changes', () => {
    const h = createHarness({ actorId: 'u-owner' });
    const invalid = h.run({
      type: 'entitlement.update',
      input: { product: 'payroll', active: true, expiresOn: '2026-02-30' },
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error.code).toBe('VALIDATION');

    const maker = createHarness({ actorId: 'u-maker' });
    const denied = maker.run({
      type: 'entitlement.update',
      input: { product: 'accounting', active: false, expiresOn: null },
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe('FORBIDDEN');
  });
});

describe('G15 — standalone Accounting activation', () => {
  it('requires the exact approved opening value and activates only once', () => {
    const h = createHarness({ actorId: 'u-badmin', workspaceId: WORKSPACE_B });
    const cutover = wsBCutover(h);
    const movementsBefore = h.state.movements.filter((movement) => movement.workspaceId === WORKSPACE_B).length;

    const wrong = h.run({
      type: 'workspace.activateAccounting',
      input: { cutoverDate: '2026-11-15', reason: 'Synthetic cutover approval', confirmOpeningValueCentavos: 99_999 },
    });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) {
      expect(wrong.error.code).toBe('AMOUNT_MISMATCH');
      expect(wrong.error.message).toContain('100000');
    }
    expect(wsBCutover(h).status).toBe('proposed');
    expect(h.state.workspaces.find((workspace) => workspace.id === WORKSPACE_B)!.entitlements.accounting.active).toBe(false);

    const activated = h.runOk({
      type: 'workspace.activateAccounting',
      input: {
        cutoverDate: '2026-11-15',
        reason: 'Synthetic cutover approval',
        confirmOpeningValueCentavos: cutover.inventoryOpeningValueCentavos,
      },
    });
    expect(activated.warnings.join(' ')).toContain('does not post it a second time');
    const workspace = h.state.workspaces.find((candidate) => candidate.id === WORKSPACE_B)!;
    expect(workspace.entitlements.accounting.active).toBe(true);
    expect(workspace.entitlements.accounting.activatedOn).toBe('2026-11-15');
    expect(workspace.settings.cutover).toMatchObject({
      status: 'activated',
      approvedDate: '2026-11-15',
      approvedBy: 'u-badmin',
    });
    const audit = h.state.auditEvents.find((event) => event.action === 'workspace.activateAccounting')!;
    expect(audit.detail.historicalMovementsRetained).toBe(movementsBefore);
    expect(h.state.movements.filter((movement) => movement.workspaceId === WORKSPACE_B)).toHaveLength(movementsBefore);

    const again = h.run({
      type: 'workspace.activateAccounting',
      input: {
        cutoverDate: '2026-11-16',
        reason: 'Synthetic repeat cutover',
        confirmOpeningValueCentavos: cutover.inventoryOpeningValueCentavos,
      },
    });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe('CONFLICT');
  });
});

describe('master and opening import', () => {
  it('imports reconciled standalone openings once without replaying history', () => {
    const h = createHarness({ actorId: 'u-badmin', workspaceId: WORKSPACE_B });
    const contactsBefore = h.state.contacts.filter((contact) => contact.workspaceId === WORKSPACE_B).length;
    const result = h.runOk({
      type: 'masters.import',
      input: mastersInput({
        contacts: [{ name: 'Synthetic B Onboarding Customer', tin: '', address: 'Synthetic B address', roles: ['customer'] }],
        items: [{ sku: 'B-NEW-1', name: 'Synthetic B item', baseUnit: 'pc' }],
        openings: [
          { accountId: 'acc-ws-b-1020', debitCentavos: 100_000, creditCentavos: 0 },
          { accountId: 'acc-ws-b-3010', debitCentavos: 0, creditCentavos: 100_000 },
        ],
      }),
    });
    expect(result.journalIds).toHaveLength(1);
    const journal = h.state.journals.find((candidate) => candidate.id === result.journalIds[0])!;
    expect(journal.sourceType).toBe('opening_import');
    expect(journalDebitTotal(journal.lines)).toBe(journalCreditTotal(journal.lines));
    expect(journalCreditTotal(journal.lines)).toBe(100_000);
    expect(accountBalance(h.state, WORKSPACE_B, 'acc-ws-b-1020', null, null).netDebitCentavos).toBe(100_000);
    expect(h.state.contacts.filter((contact) => contact.workspaceId === WORKSPACE_B)).toHaveLength(contactsBefore + 1);
    expect(h.state.items.some((item) => item.workspaceId === WORKSPACE_B && item.sku === 'B-NEW-1')).toBe(true);
    expect(h.state.workspaces.find((workspace) => workspace.id === WORKSPACE_B)!.entitlements.accounting.active).toBe(
      false,
    );

    const duplicate = h.run({
      type: 'masters.import',
      input: mastersInput({
        contacts: [{ name: 'Synthetic B Second Contact', tin: '', address: 'Synthetic B address', roles: ['vendor'] }],
        openings: [
          { accountId: 'acc-ws-b-1020', debitCentavos: 100_000, creditCentavos: 0 },
          { accountId: 'acc-ws-b-3010', debitCentavos: 0, creditCentavos: 100_000 },
        ],
      }),
    });
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.error.code).toBe('DUPLICATE_EFFECT');
    expect(h.state.contacts.some((contact) => contact.name === 'Synthetic B Second Contact')).toBe(false);
  });

  it('rejects duplicates, unbalanced openings, foreign accounts, and missing approval', () => {
    const h = createHarness({ actorId: 'u-badmin', workspaceId: WORKSPACE_B });
    const duplicated = h.run({
      type: 'masters.import',
      input: mastersInput({
        contacts: [{ name: 'Isla Retail Demo Store', tin: '', address: 'Synthetic', roles: ['customer'] }],
      }),
    });
    expect(duplicated.ok).toBe(false);
    if (!duplicated.ok) expect(duplicated.error.code).toBe('DUPLICATE_ROW');
    expect(h.state.contacts.filter((contact) => contact.workspaceId === WORKSPACE_B)).toHaveLength(2);

    const unbalanced = h.run({
      type: 'masters.import',
      input: mastersInput({
        contacts: [{ name: 'Synthetic Rollback Contact', tin: '', address: 'Synthetic', roles: ['customer'] }],
        openings: [{ accountId: 'acc-ws-b-1020', debitCentavos: 100_000, creditCentavos: 0 }],
      }),
    });
    expect(unbalanced.ok).toBe(false);
    if (!unbalanced.ok) expect(unbalanced.error.code).toBe('VALIDATION');
    expect(h.state.contacts.some((contact) => contact.name === 'Synthetic Rollback Contact')).toBe(false);

    const foreign = h.run({
      type: 'masters.import',
      input: mastersInput({
        openings: [
          { accountId: 'acc-ws-a-1020', debitCentavos: 1_000, creditCentavos: 0 },
          { accountId: 'acc-ws-b-3010', debitCentavos: 0, creditCentavos: 1_000 },
        ],
      }),
    });
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.error.code).toBe('VALIDATION');

    const noNote = h.run({
      type: 'masters.import',
      input: mastersInput({ approvalNote: 'x' }),
    });
    expect(noNote.ok).toBe(false);
    if (!noNote.ok) expect(noNote.error.code).toBe('VALIDATION');

    const inventory = h.run(
      {
        type: 'masters.import',
        input: mastersInput({ contacts: [{ name: 'Synthetic Officer Contact', tin: '', address: 'Synthetic', roles: ['customer'] }] }),
      },
      { actorId: 'u-binv' },
    );
    expect(inventory.ok).toBe(false);
    if (!inventory.ok) expect(inventory.error.code).toBe('FORBIDDEN');
  });
});
