import { journalForViewer } from '../../domain/journalVisibility';
import { useEffect, useMemo, useState } from 'react';
import type { Journal, JournalDraft, Period } from '../../domain/schema';
import {
  auditTrail,
  certificate2307Register,
  taxRegister,
} from '../../domain/queries';
import { useApp } from '../useApp';
import { useAppRoute, useNavigation } from '../navigation';
import { appRoute } from '../router';
import { downloadText, toCsv } from '../../adapters/csv';
import { EmptyState, Field, Modal, Panel, StatusBadge } from '../components';
import { humanDate, humanTimestamp, money, peso, titleCase } from '../format';
import { dateField, moneyField, requiredField } from '../forms';
import { hasAnyRole } from '../permissions';

type OtherTab = 'journals' | 'drafts' | 'periods' | 'tax' | 'certificates' | 'audit';

interface DraftLineForm {
  accountId: string;
  debit: string;
  credit: string;
}

function amountOrZero(value: string, label: string): { ok: boolean; value: number; message: string } {
  if (value.trim() === '') return { ok: true, value: 0, message: '' };
  const parsed = moneyField(value, label);
  return { ok: parsed.ok, value: parsed.value ?? 0, message: parsed.message };
}

export function OtherScreen() {
  const api = useApp();
  const route = useAppRoute();
  const { navigate } = useNavigation();
  const { state, workspaceId, access } = api;
  const accountingStatus = api.productStatus('accounting');
  const accountingActive = accountingStatus === 'active';
  const canAccount = accountingActive && hasAnyRole(access, 'accountant', 'company_admin');
  const canClerk = accountingActive && hasAnyRole(access, 'accountant', 'ap_ar_clerk', 'company_admin');
  const isAdmin = hasAnyRole(access, 'company_admin');

  const tab: OtherTab =
    route?.page === 'drafts' ||
    route?.page === 'periods' ||
    route?.page === 'tax' ||
    route?.page === 'certificates' ||
    route?.page === 'audit'
      ? route.page
      : 'journals';
  const [selectedJournal, setJournalDetail] = useState<Journal | null>(null);
  const journalDetail = selectedJournal ? journalForViewer(state, selectedJournal, api.actorId) : null;

  useEffect(() => {
    const recordId = route?.recordId;
    if (!recordId) {
      setJournalDetail(null);
      return;
    }
    const journal = state.journals.find(
      (candidate) => candidate.id === recordId && candidate.workspaceId === workspaceId,
    );
    setJournalDetail(journal ?? null);
  }, [route?.recordId, state.journals, workspaceId]);
  const accounts = useMemo(
    () =>
      state.accounts
        .filter((account) => account.workspaceId === workspaceId)
        .slice()
        .sort((left, right) => left.code.localeCompare(right.code)),
    [state.accounts, workspaceId],
  );
  const journals = state.journals
    .filter((journal) => journal.workspaceId === workspaceId)
    .map((journal) => journalForViewer(state, journal, api.actorId))
    .slice()
    .sort((left, right) => right.journalNo.localeCompare(left.journalNo));
  const drafts = state.journalDrafts
    .filter((draft) => draft.workspaceId === workspaceId)
    .slice()
    .sort((left, right) => right.draftNo.localeCompare(left.draftNo));
  const periods = state.periods
    .filter((period) => period.workspaceId === workspaceId)
    .slice()
    .sort((left, right) => right.year - left.year || right.month - left.month);
  const taxFrom = `${api.clock.today.slice(0, 7)}-01`;
  const [taxFromDate, setTaxFromDate] = useState(taxFrom);
  const [taxToDate, setTaxToDate] = useState(api.clock.today);
  const tax = useMemo(
    () =>
      taxRegister(state, workspaceId, taxFromDate, taxToDate, {
        asOfDate: api.clock.today,
      }),
    [state, workspaceId, taxFromDate, taxToDate, api.clock.today],
  );
  const certificates = useMemo(
    () => certificate2307Register(state, workspaceId),
    [state, workspaceId],
  );
  const audit = useMemo(
    () => auditTrail(state, workspaceId, 300),
    [state, workspaceId],
  );
  const vendors = state.contacts.filter(
    (contact) => contact.workspaceId === workspaceId && contact.active && contact.roles.includes('vendor'),
  );

  // Journal draft creation
  const [draftOpen, setDraftOpen] = useState(false);
  const [draftHeader, setDraftHeader] = useState({ journalDate: api.clock.today, memo: '' });
  const [draftLines, setDraftLines] = useState<DraftLineForm[]>([
    { accountId: '', debit: '', credit: '' },
    { accountId: '', debit: '', credit: '' },
  ]);

  // Rejection / reversal / period reason dialogs
  const [rejectTarget, setRejectTarget] = useState<JournalDraft | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [reverseTarget, setReverseTarget] = useState<Journal | null>(null);
  const [reverseForm, setReverseForm] = useState({ reversalDate: api.clock.today, reason: '' });
  const [periodTarget, setPeriodTarget] = useState<{ period: Period; action: 'close' | 'reopen' } | null>(null);
  const [periodReason, setPeriodReason] = useState('');

  // Final withholding
  const [fwtOpen, setFwtOpen] = useState(false);
  const [fwtForm, setFwtForm] = useState({
    partyContactId: '',
    taxDate: api.clock.today,
    base: '',
    tax: '',
    description: '',
  });

  // 2307 certificate
  const [certOpen, setCertOpen] = useState(false);
  const [certForm, setCertForm] = useState({
    direction: 'issued' as 'issued' | 'received',
    counterpartyContactId: '',
    certificateNo: '',
    certificateDate: api.clock.today,
    periodFrom: taxFrom,
    periodTo: api.clock.today,
  });
  const [certRecords, setCertRecords] = useState<string[]>([]);

  const openDraft = () => {
    setDraftHeader({ journalDate: api.clock.today, memo: '' });
    setDraftLines([
      { accountId: accounts[0]?.id ?? '', debit: '', credit: '' },
      { accountId: accounts[1]?.id ?? accounts[0]?.id ?? '', debit: '', credit: '' },
    ]);
    setDraftOpen(true);
  };

  const draftTotals = draftLines.reduce(
    (totals, line) => ({
      debit: totals.debit + (amountOrZero(line.debit, 'debit').value ?? 0),
      credit: totals.credit + (amountOrZero(line.credit, 'credit').value ?? 0),
    }),
    { debit: 0, credit: 0 },
  );

  const submitDraft = () => {
    const date = dateField(draftHeader.journalDate, 'journal date');
    const memo = requiredField(draftHeader.memo, 'memo');
    if (!date.ok || !memo.ok) {
      api.notify('error', 'Journal draft is incomplete', date.message || memo.message);
      return;
    }
    const lines: Array<{ accountId: string; debitCentavos: number; creditCentavos: number }> = [];
    for (const [index, line] of draftLines.entries()) {
      if (!line.accountId) {
        api.notify('error', 'Journal draft is incomplete', `Line ${index + 1} needs an account.`);
        return;
      }
      const debit = amountOrZero(line.debit, 'debit');
      const credit = amountOrZero(line.credit, 'credit');
      if (!debit.ok || !credit.ok) {
        api.notify('error', 'Journal draft is incomplete', debit.message || credit.message);
        return;
      }
      lines.push({ accountId: line.accountId, debitCentavos: debit.value, creditCentavos: credit.value });
    }
    if (draftTotals.debit === 0 && draftTotals.credit === 0) {
      api.notify('error', 'Journal draft has no amounts', 'Enter at least one debit and credit.');
      return;
    }
    const result = api.dispatch({
      type: 'journalDraft.create',
      input: { journalDate: draftHeader.journalDate, memo: draftHeader.memo, lines },
    });
    if (result) setDraftOpen(false);
  };

  const submitRejection = () => {
    if (!rejectTarget) return;
    const result = api.dispatch({
      type: 'journalDraft.reject',
      input: { draftId: rejectTarget.id, reason: rejectReason },
    });
    if (result) {
      setRejectTarget(null);
      setRejectReason('');
    }
  };

  const submitReversal = () => {
    if (!reverseTarget) return;
    const result = api.dispatch({
      type: 'journal.reverse',
      input: {
        journalId: reverseTarget.id,
        reversalDate: reverseForm.reversalDate,
        reason: reverseForm.reason,
      },
    });
    if (result) {
      setReverseTarget(null);
      setReverseForm({ reversalDate: api.clock.today, reason: '' });
    }
  };

  const submitPeriod = () => {
    if (!periodTarget) return;
    const result = api.dispatch(
      periodTarget.action === 'close'
        ? {
            type: 'period.close',
            input: {
              year: periodTarget.period.year,
              month: periodTarget.period.month,
              reason: periodReason,
            },
          }
        : {
            type: 'period.reopen',
            input: {
              year: periodTarget.period.year,
              month: periodTarget.period.month,
              reason: periodReason,
            },
          },
    );
    if (result) {
      setPeriodTarget(null);
      setPeriodReason('');
    }
  };

  const submitFwt = () => {
    const party = requiredField(fwtForm.partyContactId, 'payee');
    const base = moneyField(fwtForm.base, 'base');
    const taxAmount = moneyField(fwtForm.tax, 'tax');
    const description = requiredField(fwtForm.description, 'description');
    const date = dateField(fwtForm.taxDate, 'tax date');
    const firstError = [party, base, taxAmount, description, date].find((field) => !field.ok);
    if (firstError) {
      api.notify('error', 'Final withholding is incomplete', firstError.message);
      return;
    }
    const result = api.dispatch({
      type: 'taxRecord.createFinalWithholding',
      input: {
        partyContactId: fwtForm.partyContactId,
        taxDate: fwtForm.taxDate,
        baseCentavos: base.value ?? 0,
        taxCentavos: taxAmount.value ?? 0,
        description: fwtForm.description,
      },
    });
    if (result) {
      setFwtOpen(false);
      setFwtForm({
        partyContactId: '',
        taxDate: api.clock.today,
        base: '',
        tax: '',
        description: '',
      });
    }
  };

  const availableCertRecords = state.taxRecords.filter(
    (record) =>
      record.workspaceId === workspaceId &&
      record.type === 'ewt_creditable' &&
      record.certificateId === null &&
      record.partyContactId === certForm.counterpartyContactId,
  );
  const certTotal = availableCertRecords
    .filter((record) => certRecords.includes(record.id))
    .reduce((sum, record) => sum + record.taxCentavos, 0);

  const submitCertificate = () => {
    const counterparty = requiredField(certForm.counterpartyContactId, 'counterparty');
    const number = requiredField(certForm.certificateNo, 'certificate number');
    const date = dateField(certForm.certificateDate, 'certificate date');
    const from = dateField(certForm.periodFrom, 'period from');
    const to = dateField(certForm.periodTo, 'period to');
    const firstError = [counterparty, number, date, from, to].find((field) => !field.ok);
    if (firstError) {
      api.notify('error', 'Certificate is incomplete', firstError.message);
      return;
    }
    if (certRecords.length === 0) {
      api.notify('error', 'Select withholding records', 'A 2307 needs at least one creditable EWT record.');
      return;
    }
    const result = api.dispatch({
      type: 'certificate2307.create',
      input: {
        direction: certForm.direction,
        counterpartyContactId: certForm.counterpartyContactId,
        certificateNo: certForm.certificateNo,
        certificateDate: certForm.certificateDate,
        periodFrom: certForm.periodFrom,
        periodTo: certForm.periodTo,
        sourceTaxRecordIds: certRecords,
      },
    });
    if (result) {
      setCertOpen(false);
      setCertRecords([]);
    }
  };

  const exportJournals = () => {
    downloadText(
      'ece-accounting-general-journals.csv',
      toCsv(
        journals.flatMap((journal) =>
          journal.lines.map((line) => ({
            journal_no: journal.journalNo,
            posting_date: journal.postingDate,
            source_type: journal.sourceType,
            source_id: journal.sourceId,
            memo: journal.memo,
            account_code: line.accountCode,
            debit_centavos: line.debitCentavos,
            credit_centavos: line.creditCentavos,
            status: journal.status,
            reversal_of: journal.reversalOf ?? '',
            reversed_by: journal.reversedBy ?? '',
          })),
        ),
      ),
    );
  };

  const exportTax = () => {
    downloadText(
      `ece-accounting-tax-register-${taxFromDate}-to-${taxToDate}.csv`,
      toCsv(
        tax.rows.map((row) => ({
          tax_date: row.taxDate,
          type: row.type,
          direction: row.direction,
          party: row.partyName,
          source_no: row.sourceNo,
          description: row.description,
          base_centavos: row.baseCentavos,
          tax_centavos: row.taxCentavos,
          certificate_no: row.certificateNo ?? '',
          certificate_state: row.certificateState,
        })),
      ),
    );
  };

  const exportAudit = () => {
    downloadText(
      'ece-accounting-audit-trail.csv',
      toCsv(
        audit.map((event) => ({
          at: event.at,
          actor: state.users.find((user) => user.id === event.actorId)?.name ?? event.actorId,
          action: event.action,
          record_type: event.recordType,
          record_id: event.recordId,
          reason: event.reason ?? '',
          detail: JSON.stringify(event.detail),
        })),
      ),
    );
  };

  return (
    <div className="screen">
      {accountingStatus !== 'active' && (
        <div className="callout callout-warn" role="status">
          <strong>Accounting is {accountingStatus}.</strong> Journals, periods, and tax registers
          are readable; changes that require a live accounting product are blocked.
        </div>
      )}

      {tab === 'journals' && (
        <Panel
          title="Posted general journals"
          subtitle="Immutable once posted. Reversing creates a linked contra journal; the original stays visible."
          actions={
            <button type="button" onClick={exportJournals}>
              Export journals CSV
            </button>
          }
        >
          {journals.length === 0 ? (
            <EmptyState title="No journals have been posted" />
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <caption>Posted journals</caption>
                <thead>
                  <tr>
                    <th scope="col">Journal</th>
                    <th scope="col">Date</th>
                    <th scope="col">Source</th>
                    <th scope="col">Memo</th>
                    <th scope="col" className="numeric">
                      Lines
                    </th>
                    <th scope="col" className="numeric">
                      Debit total
                    </th>
                    <th scope="col">Created by</th>
                    <th scope="col">Approved by</th>
                    <th scope="col">Status</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {journals.map((journal) => (
                    <tr key={journal.id}>
                      <th scope="row">
                        <button
                          type="button"
                          className="link-button"
                          onClick={() => navigate(appRoute('other', 'journals', { recordId: journal.id }))}
                        >
                          {journal.journalNo}
                        </button>
                      </th>
                      <td>{humanDate(journal.postingDate)}</td>
                      <td>{titleCase(journal.sourceType)}</td>
                      <td>{journal.memo}</td>
                      <td className="numeric">{journal.lines.length}</td>
                      <td className="numeric">
                        {money(journal.lines.reduce((sum, line) => sum + line.debitCentavos, 0))}
                      </td>
                      <td>{state.users.find((user) => user.id === journal.createdBy)?.name ?? journal.createdBy}</td>
                      <td>
                        {journal.approvedBy
                          ? state.users.find((user) => user.id === journal.approvedBy)?.name ?? journal.approvedBy
                          : <span className="muted">—</span>}
                      </td>
                      <td>
                        {journal.reversedBy
                          ? 'Reversed'
                          : journal.reversalOf
                            ? 'Reversal entry'
                            : 'Posted'}
                      </td>
                      <td className="actions">
                        <button
                          type="button"
                          className="link-button"
                          disabled={!canAccount || journal.reversalOf !== null || journal.reversedBy !== null}
                          onClick={() => {
                            setReverseTarget(journal);
                            setReverseForm({ reversalDate: api.clock.today, reason: '' });
                          }}
                        >
                          Reverse
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      )}

      {tab === 'drafts' && (
        <Panel
          title="Journal drafts"
          subtitle="A draft must be approved by a user other than its maker before it can post. Rejected drafts remain in history with a reason."
          actions={
            <button type="button" className="primary" onClick={openDraft} disabled={!canClerk}>
              New journal draft
            </button>
          }
        >
          {drafts.length === 0 ? (
            <EmptyState title="No journal drafts" />
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <caption>Journal drafts</caption>
                <thead>
                  <tr>
                    <th scope="col">Draft</th>
                    <th scope="col">Date</th>
                    <th scope="col">Memo</th>
                    <th scope="col" className="numeric">
                      Debit total
                    </th>
                    <th scope="col">Maker</th>
                    <th scope="col">Approver</th>
                    <th scope="col">Status</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {drafts.map((draft) => {
                    const makerIsActor = draft.createdBy === api.actorId;
                    return (
                      <tr key={draft.id}>
                        <th scope="row">{draft.draftNo}</th>
                        <td>{humanDate(draft.journalDate)}</td>
                        <td>{draft.memo}</td>
                        <td className="numeric">
                          {money(draft.lines.reduce((sum, line) => sum + line.debitCentavos, 0))}
                        </td>
                        <td>{state.users.find((user) => user.id === draft.createdBy)?.name ?? draft.createdBy}</td>
                        <td>
                          {draft.approvedBy
                            ? state.users.find((user) => user.id === draft.approvedBy)?.name ?? draft.approvedBy
                            : <span className="muted">—</span>}
                        </td>
                        <td>
                          <StatusBadge status={draft.status} />
                          {draft.rejectionReason && (
                            <span className="muted"> · {draft.rejectionReason}</span>
                          )}
                        </td>
                        <td className="actions">
                          {draft.status === 'draft' && (
                            <>
                              <button
                                type="button"
                                className="link-button"
                                disabled={!canAccount || makerIsActor}
                                title={makerIsActor ? 'A different user must approve.' : undefined}
                                onClick={() =>
                                  api.dispatch({ type: 'journalDraft.approve', input: { draftId: draft.id } })
                                }
                              >
                                Approve
                              </button>
                              <button
                                type="button"
                                className="link-button"
                                disabled={!canAccount || makerIsActor}
                                onClick={() => {
                                  setRejectTarget(draft);
                                  setRejectReason('');
                                }}
                              >
                                Reject
                              </button>
                            </>
                          )}
                          {draft.status === 'approved' && (
                            <>
                              <button
                                type="button"
                                className="link-button"
                                disabled={!canAccount}
                                onClick={() =>
                                  api.dispatch({ type: 'journalDraft.post', input: { draftId: draft.id } })
                                }
                              >
                                Post
                              </button>
                              <button
                                type="button"
                                className="link-button"
                                disabled={!canAccount || makerIsActor}
                                onClick={() => {
                                  setRejectTarget(draft);
                                  setRejectReason('');
                                }}
                              >
                                Reject
                              </button>
                            </>
                          )}
                          {draft.status === 'posted' && (
                            <span className="muted">Posted as {draft.journalId}</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      )}

      {tab === 'periods' && (
        <Panel
          title="Accounting periods"
          subtitle="Closing blocks postings dated inside the period. Reopening requires a company administrator and always records a reason."
        >
          <div className="table-wrap">
            <table className="data-table">
              <caption>Period status</caption>
              <thead>
                <tr>
                  <th scope="col">Period</th>
                  <th scope="col">Status</th>
                  <th scope="col">Closed by</th>
                  <th scope="col">Closed at</th>
                  <th scope="col">Reason</th>
                  <th scope="col">Last reopened</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {periods.map((period) => {
                  const label = `${period.year}-${String(period.month).padStart(2, '0')}`;
                  return (
                    <tr key={period.id}>
                      <th scope="row">{label}</th>
                      <td>
                        <StatusBadge status={period.status} />
                      </td>
                      <td>{period.closedBy ?? <span className="muted">—</span>}</td>
                      <td>{period.closedAt ? humanTimestamp(period.closedAt) : <span className="muted">—</span>}</td>
                      <td>{period.closeReason ?? <span className="muted">—</span>}</td>
                      <td>
                        {period.reopenedAt
                          ? `${humanTimestamp(period.reopenedAt)} · ${period.reopenReason ?? ''}`
                          : <span className="muted">—</span>}
                      </td>
                      <td className="actions">
                        {period.status === 'open' ? (
                          <button
                            type="button"
                            className="link-button"
                            disabled={!canAccount}
                            onClick={() => {
                              setPeriodTarget({ period, action: 'close' });
                              setPeriodReason('');
                            }}
                          >
                            Close period
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="link-button"
                            disabled={!isAdmin}
                            onClick={() => {
                              setPeriodTarget({ period, action: 'reopen' });
                              setPeriodReason('');
                            }}
                          >
                            Reopen
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      {tab === 'tax' && (
        <>
          <Panel
            title="Tax register"
            subtitle="Output VAT, input VAT, creditable EWT, and final withholding are recorded by the documents that create them. Pending and missing 2307 states use a synthetic demo grace period that is not a statutory deadline."
            actions={
              <>
                <label className="inline-control">
                  <span>From</span>
                  <input
                    type="date"
                    value={taxFromDate}
                    onChange={(event) => setTaxFromDate(event.target.value)}
                  />
                </label>
                <label className="inline-control">
                  <span>To</span>
                  <input
                    type="date"
                    value={taxToDate}
                    onChange={(event) => setTaxToDate(event.target.value)}
                  />
                </label>
                <button type="button" onClick={exportTax}>
                  Export tax CSV
                </button>
                <button type="button" className="primary" onClick={() => setFwtOpen(true)} disabled={!canAccount}>
                  Record final withholding
                </button>
              </>
            }
          >
            <div className="stat-row">
              <div className="stat">
                <span>Output VAT</span>
                <strong>{peso(tax.summary.outputVatCentavos)}</strong>
              </div>
              <div className="stat">
                <span>Input VAT</span>
                <strong>{peso(tax.summary.inputVatCentavos)}</strong>
              </div>
              <div className="stat">
                <span>Net VAT payable</span>
                <strong>{peso(tax.summary.netVatPayableCentavos)}</strong>
              </div>
              <div className="stat">
                <span>Creditable EWT</span>
                <strong>{peso(tax.summary.ewtCreditableCentavos)}</strong>
              </div>
              <div className="stat">
                <span>Final withholding</span>
                <strong>{peso(tax.summary.fwtFinalCentavos)}</strong>
              </div>
              <div className="stat">
                <span>2307 pending / missing</span>
                <strong>
                  {tax.summary.pendingCertificateCount} / {tax.summary.missingCertificateCount}
                </strong>
              </div>
            </div>
            {tax.rows.length === 0 ? (
              <EmptyState title="No tax records in this period">
                Post a VAT invoice or bill, or record final withholding, to populate the register.
              </EmptyState>
            ) : (
              <div className="table-wrap">
                <table className="data-table">
                  <caption>Tax records</caption>
                  <thead>
                    <tr>
                      <th scope="col">Date</th>
                      <th scope="col">Type</th>
                      <th scope="col">Party</th>
                      <th scope="col">Source</th>
                      <th scope="col">Description</th>
                      <th scope="col" className="numeric">
                        Base
                      </th>
                      <th scope="col" className="numeric">
                        Tax
                      </th>
                      <th scope="col">2307 state</th>
                      <th scope="col">Certificate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tax.rows.map((row) => (
                      <tr key={row.id}>
                        <td>{humanDate(row.taxDate)}</td>
                        <td>{titleCase(row.type)}</td>
                        <td>{row.partyName}</td>
                        <td>{row.sourceNo}</td>
                        <td>{row.description}</td>
                        <td className="numeric">{money(row.baseCentavos)}</td>
                        <td className="numeric">{money(row.taxCentavos)}</td>
                        <td>
                          <StatusBadge status={row.certificateState} />
                        </td>
                        <td>{row.certificateNo ?? <span className="muted">—</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="callout callout-info">
              Final withholding is reported separately and never counted as creditable tax on a
              2307. This register is synthetic and is not filed with the BIR.
            </p>
          </Panel>
        </>
      )}

      {tab === 'certificates' && (
        <Panel
          title="Certificate 2307 register"
          subtitle="A certificate links one or more creditable EWT records for a single counterparty. Linked records cannot be reused on another certificate."
          actions={
            <button
              type="button"
              className="primary"
              disabled={!canAccount}
              onClick={() => {
                setCertForm({
                  direction: 'issued',
                  counterpartyContactId: '',
                  certificateNo: '',
                  certificateDate: api.clock.today,
                  periodFrom: taxFrom,
                  periodTo: api.clock.today,
                });
                setCertRecords([]);
                setCertOpen(true);
              }}
            >
              New 2307 certificate
            </button>
          }
        >
          {certificates.length === 0 ? (
            <EmptyState title="No 2307 certificates recorded" />
          ) : (
            <table className="data-table">
              <caption>Certificates 2307</caption>
              <thead>
                <tr>
                  <th scope="col">Certificate</th>
                  <th scope="col">Direction</th>
                  <th scope="col">Counterparty</th>
                  <th scope="col">Certificate date</th>
                  <th scope="col">Period</th>
                  <th scope="col" className="numeric">
                    Base
                  </th>
                  <th scope="col" className="numeric">
                    Creditable tax
                  </th>
                  <th scope="col" className="numeric">
                    Records
                  </th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {certificates.map((certificate) => (
                  <tr key={certificate.id}>
                    <th scope="row">{certificate.certificateNo}</th>
                    <td>{titleCase(certificate.direction)}</td>
                    <td>{certificate.counterpartyName}</td>
                    <td>{humanDate(certificate.certificateDate)}</td>
                    <td>
                      {humanDate(certificate.periodFrom)} – {humanDate(certificate.periodTo)}
                    </td>
                    <td className="numeric">{money(certificate.baseCentavos)}</td>
                    <td className="numeric">{money(certificate.creditableTaxCentavos)}</td>
                    <td className="numeric">{certificate.sourceCount}</td>
                    <td>{titleCase(certificate.status)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="callout callout-info">
            These register entries are demonstration data. Nothing here is submitted to or
            validated by the BIR, and no official certificate is generated.
          </p>
        </Panel>
      )}

      {tab === 'audit' && (
        <Panel
          title="Audit trail"
          subtitle="Every committed command records an append-only event with the actor, action, record, timestamp, and any reason."
          actions={
            <button type="button" onClick={exportAudit}>
              Export audit CSV
            </button>
          }
        >
          {audit.length === 0 ? (
            <EmptyState title="No audit events yet" />
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <caption>Recent audit events</caption>
                <thead>
                  <tr>
                    <th scope="col">When</th>
                    <th scope="col">Actor</th>
                    <th scope="col">Action</th>
                    <th scope="col">Record</th>
                    <th scope="col">Reason</th>
                    <th scope="col">Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.map((event) => (
                    <tr key={`${event.at}-${event.recordId}-${event.action}`}>
                      <td>{humanTimestamp(event.at)}</td>
                      <td>{state.users.find((user) => user.id === event.actorId)?.name ?? event.actorId}</td>
                      <td>{event.action}</td>
                      <td>
                        {titleCase(event.recordType)} · {event.recordId}
                      </td>
                      <td>{event.reason ?? <span className="muted">—</span>}</td>
                      <td className="mono small">{JSON.stringify(event.detail)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      )}

      <Modal
        open={draftOpen}
        wide
        title="New journal draft"
        onClose={() => setDraftOpen(false)}
        footer={
          <>
            <button type="button" onClick={() => setDraftOpen(false)}>
              Cancel
            </button>
            <button type="button" className="primary" onClick={submitDraft}>
              Save draft
            </button>
          </>
        }
      >
        <div className="form-grid">
          <Field label="Journal date" htmlFor="draft-date">
            <input
              id="draft-date"
              type="date"
              value={draftHeader.journalDate}
              onChange={(event) => setDraftHeader({ ...draftHeader, journalDate: event.target.value })}
            />
          </Field>
          <Field label="Memo" htmlFor="draft-memo">
            <input
              id="draft-memo"
              value={draftHeader.memo}
              onChange={(event) => setDraftHeader({ ...draftHeader, memo: event.target.value })}
            />
          </Field>
        </div>
        <table className="line-editor">
          <thead>
            <tr>
              <th scope="col">Account</th>
              <th scope="col">Debit (PHP)</th>
              <th scope="col">Credit (PHP)</th>
              <th scope="col" />
            </tr>
          </thead>
          <tbody>
            {draftLines.map((line, index) => (
              <tr key={index}>
                <td>
                  <select
                    aria-label={`Line ${index + 1} account`}
                    value={line.accountId}
                    onChange={(event) =>
                      setDraftLines(
                        draftLines.map((candidate, position) =>
                          position === index ? { ...candidate, accountId: event.target.value } : candidate,
                        ),
                      )
                    }
                  >
                    {accounts.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.code} · {account.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <input
                    aria-label={`Line ${index + 1} debit`}
                    inputMode="decimal"
                    value={line.debit}
                    onChange={(event) =>
                      setDraftLines(
                        draftLines.map((candidate, position) =>
                          position === index
                            ? { ...candidate, debit: event.target.value, credit: '' }
                            : candidate,
                        ),
                      )
                    }
                  />
                </td>
                <td>
                  <input
                    aria-label={`Line ${index + 1} credit`}
                    inputMode="decimal"
                    value={line.credit}
                    onChange={(event) =>
                      setDraftLines(
                        draftLines.map((candidate, position) =>
                          position === index
                            ? { ...candidate, credit: event.target.value, debit: '' }
                            : candidate,
                        ),
                      )
                    }
                  />
                </td>
                <td>
                  <button
                    type="button"
                    className="link-button"
                    disabled={draftLines.length <= 2}
                    onClick={() => setDraftLines(draftLines.filter((_, position) => position !== index))}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">Totals</th>
              <td>{money(draftTotals.debit)}</td>
              <td>{money(draftTotals.credit)}</td>
              <td>
                <span className={draftTotals.debit === draftTotals.credit ? 'muted' : 'negative'}>
                  {draftTotals.debit === draftTotals.credit ? 'Balanced' : 'Not balanced'}
                </span>
              </td>
            </tr>
          </tfoot>
        </table>
        <button
          type="button"
          onClick={() => setDraftLines([...draftLines, { accountId: accounts[0]?.id ?? '', debit: '', credit: '' }])}
        >
          Add line
        </button>
      </Modal>

      <Modal
        open={rejectTarget !== null}
        title={rejectTarget ? `Reject ${rejectTarget.draftNo}` : 'Reject draft'}
        onClose={() => setRejectTarget(null)}
        footer={
          <>
            <button type="button" onClick={() => setRejectTarget(null)}>
              Cancel
            </button>
            <button type="button" className="danger" onClick={submitRejection}>
              Reject draft
            </button>
          </>
        }
      >
        <Field label="Rejection reason" htmlFor="reject-reason" hint="Recorded in the audit trail.">
          <input
            id="reject-reason"
            value={rejectReason}
            onChange={(event) => setRejectReason(event.target.value)}
          />
        </Field>
      </Modal>

      <Modal
        open={reverseTarget !== null}
        title={reverseTarget ? `Reverse ${reverseTarget.journalNo}` : 'Reverse journal'}
        onClose={() => setReverseTarget(null)}
        footer={
          <>
            <button type="button" onClick={() => setReverseTarget(null)}>
              Cancel
            </button>
            <button type="button" className="danger" onClick={submitReversal}>
              Post linked reversal
            </button>
          </>
        }
      >
        <p>
          The original journal remains posted and immutable. A new contra journal is linked through
          the reversal field.
        </p>
        <div className="form-grid">
          <Field label="Reversal date" htmlFor="reverse-date">
            <input
              id="reverse-date"
              type="date"
              value={reverseForm.reversalDate}
              onChange={(event) => setReverseForm({ ...reverseForm, reversalDate: event.target.value })}
            />
          </Field>
          <Field label="Reason" htmlFor="reverse-reason">
            <input
              id="reverse-reason"
              value={reverseForm.reason}
              onChange={(event) => setReverseForm({ ...reverseForm, reason: event.target.value })}
            />
          </Field>
        </div>
      </Modal>

      <Modal
        open={periodTarget !== null}
        title={
          periodTarget
            ? `${periodTarget.action === 'close' ? 'Close' : 'Reopen'} ${periodTarget.period.year}-${String(periodTarget.period.month).padStart(2, '0')}`
            : 'Period'
        }
        onClose={() => setPeriodTarget(null)}
        footer={
          <>
            <button type="button" onClick={() => setPeriodTarget(null)}>
              Cancel
            </button>
            <button
              type="button"
              className={periodTarget?.action === 'reopen' ? 'danger' : 'primary'}
              onClick={submitPeriod}
            >
              {periodTarget?.action === 'close' ? 'Close period' : 'Reopen period'}
            </button>
          </>
        }
      >
        <Field label="Reason" htmlFor="period-reason" hint="Required and written to the audit trail.">
          <input
            id="period-reason"
            value={periodReason}
            onChange={(event) => setPeriodReason(event.target.value)}
          />
        </Field>
      </Modal>

      <Modal
        open={fwtOpen}
        title="Record final withholding"
        onClose={() => setFwtOpen(false)}
        footer={
          <>
            <button type="button" onClick={() => setFwtOpen(false)}>
              Cancel
            </button>
            <button type="button" className="primary" onClick={submitFwt}>
              Save final withholding
            </button>
          </>
        }
      >
        <div className="form-grid">
          <Field label="Payee" htmlFor="fwt-party">
            <select
              id="fwt-party"
              value={fwtForm.partyContactId}
              onChange={(event) => setFwtForm({ ...fwtForm, partyContactId: event.target.value })}
            >
              <option value="">Select a vendor contact</option>
              {vendors.map((contact) => (
                <option key={contact.id} value={contact.id}>
                  {contact.contactNo} · {contact.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Tax date" htmlFor="fwt-date">
            <input
              id="fwt-date"
              type="date"
              value={fwtForm.taxDate}
              onChange={(event) => setFwtForm({ ...fwtForm, taxDate: event.target.value })}
            />
          </Field>
          <Field label="Base (PHP)" htmlFor="fwt-base">
            <input
              id="fwt-base"
              inputMode="decimal"
              value={fwtForm.base}
              onChange={(event) => setFwtForm({ ...fwtForm, base: event.target.value })}
            />
          </Field>
          <Field label="Final tax (PHP)" htmlFor="fwt-tax">
            <input
              id="fwt-tax"
              inputMode="decimal"
              value={fwtForm.tax}
              onChange={(event) => setFwtForm({ ...fwtForm, tax: event.target.value })}
            />
          </Field>
          <Field label="Description" htmlFor="fwt-description">
            <input
              id="fwt-description"
              value={fwtForm.description}
              onChange={(event) => setFwtForm({ ...fwtForm, description: event.target.value })}
            />
          </Field>
        </div>
        <p className="callout callout-info">
          Final withholding is saved on its own. It is never added to the creditable 2307 register.
        </p>
      </Modal>

      <Modal
        open={certOpen}
        wide
        title="New certificate 2307"
        onClose={() => setCertOpen(false)}
        footer={
          <>
            <button type="button" onClick={() => setCertOpen(false)}>
              Cancel
            </button>
            <button type="button" className="primary" onClick={submitCertificate}>
              Record certificate
            </button>
          </>
        }
      >
        <div className="form-grid">
          <Field label="Direction" htmlFor="cert-direction">
            <select
              id="cert-direction"
              value={certForm.direction}
              onChange={(event) =>
                setCertForm({ ...certForm, direction: event.target.value as 'issued' | 'received' })
              }
            >
              <option value="issued">Issued by us</option>
              <option value="received">Received from a customer</option>
            </select>
          </Field>
          <Field label="Counterparty" htmlFor="cert-counterparty">
            <select
              id="cert-counterparty"
              value={certForm.counterpartyContactId}
              onChange={(event) => {
                setCertForm({ ...certForm, counterpartyContactId: event.target.value });
                setCertRecords([]);
              }}
            >
              <option value="">Select a contact</option>
              {state.contacts
                .filter((contact) => contact.workspaceId === workspaceId && contact.active)
                .map((contact) => (
                  <option key={contact.id} value={contact.id}>
                    {contact.contactNo} · {contact.name}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Certificate number" htmlFor="cert-number">
            <input
              id="cert-number"
              value={certForm.certificateNo}
              onChange={(event) => setCertForm({ ...certForm, certificateNo: event.target.value })}
            />
          </Field>
          <Field label="Certificate date" htmlFor="cert-date">
            <input
              id="cert-date"
              type="date"
              value={certForm.certificateDate}
              onChange={(event) => setCertForm({ ...certForm, certificateDate: event.target.value })}
            />
          </Field>
          <Field label="Period from" htmlFor="cert-from">
            <input
              id="cert-from"
              type="date"
              value={certForm.periodFrom}
              onChange={(event) => setCertForm({ ...certForm, periodFrom: event.target.value })}
            />
          </Field>
          <Field label="Period to" htmlFor="cert-to">
            <input
              id="cert-to"
              type="date"
              value={certForm.periodTo}
              onChange={(event) => setCertForm({ ...certForm, periodTo: event.target.value })}
            />
          </Field>
        </div>
        <h3>Available creditable EWT records</h3>
        {availableCertRecords.length === 0 ? (
          <p className="muted">
            No unlinked creditable withholding records for this counterparty. Choose another
            counterparty or post a bill that withholds EWT.
          </p>
        ) : (
          <ul className="check-list">
            {availableCertRecords.map((record) => (
              <li key={record.id}>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={certRecords.includes(record.id)}
                    onChange={(event) =>
                      setCertRecords(
                        event.target.checked
                          ? [...certRecords, record.id]
                          : certRecords.filter((id) => id !== record.id),
                      )
                    }
                  />
                  {humanDate(record.taxDate)} · {record.description} · base {money(record.baseCentavos)} · tax{' '}
                  {money(record.taxCentavos)}
                </label>
              </li>
            ))}
          </ul>
        )}
        <p>
          Selected creditable tax: <strong>{money(certTotal)}</strong>
        </p>
        <p className="callout callout-info">
          The mockup records the register entry only. It generates no official BIR form and files
          nothing.
        </p>
      </Modal>

      <Modal
        open={journalDetail !== null}
        wide
        title={journalDetail ? `Journal ${journalDetail.journalNo}` : 'Journal entry'}
        onClose={() => navigate(appRoute('other', 'journals'))}
        footer={
          <button type="button" onClick={() => window.print()}>
            Print journal
          </button>
        }
      >
        {journalDetail && (
          <article>
            <dl className="definition-grid">
              <div>
                <dt>Posting date</dt>
                <dd>{humanDate(journalDetail.postingDate)}</dd>
              </div>
              <div>
                <dt>Source</dt>
                <dd>{titleCase(journalDetail.sourceType)}</dd>
              </div>
              <div>
                <dt>Source record</dt>
                <dd className="mono">{journalDetail.sourceId}</dd>
              </div>
              <div>
                <dt>Memo</dt>
                <dd>{journalDetail.memo}</dd>
              </div>
              <div>
                <dt>Created by</dt>
                <dd>{state.users.find((user) => user.id === journalDetail.createdBy)?.name ?? journalDetail.createdBy}</dd>
              </div>
              <div>
                <dt>Approved by</dt>
                <dd>{journalDetail.approvedBy ? state.users.find((user) => user.id === journalDetail.approvedBy)?.name ?? journalDetail.approvedBy : '—'}</dd>
              </div>
            </dl>
            <div className="table-wrap">
              <table className="data-table">
                <caption>Journal lines</caption>
                <thead>
                  <tr>
                    <th scope="col">Account</th>
                    <th scope="col">Memo</th>
                    <th scope="col" className="numeric">Debit</th>
                    <th scope="col" className="numeric">Credit</th>
                  </tr>
                </thead>
                <tbody>
                  {journalDetail.lines.map((line, index) => (
                    <tr key={`${journalDetail.id}-${index}`}>
                      <th scope="row">
                        {line.accountCode} · {state.accounts.find((account) => account.id === line.accountId)?.name ?? 'Unknown account'}
                      </th>
                      <td>{line.memo}</td>
                      <td className="numeric">{line.debitCentavos ? money(line.debitCentavos) : '—'}</td>
                      <td className="numeric">{line.creditCentavos ? money(line.creditCentavos) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="muted">
              Posted lines are immutable. Corrections use a linked reversal journal; the original
              remains visible.
            </p>
          </article>
        )}
      </Modal>
    </div>
  );
}
