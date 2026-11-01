import { useMemo, useState } from 'react';
import type { BankRow } from '../../domain/schema';
import { accountBalance } from '../../domain/ledger';
import { dayDifference } from '../../domain/shared/dates';
import { useApp } from '../useApp';
import { useAppRoute } from '../navigation';
import { BANK_CSV_TEMPLATE, downloadText, parseBankCsv } from '../../adapters/csv';
import type { BankCsvRowInput } from '../../domain/commandTypes';
import { EmptyState, Field, Modal, Panel, StatusBadge } from '../components';
import { humanDate, humanTimestamp, money, peso, titleCase } from '../format';
import { hasAnyRole } from '../permissions';

interface MatchSuggestion {
  row: BankRow;
  sourceType: 'customer_receipt' | 'payment';
  sourceId: string;
  label: string;
  reasons: string[];
  confidence: 'strong' | 'possible' | 'none';
}

export function CashScreen() {
  const api = useApp();
  const route = useAppRoute();
  const page = route?.page === 'matching' || route?.page === 'history' ? route.page : 'statements';
  const { state, workspaceId, access } = api;
  const banks = useMemo(
    () => state.bankAccounts.filter((bank) => bank.workspaceId === workspaceId && bank.active),
    [state.bankAccounts, workspaceId],
  );
  const [bankId, setBankId] = useState(banks[0]?.id ?? '');
  const [csvText, setCsvText] = useState('');
  const [sourceName, setSourceName] = useState('synthetic-bank-statement.csv');
  const [preview, setPreview] = useState<{ rows: BankCsvRowInput[]; errors: string[] } | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [matching, setMatching] = useState<MatchSuggestion | null>(null);
  const [matchReason, setMatchReason] = useState('');
  const [undoing, setUndoing] = useState<BankRow | null>(null);
  const [undoForm, setUndoForm] = useState({ date: api.clock.today, reason: '' });
  const [historyOpen, setHistoryOpen] = useState(false);

  const accountingStatus = api.productStatus('accounting');
  const activeBankId = banks.some((bank) => bank.id === bankId) ? bankId : (banks[0]?.id ?? '');
  const bank = banks.find((candidate) => candidate.id === activeBankId);
  const bankBalance = bank
    ? accountBalance(state, workspaceId, bank.ledgerAccountId, null, api.clock.today)
    : null;
  const rows = state.bankRows
    .filter((row) => row.workspaceId === workspaceId && row.bankAccountId === activeBankId)
    .slice()
    .sort((left, right) => right.valueDate.localeCompare(left.valueDate));
  const statements = latestStatements(state.bankStatements, workspaceId);
  const canImport = accountingStatus === 'active' && hasAnyRole(access, 'accountant', 'ap_ar_clerk', 'company_admin');
  const canMatch = canImport;
  const canUndo = accountingStatus === 'active' && hasAnyRole(access, 'accountant', 'company_admin');

  const suggestions = useMemo(() => rows.map((row) => suggestMatch(state, workspaceId, row)), [rows, state, workspaceId]);

  const readFile = (file: File | null) => {
    if (!file) return;
    setSourceName(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === 'string' ? reader.result : '';
      setCsvText(text);
      setPreview(parseBankCsv(text));
    };
    reader.readAsText(file);
  };

  const runImport = () => {
    const parsed = preview ?? parseBankCsv(csvText);
    if (parsed.errors.length > 0) {
      setPreview(parsed);
      return;
    }
    if (!activeBankId) {
      api.notify('error', 'Select a bank account');
      return;
    }
    const result = api.dispatch({
      type: 'bankRow.import',
      input: { bankAccountId: activeBankId, sourceName, rows: parsed.rows },
    });
    if (result) {
      setShowImport(false);
      setCsvText('');
      setPreview(null);
    }
  };

  const submitMatch = () => {
    if (!matching) return;
    const result = api.dispatch({
      type: 'bankRow.match',
      input: {
        rowId: matching.row.id,
        sourceType: matching.sourceType,
        sourceId: matching.sourceId,
        reason: matchReason,
      },
    });
    if (result) setMatching(null);
  };

  const submitUndo = () => {
    if (!undoing) return;
    const result = api.dispatch({
      type: 'bankRow.undo',
      input: { rowId: undoing.id, reversalDate: undoForm.date, reason: undoForm.reason },
    });
    if (result) setUndoing(null);
  };

  return (
    <div className="screen">
      {accountingStatus !== 'active' && (
        <div className="callout callout-warn" role="status">
          <strong>Accounting is {accountingStatus}.</strong> Bank statements and operational records
          stay visible, but importing and reconciling are unavailable.
        </div>
      )}
      {page === 'statements' && (
        <>
          <div className="stat-row">
            <div className="stat">
              <span>Demo bank ledger balance</span>
              <strong>{bankBalance ? peso(bankBalance.netDebitCentavos) : '—'}</strong>
            </div>
            <div className="stat">
              <span>Unmatched rows</span>
              <strong>{rows.filter((row) => row.status === 'unmatched').length}</strong>
            </div>
            <div className="stat">
              <span>Reconciled rows</span>
              <strong>{rows.filter((row) => row.status === 'reconciled').length}</strong>
            </div>
            <div className="stat">
              <span>Statement imports</span>
              <strong>
                {statements.filter((statement) => statement.bankAccountId === activeBankId).length}
              </strong>
            </div>
          </div>

          <Panel
            title="Bank statement import"
            subtitle="Generic synthetic CSV only. There is no live bank feed or credential connection in this mockup."
            actions={
              <>
                <button
                  type="button"
                  onClick={() => downloadText('ece-accounting-bank-template.csv', BANK_CSV_TEMPLATE)}
                >
                  Download CSV template
                </button>
                <button type="button" className="primary" onClick={() => setShowImport(true)} disabled={!canImport}>
                  Import CSV
                </button>
                <button type="button" onClick={() => setHistoryOpen(true)}>
                  Import history
                </button>
              </>
            }
          >
            <div className="form-grid">
              <Field label="Bank account" htmlFor="bank-account">
                <select id="bank-account" value={activeBankId} onChange={(event) => setBankId(event.target.value)}>
                  {banks.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.bankCode} · {candidate.bankName} · {candidate.name} {candidate.accountNoMasked}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="field">
                <span className="field-label">Statement conventions</span>
                <p className="field-hint">
                  Required columns: reference, value_date, description, direction (in/out), amount.
                  A duplicate reference within the file or an already imported statement is rejected.
                </p>
              </div>
            </div>
          </Panel>
        </>
      )}

      {(page === 'statements' || page === 'matching') && (
      <Panel
        title="Bank rows and suggested matches"
        subtitle="Suggestions are explainable candidates only. A person chooses the source and records a reason; the suggestion does not post by itself."
      >
        {rows.length === 0 ? (
          <EmptyState title="No bank statement rows for this account">
            Download the template, fill in invented rows, and import. Amounts must be positive
            with at most two decimal places; direction carries the sign.
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <caption>Bank rows for {bank ? `${bank.bankCode} · ${bank.name}` : 'selected account'}</caption>
              <thead>
                <tr>
                  <th scope="col">Value date</th>
                  <th scope="col">Reference</th>
                  <th scope="col">Description</th>
                  <th scope="col">Direction</th>
                  <th scope="col" className="numeric">
                    Amount
                  </th>
                  <th scope="col">Status</th>
                  <th scope="col">Suggested source</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => {
                  const suggestion = suggestions[index];
                  return (
                    <tr key={row.id}>
                      <td>{humanDate(row.valueDate)}</td>
                      <th scope="row">{row.rowRef}</th>
                      <td>{row.description}</td>
                      <td>{row.direction === 'in' ? 'Money in' : 'Money out'}</td>
                      <td className="numeric">{money(row.amountCentavos)}</td>
                      <td>
                        <StatusBadge status={row.status} />
                      </td>
                      <td>
                        {row.status !== 'unmatched' ? (
                          <span className="muted">
                            {row.matchedSourceType ? titleCase(row.matchedSourceType) : '—'} ·{' '}
                            {row.matchReason ?? 'no reason'}
                          </span>
                        ) : suggestion ? (
                          <span>
                            <strong>{suggestion.label}</strong>
                            <br />
                            <span className="muted">{suggestion.reasons.join(' · ')}</span>
                          </span>
                        ) : (
                          <span className="muted">No candidate</span>
                        )}
                      </td>
                      <td className="actions">
                        {row.status === 'unmatched' && suggestion && (
                          <button
                            type="button"
                            className="link-button"
                            disabled={!canMatch || suggestion.confidence === 'none'}
                            onClick={() => {
                              setMatching(suggestion);
                              setMatchReason(suggestion.reasons.join('; '));
                            }}
                          >
                            Review match
                          </button>
                        )}
                        {row.status !== 'unmatched' && (
                          <button
                            type="button"
                            className="link-button"
                            disabled={!canUndo}
                            onClick={() => {
                              setUndoForm({ date: api.clock.today, reason: '' });
                              setUndoing(row);
                            }}
                          >
                            Undo
                          </button>
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

      {page === 'history' && (
        <Panel
          title="Statement import history"
          subtitle="Every imported synthetic statement file, newest first. The file itself is not stored."
        >
          {statements.length === 0 ? (
            <EmptyState title="No statement files imported yet" />
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <caption>Statement imports for the active company</caption>
                <thead>
                  <tr>
                    <th scope="col">Imported</th>
                    <th scope="col">Source</th>
                    <th scope="col">Account</th>
                    <th scope="col" className="numeric">
                      Rows
                    </th>
                    <th scope="col">Imported by</th>
                  </tr>
                </thead>
                <tbody>
                  {statements.slice(0, 50).map((statement) => (
                    <tr key={statement.id}>
                      <td>{humanTimestamp(statement.importedAt)}</td>
                      <td>{statement.sourceName}</td>
                      <td>
                        {(() => {
                          const candidate = state.bankAccounts.find((b) => b.id === statement.bankAccountId);
                          return candidate ? `${candidate.bankCode} · ${candidate.name}` : statement.bankAccountId;
                        })()}
                      </td>
                      <td className="numeric">{statement.rowCount}</td>
                      <td>{state.users.find((user) => user.id === statement.importedBy)?.name ?? statement.importedBy}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      )}

      <Modal
        open={showImport}
        wide
        title="Import synthetic bank CSV"
        onClose={() => setShowImport(false)}
        footer={
          <>
            <button type="button" onClick={() => setShowImport(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="primary"
              onClick={runImport}
              disabled={!preview || preview.errors.length > 0 || preview.rows.length === 0}
            >
              Import {preview?.rows.length ?? 0} row(s)
            </button>
          </>
        }
      >
        <p>
          The file never leaves this browser. Use invented statement references and amounts. No
          bank credentials, live feed, or real customer data are accepted by this demo.
        </p>
        <Field label="Statement source name" htmlFor="bank-source">
          <input id="bank-source" value={sourceName} onChange={(event) => setSourceName(event.target.value)} />
        </Field>
        <Field label="CSV file" htmlFor="bank-file" hint="Alternatively paste CSV text below.">
          <input
            id="bank-file"
            type="file"
            accept=".csv,text/csv"
            onChange={(event) => readFile(event.target.files?.[0] ?? null)}
          />
        </Field>
        <Field label="CSV text" htmlFor="bank-csv">
          <textarea
            id="bank-csv"
            rows={8}
            value={csvText}
            onChange={(event) => {
              setCsvText(event.target.value);
              setPreview(null);
            }}
            placeholder={BANK_CSV_TEMPLATE}
          />
        </Field>
        <div className="button-row">
          <button type="button" onClick={() => setPreview(parseBankCsv(csvText))} disabled={!csvText.trim()}>
            Validate and preview
          </button>
        </div>
        {preview && (
          <div className="preview">
            <p role="status">
              <strong>{preview.rows.length}</strong> valid row(s); <strong>{preview.errors.length}</strong>{' '}
              error(s). Nothing is written until Import is chosen.
            </p>
            {preview.errors.length > 0 && (
              <ul className="error-list" role="alert">
                {preview.errors.map((error, index) => (
                  <li key={index}>{error}</li>
                ))}
              </ul>
            )}
            {preview.rows.length > 0 && (
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th scope="col">Reference</th>
                      <th scope="col">Date</th>
                      <th scope="col">Direction</th>
                      <th scope="col" className="numeric">
                        Amount
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.slice(0, 10).map((row) => (
                      <tr key={row.rowRef}>
                        <td>{row.rowRef}</td>
                        <td>{humanDate(row.valueDate)}</td>
                        <td>{row.direction}</td>
                        <td className="numeric">{money(row.amountCentavos)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </Modal>

      <Modal
        open={matching !== null}
        title={matching ? `Match ${matching.row.rowRef}` : 'Match bank row'}
        onClose={() => setMatching(null)}
        footer={
          <>
            <button type="button" onClick={() => setMatching(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="primary"
              onClick={submitMatch}
              disabled={matchReason.trim().length < 3}
            >
              Record reconciliation
            </button>
          </>
        }
      >
        {matching && (
          <div>
            <p>
              Bank row {matching.row.rowRef} · {money(matching.row.amountCentavos)} on{' '}
              {humanDate(matching.row.valueDate)}.
            </p>
            <p>
              Suggested source: <strong>{matching.label}</strong> ({titleCase(matching.sourceType)})
              <br />
              <span className="muted">{matching.reasons.join(' · ')}</span>
            </p>
            <p>
              The clearing journal is created by the business source, not by this match. The row
              is linked to that source so the clearing control is cleared at most once.
            </p>
            <Field label="Match reason" htmlFor="match-reason" hint="Recorded with the reconciliation; at least three characters.">
              <input id="match-reason" value={matchReason} onChange={(event) => setMatchReason(event.target.value)} />
            </Field>
          </div>
        )}
      </Modal>

      <Modal
        open={undoing !== null}
        title={undoing ? `Undo reconciliation of ${undoing.rowRef}` : 'Undo reconciliation'}
        onClose={() => setUndoing(null)}
        footer={
          <>
            <button type="button" onClick={() => setUndoing(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="danger"
              onClick={submitUndo}
              disabled={undoForm.reason.trim().length < 3}
            >
              Post linked reversal
            </button>
          </>
        }
      >
        <p>
          Undo records a reason and a linked reversal in an open period. It does not delete the
          import, the match, or the original clearing journal.
        </p>
        <Field label="Reversal date" htmlFor="undo-date">
          <input
            id="undo-date"
            type="date"
            value={undoForm.date}
            onChange={(event) => setUndoForm({ ...undoForm, date: event.target.value })}
          />
        </Field>
        <Field label="Reason" htmlFor="undo-reason">
          <input
            id="undo-reason"
            value={undoForm.reason}
            onChange={(event) => setUndoForm({ ...undoForm, reason: event.target.value })}
          />
        </Field>
      </Modal>

      <Modal open={historyOpen} wide title="Statement import history" onClose={() => setHistoryOpen(false)}>
        {statements.length === 0 ? (
          <EmptyState title="No statement files imported yet" />
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Imported</th>
                <th scope="col">Source</th>
                <th scope="col">Account</th>
                <th scope="col" className="numeric">
                  Rows
                </th>
                <th scope="col">Imported by</th>
              </tr>
            </thead>
            <tbody>
              {statements.slice(0, 50).map((statement) => (
                <tr key={statement.id}>
                  <td>{humanTimestamp(statement.importedAt)}</td>
                  <td>{statement.sourceName}</td>
                  <td>
                    {(() => {
                      const candidate = state.bankAccounts.find((b) => b.id === statement.bankAccountId);
                      return candidate ? `${candidate.bankCode} · ${candidate.name}` : statement.bankAccountId;
                    })()}
                  </td>
                  <td className="numeric">{statement.rowCount}</td>
                  <td>{state.users.find((user) => user.id === statement.importedBy)?.name ?? statement.importedBy}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Modal>
    </div>
  );
}

function latestStatements(
  statements: Array<{ id: string; workspaceId: string; bankAccountId: string; importedAt: string; sourceName: string; rowCount: number; importedBy: string }>,
  workspaceId: string,
) {
  return statements
    .filter((statement) => statement.workspaceId === workspaceId)
    .slice()
    .sort((left, right) => right.importedAt.localeCompare(left.importedAt));
}

function suggestMatch(
  state: ReturnType<typeof useApp>['state'],
  workspaceId: string,
  row: BankRow,
): MatchSuggestion | null {
  const candidates: MatchSuggestion[] = [];
  if (row.direction === 'in') {
    for (const receipt of state.receipts) {
      if (receipt.workspaceId !== workspaceId || receipt.status !== 'posted') continue;
      if (receipt.amountCentavos !== row.amountCentavos) continue;
      const gap = Math.abs(dayDifference(receipt.receiptDate, row.valueDate));
      if (gap > 7) continue;
      const referenceHit =
        receipt.reference.length > 0 &&
        (row.description.toLowerCase().includes(receipt.reference.toLowerCase()) ||
          row.rowRef.toLowerCase().includes(receipt.reference.toLowerCase()));
      candidates.push({
        row,
        sourceType: 'customer_receipt',
        sourceId: receipt.id,
        label: `${receipt.receiptNo} · ${money(receipt.amountCentavos)}`,
        reasons: [
          'same amount',
          gap === 0 ? 'same date' : `${gap} day(s) apart`,
          ...(referenceHit ? ['reference appears in statement'] : []),
        ],
        confidence: gap <= 2 || referenceHit ? 'strong' : 'possible',
      });
    }
  } else {
    for (const payment of state.payments) {
      if (payment.workspaceId !== workspaceId) continue;
      if (payment.amountCentavos !== row.amountCentavos) continue;
      const gap = Math.abs(dayDifference(payment.paymentDate, row.valueDate));
      if (gap > 7) continue;
      candidates.push({
        row,
        sourceType: 'payment',
        sourceId: payment.id,
        label: `${payment.paymentNo} · ${money(payment.amountCentavos)}`,
        reasons: ['same amount', gap === 0 ? 'same date' : `${gap} day(s) apart`, `payment method ${payment.method}`],
        confidence: gap <= 2 ? 'strong' : 'possible',
      });
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((left, right) => {
    if (left.confidence !== right.confidence) return left.confidence === 'strong' ? -1 : 1;
    return left.label.localeCompare(right.label);
  });
  if (candidates.length > 1) {
    return {
      ...candidates[0]!,
      reasons: [...candidates[0]!.reasons, `${candidates.length} candidates — review`],
      confidence: 'possible',
    };
  }
  return candidates[0]!;
}
