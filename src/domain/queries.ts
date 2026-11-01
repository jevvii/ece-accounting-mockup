import { canViewPayrollDetail, journalForViewer, payrollSensitiveJournal } from './journalVisibility';
import { accountBalance, resolveJournalProvenance } from './ledger';
import { movementPool, locationQuantity, itemsForWorkspace, averageUnitCost } from './inventory';
import { monthlyDepreciation, assetNetBookValue } from './assets';
import type { Account, AppState, Invoice, PayrollRun, SourceBookKey } from './schema';
import { SOURCE_BOOK_KEYS } from './schema';
import { dayDifference } from './shared/dates';
import { sumCentavos } from './shared/money';

export interface SourceBookAmount {
  debitCentavos: number;
  creditCentavos: number;
}

export interface TrialBalanceClassificationException {
  journalId: string;
  journalNo: string;
  sourceType: string;
  reason: string;
}

export interface TrialBalanceRow {
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: Account['type'];
  normalSide: Account['normalBalance'];
  // Compatibility properties
  code: string;
  name: string;
  type: Account['type'];
  normalBalance: Account['normalBalance'];

  books: Record<SourceBookKey, SourceBookAmount>;
  netBalance: SourceBookAmount;
  // Backward-compatible fields:
  openingDebitCentavos: number;
  openingCreditCentavos: number;
  debitCentavos: number;
  creditCentavos: number;
  closingDebitCentavos: number;
  closingCreditCentavos: number;
}

export interface TrialBalance {
  asOfDate: string;
  fromDate: string | null;
  mode: 'as_of' | 'activity';
  rows: TrialBalanceRow[];
  bookTotals: Record<SourceBookKey, SourceBookAmount>;
  grossTotals: SourceBookAmount;
  netBalanceTotals: SourceBookAmount;
  includedJournalCount: number;
  classificationExceptions: TrialBalanceClassificationException[];
  // Backward-compatible fields:
  totals: {
    openingDebitCentavos: number;
    openingCreditCentavos: number;
    debitCentavos: number;
    creditCentavos: number;
    closingDebitCentavos: number;
    closingCreditCentavos: number;
  };
  totalOpeningDebitCentavos: number;
  totalOpeningCreditCentavos: number;
  totalDebitCentavos: number;
  totalCreditCentavos: number;
  totalClosingDebitCentavos: number;
  totalClosingCreditCentavos: number;
  balanced: boolean;
}

export interface TrialBalanceDrilldownLine {
  journalId: string;
  journalNo: string;
  postingDate: string;
  documentDate: string;
  book: SourceBookKey;
  sourceType: string;
  sourceId: string;
  sourceDocumentNo: string;
  sourceRoute: string;
  memo: string;
  debitCentavos: number;
  creditCentavos: number;
  originJournalId: string | null;
  reversalOf: string | null;
  reversedBy: string | null;
  provisional: boolean;
  exceptionReason: string | null;
}

export function trialBalance(
  state: AppState,
  workspaceId: string,
  fromDate?: string | null,
  toDate?: string,
): TrialBalance {
  const isActivity = Boolean(fromDate && fromDate.trim() !== '');
  const mode: 'as_of' | 'activity' = isActivity ? 'activity' : 'as_of';
  const effectiveFromDate: string | null = isActivity ? (fromDate as string) : null;
  const effectiveToDate: string = toDate && toDate.trim() !== '' ? toDate : '9999-12-31';
  const asOfDate: string = effectiveToDate === '9999-12-31' ? (toDate ?? '9999-12-31') : effectiveToDate;

  const workspaceJournals = state.journals.filter((j) => j.workspaceId === workspaceId);
  const includedJournals = workspaceJournals.filter((j) => {
    if (mode === 'as_of') {
      return j.postingDate <= effectiveToDate;
    }
    return (
      effectiveFromDate !== null &&
      j.postingDate >= effectiveFromDate &&
      j.postingDate <= effectiveToDate
    );
  });
  const openingJournals = workspaceJournals.filter((j) => {
    if (mode === 'activity' && effectiveFromDate !== null) {
      return j.postingDate < effectiveFromDate;
    }
    return false;
  });

  const classificationExceptions: TrialBalanceClassificationException[] = [];
  const seenExceptions = new Set<string>();

  for (const journal of includedJournals) {
    const prov = journal.sourceProvenance ?? resolveJournalProvenance(state, journal);
    if (prov.provisional && !seenExceptions.has(journal.id)) {
      seenExceptions.add(journal.id);
      classificationExceptions.push({
        journalId: journal.id,
        journalNo: journal.journalNo,
        sourceType: journal.sourceType,
        reason: prov.exceptionReason ?? 'Provisional classification',
      });
    }
  }

  const rows: TrialBalanceRow[] = [];
  const workspaceAccounts = state.accounts.filter((a) => a.workspaceId === workspaceId);

  for (const account of workspaceAccounts) {
    let openingDebit = 0;
    let openingCredit = 0;
    for (const journal of openingJournals) {
      for (const line of journal.lines) {
        if (line.accountId === account.id) {
          openingDebit += line.debitCentavos;
          openingCredit += line.creditCentavos;
        }
      }
    }

    const books: Record<SourceBookKey, SourceBookAmount> = {
      sales: { debitCentavos: 0, creditCentavos: 0 },
      collections: { debitCentavos: 0, creditCentavos: 0 },
      purchases: { debitCentavos: 0, creditCentavos: 0 },
      cash_disbursements: { debitCentavos: 0, creditCentavos: 0 },
      journals: { debitCentavos: 0, creditCentavos: 0 },
    };

    for (const journal of includedJournals) {
      const prov = journal.sourceProvenance ?? resolveJournalProvenance(state, journal);
      for (const line of journal.lines) {
        if (line.accountId === account.id) {
          books[prov.book].debitCentavos += line.debitCentavos;
          books[prov.book].creditCentavos += line.creditCentavos;
        }
      }
    }

    const periodDebit =
      books.sales.debitCentavos +
      books.collections.debitCentavos +
      books.purchases.debitCentavos +
      books.cash_disbursements.debitCentavos +
      books.journals.debitCentavos;
    const periodCredit =
      books.sales.creditCentavos +
      books.collections.creditCentavos +
      books.purchases.creditCentavos +
      books.cash_disbursements.creditCentavos +
      books.journals.creditCentavos;

    let closingDebitCentavos = 0;
    let closingCreditCentavos = 0;
    let netBalance: SourceBookAmount;

    if (mode === 'as_of') {
      const net = periodDebit - periodCredit;
      netBalance = {
        debitCentavos: net > 0 ? net : 0,
        creditCentavos: net < 0 ? -net : 0,
      };
      closingDebitCentavos = netBalance.debitCentavos;
      closingCreditCentavos = netBalance.creditCentavos;
    } else {
      const activityNet = periodDebit - periodCredit;
      netBalance = {
        debitCentavos: activityNet > 0 ? activityNet : 0,
        creditCentavos: activityNet < 0 ? -activityNet : 0,
      };
      const cumulativeNet = openingDebit - openingCredit + periodDebit - periodCredit;
      closingDebitCentavos = cumulativeNet > 0 ? cumulativeNet : 0;
      closingCreditCentavos = cumulativeNet < 0 ? -cumulativeNet : 0;
    }

    const hasSourceActivity = SOURCE_BOOK_KEYS.some(
      (k) => books[k].debitCentavos !== 0 || books[k].creditCentavos !== 0,
    );
    const hasNonzeroBalance =
      openingDebit !== 0 ||
      openingCredit !== 0 ||
      closingDebitCentavos !== 0 ||
      closingCreditCentavos !== 0 ||
      netBalance.debitCentavos !== 0 ||
      netBalance.creditCentavos !== 0;

    if (!hasSourceActivity && !hasNonzeroBalance && account.controlRole === null) {
      continue;
    }

    rows.push({
      accountId: account.id,
      accountCode: account.code,
      accountName: account.name,
      accountType: account.type,
      normalSide: account.normalBalance,
      code: account.code,
      name: account.name,
      type: account.type,
      normalBalance: account.normalBalance,
      books,
      netBalance,
      openingDebitCentavos: openingDebit,
      openingCreditCentavos: openingCredit,
      debitCentavos: periodDebit,
      creditCentavos: periodCredit,
      closingDebitCentavos,
      closingCreditCentavos,
    });
  }

  rows.sort((left, right) =>
    left.accountCode.localeCompare(right.accountCode, undefined, { numeric: true }),
  );

  const bookTotals: Record<SourceBookKey, SourceBookAmount> = {
    sales: { debitCentavos: 0, creditCentavos: 0 },
    collections: { debitCentavos: 0, creditCentavos: 0 },
    purchases: { debitCentavos: 0, creditCentavos: 0 },
    cash_disbursements: { debitCentavos: 0, creditCentavos: 0 },
    journals: { debitCentavos: 0, creditCentavos: 0 },
  };
  for (const row of rows) {
    for (const key of SOURCE_BOOK_KEYS) {
      bookTotals[key].debitCentavos += row.books[key].debitCentavos;
      bookTotals[key].creditCentavos += row.books[key].creditCentavos;
    }
  }

  const grossTotals: SourceBookAmount = {
    debitCentavos: SOURCE_BOOK_KEYS.reduce((sum, k) => sum + bookTotals[k].debitCentavos, 0),
    creditCentavos: SOURCE_BOOK_KEYS.reduce((sum, k) => sum + bookTotals[k].creditCentavos, 0),
  };

  const netBalanceTotals: SourceBookAmount = {
    debitCentavos: sumCentavos(rows.map((r) => r.netBalance.debitCentavos)),
    creditCentavos: sumCentavos(rows.map((r) => r.netBalance.creditCentavos)),
  };

  const totals = {
    openingDebitCentavos: sumCentavos(rows.map((row) => row.openingDebitCentavos)),
    openingCreditCentavos: sumCentavos(rows.map((row) => row.openingCreditCentavos)),
    debitCentavos: sumCentavos(rows.map((row) => row.debitCentavos)),
    creditCentavos: sumCentavos(rows.map((row) => row.creditCentavos)),
    closingDebitCentavos: sumCentavos(rows.map((row) => row.closingDebitCentavos)),
    closingCreditCentavos: sumCentavos(rows.map((row) => row.closingCreditCentavos)),
  };

  const allBooksBalanced = SOURCE_BOOK_KEYS.every(
    (k) => bookTotals[k].debitCentavos === bookTotals[k].creditCentavos,
  );
  const grossBalanced = grossTotals.debitCentavos === grossTotals.creditCentavos;
  const netBalanced = netBalanceTotals.debitCentavos === netBalanceTotals.creditCentavos;
  const legacyBalanced =
    totals.openingDebitCentavos === totals.openingCreditCentavos &&
    totals.debitCentavos === totals.creditCentavos &&
    totals.closingDebitCentavos === totals.closingCreditCentavos;

  const balanced = allBooksBalanced && grossBalanced && netBalanced && legacyBalanced;

  return {
    asOfDate,
    fromDate: effectiveFromDate,
    mode,
    rows,
    bookTotals,
    grossTotals,
    netBalanceTotals,
    includedJournalCount: includedJournals.length,
    classificationExceptions,
    totals,
    totalOpeningDebitCentavos: totals.openingDebitCentavos,
    totalOpeningCreditCentavos: totals.openingCreditCentavos,
    totalDebitCentavos: totals.debitCentavos,
    totalCreditCentavos: totals.creditCentavos,
    totalClosingDebitCentavos: totals.closingDebitCentavos,
    totalClosingCreditCentavos: totals.closingCreditCentavos,
    balanced,
  };
}

export function sourceBookTrialBalance(
  state: AppState,
  workspaceId: string,
  options: {
    toDate?: string;
    fromDate?: string | null;
    mode?: 'as_of' | 'activity';
    search?: string;
  } = {},
): TrialBalance {
  const from = options.mode === 'as_of' ? null : (options.fromDate ?? null);
  const tb = trialBalance(state, workspaceId, from, options.toDate);
  if (!options.search || options.search.trim() === '') {
    return tb;
  }
  const query = options.search.trim().toLowerCase();
  const filteredRows = tb.rows.filter(
    (row) =>
      row.accountCode.toLowerCase().includes(query) ||
      row.accountName.toLowerCase().includes(query),
  );
  return {
    ...tb,
    rows: filteredRows,
  };
}

export function trialBalanceCellDrilldown(
  state: AppState,
  workspaceId: string,
  params: {
    accountId: string;
    book?: SourceBookKey;
    toDate?: string;
    fromDate?: string | null;
    mode?: 'as_of' | 'activity';
    actorId?: string;
  },
): TrialBalanceDrilldownLine[] {
  const isActivity =
    params.mode === 'activity' || (params.mode !== 'as_of' && Boolean(params.fromDate && params.fromDate.trim() !== ''));
  const toDate = params.toDate && params.toDate.trim() !== '' ? params.toDate : '9999-12-31';

  const hasPayrollAccess = canViewPayrollDetail(state, workspaceId, params.actorId);

  const workspaceJournals = state.journals.filter((j) => j.workspaceId === workspaceId);
  const filteredJournals = workspaceJournals.filter((j) => {
    if (j.postingDate > toDate) return false;
    if (isActivity && params.fromDate && j.postingDate < params.fromDate) return false;
    return true;
  });

  const lines: TrialBalanceDrilldownLine[] = [];

  for (const journal of filteredJournals) {
    const prov = journal.sourceProvenance ?? resolveJournalProvenance(state, journal);
    if (params.book && prov.book !== params.book) {
      continue;
    }

    const isPayrollJournal = payrollSensitiveJournal(state, journal);
    const visibleJournal = journalForViewer(state, journal, params.actorId);
    let docNo = journal.sourceId;
    const journalRoute = `#/other/journals/${encodeURIComponent(journal.id)}`;
    let route = journalRoute;

    switch (journal.sourceType) {
      case 'invoice':
      case 'invoice_reversal': {
        const doc = state.invoices.find((i) => i.id === journal.sourceId && i.workspaceId === workspaceId);
        docNo = doc?.invoiceNo ?? journal.sourceId;
        route = doc ? `#/billing/invoices/${encodeURIComponent(doc.id)}` : journalRoute;
        break;
      }
      case 'credit_note': {
        const doc = state.creditNotes.find((c) => c.id === journal.sourceId && c.workspaceId === workspaceId);
        docNo = doc?.creditNo ?? journal.sourceId;
        route = journalRoute;
        break;
      }
      case 'customer_receipt':
      case 'receipt_return': {
        const doc = state.receipts.find((r) => r.id === journal.sourceId && r.workspaceId === workspaceId);
        docNo = doc?.receiptNo ?? journal.sourceId;
        route = journalRoute;
        break;
      }
      case 'bill':
      case 'bill_reversal': {
        const doc = state.bills.find((b) => b.id === journal.sourceId && b.workspaceId === workspaceId);
        docNo = doc?.billNo ?? journal.sourceId;
        route = doc ? `#/purchases/bills/${encodeURIComponent(doc.id)}` : journalRoute;
        break;
      }
      case 'payment': {
        const doc = state.payments.find((p) => p.id === journal.sourceId && p.workspaceId === workspaceId);
        docNo = doc?.paymentNo ?? journal.sourceId;
        route = journalRoute;
        break;
      }
      case 'employee_advance': {
        const doc = state.advances.find((a) => a.id === journal.sourceId && a.workspaceId === workspaceId);
        docNo = doc?.advanceNo ?? journal.sourceId;
        route = doc ? `#/purchases/advances/${encodeURIComponent(doc.id)}` : journalRoute;
        break;
      }
      case 'advance_excess_settlement':
      case 'advance_liquidation': {
        const doc = state.liquidations.find((l) => l.id === journal.sourceId && l.workspaceId === workspaceId);
        docNo = doc?.liquidationNo ?? journal.sourceId;
        route = doc ? `#/purchases/advances/${encodeURIComponent(doc.advanceId)}` : journalRoute;
        break;
      }
      case 'customer_refund': {
        const doc = state.refunds.find((r) => r.id === journal.sourceId && r.workspaceId === workspaceId);
        docNo = doc?.refundNo ?? journal.sourceId;
        route = journalRoute;
        break;
      }
      case 'payroll_run':
      case 'payroll_reversal':
      case 'payroll_payment': {
        const doc = state.payrollRuns.find((r) => r.id === journal.sourceId && r.workspaceId === workspaceId);
        docNo = doc?.runNo ?? journal.sourceId;
        route = journalRoute;
        break;
      }
      case 'bank_clearing':
      case 'bank_clearing_undo': {
        const doc = state.bankRows.find((r) => r.id === journal.sourceId && r.workspaceId === workspaceId);
        docNo = doc?.rowRef ?? journal.sourceId;
        route = journalRoute;
        break;
      }
      case 'depreciation': {
        const doc = state.assets.find((a) => a.id === journal.sourceId && a.workspaceId === workspaceId);
        docNo = doc?.assetNo ?? journal.sourceId;
        route = journalRoute;
        break;
      }
      case 'asset_acquisition': {
        const doc = state.assets.find((a) => a.id === journal.sourceId && a.workspaceId === workspaceId);
        docNo = doc?.assetNo ?? journal.sourceId;
        route = doc ? `#/assets/register/${encodeURIComponent(doc.id)}` : journalRoute;
        break;
      }
      case 'inventory_receipt':
      case 'inventory_issue':
      case 'inventory_customer_return':
      case 'inventory_supplier_return':
      case 'inventory_count': {
        const doc = state.movements.find((m) => m.id === journal.sourceId && m.workspaceId === workspaceId);
        docNo = doc?.movementNo ?? journal.sourceId;
        route = journalRoute;
        break;
      }
      case 'journal_draft': {
        const doc = state.journalDrafts.find((d) => d.id === journal.sourceId && d.workspaceId === workspaceId);
        docNo = doc?.draftNo ?? journal.sourceId;
        route = journalRoute;
        break;
      }
      case 'opening':
      case 'standalone_opening':
      case 'opening_import': {
        docNo = journal.journalNo;
        route = journalRoute;
        break;
      }
      default: {
        docNo = journal.journalNo || journal.sourceId;
        route = journalRoute;
        break;
      }
    }

    for (const line of visibleJournal.lines) {
      if (line.accountId !== params.accountId) continue;

      let memoText = line.memo || visibleJournal.memo;
      if (isPayrollJournal && !hasPayrollAccess) {
        memoText = visibleJournal.memo;
        route = journalRoute;
      }

      lines.push({
        journalId: journal.id,
        journalNo: journal.journalNo,
        postingDate: journal.postingDate,
        documentDate: journal.documentDate,
        book: prov.book,
        sourceType: journal.sourceType,
        sourceId: journal.sourceId,
        sourceDocumentNo: docNo,
        sourceRoute: route,
        memo: memoText,
        debitCentavos: line.debitCentavos,
        creditCentavos: line.creditCentavos,
        originJournalId: prov.originJournalId ?? null,
        reversalOf: journal.reversalOf ?? null,
        reversedBy: journal.reversedBy ?? null,
        provisional: prov.provisional,
        exceptionReason: prov.exceptionReason ?? null,
      });
    }
  }

  lines.sort((a, b) => a.postingDate.localeCompare(b.postingDate) || a.journalNo.localeCompare(b.journalNo));
  return lines;
}

export interface ExpenseRow {
  accountId: string;
  code: string;
  name: string;
  amountCentavos: number;
}

export function expenseReport(
  state: AppState,
  workspaceId: string,
  fromDate: string,
  toDate: string,
): { rows: ExpenseRow[]; totalCentavos: number } {
  const rows: ExpenseRow[] = [];
  for (const account of state.accounts) {
    if (account.workspaceId !== workspaceId || account.type !== 'expense') continue;
    const balance = accountBalance(state, workspaceId, account.id, fromDate, toDate);
    const amount = balance.debitCentavos - balance.creditCentavos;
    if (amount !== 0) {
      rows.push({ accountId: account.id, code: account.code, name: account.name, amountCentavos: amount });
    }
  }
  rows.sort((left, right) => left.code.localeCompare(right.code));
  return { rows, totalCentavos: sumCentavos(rows.map((row) => row.amountCentavos)) };
}

export interface ExpenseReportLine {
  kind: 'purchase' | 'reimbursement';
  documentId: string;
  documentNo: string;
  partyName: string;
  transactionDate: string;
  dueDate: string | null;
  description: string;
  subtotalCentavos: number;
  taxCentavos: number;
  totalCentavos: number;
  paidCentavos: number;
  outstandingCentavos: number;
  sourceType: 'bill' | 'liquidation';
  sourceId: string;
}

export function expenseReportLines(
  state: AppState,
  workspaceId: string,
  fromDate: string,
  toDate: string,
): { lines: ExpenseReportLine[]; purchasesTotalCentavos: number; reimbursementTotalCentavos: number } {
  const lines: ExpenseReportLine[] = [];
  for (const bill of state.bills) {
    if (
      bill.workspaceId !== workspaceId ||
      bill.billDate < fromDate ||
      bill.billDate > toDate ||
      bill.status === 'held' ||
      bill.status === 'reversed'
    ) {
      continue;
    }
    lines.push({
      kind: 'purchase',
      documentId: bill.id,
      documentNo: bill.billNo,
      partyName: bill.vendorSnapshot.name,
      transactionDate: bill.billDate,
      dueDate: bill.dueDate,
      description: bill.lines.map((line) => line.description).join('; '),
      subtotalCentavos: bill.subtotalCentavos,
      taxCentavos: bill.taxCentavos,
      totalCentavos: bill.totalCentavos,
      paidCentavos: bill.paidCentavos,
      outstandingCentavos: bill.outstandingCentavos,
      sourceType: 'bill',
      sourceId: bill.id,
    });
  }
  for (const liquidation of state.liquidations) {
    if (
      liquidation.workspaceId !== workspaceId ||
      liquidation.liquidationDate < fromDate ||
      liquidation.liquidationDate > toDate
    ) {
      continue;
    }
    const advance = state.advances.find((candidate) => candidate.id === liquidation.advanceId);
    const employee = state.employees.find((candidate) => candidate.id === advance?.employeeId);
    for (const [index, expense] of liquidation.expenses.entries()) {
      lines.push({
        kind: 'reimbursement',
        documentId: liquidation.id,
        documentNo: `${advance?.advanceNo ?? 'ADV'} · ${index + 1}`,
        partyName: employee?.name ?? 'Unknown employee',
        transactionDate: liquidation.liquidationDate,
        dueDate: null,
        description: expense.description,
        subtotalCentavos: expense.amountCentavos,
        taxCentavos: 0,
        totalCentavos: expense.amountCentavos,
        paidCentavos: expense.amountCentavos,
        outstandingCentavos: 0,
        sourceType: 'liquidation',
        sourceId: liquidation.id,
      });
    }
  }
  lines.sort((left, right) => {
    const byDate = left.transactionDate.localeCompare(right.transactionDate);
    return byDate !== 0 ? byDate : left.documentNo.localeCompare(right.documentNo);
  });
  return {
    lines,
    purchasesTotalCentavos: sumCentavos(
      lines.filter((line) => line.kind === 'purchase').map((line) => line.totalCentavos),
    ),
    reimbursementTotalCentavos: sumCentavos(
      lines.filter((line) => line.kind === 'reimbursement').map((line) => line.totalCentavos),
    ),
  };
}

export interface SalesReportLine {
  invoiceId: string;
  invoiceNo: string;
  customerContactId: string;
  customerName: string;
  invoiceDate: string;
  dueDate: string;
  status: Invoice['status'];
  taxTreatment: Invoice['taxTreatment'];
  subtotalCentavos: number;
  taxCentavos: number;
  totalCentavos: number;
  paidCentavos: number;
  outstandingCentavos: number;
}

export function salesReportLines(
  state: AppState,
  workspaceId: string,
  fromDate: string,
  toDate: string,
): SalesReportLine[] {
  return state.invoices
    .filter(
      (invoice) =>
        invoice.workspaceId === workspaceId &&
        invoice.invoiceDate >= fromDate &&
        invoice.invoiceDate <= toDate &&
        invoice.status !== 'draft' &&
        invoice.status !== 'reversed',
    )
    .map((invoice) => ({
      invoiceId: invoice.id,
      invoiceNo: invoice.invoiceNo,
      customerContactId: invoice.customerContactId,
      customerName: invoice.customerSnapshot.name,
      invoiceDate: invoice.invoiceDate,
      dueDate: invoice.dueDate,
      status: invoice.status,
      taxTreatment: invoice.taxTreatment,
      subtotalCentavos: invoice.subtotalCentavos,
      taxCentavos: invoice.taxCentavos,
      totalCentavos: invoice.totalCentavos,
      paidCentavos: invoice.paidCentavos,
      outstandingCentavos: invoice.outstandingCentavos,
    }))
    .sort((left, right) => {
      const byDate = left.invoiceDate.localeCompare(right.invoiceDate);
      return byDate !== 0 ? byDate : left.invoiceNo.localeCompare(right.invoiceNo);
    });
}

export interface SalesRow {
  accountId: string;
  code: string;
  name: string;
  amountCentavos: number;
}

export function salesReport(
  state: AppState,
  workspaceId: string,
  fromDate: string,
  toDate: string,
): { rows: SalesRow[]; totalCentavos: number; invoices: Invoice[] } {
  const rows: SalesRow[] = [];
  for (const account of state.accounts) {
    if (account.workspaceId !== workspaceId || account.type !== 'revenue') continue;
    const balance = accountBalance(state, workspaceId, account.id, fromDate, toDate);
    const amount = balance.creditCentavos - balance.debitCentavos;
    if (amount !== 0) {
      rows.push({ accountId: account.id, code: account.code, name: account.name, amountCentavos: amount });
    }
  }
  rows.sort((left, right) => left.code.localeCompare(right.code));
  return {
    rows,
    totalCentavos: sumCentavos(rows.map((row) => row.amountCentavos)),
    invoices: state.invoices
      .filter(
        (invoice) =>
          invoice.workspaceId === workspaceId &&
          invoice.invoiceDate >= fromDate &&
          invoice.invoiceDate <= toDate &&
          invoice.status !== 'draft' &&
          invoice.status !== 'reversed',
      )
      .sort((left, right) => left.invoiceDate.localeCompare(right.invoiceDate)),
  };
}

export type AgingBucket = 'current' | 'days_1_30' | 'days_31_60' | 'days_61_90' | 'days_over_90';

export interface AgingRow {
  customerContactId: string;
  customerName: string;
  currentCentavos: number;
  days1To30Centavos: number;
  days31To60Centavos: number;
  days61To90Centavos: number;
  daysOver90Centavos: number;
  totalCentavos: number;
}

export function agingBucket(dueDate: string, asOf: string): AgingBucket {
  const overdue = dayDifference(dueDate, asOf);
  if (overdue <= 0) return 'current';
  if (overdue <= 30) return 'days_1_30';
  if (overdue <= 60) return 'days_31_60';
  if (overdue <= 90) return 'days_61_90';
  return 'days_over_90';
}

export function arAging(state: AppState, workspaceId: string, asOf: string): {
  rows: AgingRow[];
  totals: AgingRow;
} {
  const byCustomer = new Map<string, AgingRow>();
  for (const invoice of state.invoices) {
    if (
      invoice.workspaceId !== workspaceId ||
      invoice.outstandingCentavos <= 0 ||
      invoice.status === 'draft' ||
      invoice.status === 'reversed'
    ) {
      continue;
    }
    const row =
      byCustomer.get(invoice.customerContactId) ??
      ({
        customerContactId: invoice.customerContactId,
        customerName: invoice.customerSnapshot.name,
        currentCentavos: 0,
        days1To30Centavos: 0,
        days31To60Centavos: 0,
        days61To90Centavos: 0,
        daysOver90Centavos: 0,
        totalCentavos: 0,
      } satisfies AgingRow);
    const bucket = agingBucket(invoice.dueDate, asOf);
    if (bucket === 'current') row.currentCentavos += invoice.outstandingCentavos;
    else if (bucket === 'days_1_30') row.days1To30Centavos += invoice.outstandingCentavos;
    else if (bucket === 'days_31_60') row.days31To60Centavos += invoice.outstandingCentavos;
    else if (bucket === 'days_61_90') row.days61To90Centavos += invoice.outstandingCentavos;
    else row.daysOver90Centavos += invoice.outstandingCentavos;
    row.totalCentavos += invoice.outstandingCentavos;
    byCustomer.set(invoice.customerContactId, row);
  }
  const rows = [...byCustomer.values()].sort((left, right) => right.totalCentavos - left.totalCentavos);
  const totals = rows.reduce<AgingRow>(
    (total, row) => ({
      customerContactId: '',
      customerName: 'Total',
      currentCentavos: total.currentCentavos + row.currentCentavos,
      days1To30Centavos: total.days1To30Centavos + row.days1To30Centavos,
      days31To60Centavos: total.days31To60Centavos + row.days31To60Centavos,
      days61To90Centavos: total.days61To90Centavos + row.days61To90Centavos,
      daysOver90Centavos: total.daysOver90Centavos + row.daysOver90Centavos,
      totalCentavos: total.totalCentavos + row.totalCentavos,
    }),
    {
      customerContactId: '',
      customerName: 'Total',
      currentCentavos: 0,
      days1To30Centavos: 0,
      days31To60Centavos: 0,
      days61To90Centavos: 0,
      daysOver90Centavos: 0,
      totalCentavos: 0,
    },
  );
  return { rows, totals };
}

export interface StockRow {
  itemId: string;
  itemNo: string;
  sku: string;
  name: string;
  baseUnit: string;
  quantityMilli: number;
  valueCentavos: number;
  averageUnitCostCentavos: number;
  locations: Array<{ locationId: string; code: string; name: string; quantityMilli: number }>;
}

export type StockValuationRow = StockRow;

export function stockValuation(state: AppState, workspaceId: string): {
  rows: StockRow[];
  totalValueCentavos: number;
  totalQuantityMilli: number;
} {
  const items = itemsForWorkspace(state, workspaceId);
  const rows: StockRow[] = items.map((item) => {
    const pool = movementPool(state, workspaceId, item.id);
    const locations = state.locations
      .filter((location) => location.workspaceId === workspaceId)
      .map((location) => ({
        locationId: location.id,
        code: location.code,
        name: location.name,
        quantityMilli: locationQuantity(state, workspaceId, item.id, location.id),
      }))
      .filter((location) => location.quantityMilli !== 0);
    return {
      itemId: item.id,
      itemNo: item.itemNo,
      sku: item.sku,
      name: item.name,
      baseUnit: item.baseUnit,
      quantityMilli: pool.quantityMilli,
      valueCentavos: pool.valueCentavos,
      averageUnitCostCentavos: averageUnitCost(pool),
      locations,
    };
  });
  return {
    rows,
    totalValueCentavos: sumCentavos(rows.map((row) => row.valueCentavos)),
    totalQuantityMilli: rows.reduce((total, row) => total + row.quantityMilli, 0),
  };
}

export function payrollRegister(run: PayrollRun): Array<{
  employeeId: string;
  employeeName: string;
  basePayCentavos: number;
  grossCentavos: number;
  deductionsCentavos: number;
  netCentavos: number;
  employerCostCentavos: number;
  buckets: number;
}> {
  return run.lines.map((line) => ({
    employeeId: line.employeeId,
    employeeName: line.employeeName,
    basePayCentavos: line.basePayCentavos,
    grossCentavos: line.grossCentavos,
    deductionsCentavos: line.totalDeductionsCentavos,
    netCentavos: line.netCentavos,
    employerCostCentavos: line.employerCostCentavos,
    buckets: line.buckets.length,
  }));
}

export interface AssetScheduleRow {
  assetId: string;
  assetNo: string;
  description: string;
  costCentavos: number;
  monthlyCentavos: number;
  accumulatedCentavos: number;
  netBookValueCentavos: number;
  status: string;
  periodPosted: string | null;
}

export function assetSchedule(
  state: AppState,
  workspaceId: string,
  period: string,
): AssetScheduleRow[] {
  return state.assets
    .filter((asset) => asset.workspaceId === workspaceId)
    .map((asset) => {
      const posted = state.depreciationPosts.filter(
        (post) => post.assetId === asset.id && post.status === 'posted',
      );
      const accumulated = sumCentavos(posted.map((post) => post.amountCentavos));
      return {
        assetId: asset.id,
        assetNo: asset.assetNo,
        description: asset.description,
        costCentavos: asset.costCentavos,
        monthlyCentavos: monthlyDepreciation(asset),
        accumulatedCentavos: accumulated,
        netBookValueCentavos: assetNetBookValue(asset, state),
        status: asset.status,
        periodPosted: state.depreciationPosts.some(
          (post) => post.assetId === asset.id && post.period === period && post.status === 'posted',
        )
          ? period
          : null,
      };
    })
    .sort((left, right) => left.assetNo.localeCompare(right.assetNo));
}

/**
 * Synthetic certificate-gap policy for the mockup only. Real BIR deadlines are
 * not encoded here; the UI labels this figure as a demo grace period.
 */
export const CERTIFICATE_GRACE_DAYS = 30;

export type CertificateGapState = 'linked' | 'pending' | 'missing' | 'not_required';

export interface TaxRegisterRow {
  id: string;
  type: string;
  direction: string;
  taxDate: string;
  partyContactId: string | null;
  partyName: string;
  sourceType: string;
  sourceId: string;
  sourceNo: string;
  description: string;
  baseCentavos: number;
  taxCentavos: number;
  certificateStatus: string;
  certificateId: string | null;
  certificateNo: string | null;
  certificateState: CertificateGapState;
}

export interface TaxRegisterSummary {
  outputVatCentavos: number;
  inputVatCentavos: number;
  netVatPayableCentavos: number;
  ewtCreditableCentavos: number;
  fwtFinalCentavos: number;
  pendingCertificateCount: number;
  missingCertificateCount: number;
}

function sourceDocumentNo(state: AppState, sourceType: string, sourceId: string): string {
  if (sourceType === 'invoice') {
    return state.invoices.find((invoice) => invoice.id === sourceId)?.invoiceNo ?? sourceId;
  }
  if (sourceType === 'credit_note') {
    return state.creditNotes.find((note) => note.id === sourceId)?.creditNo ?? sourceId;
  }
  if (sourceType === 'bill') {
    return state.bills.find((bill) => bill.id === sourceId)?.billNo ?? sourceId;
  }
  if (sourceType === 'payment') {
    return state.payments.find((payment) => payment.id === sourceId)?.paymentNo ?? sourceId;
  }
  return sourceId;
}

export function taxRegister(
  state: AppState,
  workspaceId: string,
  fromDate: string,
  toDate: string,
  options: { asOfDate?: string; graceDays?: number } = {},
): { rows: TaxRegisterRow[]; summary: TaxRegisterSummary } {
  const asOf = options.asOfDate ?? toDate;
  const graceDays = options.graceDays ?? CERTIFICATE_GRACE_DAYS;
  const rows: TaxRegisterRow[] = [];
  for (const record of state.taxRecords) {
    if (record.workspaceId !== workspaceId || record.taxDate < fromDate || record.taxDate > toDate) continue;
    const party = state.contacts.find(
      (contact) => contact.id === record.partyContactId && contact.workspaceId === workspaceId,
    );
    const certificate = state.certificates2307.find(
      (candidate) => candidate.id === record.certificateId && candidate.workspaceId === workspaceId,
    );
    let certificateState: CertificateGapState = 'not_required';
    if (record.type === 'ewt_creditable') {
      if (record.certificateId !== null) certificateState = 'linked';
      else if (dayDifference(record.taxDate, asOf) > graceDays) certificateState = 'missing';
      else certificateState = 'pending';
    }
    rows.push({
      id: record.id,
      type: record.type,
      direction: record.direction,
      taxDate: record.taxDate,
      partyContactId: record.partyContactId,
      partyName: party?.name ?? 'Unknown party',
      sourceType: record.sourceType,
      sourceId: record.sourceId,
      sourceNo: sourceDocumentNo(state, record.sourceType, record.sourceId),
      description: record.description,
      baseCentavos: record.baseCentavos,
      taxCentavos: record.taxCentavos,
      certificateStatus: record.certificateStatus,
      certificateId: record.certificateId,
      certificateNo: certificate?.certificateNo ?? null,
      certificateState,
    });
  }
  rows.sort((left, right) => {
    const byDate = left.taxDate.localeCompare(right.taxDate);
    return byDate !== 0 ? byDate : left.id.localeCompare(right.id);
  });
  const ofType = (type: string) => sumCentavos(rows.filter((row) => row.type === type).map((row) => row.taxCentavos));
  const outputVatCentavos = ofType('output_vat');
  const inputVatCentavos = ofType('input_vat');
  return {
    rows,
    summary: {
      outputVatCentavos,
      inputVatCentavos,
      netVatPayableCentavos: outputVatCentavos - inputVatCentavos,
      ewtCreditableCentavos: ofType('ewt_creditable'),
      fwtFinalCentavos: ofType('fwt_final'),
      pendingCertificateCount: rows.filter((row) => row.certificateState === 'pending').length,
      missingCertificateCount: rows.filter((row) => row.certificateState === 'missing').length,
    },
  };
}

export interface CertificateRegisterRow {
  id: string;
  direction: 'issued' | 'received';
  certificateNo: string;
  certificateDate: string;
  periodFrom: string;
  periodTo: string;
  counterpartyContactId: string;
  counterpartyName: string;
  baseCentavos: number;
  creditableTaxCentavos: number;
  sourceCount: number;
  status: string;
  createdBy: string;
  createdAt: string;
}

export function certificate2307Register(
  state: AppState,
  workspaceId: string,
): CertificateRegisterRow[] {
  return state.certificates2307
    .filter((certificate) => certificate.workspaceId === workspaceId)
    .map((certificate) => {
      const sources = state.taxRecords.filter(
        (record) => record.workspaceId === workspaceId && certificate.sourceTaxRecordIds.includes(record.id),
      );
      const counterparty = state.contacts.find(
        (contact) => contact.id === certificate.counterpartyContactId && contact.workspaceId === workspaceId,
      );
      return {
        id: certificate.id,
        direction: certificate.direction,
        certificateNo: certificate.certificateNo,
        certificateDate: certificate.certificateDate,
        periodFrom: certificate.periodFrom,
        periodTo: certificate.periodTo,
        counterpartyContactId: certificate.counterpartyContactId,
        counterpartyName: counterparty?.name ?? 'Unknown counterparty',
        baseCentavos: sumCentavos(sources.map((record) => record.baseCentavos)),
        creditableTaxCentavos: certificate.creditableTaxCentavos,
        sourceCount: certificate.sourceTaxRecordIds.length,
        status: certificate.status,
        createdBy: certificate.createdBy,
        createdAt: certificate.createdAt,
      };
    })
    .sort((left, right) => {
      const byDate = left.certificateDate.localeCompare(right.certificateDate);
      return byDate !== 0 ? byDate : left.certificateNo.localeCompare(right.certificateNo);
    });
}

export function auditTrail(state: AppState, workspaceId: string, limit = 100) {
  return state.auditEvents
    .filter((event) => event.workspaceId === workspaceId)
    .slice()
    .sort((left, right) => right.at.localeCompare(left.at))
    .slice(0, limit);
}

export function dashboardSummary(state: AppState, workspaceId: string, asOf: string) {
  const bank = state.accounts.find(
    (account) => account.workspaceId === workspaceId && account.controlRole === 'bank',
  );
  const ar = state.accounts.find(
    (account) => account.workspaceId === workspaceId && account.controlRole === 'ar',
  );
  const ap = state.accounts.find(
    (account) => account.workspaceId === workspaceId && account.controlRole === 'ap',
  );
  const bankBalance = bank ? accountBalance(state, workspaceId, bank.id, null, asOf).netDebitCentavos : 0;
  const arBalance = ar ? accountBalance(state, workspaceId, ar.id, null, asOf).netDebitCentavos : 0;
  const apBalance = ap ? -accountBalance(state, workspaceId, ap.id, null, asOf).netDebitCentavos : 0;
  const aging = arAging(state, workspaceId, asOf);
  return {
    bankBalanceCentavos: bankBalance,
    arBalanceCentavos: arBalance,
    apBalanceCentavos: apBalance,
    overdueCentavos:
      aging.totals.days1To30Centavos +
      aging.totals.days31To60Centavos +
      aging.totals.days61To90Centavos +
      aging.totals.daysOver90Centavos,
    openInvoices: state.invoices.filter(
      (invoice) =>
        invoice.workspaceId === workspaceId &&
        invoice.outstandingCentavos > 0 &&
        (invoice.status === 'posted' || invoice.status === 'partially_paid'),
    ).length,
    openBills: state.bills.filter(
      (bill) => bill.workspaceId === workspaceId && bill.outstandingCentavos > 0 && bill.status !== 'held',
    ).length,
    unmatchedBankRows: state.bankRows.filter(
      (row) => row.workspaceId === workspaceId && row.status === 'unmatched',
    ).length,
  };
}

export function periodOptions(state: AppState, workspaceId: string): Array<{ id: string; label: string; status: string }> {
  return state.periods
    .filter((period) => period.workspaceId === workspaceId)
    .map((period) => ({
      id: `${period.year}-${String(period.month).padStart(2, '0')}`,
      label: `${period.year}-${String(period.month).padStart(2, '0')}`,
      status: period.status,
    }));
}
