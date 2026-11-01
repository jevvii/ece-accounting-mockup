import { Fragment, useMemo, useState } from 'react';
import {
  expenseReport,
  expenseReportLines,
  salesReport,
  salesReportLines,
  sourceBookTrialBalance,
  trialBalanceCellDrilldown,
} from '../../domain/queries';
import { SOURCE_BOOK_KEYS, SOURCE_BOOK_LABELS, type SourceBookKey } from '../../domain/schema';
import { useApp } from '../useApp';
import { useAppRoute } from '../navigation';
import { downloadText, toCsv } from '../../adapters/csv';
import { EmptyState, Modal, Panel } from '../components';
import { humanDate, money, peso, titleCase } from '../format';
import { shiftMonth, trialBalancePeriod, TRIAL_BALANCE_PRESETS, type TrialBalancePreset } from '../../domain/shared/reportPeriod';

type ReportTab = 'trial-balance' | 'expenses' | 'sales';

function fiscalYearStart(today: string, startMonth: number): string {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const startYear = month < startMonth ? year - 1 : year;
  return `${startYear}-${String(startMonth).padStart(2, '0')}-01`;
}

interface DrilldownTarget {
  accountId: string;
  accountCode: string;
  accountName: string;
  book?: SourceBookKey;
}

export function ReportsScreen() {
  const api = useApp();
  const route = useAppRoute();
  const { state, workspaceId } = api;
  const workspace = state.workspaces.find((candidate) => candidate.id === workspaceId);
  const accountingStatus = api.productStatus('accounting');
  const tab: ReportTab =
    route?.page === 'expenses' || route?.page === 'sales' ? route.page : 'trial-balance';

  const [tbPreset, setTbPreset] = useState<TrialBalancePreset>('month_end');
  const [tbMonth, setTbMonth] = useState(api.clock.today.slice(0, 7));
  const [customAsOf, setCustomAsOf] = useState(api.clock.today);
  const [customFrom, setCustomFrom] = useState(() => fiscalYearStart(api.clock.today, workspace?.fiscalYearStartMonth ?? 1));
  const [customTo, setCustomTo] = useState(api.clock.today);
  const period = trialBalancePeriod({ preset: tbPreset, month: tbMonth, asOfDate: customAsOf, fromDate: customFrom, toDate: customTo });
  const tbMode = period.ok ? period.value.mode : 'as_of';
  const tbTo = period.ok ? period.value.toDate : '0000-01-01';
  const tbFrom = period.ok ? period.value.fromDate ?? customFrom : customFrom;
  const previousMonth = shiftMonth(tbMonth, -1);
  const nextMonth = shiftMonth(tbMonth, 1);
  const scopeLabel = !period.ok ? 'Choose a valid report period' : tbMode === 'as_of'
    ? `As of ${humanDate(tbTo)}${tbPreset === 'month_end' ? ' · Month end' : ''}`
    : `Activity ${humanDate(tbFrom)} to ${humanDate(tbTo)}`;
  const [tbSearch, setTbSearch] = useState('');

  // Expenses & Sales scope state
  const [fromDate, setFromDate] = useState(() =>
    fiscalYearStart(api.clock.today, workspace?.fiscalYearStartMonth ?? 1),
  );
  const [toDate, setToDate] = useState(api.clock.today);

  // Drilldown modal state
  const [drilldownTarget, setDrilldownTarget] = useState<DrilldownTarget | null>(null);

  const invalidRange =
    tab === 'trial-balance'
      ? !period.ok
      : fromDate > toDate;

  const tb = useMemo(
    () =>
      sourceBookTrialBalance(state, workspaceId, {
        toDate: tbTo,
        fromDate: tbMode === 'activity' ? tbFrom : null,
        mode: tbMode,
        search: tbSearch,
      }),
    [state, workspaceId, tbTo, tbFrom, tbMode, tbSearch],
  );

  const expenses = useMemo(
    () => expenseReport(state, workspaceId, fromDate, toDate),
    [state, workspaceId, fromDate, toDate],
  );
  const expenseLines = useMemo(
    () => expenseReportLines(state, workspaceId, fromDate, toDate),
    [state, workspaceId, fromDate, toDate],
  );
  const sales = useMemo(
    () => salesReport(state, workspaceId, fromDate, toDate),
    [state, workspaceId, fromDate, toDate],
  );
  const salesLines = useMemo(
    () => salesReportLines(state, workspaceId, fromDate, toDate),
    [state, workspaceId, fromDate, toDate],
  );

  const drilldownLines = useMemo(() => {
    if (!drilldownTarget) return [];
    return trialBalanceCellDrilldown(state, workspaceId, {
      accountId: drilldownTarget.accountId,
      book: drilldownTarget.book,
      toDate: tbTo,
      fromDate: tbMode === 'activity' ? tbFrom : null,
      mode: tbMode,
      actorId: api.actorId,
    });
  }, [state, workspaceId, drilldownTarget, tbTo, tbFrom, tbMode, api.actorId]);

  const exportCurrent = () => {
    if (invalidRange) return;
    if (tab === 'trial-balance') {
      const rows = tb.rows.map((row) => ({
        'Account Code': row.accountCode,
        'Account Name': row.accountName,
        'Account Type': titleCase(row.accountType),
        'Sales Report Debit': (row.books.sales.debitCentavos / 100).toFixed(2),
        'Sales Report Credit': (row.books.sales.creditCentavos / 100).toFixed(2),
        'Collections Debit': (row.books.collections.debitCentavos / 100).toFixed(2),
        'Collections Credit': (row.books.collections.creditCentavos / 100).toFixed(2),
        'Purchases Debit': (row.books.purchases.debitCentavos / 100).toFixed(2),
        'Purchases Credit': (row.books.purchases.creditCentavos / 100).toFixed(2),
        'Cash Disbursements Debit': (row.books.cash_disbursements.debitCentavos / 100).toFixed(2),
        'Cash Disbursements Credit': (row.books.cash_disbursements.creditCentavos / 100).toFixed(2),
        'Journals Debit': (row.books.journals.debitCentavos / 100).toFixed(2),
        'Journals Credit': (row.books.journals.creditCentavos / 100).toFixed(2),
        'Net Closing Debit': (row.closingDebitCentavos / 100).toFixed(2),
        'Net Closing Credit': (row.closingCreditCentavos / 100).toFixed(2),
      }));

      rows.push({
        'Account Code': 'TOTALS',
        'Account Name': 'TOTALS (BY SOURCE BOOK)',
        'Account Type': '',
        'Sales Report Debit': (tb.bookTotals.sales.debitCentavos / 100).toFixed(2),
        'Sales Report Credit': (tb.bookTotals.sales.creditCentavos / 100).toFixed(2),
        'Collections Debit': (tb.bookTotals.collections.debitCentavos / 100).toFixed(2),
        'Collections Credit': (tb.bookTotals.collections.creditCentavos / 100).toFixed(2),
        'Purchases Debit': (tb.bookTotals.purchases.debitCentavos / 100).toFixed(2),
        'Purchases Credit': (tb.bookTotals.purchases.creditCentavos / 100).toFixed(2),
        'Cash Disbursements Debit': (tb.bookTotals.cash_disbursements.debitCentavos / 100).toFixed(2),
        'Cash Disbursements Credit': (tb.bookTotals.cash_disbursements.creditCentavos / 100).toFixed(2),
        'Journals Debit': (tb.bookTotals.journals.debitCentavos / 100).toFixed(2),
        'Journals Credit': (tb.bookTotals.journals.creditCentavos / 100).toFixed(2),
        'Net Closing Debit': (tb.totals.closingDebitCentavos / 100).toFixed(2),
        'Net Closing Credit': (tb.totals.closingCreditCentavos / 100).toFixed(2),
      });

      rows.push({
        'Account Code': 'COMBINED GROSS TOTALS',
        'Account Name': 'Gross turnover per side across all books',
        'Account Type': '',
        'Sales Report Debit': (tb.grossTotals.debitCentavos / 100).toFixed(2),
        'Sales Report Credit': (tb.grossTotals.creditCentavos / 100).toFixed(2),
        'Collections Debit': '',
        'Collections Credit': '',
        'Purchases Debit': '',
        'Purchases Credit': '',
        'Cash Disbursements Debit': '',
        'Cash Disbursements Credit': '',
        'Journals Debit': '',
        'Journals Credit': '',
        'Net Closing Debit': '',
        'Net Closing Credit': '',
      });

      const scopeSlug = tbPreset === 'month_end' || tbPreset === 'month_activity'
        ? `${tbPreset.replaceAll('_', '-')}-${tbMonth}`
        : `${tbPreset.replaceAll('_', '-')}-${tbMode === 'activity' ? `${tbFrom}-to-` : ''}${tbTo}`;
      downloadText(`ece-accounting-trial-balance-${scopeSlug}.csv`, toCsv(rows.map((row) => ({ Scope: scopeLabel, ...row }))));
      return;
    }

    if (tab === 'expenses') {
      downloadText(
        `ece-accounting-expense-report-${fromDate}-${toDate}.csv`,
        toCsv(
          expenseLines.lines.map((line) => ({
            kind: line.kind,
            document_no: line.documentNo,
            party: line.partyName,
            transaction_date: line.transactionDate,
            due_date: line.dueDate ?? '',
            description: line.description,
            subtotal_centavos: line.subtotalCentavos,
            tax_centavos: line.taxCentavos,
            total_centavos: line.totalCentavos,
            paid_centavos: line.paidCentavos,
            outstanding_centavos: line.outstandingCentavos,
            source_type: line.sourceType,
            source_id: line.sourceId,
          })),
        ),
      );
      return;
    }

    downloadText(
      `ece-accounting-sales-report-${fromDate}-${toDate}.csv`,
      toCsv(
        salesLines.map((line) => ({
          invoice_no: line.invoiceNo,
          customer: line.customerName,
          invoice_date: line.invoiceDate,
          due_date: line.dueDate,
          status: line.status,
          tax_treatment: line.taxTreatment,
          subtotal_centavos: line.subtotalCentavos,
          tax_centavos: line.taxCentavos,
          total_centavos: line.totalCentavos,
          paid_centavos: line.paidCentavos,
          outstanding_centavos: line.outstandingCentavos,
        })),
      ),
    );
  };

  return (
    <div className="screen">
      {accountingStatus !== 'active' && (
        <div className="callout callout-warn" role="status">
          <strong>Accounting is {accountingStatus}.</strong> Reports remain readable for this
          browser-local demo, but no new postings can be created.
        </div>
      )}

      {/* Print Document Header (Visible during Print) */}
      <div className="print-document print-only">
        <p className="print-banner">LOCAL DEMO · SYNTHETIC DATA · ECE ACCOUNTING</p>
        <header className="print-head">
          <div>
            <h2>{workspace?.legalName ?? 'Demo Company'}</h2>
            <p>TIN: {workspace?.tin ?? '000-000-000-000'}</p>
          </div>
          <div className="print-meta">
            <p>
              <strong>
                {tab === 'trial-balance'
                  ? 'Trial Balance — By Source Book'
                  : tab === 'expenses'
                    ? 'Expenses by Account'
                    : 'Sales Register'}
              </strong>
            </p>
            <p>
              Scope:{' '}
              {tab === 'trial-balance' ? scopeLabel : `${humanDate(fromDate)} to ${humanDate(toDate)}`}
            </p>
            <p>Printed: {humanDate(api.clock.today)}</p>
          </div>
        </header>
      </div>

      <Panel
        title="Report scope & parameters"
        subtitle="Reports read posted journals only. A draft or held document never appears in the ledger until it is posted."
        actions={
          <>
            <button type="button" onClick={exportCurrent} disabled={invalidRange}>
              Export current report CSV
            </button>
            <button type="button" onClick={() => window.print()} disabled={invalidRange}>
              Print
            </button>
          </>
        }
      >
        {tab === 'trial-balance' ? (
          <div className="filter-row" style={{ flexWrap: 'wrap', gap: '1rem', alignItems: 'flex-end' }}>
            <label className="inline-control">
              <span>Scope mode</span>
              <select value={tbPreset} onChange={(event) => {
                const option = TRIAL_BALANCE_PRESETS.find((item) => item.id === event.target.value);
                if (option) setTbPreset(option.id);
                setDrilldownTarget(null);
              }}>
                {TRIAL_BALANCE_PRESETS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>
            </label>
            {tbPreset === 'month_end' || tbPreset === 'month_activity' ? (
              <>
                <label className="inline-control">
                  <span>Reporting month</span>
                  <input type="month" value={tbMonth} onChange={(event) => { setTbMonth(event.target.value); setDrilldownTarget(null); }} aria-describedby="tb-month-help" />
                </label>
                <div className="button-row">
                  <button type="button" disabled={!previousMonth.ok} onClick={() => { if (previousMonth.ok) setTbMonth(previousMonth.value); setDrilldownTarget(null); }}>Previous month</button>
                  <button type="button" onClick={() => { setTbMonth(api.clock.today.slice(0, 7)); setDrilldownTarget(null); }}>This month</button>
                  <button type="button" disabled={!nextMonth.ok} onClick={() => { if (nextMonth.ok) setTbMonth(nextMonth.value); setDrilldownTarget(null); }}>Next month</button>
                </div>
                <p id="tb-month-help" className="muted">{tbPreset === 'month_end'
                  ? 'Includes opening balances and all posted entries through the selected month end.'
                  : 'Source columns show only this month’s postings. Closing balances also include earlier history.'}</p>
              </>
            ) : tbPreset === 'as_of' ? (
              <label className="inline-control"><span>As of date</span><input type="date" value={customAsOf} onChange={(event) => setCustomAsOf(event.target.value)} /></label>
            ) : (
              <>
                <label className="inline-control"><span>From</span><input type="date" value={customFrom} onChange={(event) => setCustomFrom(event.target.value)} /></label>
                <label className="inline-control"><span>To</span><input type="date" value={customTo} onChange={(event) => setCustomTo(event.target.value)} /></label>
              </>
            )}

            <label className="inline-control">
              <span>Filter accounts</span>
              <input
                type="search"
                value={tbSearch}
                placeholder="Code or name…"
                onChange={(event) => setTbSearch(event.target.value)}
              />
            </label>

            <span className="muted">
              {workspace
                ? `Fiscal year starts month ${workspace.fiscalYearStartMonth}. Demo date ${humanDate(api.clock.today)}.`
                : ''}
            </span>
          </div>
        ) : (
          <div className="filter-row">
            <label className="inline-control">
              <span>From</span>
              <input
                type="date"
                value={fromDate}
                onChange={(event) => setFromDate(event.target.value)}
              />
            </label>
            <label className="inline-control">
              <span>To</span>
              <input type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} />
            </label>
            <span className="muted">
              {workspace
                ? `Fiscal year starts month ${workspace.fiscalYearStartMonth}. Demo date ${humanDate(api.clock.today)}.`
                : ''}
            </span>
          </div>
        )}
        {invalidRange && (
          <p className="callout callout-error" role="alert">
            {tab === 'trial-balance' && !period.ok ? period.error.message : 'The start date must be on or before the end date.'}
          </p>
        )}
      </Panel>

      {tab === 'trial-balance' && !invalidRange && (
        <Panel
          title="Trial Balance"
          subtitle={`By source book — ${scopeLabel}`}
          actions={
            <span className={`status-badge ${tb.balanced ? 'badge-ok' : 'badge-error'}`}>
              {tb.balanced ? 'Balanced' : 'Out of balance'}
            </span>
          }
        >
          {/* Reconciliation & Summary Strip */}
          <div className="stat-row">
            <div className="stat">
              <span className="stat-label">Source Books</span>
              <span className="stat-value">
                <span className={`status-badge ${tb.balanced ? 'badge-ok' : 'badge-error'}`}>
                  {tb.balanced ? 'Balanced' : 'Out of balance'}
                </span>
              </span>
              <span className="stat-note">5 balanced source groups</span>
            </div>
            <div className="stat">
              <span className="stat-label">Gross Source Totals</span>
              <span className="stat-value mono">
                Dr {peso(tb.grossTotals.debitCentavos)} / Cr {peso(tb.grossTotals.creditCentavos)}
              </span>
              <span className="stat-note">{tb.includedJournalCount} posted journal(s) included</span>
            </div>
            <div className="stat">
              <span className="stat-label">Net Closing Reconciliation</span>
              <span className="stat-value mono">
                Dr {peso(tb.totals.closingDebitCentavos)} / Cr {peso(tb.totals.closingCreditCentavos)}
              </span>
              <span className="stat-note">Netted balance across all books</span>
            </div>
          </div>
          <p className="muted" style={{ marginTop: '0.5rem', marginBottom: '1rem' }}>
            Gross source columns sum posted activity per book; net closing balance nets debit and credit across all books per account.
          </p>

          {tb.classificationExceptions.length > 0 && (
            <div className="callout callout-warn" role="status" style={{ marginBottom: '1rem' }}>
              <strong>Provisional classification notice:</strong> {tb.classificationExceptions.length} journal(s) could not be definitively classified and are provisionally included under Journals:
              <ul className="compact-list">
                {tb.classificationExceptions.map((ex) => (
                  <li key={ex.journalId}>
                    <strong>{ex.journalNo}</strong> ({titleCase(ex.sourceType)}): {ex.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {tb.rows.length === 0 ? (
            <EmptyState title="No accounts with activity in this period">
              Post an invoice, bill, payroll, or journal to see ledger activity.
            </EmptyState>
          ) : (
            <div
              className="table-wrap table-scroll"
              role="region"
              aria-label="Trial Balance by source book"
              tabIndex={0}
            >
              <table className="data-table">
                <caption>
                  Trial Balance by source book —{' '}
                  {tbMode === 'as_of'
                    ? `As of ${humanDate(tbTo)}`
                    : `${humanDate(tbFrom)} to ${humanDate(tbTo)}`}
                  {tbSearch ? ` · Filtered by "${tbSearch}" (${tb.rows.length} account(s) shown)` : ''}
                </caption>
                <thead>
                  <tr>
                    <th scope="col" rowSpan={2}>
                      Account Code
                    </th>
                    <th scope="col" rowSpan={2}>
                      Account Name
                    </th>
                    <th scope="col" rowSpan={2}>
                      Type
                    </th>
                    <th scope="colgroup" colSpan={2} className="group-head">
                      Sales Report
                    </th>
                    <th scope="colgroup" colSpan={2} className="group-head">
                      Collections
                    </th>
                    <th scope="colgroup" colSpan={2} className="group-head">
                      Purchases
                    </th>
                    <th scope="colgroup" colSpan={2} className="group-head">
                      Cash Disbursements
                    </th>
                    <th scope="colgroup" colSpan={2} className="group-head">
                      Journals
                    </th>
                  </tr>
                  <tr>
                    <th scope="col" className="numeric">
                      Debit
                    </th>
                    <th scope="col" className="numeric">
                      Credit
                    </th>
                    <th scope="col" className="numeric">
                      Debit
                    </th>
                    <th scope="col" className="numeric">
                      Credit
                    </th>
                    <th scope="col" className="numeric">
                      Debit
                    </th>
                    <th scope="col" className="numeric">
                      Credit
                    </th>
                    <th scope="col" className="numeric">
                      Debit
                    </th>
                    <th scope="col" className="numeric">
                      Credit
                    </th>
                    <th scope="col" className="numeric">
                      Debit
                    </th>
                    <th scope="col" className="numeric">
                      Credit
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {tb.rows.map((row) => (
                    <tr key={row.accountId}>
                      <td className="mono">
                        <button
                          type="button"
                          className="link-button mono"
                          onClick={() =>
                            setDrilldownTarget({
                              accountId: row.accountId,
                              accountCode: row.accountCode,
                              accountName: row.accountName,
                            })
                          }
                          aria-label={`Drilldown all books for ${row.accountCode} ${row.accountName}`}
                        >
                          {row.accountCode}
                        </button>
                      </td>
                      <td>
                        <button
                          type="button"
                          className="link-button"
                          onClick={() =>
                            setDrilldownTarget({
                              accountId: row.accountId,
                              accountCode: row.accountCode,
                              accountName: row.accountName,
                            })
                          }
                          aria-label={`Drilldown all books for ${row.accountCode} ${row.accountName}`}
                        >
                          {row.accountName}
                        </button>
                      </td>
                      <td>{titleCase(row.accountType)}</td>
                      {SOURCE_BOOK_KEYS.map((book) => {
                        const dr = row.books[book].debitCentavos;
                        const cr = row.books[book].creditCentavos;
                        return (
                          <Fragment key={book}>
                            <td className="numeric mono">
                              {dr > 0 ? (
                                <button
                                  type="button"
                                  className="link-button numeric mono"
                                  onClick={() =>
                                    setDrilldownTarget({
                                      accountId: row.accountId,
                                      accountCode: row.accountCode,
                                      accountName: row.accountName,
                                      book,
                                    })
                                  }
                                  aria-label={`${row.accountCode} ${row.accountName} — ${SOURCE_BOOK_LABELS[book]} Debit ${peso(dr)}`}
                                >
                                  {money(dr)}
                                </button>
                              ) : (
                                '0.00'
                              )}
                            </td>
                            <td className="numeric mono">
                              {cr > 0 ? (
                                <button
                                  type="button"
                                  className="link-button numeric mono"
                                  onClick={() =>
                                    setDrilldownTarget({
                                      accountId: row.accountId,
                                      accountCode: row.accountCode,
                                      accountName: row.accountName,
                                      book,
                                    })
                                  }
                                  aria-label={`${row.accountCode} ${row.accountName} — ${SOURCE_BOOK_LABELS[book]} Credit ${peso(cr)}`}
                                >
                                  {money(cr)}
                                </button>
                              ) : (
                                '0.00'
                              )}
                            </td>
                          </Fragment>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="total-row">
                    <th scope="row" colSpan={3}>
                      Source Book Totals
                    </th>
                    {SOURCE_BOOK_KEYS.map((book) => (
                      <Fragment key={book}>
                        <td className="numeric mono">{money(tb.bookTotals[book].debitCentavos)}</td>
                        <td className="numeric mono">{money(tb.bookTotals[book].creditCentavos)}</td>
                      </Fragment>
                    ))}
                  </tr>
                  <tr className="total-row summary-total-row">
                    <th scope="row" colSpan={3}>
                      Combined Gross Totals
                    </th>
                    <td className="numeric mono" colSpan={5}>
                      Debit {peso(tb.grossTotals.debitCentavos)}
                    </td>
                    <td className="numeric mono" colSpan={5}>
                      Credit {peso(tb.grossTotals.creditCentavos)}
                    </td>
                  </tr>
                  <tr className="total-row summary-total-row">
                    <th scope="row" colSpan={3}>
                      Net Closing Balance
                    </th>
                    <td className="numeric mono" colSpan={5}>
                      Debit {peso(tb.totals.closingDebitCentavos)}
                    </td>
                    <td className="numeric mono" colSpan={5}>
                      Credit {peso(tb.totals.closingCreditCentavos)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </Panel>
      )}

      {tab === 'expenses' && (
        <>
          <Panel
            title="Expenses by account"
            subtitle="Expense-account movement over the selected dates."
          >
            {expenses.rows.length === 0 ? (
              <EmptyState title="No expense-account activity" />
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">Account</th>
                    <th scope="col" className="numeric">
                      Amount
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {expenses.rows.map((row) => (
                    <tr key={row.accountId}>
                      <th scope="row">
                        {row.code} · {row.name}
                      </th>
                      <td className="numeric">{money(row.amountCentavos)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="total-row">
                    <th scope="row">Total expenses</th>
                    <td className="numeric">{money(expenses.totalCentavos)}</td>
                  </tr>
                </tfoot>
              </table>
            )}
          </Panel>

          <Panel title="Expense lines" subtitle="Bills and expenses posted in the period.">
            {expenseLines.lines.length === 0 ? (
              <EmptyState title="No expense lines in this period" />
            ) : (
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th scope="col">Date</th>
                      <th scope="col">Doc No.</th>
                      <th scope="col">Party</th>
                      <th scope="col">Kind</th>
                      <th scope="col">Description</th>
                      <th scope="col" className="numeric">
                        Total
                      </th>
                      <th scope="col" className="numeric">
                        Paid
                      </th>
                      <th scope="col" className="numeric">
                        Outstanding
                      </th>
                      <th scope="col">Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    {expenseLines.lines.map((line) => (
                      <tr key={line.documentId}>
                        <td>{humanDate(line.transactionDate)}</td>
                        <td className="mono">{line.documentNo}</td>
                        <td>{line.partyName}</td>
                        <td>{titleCase(line.kind)}</td>
                        <td>{line.description}</td>
                        <td className="numeric">{money(line.totalCentavos)}</td>
                        <td className="numeric">{money(line.paidCentavos)}</td>
                        <td className="numeric">{money(line.outstandingCentavos)}</td>
                        <td>
                          {line.sourceType === 'bill' ? (
                            <a href={`#/purchases/bills/${line.sourceId}`}>Bill detail</a>
                          ) : (
                            <a href={`#/purchases/advances/${line.sourceId}`}>Advance detail</a>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="total-row">
                      <th scope="row" colSpan={5}>
                        Totals
                      </th>
                      <td className="numeric">
                        {money(expenseLines.lines.reduce((sum, line) => sum + line.totalCentavos, 0))}
                      </td>
                      <td className="numeric">
                        {money(expenseLines.lines.reduce((sum, line) => sum + line.paidCentavos, 0))}
                      </td>
                      <td className="numeric">
                        {money(expenseLines.lines.reduce((sum, line) => sum + line.outstandingCentavos, 0))}
                      </td>
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </Panel>
        </>
      )}

      {tab === 'sales' && (
        <>
          <Panel title="Sales summary" subtitle="Customer revenue recognition for the period.">
            {sales.rows.length === 0 ? (
              <EmptyState title="No sales-account activity" />
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">Account</th>
                    <th scope="col" className="numeric">
                      Amount
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sales.rows.map((row) => (
                    <tr key={row.accountId}>
                      <th scope="row">
                        {row.code} · {row.name}
                      </th>
                      <td className="numeric">{money(row.amountCentavos)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="total-row">
                    <th scope="row">Total sales</th>
                    <td className="numeric">{money(sales.totalCentavos)}</td>
                  </tr>
                </tfoot>
              </table>
            )}
          </Panel>

          <Panel title="Sales invoice detail" subtitle="Posted invoices within the selected date range.">
            {salesLines.length === 0 ? (
              <EmptyState title="No sales invoices in this period" />
            ) : (
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th scope="col">Invoice</th>
                      <th scope="col">Date</th>
                      <th scope="col">Customer</th>
                      <th scope="col" className="numeric">
                        Subtotal
                      </th>
                      <th scope="col" className="numeric">
                        Tax
                      </th>
                      <th scope="col" className="numeric">
                        Total
                      </th>
                      <th scope="col" className="numeric">
                        Paid
                      </th>
                      <th scope="col" className="numeric">
                        Balance
                      </th>
                      <th scope="col">Status</th>
                      <th scope="col">Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    {salesLines.map((line) => (
                      <tr key={line.invoiceId}>
                        <td className="mono">{line.invoiceNo}</td>
                        <td>{humanDate(line.invoiceDate)}</td>
                        <td>{line.customerName}</td>
                        <td className="numeric">{money(line.subtotalCentavos)}</td>
                        <td className="numeric">{money(line.taxCentavos)}</td>
                        <td className="numeric">{money(line.totalCentavos)}</td>
                        <td className="numeric">{money(line.paidCentavos)}</td>
                        <td className="numeric">{money(line.outstandingCentavos)}</td>
                        <td>{titleCase(line.status)}</td>
                        <td>
                          <a href={`#/billing/invoices/${line.invoiceId}`}>Invoice detail</a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="total-row">
                      <th scope="row" colSpan={3}>
                        Totals
                      </th>
                      <td className="numeric">
                        {money(salesLines.reduce((sum, line) => sum + line.subtotalCentavos, 0))}
                      </td>
                      <td className="numeric">
                        {money(salesLines.reduce((sum, line) => sum + line.taxCentavos, 0))}
                      </td>
                      <td className="numeric">
                        {money(salesLines.reduce((sum, line) => sum + line.totalCentavos, 0))}
                      </td>
                      <td className="numeric">
                        {money(salesLines.reduce((sum, line) => sum + line.paidCentavos, 0))}
                      </td>
                      <td className="numeric">
                        {money(salesLines.reduce((sum, line) => sum + line.outstandingCentavos, 0))}
                      </td>
                      <td colSpan={2} />
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </Panel>
        </>
      )}

      {/* Cell Drill-Through Modal */}
      {drilldownTarget && (
        <Modal
          open={drilldownTarget !== null}
          title={`Ledger Drill-Through: ${drilldownTarget.accountCode} · ${drilldownTarget.accountName}${
            drilldownTarget.book ? ` (${SOURCE_BOOK_LABELS[drilldownTarget.book]})` : ' (All books)'
          }`}
          wide
          onClose={() => setDrilldownTarget(null)}
          footer={
            <button type="button" className="primary" onClick={() => setDrilldownTarget(null)}>
              Close
            </button>
          }
        >
          <div className="drilldown-summary" style={{ marginBottom: '1rem' }}>
            <p>
              <strong>Scope:</strong>{' '}
              {tbMode === 'as_of' ? `As of ${humanDate(tbTo)}` : `${humanDate(tbFrom)} to ${humanDate(tbTo)}`} ·{' '}
              {drilldownLines.length} contributing posted journal line(s)
            </p>
          </div>
          {drilldownLines.length === 0 ? (
            <EmptyState title="No contributing journal lines found for this selection" />
          ) : (
            <div
              className="table-wrap table-scroll"
              role="region"
              aria-label="Contributing journal lines"
              tabIndex={0}
            >
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">Journal No.</th>
                    <th scope="col">Posting Date</th>
                    <th scope="col">Source Book</th>
                    <th scope="col">Source Type</th>
                    <th scope="col">Source Document</th>
                    <th scope="col">Origin / Reversal</th>
                    <th scope="col">Memo</th>
                    <th scope="col" className="numeric">
                      Debit
                    </th>
                    <th scope="col" className="numeric">
                      Credit
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {drilldownLines.map((line, idx) => (
                    <tr key={`${line.journalId}-${idx}`}>
                      <td className="mono">
                        <a href={`#/other/journals?journalId=${line.journalId}`}>{line.journalNo}</a>
                      </td>
                      <td>{humanDate(line.postingDate)}</td>
                      <td>{SOURCE_BOOK_LABELS[line.book]}</td>
                      <td>{titleCase(line.sourceType)}</td>
                      <td>
                        {line.sourceRoute ? (
                          <a href={line.sourceRoute}>{line.sourceDocumentNo}</a>
                        ) : (
                          line.sourceDocumentNo
                        )}
                      </td>
                      <td>
                        {line.reversalOf && (
                          <span>Reversal of {line.originJournalId ?? line.reversalOf} </span>
                        )}
                        {line.reversedBy && <span>Reversed by {line.reversedBy} </span>}
                        {line.provisional && (
                          <span className="badge badge-warn">
                            Provisional: {line.exceptionReason ?? 'Review required'}
                          </span>
                        )}
                        {!line.reversalOf && !line.reversedBy && !line.provisional && '—'}
                      </td>
                      <td>{line.memo}</td>
                      <td className="numeric mono">
                        {line.debitCentavos > 0 ? peso(line.debitCentavos) : '—'}
                      </td>
                      <td className="numeric mono">
                        {line.creditCentavos > 0 ? peso(line.creditCentavos) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="total-row">
                    <th scope="row" colSpan={7}>
                      Drill-Through Totals
                    </th>
                    <td className="numeric mono">
                      {peso(drilldownLines.reduce((sum, l) => sum + l.debitCentavos, 0))}
                    </td>
                    <td className="numeric mono">
                      {peso(drilldownLines.reduce((sum, l) => sum + l.creditCentavos, 0))}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
