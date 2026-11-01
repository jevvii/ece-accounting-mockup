import { useMemo, useState } from 'react';
import type { Account, Contact, Membership, ProductCode, Role, Seat } from '../../domain/schema';
import {
  archiveChecksumPrefix,
  archiveCounts,
  buildCompanyArchive,
  canExportCompanyArchive,
  type CompanyArchive,
} from '../../domain/archive';
import { sealCompanyArchive, verifyCompanyArchive } from '../../adapters/archive';
import {
  CONTACTS_CSV_TEMPLATE,
  ITEMS_CSV_TEMPLATE,
  OPENINGS_CSV_TEMPLATE,
  downloadText,
  parseContactsCsv,
  parseItemsCsv,
  parseOpeningsCsv,
} from '../../adapters/csv';
import {
  NUMBERING_KINDS,
  formatNumber,
  isMasterKind,
  numberingDefinition,
  numberingPolicy,
  previewCodes,
  type RecordKind,
} from '../../domain/numbering';
import { useApp } from '../useApp';
import { masterRecords, reconcileMasterCodes } from '../../domain/masterCodes';
import { useAppRoute, useUnsavedChanges } from '../navigation';
import { EmptyState, Field, Modal, Panel, StatusBadge } from '../components';
import { humanDate, humanTimestamp, money, titleCase } from '../format';
import { dateField, focusField, moneyField, positiveIntField, requiredField } from '../forms';

type AdminTab = 'company' | 'access' | 'entitlements' | 'masters' | 'numbering' | 'archive';

const ROLES: Role[] = [
  'company_admin',
  'accountant',
  'ap_ar_clerk',
  'payroll_officer',
  'inventory_officer',
];

const PRODUCTS: ProductCode[] = ['accounting', 'payroll', 'inventory'];

const ACCOUNT_TYPES: Array<{ value: Account['type']; label: string; normal: Account['normalBalance'] }> = [
  { value: 'asset', label: 'Asset', normal: 'debit' },
  { value: 'liability', label: 'Liability', normal: 'credit' },
  { value: 'equity', label: 'Equity', normal: 'credit' },
  { value: 'revenue', label: 'Revenue', normal: 'credit' },
  { value: 'expense', label: 'Expense', normal: 'debit' },
];

type RestorePreview =
  | { kind: 'none' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; archive: CompanyArchive; checksum: string; counts: Record<string, number> };

function toggleRole(roles: Role[], role: Role): Role[] {
  return roles.includes(role) ? roles.filter((candidate) => candidate !== role) : [...roles, role];
}

export function AdminScreen() {
  const api = useApp();
  const route = useAppRoute();
  const { state, workspaceId, access } = api;
  const workspace = state.workspaces.find((candidate) => candidate.id === workspaceId);
  const isAdmin = access?.membership.roles.includes('company_admin') ?? false;
  const accountingActive = api.productStatus('accounting') === 'active';

  const memberships = state.memberships.filter(
    (membership) => membership.workspaceId === workspaceId,
  );
  const seats = state.seats.filter((seat) => seat.workspaceId === workspaceId);
  const contacts = state.contacts.filter((contact) => contact.workspaceId === workspaceId);
  const accounts = state.accounts
    .filter((account) => account.workspaceId === workspaceId)
    .slice()
    .sort((left, right) => left.code.localeCompare(right.code));
  const archiveLog = state.archiveLog
    .filter((entry) => entry.workspaceId === workspaceId)
    .slice()
    .sort((left, right) => right.at.localeCompare(left.at));

  const activeTab: AdminTab =
    route?.page === 'company' ||
    route?.page === 'access' ||
    route?.page === 'entitlements' ||
    route?.page === 'masters' ||
    route?.page === 'numbering' ||
    route?.page === 'archive'
      ? route.page
      : 'access';
  const [memberTarget, setMemberTarget] = useState<Membership | null>(null);
  const [memberForm, setMemberForm] = useState<{
    roles: Role[];
    payrollDetail: boolean;
    archiveGrant: boolean;
    active: boolean;
  }>({ roles: [], payrollDetail: false, archiveGrant: false, active: true });
  const [entitlementTarget, setEntitlementTarget] = useState<ProductCode | null>(null);
  const [entitlementForm, setEntitlementForm] = useState({ active: true, expiresOn: '' });
  const [maintenanceForm, setMaintenanceForm] = useState(() => ({
    windowLabel: workspace?.settings.maintenance.windowLabel ?? '',
    scheduledFor: workspace?.settings.maintenance.scheduledFor ?? '',
    maxDurationMinutes: String(workspace?.settings.maintenance.maxDurationMinutes ?? 120),
    note: '',
  }));
  const [cutoverForm, setCutoverForm] = useState({
    cutoverDate: workspace?.settings.cutover?.proposedDate ?? api.clock.today,
    reason: '',
    confirmOpeningValue: '',
  });
  const [contactModal, setContactModal] = useState<Contact | 'new' | null>(null);
  const [contactForm, setContactForm] = useState<{
    name: string;
    tin: string;
    address: string;
    roles: Array<'customer' | 'vendor'>;
    active: boolean;
  }>({ name: '', tin: '', address: '', roles: ['customer'], active: true });
  const [accountOpen, setAccountOpen] = useState(false);
  const [accountErrors, setAccountErrors] = useState<{ code?: string; name?: string }>({});
  const [accountForm, setAccountForm] = useState<{
    code: string;
    name: string;
    type: Account['type'];
    normalBalance: Account['normalBalance'];
  }>({ code: '', name: '', type: 'asset', normalBalance: 'debit' });
  const initialNumbering = numberingPolicy(state, workspaceId, 'account');
  const [numberingKind, setNumberingKind] = useState<RecordKind>('account');
  const [numberingForm, setNumberingForm] = useState({
    prefix: initialNumbering.prefix,
    nextNumber: String(initialNumbering.startNumber),
    minDigits: String(initialNumbering.minDigits),
    increment: String(initialNumbering.increment),
    manualOverride: initialNumbering.manualOverride,
    reason: '',
  });
  const [importTexts, setImportTexts] = useState({ contacts: '', items: '', openings: '' });
  const [importMeta, setImportMeta] = useState({ postingDate: api.clock.today, approvalNote: '' });
  const [exportPreview, setExportPreview] = useState<CompanyArchive | null>(null);
  const [exportBusy, setExportBusy] = useState(false);
  const [restorePreview, setRestorePreview] = useState<RestorePreview>({ kind: 'none' });
  const [restoreReason, setRestoreReason] = useState('');
  const [restoreAcknowledged, setRestoreAcknowledged] = useState(false);

  const contactPreview = useMemo(() => parseContactsCsv(importTexts.contacts), [importTexts.contacts]);
  const itemPreview = useMemo(() => parseItemsCsv(importTexts.items), [importTexts.items]);
  const openingPreview = useMemo(() => {
    const parsed = parseOpeningsCsv(importTexts.openings);
    const rows: Array<{ accountId: string; debitCentavos: number; creditCentavos: number }> = [];
    const errors = [...parsed.errors];
    let debitTotal = 0;
    let creditTotal = 0;
    for (const row of parsed.rows) {
      const account = accounts.find(
        (candidate) => candidate.code === row.accountCode && candidate.active,
      );
      if (!account) {
        errors.push(`Account code ${row.accountCode} is not an active account in this company.`);
        continue;
      }
      rows.push({ accountId: account.id, debitCentavos: row.debitCentavos, creditCentavos: row.creditCentavos });
      debitTotal += row.debitCentavos;
      creditTotal += row.creditCentavos;
    }
    if (rows.length > 0 && debitTotal !== creditTotal) {
      errors.push(`Opening lines do not balance (debit ${money(debitTotal)} versus credit ${money(creditTotal)}).`);
    }
    return { rows, errors, debitTotal, creditTotal };
  }, [importTexts.openings, accounts]);

  const openMember = (membership: Membership) => {
    setMemberTarget(membership);
    setMemberForm({
      roles: [...membership.roles],
      payrollDetail: membership.payrollDetail,
      archiveGrant: membership.archiveGrant,
      active: membership.active,
    });
  };

  const submitMember = () => {
    if (!memberTarget) return;
    if (memberForm.roles.length === 0) {
      api.notify('error', 'Membership is incomplete', 'A member needs at least one role.');
      return;
    }
    const selfDemotion =
      memberTarget.userId === api.actorId &&
      (!memberForm.active || !memberForm.roles.includes('company_admin'));
    if (selfDemotion) {
      api.notify('error', 'Self-demotion blocked', 'You cannot remove your own active company-admin access.');
      return;
    }
    const result = api.dispatch({
      type: 'membership.update',
      input: {
        userId: memberTarget.userId,
        roles: memberForm.roles,
        payrollDetail: memberForm.payrollDetail,
        archiveGrant: memberForm.archiveGrant,
        active: memberForm.active,
      },
    });
    if (result) setMemberTarget(null);
  };

  const openEntitlement = (product: ProductCode) => {
    if (!workspace) return;
    const entitlement = workspace.entitlements[product];
    setEntitlementTarget(product);
    setEntitlementForm({ active: entitlement.active, expiresOn: entitlement.expiresOn ?? '' });
  };

  const submitEntitlement = () => {
    if (!entitlementTarget) return;
    if (entitlementForm.expiresOn.trim() !== '') {
      const parsed = dateField(entitlementForm.expiresOn, 'expiry date');
      if (!parsed.ok) {
        api.notify('error', 'Entitlement is incomplete', parsed.message);
        return;
      }
    }
    const result = api.dispatch({
      type: 'entitlement.update',
      input: {
        product: entitlementTarget,
        active: entitlementForm.active,
        expiresOn: entitlementForm.expiresOn.trim() === '' ? null : entitlementForm.expiresOn,
      },
    });
    if (result) setEntitlementTarget(null);
  };

  const submitMaintenance = (active: boolean) => {
    if (!workspace) return;
    const duration = positiveIntField(maintenanceForm.maxDurationMinutes, 'maximum duration');
    if (!duration.ok) {
      api.notify('error', 'Maintenance window is incomplete', duration.message);
      return;
    }
    if (!active && maintenanceForm.note.trim().length < 3) {
      api.notify('error', 'Completion note required', 'Record what was done before ending maintenance.');
      return;
    }
    const result = api.dispatch({
      type: 'maintenance.set',
      input: {
        active,
        windowLabel: maintenanceForm.windowLabel,
        scheduledFor: maintenanceForm.scheduledFor || undefined,
        maxDurationMinutes: duration.value ?? undefined,
        note: maintenanceForm.note || undefined,
      },
    });
    if (result) setMaintenanceForm({ ...maintenanceForm, note: '' });
  };

  const submitCutover = () => {
    if (!workspace?.settings.cutover) return;
    const reason = requiredField(cutoverForm.reason, 'activation reason');
    const date = dateField(cutoverForm.cutoverDate, 'cutover date');
    const confirm = moneyField(cutoverForm.confirmOpeningValue, 'opening value');
    const firstError = [reason, date, confirm].find((field) => !field.ok);
    if (firstError) {
      api.notify('error', 'Activation is incomplete', firstError.message);
      return;
    }
    const result = api.dispatch({
      type: 'workspace.activateAccounting',
      input: {
        cutoverDate: cutoverForm.cutoverDate,
        reason: cutoverForm.reason,
        confirmOpeningValueCentavos: confirm.value ?? -1,
      },
    });
    if (result) setCutoverForm({ ...cutoverForm, reason: '', confirmOpeningValue: '' });
  };

  const openContact = (contact: Contact | 'new') => {
    setContactModal(contact);
    if (contact === 'new') {
      setContactForm({ name: '', tin: '', address: '', roles: ['customer'], active: true });
    } else {
      setContactForm({
        name: contact.name,
        tin: contact.tin,
        address: contact.address,
        roles: [...contact.roles],
        active: contact.active,
      });
    }
  };

  const submitContact = () => {
    const name = requiredField(contactForm.name, 'contact name');
    if (!name.ok) {
      api.notify('error', 'Contact is incomplete', name.message);
      return;
    }
    if (contactForm.roles.length === 0) {
      api.notify('error', 'Contact is incomplete', 'Choose customer and/or vendor.');
      return;
    }
    const base = {
      name: contactForm.name,
      tin: contactForm.tin,
      address: contactForm.address,
      roles: contactForm.roles,
    };
    const result =
      contactModal === 'new'
        ? api.dispatch({ type: 'contact.create', input: base })
        : contactModal
          ? api.dispatch({
              type: 'contact.update',
              input: { ...base, contactId: contactModal.id, active: contactForm.active },
            })
          : null;
    if (result) setContactModal(null);
  };

  const currentNumberingPolicy = numberingPolicy(state, workspaceId, numberingKind);
  const numberingDirty =
    numberingForm.prefix !== currentNumberingPolicy.prefix ||
    Number(numberingForm.nextNumber) !== (isMasterKind(numberingKind) ? currentNumberingPolicy.startNumber : currentNumberingPolicy.nextNumber) ||
    Number(numberingForm.minDigits) !== currentNumberingPolicy.minDigits ||
    Number(numberingForm.increment) !== currentNumberingPolicy.increment ||
    numberingForm.manualOverride !== currentNumberingPolicy.manualOverride ||
    numberingForm.reason.trim().length > 0;
  const importsDirty =
    importTexts.contacts.trim().length > 0 ||
    importTexts.items.trim().length > 0 ||
    importTexts.openings.trim().length > 0 ||
    importMeta.approvalNote.trim().length > 0;
  useUnsavedChanges('admin-numbering', numberingDirty);
  useUnsavedChanges('admin-imports', importsDirty);
  const numberingDefinitionForKind = numberingDefinition(numberingKind);
  const numberingRoles = access?.membership.roles ?? [];
  const canManageNumbering =
    numberingDefinitionForKind.product === 'accounting'
      ? numberingRoles.includes('company_admin') || numberingRoles.includes('accountant')
      : numberingDefinitionForKind.product === 'payroll'
        ? numberingRoles.includes('company_admin') || numberingRoles.includes('payroll_officer')
        : numberingRoles.includes('company_admin') || numberingRoles.includes('inventory_officer');
  const numberingProductActive = api.productStatus(numberingDefinitionForKind.product) === 'active';
  const numberingPreviewValues = [0, 1, 2].map((step) => {
    const start = Number(numberingForm.nextNumber);
    const increment = Number(numberingForm.increment);
    return Number.isSafeInteger(start) && Number.isSafeInteger(increment) && increment > 0
      ? formatNumber(
          { prefix: numberingForm.prefix, minDigits: Number(numberingForm.minDigits) || 0 },
          start + step * increment,
        )
      : '—';
  });

  const selectNumberingKind = (kind: RecordKind) => {
    const policy = numberingPolicy(state, workspaceId, kind);
    setNumberingKind(kind);
    setNumberingForm({
      prefix: policy.prefix,
      nextNumber: String(isMasterKind(kind) ? policy.startNumber : policy.nextNumber),
      minDigits: String(policy.minDigits),
      increment: String(policy.increment),
      manualOverride: policy.manualOverride,
      reason: '',
    });
  };

  const masterKind = isMasterKind(numberingKind) ? numberingKind : null;
  const masterPreview = masterKind
    ? reconcileMasterCodes({ ...state, numberingPolicies: state.numberingPolicies.map((policy) =>
        policy.id === currentNumberingPolicy.id ? {
          ...policy, prefix: numberingForm.prefix.trim(), startNumber: Number(numberingForm.nextNumber),
          nextNumber: Number(numberingForm.nextNumber), minDigits: Number(numberingForm.minDigits),
          increment: Number(numberingForm.increment),
        } : policy) }, { workspaceId, kind: masterKind, rebase:
          numberingForm.prefix.trim() !== currentNumberingPolicy.prefix ||
          Number(numberingForm.nextNumber) !== currentNumberingPolicy.startNumber ||
          Number(numberingForm.minDigits) !== currentNumberingPolicy.minDigits ||
          Number(numberingForm.increment) !== currentNumberingPolicy.increment })
    : null;

  const submitNumbering = () => {
    const nextNumber = Number(numberingForm.nextNumber);
    const minDigits = Number(numberingForm.minDigits);
    const increment = Number(numberingForm.increment);
    const result = api.dispatch({
      type: 'numbering.policyUpdate',
      input: {
        kind: numberingKind,
        prefix: numberingForm.prefix,
        nextNumber,
        minDigits,
        increment,
        manualOverride: numberingForm.manualOverride,
        reason: numberingForm.reason,
      },
    });
    if (result) setNumberingForm((current) => ({ ...current, reason: '' }));
  };

  const submitAccount = () => {
    const accountPolicy = numberingPolicy(state, workspaceId, 'account');
    const code = accountPolicy.manualOverride
      ? requiredField(accountForm.code, 'account code')
      : { ok: true as const, value: '' };
    const name = requiredField(accountForm.name, 'account name');
    const firstError = [code, name].find((field) => !field.ok);
    setAccountErrors({
      code: code.ok ? undefined : code.message,
      name: name.ok ? undefined : name.message,
    });
    if (firstError && !firstError.ok) {
      focusField(!code.ok ? 'account-code' : 'account-name');
      api.notify('error', 'Account is incomplete', firstError.message);
      return;
    }
    const result = api.dispatch({
      type: 'account.create',
      input: {
        code: accountPolicy.manualOverride ? accountForm.code : '',
        name: accountForm.name,
        type: accountForm.type,
        normalBalance: accountForm.normalBalance,
      },
    });
    if (result) {
      setAccountErrors({});
      setAccountOpen(false);
    }
  };

  const submitImport = () => {
    if (
      contactPreview.errors.length > 0 ||
      itemPreview.errors.length > 0 ||
      openingPreview.errors.length > 0
    ) {
      api.notify('error', 'Import has errors', 'Fix every file error before importing.');
      return;
    }
    const total =
      contactPreview.contacts.length + itemPreview.items.length + openingPreview.rows.length;
    if (total === 0) {
      api.notify('error', 'Import has no rows', 'Provide contacts, items, or reconciled openings.');
      return;
    }
    const note = requiredField(importMeta.approvalNote, 'approval note');
    const date = dateField(importMeta.postingDate, 'posting date');
    const firstError = [note, date].find((field) => !field.ok);
    if (firstError) {
      api.notify('error', 'Import is incomplete', firstError.message);
      return;
    }
    const result = api.dispatch({
      type: 'masters.import',
      input: {
        contacts: contactPreview.contacts,
        items: itemPreview.items,
        openings: openingPreview.rows,
        postingDate: importMeta.postingDate,
        approvalNote: importMeta.approvalNote,
      },
    });
    if (result) {
      setImportTexts({ contacts: '', items: '', openings: '' });
      setImportMeta({ postingDate: api.clock.today, approvalNote: '' });
    }
  };

  const prepareExport = async () => {
    if (!canExportCompanyArchive(access?.membership ?? { roles: [], payrollDetail: false, archiveGrant: false, active: false }) || !workspace) {
      api.notify('error', 'Full-company archive not authorized', 'Requires active company admin plus both the payroll-detail and archive grants.');
      return;
    }
    setExportBusy(true);
    try {
      const built = buildCompanyArchive(state, workspaceId, api.actorId, api.clock.nowIso);
      if (!built.ok) {
        api.notify('error', 'Archive could not be built', built.error.message);
        return;
      }
      const sealed = await sealCompanyArchive(built.value);
      setExportPreview(sealed);
    } catch (error) {
      api.notify('error', 'Archive could not be built', error instanceof Error ? error.message : String(error));
    } finally {
      setExportBusy(false);
    }
  };

  const downloadArchive = () => {
    if (!exportPreview) return;
    downloadText(
      `ece-accounting-company-${exportPreview.workspaceId}-${exportPreview.createdAt.slice(0, 10)}.json`,
      JSON.stringify(exportPreview, null, 2),
    );
    api.notify('success', 'Archive downloaded', `Checksum ${archiveChecksumPrefix(exportPreview.checksum)}… · plaintext synthetic data.`);
  };

  const pickRestoreFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const raw: unknown = JSON.parse(await file.text());
      const verified = await verifyCompanyArchive(raw);
      if (!verified.ok) {
        setRestorePreview({ kind: 'error', message: verified.message });
        return;
      }
      setRestorePreview({
        kind: 'ready',
        archive: verified.archive,
        checksum: verified.checksum,
        counts: archiveCounts(verified.archive),
      });
    } catch (error) {
      setRestorePreview({
        kind: 'error',
        message: `The file is not readable JSON: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  };

  const submitRestore = () => {
    if (restorePreview.kind !== 'ready') return;
    if (restoreReason.trim().length < 3) {
      api.notify('error', 'Restore reason required', 'Describe why this archive is being restored.');
      return;
    }
    if (!restoreAcknowledged) {
      api.notify('error', 'Acknowledge the replacement', 'Confirm you understand the company records will be replaced.');
      return;
    }
    const result = api.dispatch({
      type: 'archive.restore',
      input: {
        archive: restorePreview.archive,
        reason: restoreReason,
        expectedChecksum: restorePreview.checksum,
      },
    });
    if (result) {
      setRestorePreview({ kind: 'none' });
      setRestoreReason('');
      setRestoreAcknowledged(false);
    }
  };

  const canArchive = canExportCompanyArchive(
    access?.membership ?? { roles: [], payrollDetail: false, archiveGrant: false, active: false },
  );

  return (
    <div className="screen">
      {!isAdmin && (
        <div className="callout callout-info" role="status">
          Access changes, entitlements, maintenance, cutover, and archive restore require a company
          administrator in this demo. Browser-local role checks are a simulation, not production
          tenant security.
        </div>
      )}

      {activeTab === 'company' && workspace && (
        <>
          <Panel
            title="Company record"
            subtitle="The legal company is the workspace boundary. Product entitlements and membership determine what this demo actor can do."
          >
            <dl className="definition-grid">
              <div>
                <dt>Legal name</dt>
                <dd>{workspace.legalName}</dd>
              </div>
              <div>
                <dt>TIN</dt>
                <dd>{workspace.tin}</dd>
              </div>
              <div>
                <dt>Fiscal year starts</dt>
                <dd>{workspace.fiscalYearStartMonth === 1 ? 'January (calendar year)' : `Month ${workspace.fiscalYearStartMonth}`}</dd>
              </div>
              <div>
                <dt>Demo workspace ID</dt>
                <dd className="mono">{workspace.id}</dd>
              </div>
            </dl>
            <p className="muted">
              Company identity is fixed in the synthetic fixture. This mockup does not simulate
              legal registration, BIR filing, or production tenant configuration.
            </p>
          </Panel>
          <Panel
            title="Maintenance window"
            subtitle="A scheduled or active maintenance window in this demo blocks selected writes; it is not a production maintenance system."
          >
            <dl className="definition-grid">
              <div>
                <dt>Status</dt>
                <dd>{workspace.settings.maintenance.active ? 'Active' : 'Not active'}</dd>
              </div>
              <div>
                <dt>Window</dt>
                <dd>{workspace.settings.maintenance.windowLabel}</dd>
              </div>
              <div>
                <dt>Scheduled for</dt>
                <dd>{workspace.settings.maintenance.scheduledFor || 'Not scheduled'}</dd>
              </div>
              <div>
                <dt>Maximum duration</dt>
                <dd>{workspace.settings.maintenance.maxDurationMinutes} minutes</dd>
              </div>
            </dl>
            <p className="muted">
              Schedule or end the window on <a href="#/admin/access">Access</a>, which also
              holds members, roles and privileged grants.
            </p>
          </Panel>
        </>
      )}

      {activeTab === 'numbering' && (
        <>
          <Panel
            title="Numbering policies"
            subtitle="Business codes are display and search values; immutable internal record IDs remain the keys for relationships and routes."
          >
            <div className="table-wrap">
              <table className="data-table">
                <caption>Current company codes and next values</caption>
                <thead>
                  <tr>
                    <th scope="col">Record kind</th>
                    <th scope="col">Prefix</th>
                    <th scope="col">Start</th>
                    <th scope="col">Next</th>
                    <th scope="col">Minimum digits</th>
                    <th scope="col">Increment</th>
                  </tr>
                </thead>
                <tbody>
                  {NUMBERING_KINDS.map((definition) => {
                    const policy = numberingPolicy(state, workspaceId, definition.kind);
                    return (
                      <tr key={definition.kind}>
                        <th scope="row">{definition.label}</th>
                        <td>
                          <code>{policy.prefix || '(none)'}</code>
                        </td>
                        <td>
                          <code>{formatNumber(policy, policy.startNumber)}</code>
                        </td>
                        <td>
                          <code>{formatNumber(policy, policy.nextNumber)}</code>
                        </td>
                        <td>{policy.minDigits}</td>
                        <td>{policy.increment}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="callout callout-info">
              Master codes follow the policy, including existing records. Posted document snapshots and internal IDs are preserved.
            </p>
          </Panel>
          <Panel
            title={canManageNumbering ? 'Change one series' : 'View one series'}
            subtitle="Policy changes are company-scoped, privileged and audited. Internal IDs never change."
          >
            <div className="form-grid">
              <Field
                label="Record kind"
                htmlFor="numbering-kind"
                hint="Each company has its own series. Master policies govern existing and new codes; issued document numbers stay unchanged."
              >
                <select
                  id="numbering-kind"
                  value={numberingKind}
                  onChange={(event) => selectNumberingKind(event.target.value as RecordKind)}
                >
                  {NUMBERING_KINDS.map((definition) => (
                    <option key={definition.kind} value={definition.kind}>
                      {definition.label}
                    </option>
                  ))}
                </select>
              </Field>
              {canManageNumbering && numberingProductActive && (
                <>
                  <Field label="Prefix" htmlFor="numbering-prefix">
                    <input
                      id="numbering-prefix"
                      value={numberingForm.prefix}
                      onChange={(event) =>
                        setNumberingForm({ ...numberingForm, prefix: event.target.value })
                      }
                    />
                  </Field>
                  <Field label={isMasterKind(numberingKind) ? "Starting number" : "Next number"} htmlFor="numbering-next">
                    <input
                      id="numbering-next"
                      type="number"
                      min="1"
                      step="1"
                      value={numberingForm.nextNumber}
                      onChange={(event) =>
                        setNumberingForm({ ...numberingForm, nextNumber: event.target.value })
                      }
                    />
                  </Field>
                  <Field label="Minimum digits" htmlFor="numbering-digits">
                    <input
                      id="numbering-digits"
                      type="number"
                      min="0"
                      max="12"
                      step="1"
                      value={numberingForm.minDigits}
                      onChange={(event) =>
                        setNumberingForm({ ...numberingForm, minDigits: event.target.value })
                      }
                    />
                  </Field>
                  <Field label="Increment" htmlFor="numbering-increment">
                    <input
                      id="numbering-increment"
                      type="number"
                      min="1"
                      step="1"
                      value={numberingForm.increment}
                      onChange={(event) =>
                        setNumberingForm({ ...numberingForm, increment: event.target.value })
                      }
                    />
                  </Field>
                  <Field label="Change reason" htmlFor="numbering-reason">
                    <textarea
                      id="numbering-reason"
                      value={numberingForm.reason}
                      onChange={(event) =>
                        setNumberingForm({ ...numberingForm, reason: event.target.value })
                      }
                    />
                  </Field>
                </>
              )}
            </div>
            {canManageNumbering && numberingProductActive ? (
              <>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={numberingForm.manualOverride}
                    onChange={(event) =>
                      setNumberingForm({ ...numberingForm, manualOverride: event.target.checked })
                    }
                  />
                  <span>Allow selecting an unused code within this policy</span>
                </label>
                <p>
                  Preview: <code>{numberingPreviewValues.join(' · ')}</code>
                </p>
                <p className="muted">
                  Current saved next code:{' '}
                  <code>{formatNumber(currentNumberingPolicy, currentNumberingPolicy.nextNumber)}</code>
                  {numberingForm.prefix !== currentNumberingPolicy.prefix ||
                  Number(numberingForm.nextNumber) !== (isMasterKind(numberingKind) ? currentNumberingPolicy.startNumber : currentNumberingPolicy.nextNumber)
                    ? ' · unsaved change'
                    : ''}
                </p>
                {masterPreview && (masterPreview.ok ? (
                  <div className="callout callout-info" role="status">
                    <p>This policy governs all {(masterKind ? masterRecords(state, workspaceId, masterKind).length : 0)} current master records and new records. {masterPreview.value.changes.length} current codes will change. Internal IDs and posted document snapshots are preserved.</p>
                    {masterPreview.value.changes.slice(0, 5).map((change) => (
                      <p key={change.recordId}><code>{change.previousCode}</code> → <code>{change.code}</code></p>
                    ))}
                    <p>Next new record: <code>{formatNumber(numberingPolicy(masterPreview.value.state, workspaceId, numberingKind), numberingPolicy(masterPreview.value.state, workspaceId, numberingKind).nextNumber)}</code></p>
                  </div>
                ) : <p className="field-error" role="alert">{masterPreview.error.message}</p>)}
                <div className="button-row">
                  <button type="button" className="primary" onClick={submitNumbering} disabled={masterPreview !== null && !masterPreview.ok}>
                    Save numbering policy
                  </button>
                </div>
              </>
            ) : (
              <p className="muted">
                {canManageNumbering
                  ? `The ${numberingDefinitionForKind.product} product is not active for this company, so this series cannot be changed. Switch record kind to view a series whose product is active.`
                  : 'Your role can view the next code but cannot change numbering policy. Only an accountant/company administrator or the owning payroll or inventory role may change it.'}
              </p>
            )}
            <p>
              Next {numberingDefinitionForKind.label.toLowerCase()}:{' '}
              <code>{previewCodes(state, workspaceId, numberingKind, 3).join(' · ')}</code>
            </p>
          </Panel>
        </>
      )}

      {activeTab === 'access' && (
        <>
          <Panel
            title="Members, roles and privileged grants"
            subtitle="Company admin, payroll-detail, and archive grants are separate on purpose. A role does not imply access to payslips or to a full archive."
          >
            <div className="table-wrap">
              <table className="data-table">
                <caption>Workspace memberships</caption>
                <thead>
                  <tr>
                    <th scope="col">Member</th>
                    <th scope="col">Roles</th>
                    <th scope="col">Payroll detail</th>
                    <th scope="col">Archive grant</th>
                    <th scope="col">Seat</th>
                    <th scope="col">Active</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {memberships.map((membership) => {
                    const user = state.users.find((candidate) => candidate.id === membership.userId);
                    const seat = seats.find((candidate) => candidate.id === membership.seatId);
                    return (
                      <tr key={membership.userId}>
                        <th scope="row">{user?.name ?? membership.userId}</th>
                        <td>{membership.roles.map(titleCase).join(', ')}</td>
                        <td>{membership.payrollDetail ? 'Granted' : '—'}</td>
                        <td>{membership.archiveGrant ? 'Granted' : '—'}</td>
                        <td>{seat?.label ?? '—'}</td>
                        <td>{membership.active ? 'Active' : 'Inactive'}</td>
                        <td className="actions">
                          <button
                            type="button"
                            className="link-button"
                            disabled={!isAdmin}
                            onClick={() => openMember(membership)}
                          >
                            Edit
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <h3>Seats</h3>
            <table className="data-table">
              <caption>Seat assignments</caption>
              <thead>
                <tr>
                  <th scope="col">Seat</th>
                  <th scope="col">Assigned member</th>
                </tr>
              </thead>
              <tbody>
                {seats.map((seat: Seat) => (
                  <tr key={seat.id}>
                    <th scope="row">{seat.label}</th>
                    <td>
                      {state.users.find((user) => user.id === seat.assignedUserId)?.name ?? (
                        <span className="muted">Unassigned</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>

          <Panel
            title="Maintenance mode"
            subtitle="Maintenance blocks ordinary writes while authorized export stays available. Starting or ending it is itself the only allowed write while active."
          >
            {workspace?.settings.maintenance.active ? (
              <div className="callout callout-warn" role="status">
                <strong>Maintenance is active.</strong> Started{' '}
                {humanTimestamp(workspace.settings.maintenance.startedAt)} by{' '}
                {state.users.find((user) => user.id === workspace.settings.maintenance.startedBy)?.name ??
                  workspace.settings.maintenance.startedBy}
                . Ordinary writes are rejected until it ends.
              </div>
            ) : (
              <p className="muted">
                Maintenance is off. Window: {workspace?.settings.maintenance.windowLabel}. Maximum
                duration {workspace?.settings.maintenance.maxDurationMinutes} minutes.
              </p>
            )}
            <div className="form-grid">
              <Field label="Window label" htmlFor="maintenance-label">
                <input
                  id="maintenance-label"
                  value={maintenanceForm.windowLabel}
                  onChange={(event) =>
                    setMaintenanceForm({ ...maintenanceForm, windowLabel: event.target.value })
                  }
                />
              </Field>
              <Field label="Scheduled for (display only)" htmlFor="maintenance-scheduled">
                <input
                  id="maintenance-scheduled"
                  value={maintenanceForm.scheduledFor}
                  onChange={(event) =>
                    setMaintenanceForm({ ...maintenanceForm, scheduledFor: event.target.value })
                  }
                />
              </Field>
              <Field label="Maximum duration (minutes)" htmlFor="maintenance-duration">
                <input
                  id="maintenance-duration"
                  inputMode="numeric"
                  value={maintenanceForm.maxDurationMinutes}
                  onChange={(event) =>
                    setMaintenanceForm({ ...maintenanceForm, maxDurationMinutes: event.target.value })
                  }
                />
              </Field>
              <Field
                label={workspace?.settings.maintenance.active ? 'Completion note (required)' : 'Start note (optional)'}
                htmlFor="maintenance-note"
              >
                <input
                  id="maintenance-note"
                  value={maintenanceForm.note}
                  onChange={(event) => setMaintenanceForm({ ...maintenanceForm, note: event.target.value })}
                />
              </Field>
            </div>
            <div className="button-row">
              {workspace?.settings.maintenance.active ? (
                <button type="button" className="primary" disabled={!isAdmin} onClick={() => submitMaintenance(false)}>
                  End maintenance
                </button>
              ) : (
                <button type="button" className="primary" disabled={!isAdmin} onClick={() => submitMaintenance(true)}>
                  Start maintenance
                </button>
              )}
              <span className="muted">
                Export remains available in both states; restore and every ordinary write are blocked
                while maintenance is active.
              </span>
            </div>
          </Panel>
        </>
      )}

      {activeTab === 'entitlements' && workspace && (
        <>
          <Panel
            title="Product entitlements"
            subtitle="Payroll and Inventory stand alone. Accounting expiry blocks posting but not operational records already kept."
          >
            <div className="table-wrap">
              <table className="data-table">
                <caption>Entitlements for {workspace.name}</caption>
                <thead>
                  <tr>
                    <th scope="col">Product</th>
                    <th scope="col">Status</th>
                    <th scope="col">Activated on</th>
                    <th scope="col">Expires on</th>
                    <th scope="col">Enabled</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {PRODUCTS.map((product) => {
                    const entitlement = workspace.entitlements[product];
                    return (
                      <tr key={product}>
                        <th scope="row">{titleCase(product)}</th>
                        <td>
                          <StatusBadge status={api.productStatus(product)} />
                        </td>
                        <td>{humanDate(entitlement.activatedOn)}</td>
                        <td>{entitlement.expiresOn ? humanDate(entitlement.expiresOn) : 'No expiry'}</td>
                        <td>{entitlement.active ? 'Yes' : 'No'}</td>
                        <td className="actions">
                          <button
                            type="button"
                            className="link-button"
                            disabled={!isAdmin}
                            onClick={() => openEntitlement(product)}
                          >
                            Change
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="muted">
              Expiry is compared against the demo clock ({humanDate(api.clock.today)}). Expired
              products stay readable but reject writes at the command seam.
            </p>
          </Panel>

          <Panel
            title="Standalone cutover to Accounting"
            subtitle="Company B keeps inventory and payroll before Accounting. Activation needs the exact approved opening value and does not replay historical stock movements."
          >
            {!workspace.settings.cutover ? (
              <EmptyState title="No standalone cutover proposal for this company" />
            ) : workspace.settings.cutover.status === 'activated' ? (
              <dl className="definition-grid">
                <div>
                  <dt>Status</dt>
                  <dd>Activated</dd>
                </div>
                <div>
                  <dt>Approved date</dt>
                  <dd>{humanDate(workspace.settings.cutover.approvedDate)}</dd>
                </div>
                <div>
                  <dt>Approved by</dt>
                  <dd>
                    {state.users.find((user) => user.id === workspace.settings.cutover?.approvedBy)?.name ?? '—'}
                  </dd>
                </div>
                <div>
                  <dt>Opening inventory value</dt>
                  <dd>{money(workspace.settings.cutover.inventoryOpeningValueCentavos)}</dd>
                </div>
              </dl>
            ) : (
              <>
                <dl className="definition-grid">
                  <div>
                    <dt>Proposed date</dt>
                    <dd>{humanDate(workspace.settings.cutover.proposedDate)}</dd>
                  </div>
                  <div>
                    <dt>Approved opening value</dt>
                    <dd>{money(workspace.settings.cutover.inventoryOpeningValueCentavos)}</dd>
                  </div>
                </dl>
                <p className="callout callout-info">{workspace.settings.cutover.notes}</p>
                <div className="form-grid">
                  <Field label="Cutover date" htmlFor="cutover-date">
                    <input
                      id="cutover-date"
                      type="date"
                      value={cutoverForm.cutoverDate}
                      onChange={(event) => setCutoverForm({ ...cutoverForm, cutoverDate: event.target.value })}
                    />
                  </Field>
                  <Field
                    label="Confirm opening value (PHP)"
                    htmlFor="cutover-value"
                    hint={`Must equal ${money(workspace.settings.cutover.inventoryOpeningValueCentavos)} exactly.`}
                  >
                    <input
                      id="cutover-value"
                      inputMode="decimal"
                      value={cutoverForm.confirmOpeningValue}
                      onChange={(event) =>
                        setCutoverForm({ ...cutoverForm, confirmOpeningValue: event.target.value })
                      }
                    />
                  </Field>
                  <Field label="Activation reason" htmlFor="cutover-reason">
                    <input
                      id="cutover-reason"
                      value={cutoverForm.reason}
                      onChange={(event) => setCutoverForm({ ...cutoverForm, reason: event.target.value })}
                    />
                  </Field>
                </div>
                <button type="button" className="primary" disabled={!isAdmin} onClick={submitCutover}>
                  Activate Accounting once
                </button>
              </>
            )}
          </Panel>
        </>
      )}

      {activeTab === 'masters' && (
        <>
          {!accountingActive && workspace?.settings.cutover?.status !== 'proposed' && (
            <div className="callout callout-warn" role="status">
              Accounting is not active and this company has no approved standalone onboarding
              proposal, so master imports and new contacts are blocked.
            </div>
          )}
          <Panel
            title="Contacts"
            subtitle="Customers and vendors are shared masters. Payroll and Inventory remain usable without Accounting, but new contacts belong to Accounting."
            actions={
              <button
                type="button"
                className="primary"
                disabled={!accountingActive}
                onClick={() => openContact('new')}
              >
                Add contact
              </button>
            }
          >
            {contacts.length === 0 ? (
              <EmptyState title="No contacts in this company" />
            ) : (
              <div className="table-wrap">
                <table className="data-table">
                  <caption>Contact master</caption>
                  <thead>
                    <tr>
                      <th scope="col">Contact no.</th>
                      <th scope="col">Name</th>
                      <th scope="col">TIN</th>
                      <th scope="col">Roles</th>
                      <th scope="col">Address</th>
                      <th scope="col">Active</th>
                      <th scope="col">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {contacts.map((contact) => (
                      <tr key={contact.id}>
                        <th scope="row">{contact.contactNo}</th>
                        <td>{contact.name}</td>
                        <td>{contact.tin || '—'}</td>
                        <td>{contact.roles.map(titleCase).join(', ')}</td>
                        <td>{contact.address || '—'}</td>
                        <td>{contact.active ? 'Yes' : 'No'}</td>
                        <td className="actions">
                          <button
                            type="button"
                            className="link-button"
                            disabled={!accountingActive}
                            onClick={() => openContact(contact)}
                          >
                            Edit
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          <Panel
            title="Chart of accounts"
            subtitle="New accounts start without a control role, so automatic postings keep using the existing mapped accounts."
            actions={
              <button
                type="button"
                className="primary"
                disabled={!accountingActive}
                onClick={() => {
                  setAccountForm({ code: '', name: '', type: 'asset', normalBalance: 'debit' });
                  setAccountOpen(true);
                }}
              >
                Add account
              </button>
            }
          >
            <div className="table-wrap">
              <table className="data-table">
                <caption>Accounts</caption>
                <thead>
                  <tr>
                    <th scope="col">Code</th>
                    <th scope="col">Name</th>
                    <th scope="col">Type</th>
                    <th scope="col">Normal balance</th>
                    <th scope="col">Control role</th>
                    <th scope="col">Active</th>
                  </tr>
                </thead>
                <tbody>
                  {accounts.map((account) => (
                    <tr key={account.id}>
                      <th scope="row">{account.code}</th>
                      <td>{account.name}</td>
                      <td>{titleCase(account.type)}</td>
                      <td>{titleCase(account.normalBalance)}</td>
                      <td>{account.controlRole ?? '—'}</td>
                      <td>{account.active ? 'Yes' : 'No'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>

          <Panel
            title="Import masters and reconciled openings"
            subtitle="One approved batch. Opening lines must balance, resolve to active accounts, and may be posted only once."
          >
            <div className="import-grid">
              <div>
                <Field label="Contacts CSV" htmlFor="import-contacts">
                  <textarea
                    id="import-contacts"
                    rows={5}
                    value={importTexts.contacts}
                    onChange={(event) =>
                      setImportTexts({ ...importTexts, contacts: event.target.value })
                    }
                    placeholder={CONTACTS_CSV_TEMPLATE}
                  />
                </Field>
                <div className="button-row">
                  <input
                    type="file"
                    accept=".csv,text/csv"
                    aria-label="Contacts CSV file"
                    onChange={async (event) =>
                      setImportTexts({
                        ...importTexts,
                        contacts: (await event.target.files?.[0]?.text()) ?? '',
                      })
                    }
                  />
                  <button
                    type="button"
                    onClick={() => downloadText('ece-accounting-contacts-template.csv', CONTACTS_CSV_TEMPLATE)}
                  >
                    Template
                  </button>
                </div>
                <p className="muted">
                  {contactPreview.contacts.length} contact row(s).{' '}
                  {contactPreview.errors.length > 0 && `${contactPreview.errors.length} error(s).`}
                </p>
                {contactPreview.errors.map((error, index) => (
                  <p key={index} className="field-error">
                    {error}
                  </p>
                ))}
              </div>
              <div>
                <Field label="Items CSV" htmlFor="import-items">
                  <textarea
                    id="import-items"
                    rows={5}
                    value={importTexts.items}
                    onChange={(event) => setImportTexts({ ...importTexts, items: event.target.value })}
                    placeholder={ITEMS_CSV_TEMPLATE}
                  />
                </Field>
                <div className="button-row">
                  <input
                    type="file"
                    accept=".csv,text/csv"
                    aria-label="Items CSV file"
                    onChange={async (event) =>
                      setImportTexts({
                        ...importTexts,
                        items: (await event.target.files?.[0]?.text()) ?? '',
                      })
                    }
                  />
                  <button
                    type="button"
                    onClick={() => downloadText('ece-accounting-items-template.csv', ITEMS_CSV_TEMPLATE)}
                  >
                    Template
                  </button>
                </div>
                <p className="muted">
                  {itemPreview.items.length} item row(s).{' '}
                  {itemPreview.errors.length > 0 && `${itemPreview.errors.length} error(s).`}
                </p>
                {itemPreview.errors.map((error, index) => (
                  <p key={index} className="field-error">
                    {error}
                  </p>
                ))}
              </div>
              <div>
                <Field label="Opening balances CSV" htmlFor="import-openings">
                  <textarea
                    id="import-openings"
                    rows={5}
                    value={importTexts.openings}
                    onChange={(event) =>
                      setImportTexts({ ...importTexts, openings: event.target.value })
                    }
                    placeholder={OPENINGS_CSV_TEMPLATE}
                  />
                </Field>
                <div className="button-row">
                  <input
                    type="file"
                    accept=".csv,text/csv"
                    aria-label="Opening balances CSV file"
                    onChange={async (event) =>
                      setImportTexts({
                        ...importTexts,
                        openings: (await event.target.files?.[0]?.text()) ?? '',
                      })
                    }
                  />
                  <button
                    type="button"
                    onClick={() => downloadText('ece-accounting-openings-template.csv', OPENINGS_CSV_TEMPLATE)}
                  >
                    Template
                  </button>
                </div>
                <p className="muted">
                  {openingPreview.rows.length} opening line(s) · debit {money(openingPreview.debitTotal)}{' '}
                  · credit {money(openingPreview.creditTotal)}
                </p>
                {openingPreview.errors.map((error, index) => (
                  <p key={index} className="field-error">
                    {error}
                  </p>
                ))}
              </div>
            </div>
            <div className="form-grid">
              <Field label="Posting date" htmlFor="import-date">
                <input
                  id="import-date"
                  type="date"
                  value={importMeta.postingDate}
                  onChange={(event) =>
                    setImportMeta({ ...importMeta, postingDate: event.target.value })
                  }
                />
              </Field>
              <Field label="Approval note" htmlFor="import-note">
                <input
                  id="import-note"
                  value={importMeta.approvalNote}
                  onChange={(event) =>
                    setImportMeta({ ...importMeta, approvalNote: event.target.value })
                  }
                />
              </Field>
            </div>
            <div className="button-row">
              <button
                type="button"
                className="primary"
                disabled={!accountingActive && workspace?.settings.cutover?.status !== 'proposed'}
                onClick={submitImport}
              >
                Import approved batch
              </button>
              <span className="muted">
                Openings post one balanced journal; repeating the import is rejected while an opening
                journal already exists.
              </span>
            </div>
          </Panel>
        </>
      )}

      {activeTab === 'archive' && (
        <>
          <Panel
            title="Company archive export"
            subtitle="Plaintext synthetic JSON for this company only. The checksum detects accidental change; it is not encryption, a signature, or proof of delivery."
          >
            <p className="callout callout-info">{workspace?.settings.archiveNote}</p>
            <ul className="compact-list">
              <li>Includes only the selected company&apos;s records, settings, source references, and receipts.</li>
              <li>No uploaded binaries exist in this mockup, so none are included or claimed.</li>
              <li>Requires active company admin plus the payroll-detail and archive grants.</li>
            </ul>
            <div className="button-row">
              <button type="button" className="primary" disabled={!canArchive || exportBusy} onClick={prepareExport}>
                {exportBusy ? 'Building archive…' : 'Prepare archive'}
              </button>
              <span className="muted">
                {canArchive
                  ? 'Your demo membership holds all three privileges.'
                  : 'Your demo membership lacks at least one required privilege.'}
              </span>
            </div>
            {exportPreview && (
              <div className="archive-preview">
                <dl className="definition-grid">
                  <div>
                    <dt>Company</dt>
                    <dd>{exportPreview.workspaceId}</dd>
                  </div>
                  <div>
                    <dt>Created</dt>
                    <dd>{humanTimestamp(exportPreview.createdAt)}</dd>
                  </div>
                  <div>
                    <dt>Checksum</dt>
                    <dd className="mono">{exportPreview.checksum}</dd>
                  </div>
                </dl>
                <h3>Manifest counts</h3>
                <table className="data-table">
                  <tbody>
                    {Object.entries(archiveCounts(exportPreview))
                      .filter(([, count]) => count > 0)
                      .sort(([left], [right]) => left.localeCompare(right))
                      .map(([key, count]) => (
                        <tr key={key}>
                          <th scope="row">{titleCase(key)}</th>
                          <td className="numeric">{count}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
                <button type="button" onClick={downloadArchive}>
                  Download sealed archive JSON
                </button>
              </div>
            )}
          </Panel>

          <Panel
            title="Restore a company archive"
            subtitle="Verify the checksum, review the manifest, then replace only this company. A mixed-company or inconsistent file changes nothing."
          >
            <div className="form-grid">
              <Field label="Archive JSON file" htmlFor="restore-file">
                <input
                  id="restore-file"
                  type="file"
                  accept=".json,application/json"
                  onChange={async (event) => {
                    await pickRestoreFile(event.target.files?.[0]);
                  }}
                />
              </Field>
              <Field label="Restore reason" htmlFor="restore-reason">
                <input
                  id="restore-reason"
                  value={restoreReason}
                  onChange={(event) => setRestoreReason(event.target.value)}
                />
              </Field>
            </div>
            {restorePreview.kind === 'error' && (
              <div className="callout callout-error" role="alert">
                <strong>Archive rejected.</strong> {restorePreview.message} Existing state is unchanged.
              </div>
            )}
            {restorePreview.kind === 'ready' && (
              <div className="archive-preview">
                <dl className="definition-grid">
                  <div>
                    <dt>Verified company</dt>
                    <dd>{restorePreview.archive.workspaceId}</dd>
                  </div>
                  <div>
                    <dt>Created</dt>
                    <dd>{humanTimestamp(restorePreview.archive.createdAt)}</dd>
                  </div>
                  <div>
                    <dt>Checksum matches</dt>
                    <dd>
                      <StatusBadge status="verified" /> <span className="mono small">{restorePreview.checksum}</span>
                    </dd>
                  </div>
                </dl>
                <p className="muted">
                  {Object.entries(restorePreview.counts)
                    .filter(([, count]) => count > 0)
                    .map(([key, count]) => `${titleCase(key)}: ${count}`)
                    .join(' · ')}
                </p>
                {restorePreview.archive.workspaceId !== workspaceId && (
                  <div className="callout callout-error" role="alert">
                    This archive belongs to another company. Select that company before restoring; the
                    command will reject a cross-company restore.
                  </div>
                )}
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={restoreAcknowledged}
                    onChange={(event) => setRestoreAcknowledged(event.target.checked)}
                  />
                  <span>
                    I understand this replaces the current synthetic records for{' '}
                    {restorePreview.archive.workspaceId} only, and appends an audit log entry.
                  </span>
                </label>
                <button type="button" className="danger" disabled={!isAdmin} onClick={submitRestore}>
                  Restore verified archive
                </button>
              </div>
            )}
          </Panel>

          <Panel
            title="Archive log"
            subtitle="Only authorized restores append here. Export is a read-only build and download, so it does not create a log entry."
          >
            {archiveLog.length === 0 ? (
              <EmptyState title="No restores recorded for this company" />
            ) : (
              <div className="table-wrap">
                <table className="data-table">
                  <caption>Restore history</caption>
                  <thead>
                    <tr>
                      <th scope="col">When</th>
                      <th scope="col">Action</th>
                      <th scope="col">By</th>
                      <th scope="col">File</th>
                      <th scope="col">Checksum</th>
                      <th scope="col">Reason</th>
                      <th scope="col">Counts</th>
                    </tr>
                  </thead>
                  <tbody>
                    {archiveLog.map((entry) => (
                      <tr key={entry.id}>
                        <th scope="row">{humanTimestamp(entry.at)}</th>
                        <td>{titleCase(entry.action)}</td>
                        <td>{state.users.find((user) => user.id === entry.by)?.name ?? entry.by}</td>
                        <td>{entry.fileName}</td>
                        <td className="mono small">{entry.checksumPrefix}…</td>
                        <td>{entry.reason ?? '—'}</td>
                        <td className="small">
                          {Object.entries(entry.counts)
                            .filter(([, count]) => count > 0)
                            .map(([key, count]) => `${titleCase(key)}: ${count}`)
                            .join(' · ')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </>
      )}

      <Modal
        open={memberTarget !== null}
        title="Edit membership"
        onClose={() => setMemberTarget(null)}
        footer={
          <>
            <button type="button" onClick={() => setMemberTarget(null)}>
              Cancel
            </button>
            <button type="button" className="primary" onClick={submitMember}>
              Save membership
            </button>
          </>
        }
      >
        {memberTarget && (
          <>
            <p>
              <strong>{state.users.find((user) => user.id === memberTarget.userId)?.name}</strong> ·{' '}
              {state.users.find((user) => user.id === memberTarget.userId)?.title}
            </p>
            <fieldset className="check-group">
              <legend>Roles</legend>
              {ROLES.map((role) => (
                <label key={role} className="check-row">
                  <input
                    type="checkbox"
                    checked={memberForm.roles.includes(role)}
                    onChange={() =>
                      setMemberForm({ ...memberForm, roles: toggleRole(memberForm.roles, role) })
                    }
                  />
                  <span>{titleCase(role)}</span>
                </label>
              ))}
            </fieldset>
            <fieldset className="check-group">
              <legend>Privileged grants</legend>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={memberForm.payrollDetail}
                  onChange={(event) =>
                    setMemberForm({ ...memberForm, payrollDetail: event.target.checked })
                  }
                />
                <span>Payroll detail (salaries, time rows, payslips, worksheets)</span>
              </label>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={memberForm.archiveGrant}
                  onChange={(event) =>
                    setMemberForm({ ...memberForm, archiveGrant: event.target.checked })
                  }
                />
                <span>Company archive export/restore authority</span>
              </label>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={memberForm.active}
                  onChange={(event) => setMemberForm({ ...memberForm, active: event.target.checked })}
                />
                <span>Active member</span>
              </label>
            </fieldset>
            {memberTarget.userId === api.actorId && (
              <p className="callout callout-warn">
                You cannot remove your own active company-admin access. The command rejects it too.
              </p>
            )}
          </>
        )}
      </Modal>

      <Modal
        open={entitlementTarget !== null}
        title={entitlementTarget ? `Change ${titleCase(entitlementTarget)} entitlement` : 'Change entitlement'}
        onClose={() => setEntitlementTarget(null)}
        footer={
          <>
            <button type="button" onClick={() => setEntitlementTarget(null)}>
              Cancel
            </button>
            <button type="button" className="primary" onClick={submitEntitlement}>
              Save entitlement
            </button>
          </>
        }
      >
        <label className="check-row">
          <input
            type="checkbox"
            checked={entitlementForm.active}
            onChange={(event) => setEntitlementForm({ ...entitlementForm, active: event.target.checked })}
          />
          <span>Entitlement enabled</span>
        </label>
        <Field
          label="Expires on (blank for no expiry)"
          htmlFor="entitlement-expiry"
          hint="An expiry in the past makes the product read-only immediately."
        >
          <input
            id="entitlement-expiry"
            type="date"
            value={entitlementForm.expiresOn}
            onChange={(event) => setEntitlementForm({ ...entitlementForm, expiresOn: event.target.value })}
          />
        </Field>
      </Modal>

      <Modal
        open={contactModal !== null}
        title={contactModal === 'new' ? 'Add contact' : 'Edit contact'}
        onClose={() => setContactModal(null)}
        footer={
          <>
            <button type="button" onClick={() => setContactModal(null)}>
              Cancel
            </button>
            <button type="button" className="primary" onClick={submitContact}>
              Save contact
            </button>
          </>
        }
      >
        <div className="form-grid">
          <Field label="Name" htmlFor="contact-name">
            <input
              id="contact-name"
              value={contactForm.name}
              onChange={(event) => setContactForm({ ...contactForm, name: event.target.value })}
            />
          </Field>
          <Field label="TIN" htmlFor="contact-tin">
            <input
              id="contact-tin"
              value={contactForm.tin}
              onChange={(event) => setContactForm({ ...contactForm, tin: event.target.value })}
            />
          </Field>
          <Field label="Address" htmlFor="contact-address">
            <input
              id="contact-address"
              value={contactForm.address}
              onChange={(event) => setContactForm({ ...contactForm, address: event.target.value })}
            />
          </Field>
        </div>
        <fieldset className="check-group">
          <legend>Roles</legend>
          {(['customer', 'vendor'] as const).map((role) => (
            <label key={role} className="check-row">
              <input
                type="checkbox"
                checked={contactForm.roles.includes(role)}
                onChange={() =>
                  setContactForm({
                    ...contactForm,
                    roles: contactForm.roles.includes(role)
                      ? contactForm.roles.filter((candidate) => candidate !== role)
                      : [...contactForm.roles, role],
                  })
                }
              />
              <span>{titleCase(role)}</span>
            </label>
          ))}
        </fieldset>
        {contactModal !== 'new' && contactModal && (
          <label className="check-row">
            <input
              type="checkbox"
              checked={contactForm.active}
              onChange={(event) => setContactForm({ ...contactForm, active: event.target.checked })}
            />
            <span>Active contact</span>
          </label>
        )}
      </Modal>

      <Modal
        open={accountOpen}
        title="Add account"
        onClose={() => setAccountOpen(false)}
        footer={
          <>
            <button type="button" onClick={() => setAccountOpen(false)}>
              Cancel
            </button>
            <button type="button" className="primary" onClick={submitAccount}>
              Add account
            </button>
          </>
        }
      >
        <div className="form-grid">
          {numberingPolicy(state, workspaceId, 'account').manualOverride ? (
            <Field label="Code (manual override)" htmlFor="account-code">
              <input
                id="account-code"
                value={accountForm.code}
                aria-invalid={accountErrors.code ? 'true' : undefined}
                onChange={(event) => setAccountForm({ ...accountForm, code: event.target.value })}
              />
              {accountErrors.code && (
                <p className="field-message" role="alert">
                  {accountErrors.code}
                </p>
              )}
            </Field>
          ) : (
            <p className="form-note">
              Account code will be allocated: <code>{previewCodes(state, workspaceId, 'account', 1)[0]}</code>
            </p>
          )}
          <Field label="Name" htmlFor="account-name" error={accountErrors.name}>
            <input
              id="account-name"
              value={accountForm.name}
              onChange={(event) => setAccountForm({ ...accountForm, name: event.target.value })}
            />
          </Field>
          <Field label="Type" htmlFor="account-type">
            <select
              id="account-type"
              value={accountForm.type}
              onChange={(event) => {
                const selected = ACCOUNT_TYPES.find(
                  (candidate) => candidate.value === (event.target.value as Account['type']),
                );
                setAccountForm({
                  ...accountForm,
                  type: event.target.value as Account['type'],
                  normalBalance: selected?.normal ?? accountForm.normalBalance,
                });
              }}
            >
              {ACCOUNT_TYPES.map((type) => (
                <option key={type.value} value={type.value}>
                  {type.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Normal balance" htmlFor="account-normal">
            <select
              id="account-normal"
              value={accountForm.normalBalance}
              onChange={(event) =>
                setAccountForm({
                  ...accountForm,
                  normalBalance: event.target.value as Account['normalBalance'],
                })
              }
            >
              <option value="debit">Debit</option>
              <option value="credit">Credit</option>
            </select>
          </Field>
        </div>
        <p className="callout callout-info">
          New accounts start without a control role; automatic postings keep their existing mapping.
        </p>
      </Modal>
    </div>
  );
}
