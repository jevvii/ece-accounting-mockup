import { useEffect, useMemo, useState } from 'react';
import type { Invoice } from '../../domain/schema';
import { arAging } from '../../domain/queries';
import { addDays } from '../../domain/shared/dates';
import { mulDivRound } from '../../domain/shared/money';
import { useApp } from '../useApp';
import { useAppRoute, useNavigation } from '../navigation';
import { appRoute } from '../router';
import {
  ConfirmDialog,
  EmptyState,
  Field,
  Modal,
  Pagination,
  Panel,
  SearchField,
  StatusBadge,
  usePager,
} from '../components';
import { centsInput, humanDate, money, peso, titleCase } from '../format';
import { moneyField, quantityField, requiredField } from '../forms';
import { hasAnyRole } from '../permissions';

type BillingTab = 'invoices' | 'receipts' | 'credits' | 'aging';

interface InvoiceLineDraft {
  description: string;
  quantity: string;
  unitPrice: string;
  accountId: string;
}

interface InvoiceFormState {
  customerContactId: string;
  invoiceDate: string;
  dueDate: string;
  branch: string;
  department: string;
  taxTreatment: 'none' | 'vat12';
  lines: InvoiceLineDraft[];
}

function defaultInvoiceForm(customerId: string, today: string, revenueAccountId: string): InvoiceFormState {
  return {
    customerContactId: customerId,
    invoiceDate: today,
    dueDate: addDays(today, 30),
    branch: 'Main',
    department: 'Operations',
    taxTreatment: 'vat12',
    lines: [{ description: '', quantity: '1', unitPrice: '', accountId: revenueAccountId }],
  };
}

function InvoiceEditor({
  open,
  invoice,
  onClose,
}: {
  open: boolean;
  invoice: Invoice | null;
  onClose: () => void;
}) {
  const api = useApp();
  const customers = useMemo(
    () =>
      api.state.contacts.filter(
        (contact) =>
          contact.workspaceId === api.workspaceId && contact.active && contact.roles.includes('customer'),
      ),
    [api.state.contacts, api.workspaceId],
  );
  const revenueAccounts = useMemo(
    () =>
      api.state.accounts.filter(
        (account) => account.workspaceId === api.workspaceId && account.active && account.type === 'revenue',
      ),
    [api.state.accounts, api.workspaceId],
  );
  const today = api.clock.today;
  const [form, setForm] = useState<InvoiceFormState>(() =>
    defaultInvoiceForm(customers[0]?.id ?? '', today, revenueAccounts[0]?.id ?? ''),
  );
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (invoice) {
      setForm({
        customerContactId: invoice.customerContactId,
        invoiceDate: invoice.invoiceDate,
        dueDate: invoice.dueDate,
        branch: invoice.branch,
        department: invoice.department,
        taxTreatment: invoice.taxTreatment,
        lines: invoice.lines.map((line) => ({
          description: line.description,
          quantity: (line.quantityMilli / 1000).toString(),
          unitPrice: centsInput(line.unitPriceCentavos),
          accountId: line.accountId,
        })),
      });
    } else {
      setForm(defaultInvoiceForm(customers[0]?.id ?? '', today, revenueAccounts[0]?.id ?? ''));
    }
    setError('');
  }, [open, invoice, today, customers, revenueAccounts]);

  const parsedLines = form.lines.map((line) => {
    const quantityResult = quantityField(line.quantity);
    const priceResult = moneyField(line.unitPrice, 'unit price');
    return {
      ...line,
      quantityResult,
      priceResult,
      amount:
        quantityResult.value !== null && priceResult.value !== null
          ? mulDivRound(quantityResult.value, priceResult.value, 1000)
          : null,
    };
  });
  const subtotal = parsedLines.reduce((total, line) => total + (line.amount ?? 0), 0);
  const tax = form.taxTreatment === 'vat12' ? mulDivRound(subtotal, 1200, 10_000) : 0;

  const submit = (postAfter: boolean) => {
    if (!form.customerContactId) {
      setError('Select an active customer.');
      return;
    }
    if (form.lines.length === 0) {
      setError('Add at least one invoice line.');
      return;
    }
    const lines = [];
    for (const [index, line] of parsedLines.entries()) {
      const description = requiredField(line.description, `Line ${index + 1} description`);
      if (!line.quantityResult.ok) {
        setError(`Line ${index + 1}: ${line.quantityResult.message}`);
        return;
      }
      if (!line.priceResult.ok) {
        setError(`Line ${index + 1}: ${line.priceResult.message}`);
        return;
      }
      if (!description.ok || line.quantityResult.value === null || line.priceResult.value === null) {
        setError(`Line ${index + 1} is incomplete.`);
        return;
      }
      lines.push({
        description: description.value ?? '',
        quantityMilli: line.quantityResult.value,
        unitPriceCentavos: line.priceResult.value,
        accountId: line.accountId,
      });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(form.invoiceDate) || !/^\d{4}-\d{2}-\d{2}$/.test(form.dueDate)) {
      setError('Invoice and due dates must use YYYY-MM-DD.');
      return;
    }
    setBusy(true);
    const input = {
      customerContactId: form.customerContactId,
      invoiceDate: form.invoiceDate,
      dueDate: form.dueDate,
      branch: form.branch,
      department: form.department,
      taxTreatment: form.taxTreatment,
      lines,
    };
    const result = invoice
      ? api.dispatch({ type: 'invoice.update', input: { invoiceId: invoice.id, input } })
      : api.dispatch({ type: 'invoice.create', input });
    if (!result) {
      setBusy(false);
      return;
    }
    if (postAfter) {
      api.dispatch({ type: 'invoice.post', input: { invoiceId: result.documentId } });
    }
    setBusy(false);
    onClose();
  };

  const setLine = (index: number, patch: Partial<InvoiceLineDraft>) => {
    setForm((current) => ({
      ...current,
      lines: current.lines.map((line, lineIndex) => (lineIndex === index ? { ...line, ...patch } : line)),
    }));
  };

  return (
    <Modal
      open={open}
      title={invoice ? `Edit draft ${invoice.invoiceNo}` : 'New sales invoice'}
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" onClick={() => submit(false)} disabled={busy}>
            Save draft
          </button>
          <button type="button" className="primary" onClick={() => submit(true)} disabled={busy}>
            Save and post
          </button>
        </>
      }
    >
      <p className="callout callout-info">
        Demo tax profile: a 12% VAT line is an illustrative wiring test, not a statement of
        current Philippine tax law. Totals round half-up to the centavo at posting.
      </p>
      <div className="form-grid">
        <Field label="Customer" htmlFor="invoice-customer">
          <select
            id="invoice-customer"
            value={form.customerContactId}
            onChange={(event) => setForm({ ...form, customerContactId: event.target.value })}
          >
            <option value="">Select customer…</option>
            {customers.map((customer) => (
              <option key={customer.id} value={customer.id}>
                {customer.name} · TIN {customer.tin}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Invoice date" htmlFor="invoice-date">
          <input
            id="invoice-date"
            type="date"
            value={form.invoiceDate}
            onChange={(event) => setForm({ ...form, invoiceDate: event.target.value })}
          />
        </Field>
        <Field label="Due date" htmlFor="invoice-due">
          <input
            id="invoice-due"
            type="date"
            value={form.dueDate}
            onChange={(event) => setForm({ ...form, dueDate: event.target.value })}
          />
        </Field>
        <Field label="Tax treatment" htmlFor="invoice-tax">
          <select
            id="invoice-tax"
            value={form.taxTreatment}
            onChange={(event) =>
              setForm({ ...form, taxTreatment: event.target.value === 'vat12' ? 'vat12' : 'none' })
            }
          >
            <option value="vat12">12% VAT (demo profile)</option>
            <option value="none">No VAT</option>
          </select>
        </Field>
        <Field label="Branch" htmlFor="invoice-branch">
          <input
            id="invoice-branch"
            value={form.branch}
            onChange={(event) => setForm({ ...form, branch: event.target.value })}
          />
        </Field>
        <Field label="Department" htmlFor="invoice-department">
          <input
            id="invoice-department"
            value={form.department}
            onChange={(event) => setForm({ ...form, department: event.target.value })}
          />
        </Field>
      </div>

      <table className="form-table">
        <caption>Invoice lines</caption>
        <thead>
          <tr>
            <th scope="col">Description</th>
            <th scope="col">Quantity</th>
            <th scope="col">Unit price (PHP)</th>
            <th scope="col">Revenue account</th>
            <th scope="col" className="numeric">
              Amount
            </th>
            <th scope="col">
              <span className="sr-only">Remove</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {form.lines.map((line, index) => (
            <tr key={index}>
              <td>
                <input
                  aria-label={`Line ${index + 1} description`}
                  value={line.description}
                  onChange={(event) => setLine(index, { description: event.target.value })}
                />
              </td>
              <td>
                <input
                  aria-label={`Line ${index + 1} quantity`}
                  inputMode="decimal"
                  value={line.quantity}
                  onChange={(event) => setLine(index, { quantity: event.target.value })}
                />
              </td>
              <td>
                <input
                  aria-label={`Line ${index + 1} unit price`}
                  inputMode="decimal"
                  value={line.unitPrice}
                  onChange={(event) => setLine(index, { unitPrice: event.target.value })}
                />
              </td>
              <td>
                <select
                  aria-label={`Line ${index + 1} account`}
                  value={line.accountId}
                  onChange={(event) => setLine(index, { accountId: event.target.value })}
                >
                  {revenueAccounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.code} · {account.name}
                    </option>
                  ))}
                </select>
              </td>
              <td className="numeric">{money(parsedLines[index]?.amount ?? null)}</td>
              <td>
                <button
                  type="button"
                  className="link-button"
                  onClick={() =>
                    setForm((current) => ({
                      ...current,
                      lines: current.lines.filter((_, lineIndex) => lineIndex !== index),
                    }))
                  }
                  disabled={form.lines.length <= 1}
                >
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" colSpan={4}>
              Subtotal
            </th>
            <td className="numeric">{money(subtotal)}</td>
            <td />
          </tr>
          <tr>
            <th scope="row" colSpan={4}>
              VAT (demo 12%)
            </th>
            <td className="numeric">{money(tax)}</td>
            <td />
          </tr>
          <tr className="total-row">
            <th scope="row" colSpan={4}>
              Total
            </th>
            <td className="numeric">{money(subtotal + tax)}</td>
            <td />
          </tr>
        </tfoot>
      </table>
      <button
        type="button"
        onClick={() =>
          setForm((current) => ({
            ...current,
            lines: [
              ...current.lines,
              {
                description: '',
                quantity: '1',
                unitPrice: '',
                accountId: current.lines[0]?.accountId ?? revenueAccounts[0]?.id ?? '',
              },
            ],
          }))
        }
      >
        Add line
      </button>
      {error && (
        <p className="field-message" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}

function ReceiptEditor({ open, invoice, onClose }: { open: boolean; invoice: Invoice | null; onClose: () => void }) {
  const api = useApp();
  const customers = useMemo(
    () =>
      api.state.contacts.filter(
        (contact) =>
          contact.workspaceId === api.workspaceId && contact.active && contact.roles.includes('customer'),
      ),
    [api.state.contacts, api.workspaceId],
  );
  const banks = useMemo(
    () => api.state.bankAccounts.filter((bank) => bank.workspaceId === api.workspaceId && bank.active),
    [api.state.bankAccounts, api.workspaceId],
  );
  const [customerId, setCustomerId] = useState(invoice?.customerContactId ?? customers[0]?.id ?? '');
  const [receiptDate, setReceiptDate] = useState(api.clock.today);
  const [method, setMethod] = useState<'bank_deposit' | 'incoming_clearing'>('bank_deposit');
  const [bankId, setBankId] = useState(banks[0]?.id ?? '');
  const [reference, setReference] = useState('');
  const [amount, setAmount] = useState(invoice ? centsInput(invoice.outstandingCentavos) : '');
  const [allocations, setAllocations] = useState<Record<string, string>>(
    invoice ? { [invoice.id]: centsInput(invoice.outstandingCentavos) } : {},
  );
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    const nextCustomer = invoice?.customerContactId ?? customers[0]?.id ?? '';
    setCustomerId(nextCustomer);
    setReceiptDate(api.clock.today);
    setMethod('bank_deposit');
    setBankId(banks[0]?.id ?? '');
    setReference('');
    setAmount(invoice ? centsInput(invoice.outstandingCentavos) : '');
    setAllocations(invoice ? { [invoice.id]: centsInput(invoice.outstandingCentavos) } : {});
    setError('');
  }, [open, invoice, api.clock.today, customers, banks]);

  const openInvoices = api.state.invoices.filter(
    (candidate) =>
      candidate.workspaceId === api.workspaceId &&
      candidate.customerContactId === customerId &&
      candidate.outstandingCentavos > 0 &&
      (candidate.status === 'posted' || candidate.status === 'partially_paid'),
  );

  const submit = () => {
    const amountResult = moneyField(amount, 'receipt amount');
    if (!amountResult.ok || amountResult.value === null) {
      setError(amountResult.message);
      return;
    }
    const allocationInput = [];
    let allocated = 0;
    for (const [invoiceId, raw] of Object.entries(allocations)) {
      if (!raw.trim()) continue;
      const parsed = moneyField(raw, 'allocation');
      if (!parsed.ok || parsed.value === null) {
        setError(parsed.message);
        return;
      }
      if (parsed.value > 0) {
        allocationInput.push({ invoiceId, amountCentavos: parsed.value });
        allocated += parsed.value;
      }
    }
    if (allocated > amountResult.value) {
      setError('Allocated amounts cannot exceed the receipt total.');
      return;
    }
    if (!bankId) {
      setError('Select a demo bank account.');
      return;
    }
    const result = api.dispatch({
      type: 'receipt.create',
      input: {
        customerContactId: customerId,
        receiptDate,
        amountCentavos: amountResult.value,
        bankAccountId: bankId,
        method,
        reference,
        allocations: allocationInput,
      },
    });
    if (result) onClose();
  };

  return (
    <Modal
      open={open}
      title="Record customer receipt"
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="primary" onClick={submit}>
            Post receipt
          </button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="Customer" htmlFor="receipt-customer">
          <select
            id="receipt-customer"
            value={customerId}
            onChange={(event) => {
              setCustomerId(event.target.value);
              setAllocations({});
            }}
          >
            {customers.map((customer) => (
              <option key={customer.id} value={customer.id}>
                {customer.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Receipt date" htmlFor="receipt-date">
          <input
            id="receipt-date"
            type="date"
            value={receiptDate}
            onChange={(event) => setReceiptDate(event.target.value)}
          />
        </Field>
        <Field label="Total amount (PHP)" htmlFor="receipt-amount" hint="Excess over allocations becomes an explicit unapplied customer credit.">
          <input
            id="receipt-amount"
            inputMode="decimal"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
        </Field>
        <Field label="Bank account" htmlFor="receipt-bank">
          <select id="receipt-bank" value={bankId} onChange={(event) => setBankId(event.target.value)}>
            {banks.map((bank) => (
              <option key={bank.id} value={bank.id}>
                {bank.bankName} · {bank.name} {bank.accountNoMasked}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Method" htmlFor="receipt-method">
          <select
            id="receipt-method"
            value={method}
            onChange={(event) =>
              setMethod(event.target.value === 'incoming_clearing' ? 'incoming_clearing' : 'bank_deposit')
            }
          >
            <option value="bank_deposit">Direct bank deposit</option>
            <option value="incoming_clearing">Incoming clearing</option>
          </select>
        </Field>
        <Field label="Reference" htmlFor="receipt-reference">
          <input
            id="receipt-reference"
            value={reference}
            placeholder="Synthetic deposit reference"
            onChange={(event) => setReference(event.target.value)}
          />
        </Field>
      </div>
      <h3>Apply to open invoices</h3>
      {openInvoices.length === 0 ? (
        <EmptyState title="No open invoices for this customer">
          The full receipt will be recorded as an unapplied customer credit.
        </EmptyState>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">Invoice</th>
              <th scope="col">Due</th>
              <th scope="col" className="numeric">
                Outstanding
              </th>
              <th scope="col">Allocation (PHP)</th>
            </tr>
          </thead>
          <tbody>
            {openInvoices.map((candidate) => (
              <tr key={candidate.id}>
                <td>{candidate.invoiceNo}</td>
                <td>{humanDate(candidate.dueDate)}</td>
                <td className="numeric">{money(candidate.outstandingCentavos)}</td>
                <td>
                  <input
                    aria-label={`Allocation to ${candidate.invoiceNo}`}
                    inputMode="decimal"
                    value={allocations[candidate.id] ?? ''}
                    onChange={(event) =>
                      setAllocations((current) => ({ ...current, [candidate.id]: event.target.value }))
                    }
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {error && (
        <p className="field-message" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}

function InvoiceDetail({ invoice, onClose }: { invoice: Invoice | null; onClose: () => void }) {
  const api = useApp();
  if (!invoice) return null;
  return (
    <Modal
      open
      wide
      title={`Invoice ${invoice.invoiceNo}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose}>
            Close
          </button>
          <button type="button" className="primary" onClick={() => window.print()}>
            Print with demo banner
          </button>
        </>
      }
    >
      <article className="print-document">
        <p className="print-banner">LOCAL DEMO · SYNTHETIC DATA · NOT AN OFFICIAL INVOICE</p>
        <header className="print-head">
          <div>
            <h2>{api.state.workspaces.find((workspace) => workspace.id === api.workspaceId)?.legalName}</h2>
            <p>{invoice.customerSnapshot.address}</p>
          </div>
          <div className="print-meta">
            <p>
              <strong>Invoice</strong> {invoice.invoiceNo}
            </p>
            <p>Date: {humanDate(invoice.invoiceDate)}</p>
            <p>Due: {humanDate(invoice.dueDate)}</p>
            <p>Status: {titleCase(invoice.status)}</p>
          </div>
        </header>
        <section className="print-party">
          <h3>Bill to</h3>
          <p>{invoice.customerSnapshot.name}</p>
          <p>TIN {invoice.customerSnapshot.tin}</p>
          <p>{invoice.customerSnapshot.address}</p>
          <p>
            {invoice.branch} · {invoice.department}
          </p>
        </section>
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">Description</th>
              <th scope="col" className="numeric">
                Quantity
              </th>
              <th scope="col" className="numeric">
                Unit price
              </th>
              <th scope="col" className="numeric">
                Amount
              </th>
            </tr>
          </thead>
          <tbody>
            {invoice.lines.map((line) => (
              <tr key={line.id}>
                <td>{line.description}</td>
                <td className="numeric">{(line.quantityMilli / 1000).toFixed(3)}</td>
                <td className="numeric">{money(line.unitPriceCentavos)}</td>
                <td className="numeric">{money(line.amountCentavos)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" colSpan={3}>
                Subtotal
              </th>
              <td className="numeric">{money(invoice.subtotalCentavos)}</td>
            </tr>
            <tr>
              <th scope="row" colSpan={3}>
                VAT (demo 12%)
              </th>
              <td className="numeric">{money(invoice.taxCentavos)}</td>
            </tr>
            <tr className="total-row">
              <th scope="row" colSpan={3}>
                Total
              </th>
              <td className="numeric">{money(invoice.totalCentavos)}</td>
            </tr>
            <tr>
              <th scope="row" colSpan={3}>
                Paid
              </th>
              <td className="numeric">{money(invoice.paidCentavos)}</td>
            </tr>
            <tr>
              <th scope="row" colSpan={3}>
                Outstanding
              </th>
              <td className="numeric">{money(invoice.outstandingCentavos)}</td>
            </tr>
          </tfoot>
        </table>
        <p className="print-note">
          Demo document only. No BIR registration, official serial, or tax clearance is claimed.
          Source journal: {invoice.journalId ?? 'not posted'}.
        </p>
      </article>
    </Modal>
  );
}

export function BillingScreen() {
  const api = useApp();
  const route = useAppRoute();
  const { navigate } = useNavigation();
  const { state, workspaceId, access } = api;
  const [search, setSearch] = useState('');
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<Invoice | null>(null);
  const [detail, setDetail] = useState<Invoice | null>(null);
  const [posting, setPosting] = useState<Invoice | null>(null);
  const [reversing, setReversing] = useState<Invoice | null>(null);
  const [reversalDate, setReversalDate] = useState(api.clock.today);
  const [reversalReason, setReversalReason] = useState('');
  const [receiptInvoice, setReceiptInvoice] = useState<Invoice | null>(null);
  const [receiptOpen, setReceiptOpen] = useState(false);
  const [creditInvoice, setCreditInvoice] = useState<Invoice | null>(null);
  const [creditForm, setCreditForm] = useState({ date: api.clock.today, net: '', reason: '' });
  const [refundOpen, setRefundOpen] = useState(false);
  const [refundForm, setRefundForm] = useState({
    customerContactId: '',
    date: api.clock.today,
    amount: '',
    bankAccountId: '',
    reason: '',
  });
  const [asOf, setAsOf] = useState(api.clock.today);
  const [returning, setReturning] = useState<string | null>(null);
  const [returnForm, setReturnForm] = useState({ date: api.clock.today, reason: '' });

  const accountingStatus = api.productStatus('accounting');
  const accountingActive = accountingStatus === 'active';
  const canWrite = accountingActive && hasAnyRole(access, 'accountant', 'ap_ar_clerk', 'company_admin');
  const canReverse = accountingActive && hasAnyRole(access, 'accountant');
  const today = api.clock.today;
  const tab: BillingTab =
    route?.page === 'receipts' || route?.page === 'credits' || route?.page === 'aging'
      ? route.page
      : 'invoices';

  const invoices = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return state.invoices
      .filter((invoice) => invoice.workspaceId === workspaceId)
      .filter((invoice) => {
        if (!needle) return true;
        return (
          invoice.invoiceNo.toLowerCase().includes(needle) ||
          invoice.customerSnapshot.name.toLowerCase().includes(needle) ||
          invoice.status.includes(needle)
        );
      })
      .slice()
      .sort((left, right) => right.invoiceNo.localeCompare(left.invoiceNo));
  }, [state.invoices, workspaceId, search]);

  const pager = usePager(invoices);

  useEffect(() => {
    const recordId = route?.recordId;
    if (!recordId) {
      setDetail(null);
      setEditorOpen(route?.action === 'new');
      if (route?.action === 'new') setEditing(null);
      return;
    }
    const invoice = state.invoices.find(
      (candidate) => candidate.id === recordId && candidate.workspaceId === workspaceId,
    );
    if (!invoice) {
      setDetail(null);
      setEditorOpen(false);
      return;
    }
    if (route?.action === 'edit' && invoice.status === 'draft') {
      setEditing(invoice);
      setEditorOpen(true);
      setDetail(null);
      return;
    }
    setDetail(invoice);
    setEditorOpen(false);
  }, [route?.recordId, route?.action, state.invoices, workspaceId]);
  const customers = state.contacts.filter(
    (contact) => contact.workspaceId === workspaceId && contact.active && contact.roles.includes('customer'),
  );
  const banks = state.bankAccounts.filter((bank) => bank.workspaceId === workspaceId && bank.active);
  const receipts = state.receipts
    .filter((receipt) => receipt.workspaceId === workspaceId)
    .slice()
    .sort((left, right) => right.receiptNo.localeCompare(left.receiptNo));
  const credits = state.creditNotes
    .filter((credit) => credit.workspaceId === workspaceId)
    .slice()
    .sort((left, right) => right.creditNo.localeCompare(left.creditNo));
  const aging = arAging(state, workspaceId, asOf);

  const startCreate = () => {
    navigate(appRoute('billing', 'invoices', { action: 'new' }));
  };

  const startEdit = (invoice: Invoice) => {
    navigate(appRoute('billing', 'invoices', { recordId: invoice.id, action: 'edit' }));
  };

  const startReceipt = (invoice: Invoice | null) => {
    setReceiptInvoice(invoice);
    setReceiptOpen(true);
  };

  const startCredit = (invoice: Invoice) => {
    setCreditInvoice(invoice);
    setCreditForm({
      date: today,
      net: centsInput(invoice.outstandingCentavos),
      reason: '',
    });
  };

  const startRefund = () => {
    setRefundForm({
      customerContactId: customers[0]?.id ?? '',
      date: today,
      amount: '',
      bankAccountId: banks[0]?.id ?? '',
      reason: '',
    });
    setRefundOpen(true);
  };

  const submitReversal = () => {
    if (!reversing) return;
    const result = api.dispatch({
      type: 'invoice.reverse',
      input: { invoiceId: reversing.id, reversalDate, reason: reversalReason },
    });
    if (result) {
      setReversing(null);
      setReversalReason('');
    }
  };

  const submitCredit = () => {
    if (!creditInvoice) return;
    const net = moneyField(creditForm.net, 'credit net amount');
    if (!net.ok || net.value === null) {
      api.notify('error', 'Credit amount invalid', net.message);
      return;
    }
    const result = api.dispatch({
      type: 'creditNote.create',
      input: {
        invoiceId: creditInvoice.id,
        creditDate: creditForm.date,
        netCentavos: net.value,
        reason: creditForm.reason,
      },
    });
    if (result) setCreditInvoice(null);
  };

  const submitRefund = () => {
    const amount = moneyField(refundForm.amount, 'refund amount');
    if (!amount.ok || amount.value === null) {
      api.notify('error', 'Refund amount invalid', amount.message);
      return;
    }
    const result = api.dispatch({
      type: 'refund.create',
      input: {
        customerContactId: refundForm.customerContactId,
        refundDate: refundForm.date,
        amountCentavos: amount.value,
        bankAccountId: refundForm.bankAccountId,
        reason: refundForm.reason,
      },
    });
    if (result) setRefundOpen(false);
  };

  const submitReturn = () => {
    if (!returning) return;
    const result = api.dispatch({
      type: 'receipt.return',
      input: { receiptId: returning, returnDate: returnForm.date, reason: returnForm.reason },
    });
    if (result) setReturning(null);
  };

  return (
    <div className="screen">
      {accountingStatus !== 'active' && (
        <div className="callout callout-warn" role="status">
          <strong>Accounting is {accountingStatus} for this company.</strong> Existing records remain
          readable, but posting actions are unavailable until an administrator enables the product.
        </div>
      )}
      <div className="stat-row">
        <div className="stat">
          <span>Open invoices</span>
          <strong>{invoices.filter((invoice) => invoice.outstandingCentavos > 0).length}</strong>
        </div>
        <div className="stat">
          <span>Outstanding AR</span>
          <strong>{peso(invoices.reduce((total, invoice) => total + invoice.outstandingCentavos, 0))}</strong>
        </div>
        <div className="stat">
          <span>Overdue (aging)</span>
          <strong>{peso(aging.totals.totalCentavos)}</strong>
        </div>
        <div className="stat">
          <span>Unapplied credits</span>
          <strong>
            {peso(
              receipts
                .filter((receipt) => receipt.status === 'posted')
                .reduce((total, receipt) => total + receipt.unappliedCentavos, 0),
            )}
          </strong>
        </div>
      </div>

      {tab === 'invoices' && (
        <Panel
          title="Sales invoices"
          subtitle="Drafts are editable. Posted financial fields are immutable; corrections use linked credit notes or reversal."
          actions={
            <>
              <SearchField value={search} onChange={setSearch} placeholder="Number, customer, status" />
              <button type="button" className="primary" onClick={startCreate} disabled={!canWrite}>
                New invoice
              </button>
            </>
          }
          note="Posting writes a balanced journal through the single command seam. A closed period rejects the posting."
        >
          {invoices.length === 0 ? (
            <EmptyState title="No invoices yet">
              Create a draft invoice to exercise posting, receipt allocation, and aging.
            </EmptyState>
          ) : (
            <>
              <div className="table-wrap">
                <table className="data-table">
                  <caption>Sales invoices for the active company</caption>
                  <thead>
                    <tr>
                      <th scope="col">Invoice</th>
                      <th scope="col">Customer</th>
                      <th scope="col">Date</th>
                      <th scope="col">Due</th>
                      <th scope="col" className="numeric">
                        Total
                      </th>
                      <th scope="col" className="numeric">
                        Outstanding
                      </th>
                      <th scope="col">Status</th>
                      <th scope="col">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pager.pageItems.map((invoice) => (
                      <tr key={invoice.id}>
                        <th scope="row">
                          <button
                            type="button"
                            className="link-button"
                            onClick={() => navigate(appRoute('billing', 'invoices', { recordId: invoice.id }))}
                          >
                            {invoice.invoiceNo}
                          </button>
                        </th>
                        <td>{invoice.customerSnapshot.name}</td>
                        <td>{humanDate(invoice.invoiceDate)}</td>
                        <td>{humanDate(invoice.dueDate)}</td>
                        <td className="numeric">{money(invoice.totalCentavos)}</td>
                        <td className="numeric">{money(invoice.outstandingCentavos)}</td>
                        <td>
                          <StatusBadge status={invoice.status} />
                        </td>
                        <td className="actions">
                          {invoice.status === 'draft' && (
                            <>
                              <button type="button" className="link-button" onClick={() => startEdit(invoice)} disabled={!canWrite}>
                                Edit
                              </button>
                              <button type="button" className="link-button" onClick={() => setPosting(invoice)} disabled={!canWrite}>
                                Post
                              </button>
                            </>
                          )}
                          {invoice.outstandingCentavos > 0 && invoice.status !== 'draft' && (
                            <>
                              <button type="button" className="link-button" onClick={() => startReceipt(invoice)} disabled={!canWrite}>
                                Receipt
                              </button>
                              <button type="button" className="link-button" onClick={() => startCredit(invoice)} disabled={!canWrite}>
                                Credit note
                              </button>
                            </>
                          )}
                          {(invoice.status === 'posted' || invoice.status === 'partially_paid') && (
                            <button
                              type="button"
                              className="link-button"
                              onClick={() => {
                                setReversalDate(today);
                                setReversalReason('');
                                setReversing(invoice);
                              }}
                              disabled={!canReverse || invoice.paidCentavos > 0}
                              title={invoice.paidCentavos > 0 ? 'Invoices with receipts need a credit note or refund' : undefined}
                            >
                              Reverse
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pagination
                page={pager.page}
                pageCount={pager.pageCount}
                onPage={pager.setPage}
                total={invoices.length}
                pageSize={pager.pageSize}
              />
            </>
          )}
        </Panel>
      )}

      {tab === 'receipts' && (
        <Panel
          title="Customer receipts"
          subtitle="A receipt applies to one customer's open invoices; any excess is tracked as an unapplied credit."
          actions={
            <button type="button" className="primary" onClick={() => startReceipt(null)} disabled={!canWrite}>
              New receipt
            </button>
          }
        >
          {receipts.length === 0 ? (
            <EmptyState title="No receipts recorded" />
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <caption>Customer receipts</caption>
                <thead>
                  <tr>
                    <th scope="col">Receipt</th>
                    <th scope="col">Customer</th>
                    <th scope="col">Date</th>
                    <th scope="col" className="numeric">
                      Amount
                    </th>
                    <th scope="col" className="numeric">
                      Unapplied
                    </th>
                    <th scope="col">Method</th>
                    <th scope="col">Status</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {receipts.map((receipt) => {
                    const customer = state.contacts.find((contact) => contact.id === receipt.customerContactId);
                    return (
                      <tr key={receipt.id}>
                        <th scope="row">{receipt.receiptNo}</th>
                        <td>{customer?.name ?? 'Unknown customer'}</td>
                        <td>{humanDate(receipt.receiptDate)}</td>
                        <td className="numeric">{money(receipt.amountCentavos)}</td>
                        <td className="numeric">{money(receipt.unappliedCentavos)}</td>
                        <td>{titleCase(receipt.method)}</td>
                        <td>
                          <StatusBadge status={receipt.status} />
                        </td>
                        <td className="actions">
                          <button
                            type="button"
                            className="link-button"
                            onClick={() => {
                              setReturning(receipt.id);
                              setReturnForm({ date: today, reason: '' });
                            }}
                            disabled={
                              !accountingActive ||
                              !hasAnyRole(access, 'accountant', 'ap_ar_clerk') ||
                              receipt.status !== 'posted'
                            }
                          >
                            Return
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <div className="button-row">
            <button type="button" onClick={startRefund} disabled={!canReverse}>
              Record customer refund
            </button>
            <span className="muted">Refunds require an accountant and are posted against a demo bank account.</span>
          </div>
        </Panel>
      )}

      {tab === 'credits' && (
        <Panel title="Credit notes" subtitle="A credit note reduces an invoice balance and records the corresponding output VAT reduction.">
          {credits.length === 0 ? (
            <EmptyState title="No credit notes recorded" />
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">Credit</th>
                    <th scope="col">Invoice</th>
                    <th scope="col">Date</th>
                    <th scope="col" className="numeric">
                      Amount
                    </th>
                    <th scope="col" className="numeric">
                      VAT
                    </th>
                    <th scope="col">Reason</th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {credits.map((credit) => {
                    const invoice = state.invoices.find((candidate) => candidate.id === credit.invoiceId);
                    return (
                      <tr key={credit.id}>
                        <th scope="row">{credit.creditNo}</th>
                        <td>{invoice?.invoiceNo ?? credit.invoiceId}</td>
                        <td>{humanDate(credit.creditDate)}</td>
                        <td className="numeric">{money(credit.amountCentavos)}</td>
                        <td className="numeric">{money(credit.taxCentavos)}</td>
                        <td>{credit.reason}</td>
                        <td>
                          <StatusBadge status={credit.status} />
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

      {tab === 'aging' && (
        <Panel
          title="AR aging"
          subtitle="Outstanding customer invoices grouped by days past due, using each invoice's posted customer snapshot."
          actions={
            <Field label="Aging as of" htmlFor="aging-date">
              <input id="aging-date" type="date" value={asOf} onChange={(event) => setAsOf(event.target.value)} />
            </Field>
          }
        >
          {aging.rows.length === 0 ? (
            <EmptyState title="No outstanding receivables at this date" />
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <caption>Accounts receivable aging as of {humanDate(asOf)}</caption>
                <thead>
                  <tr>
                    <th scope="col">Customer</th>
                    <th scope="col" className="numeric">
                      Current
                    </th>
                    <th scope="col" className="numeric">
                      1–30
                    </th>
                    <th scope="col" className="numeric">
                      31–60
                    </th>
                    <th scope="col" className="numeric">
                      61–90
                    </th>
                    <th scope="col" className="numeric">
                      Over 90
                    </th>
                    <th scope="col" className="numeric">
                      Total
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {aging.rows.map((row) => (
                    <tr key={row.customerContactId}>
                      <th scope="row">{row.customerName}</th>
                      <td className="numeric">{money(row.currentCentavos)}</td>
                      <td className="numeric">{money(row.days1To30Centavos)}</td>
                      <td className="numeric">{money(row.days31To60Centavos)}</td>
                      <td className="numeric">{money(row.days61To90Centavos)}</td>
                      <td className="numeric">{money(row.daysOver90Centavos)}</td>
                      <td className="numeric">{money(row.totalCentavos)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="total-row">
                    <th scope="row">Total</th>
                    <td className="numeric">{money(aging.totals.currentCentavos)}</td>
                    <td className="numeric">{money(aging.totals.days1To30Centavos)}</td>
                    <td className="numeric">{money(aging.totals.days31To60Centavos)}</td>
                    <td className="numeric">{money(aging.totals.days61To90Centavos)}</td>
                    <td className="numeric">{money(aging.totals.daysOver90Centavos)}</td>
                    <td className="numeric">{money(aging.totals.totalCentavos)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </Panel>
      )}

      <InvoiceEditor
        open={editorOpen}
        invoice={editing}
        onClose={() => navigate(appRoute('billing', 'invoices'))}
      />
      <ReceiptEditor open={receiptOpen} invoice={receiptInvoice} onClose={() => setReceiptOpen(false)} />
      <InvoiceDetail
        invoice={detail}
        onClose={() => navigate(appRoute('billing', 'invoices'))}
      />

      <ConfirmDialog
        open={posting !== null}
        title={posting ? `Post ${posting.invoiceNo}?` : 'Post invoice?'}
        confirmLabel="Post invoice"
        onClose={() => setPosting(null)}
        onConfirm={() => {
          if (!posting) return;
          const result = api.dispatch({ type: 'invoice.post', input: { invoiceId: posting.id } });
          if (result) setPosting(null);
        }}
      >
        {posting && (
          <div>
            <p>
              {posting.customerSnapshot.name} · total {peso(posting.totalCentavos)} including{' '}
              {peso(posting.taxCentavos)} demo VAT.
            </p>
            <p>
              Posting locks the financial fields and creates one balanced AR/revenue/tax journal.
              A closed period rejects the posting.
            </p>
          </div>
        )}
      </ConfirmDialog>

      <Modal
        open={reversing !== null}
        title={reversing ? `Reverse ${reversing.invoiceNo}` : 'Reverse invoice'}
        onClose={() => setReversing(null)}
        footer={
          <>
            <button type="button" onClick={() => setReversing(null)}>
              Cancel
            </button>
            <button type="button" className="danger" onClick={submitReversal} disabled={reversalReason.trim().length < 3}>
              Post linked reversal
            </button>
          </>
        }
      >
        <p>The original journal remains immutable. A linked reversal is posted in an open period.</p>
        <Field label="Reversal date" htmlFor="reversal-date">
          <input id="reversal-date" type="date" value={reversalDate} onChange={(event) => setReversalDate(event.target.value)} />
        </Field>
        <Field label="Reason" htmlFor="reversal-reason" hint="At least three characters; recorded in the audit trail.">
          <input id="reversal-reason" value={reversalReason} onChange={(event) => setReversalReason(event.target.value)} />
        </Field>
      </Modal>

      <Modal
        open={creditInvoice !== null}
        title={creditInvoice ? `Credit note against ${creditInvoice.invoiceNo}` : 'Credit note'}
        onClose={() => setCreditInvoice(null)}
        footer={
          <>
            <button type="button" onClick={() => setCreditInvoice(null)}>
              Cancel
            </button>
            <button type="button" className="primary" onClick={submitCredit}>
              Post credit note
            </button>
          </>
        }
      >
        <p>
          Enter the net amount before demo VAT. The credit is limited to the invoice&apos;s
          outstanding balance and creates its own journal and tax record.
        </p>
        <Field label="Credit date" htmlFor="credit-date">
          <input
            id="credit-date"
            type="date"
            value={creditForm.date}
            onChange={(event) => setCreditForm({ ...creditForm, date: event.target.value })}
          />
        </Field>
        <Field label="Net amount (PHP)" htmlFor="credit-net">
          <input
            id="credit-net"
            inputMode="decimal"
            value={creditForm.net}
            onChange={(event) => setCreditForm({ ...creditForm, net: event.target.value })}
          />
        </Field>
        <Field label="Reason" htmlFor="credit-reason">
          <input
            id="credit-reason"
            value={creditForm.reason}
            onChange={(event) => setCreditForm({ ...creditForm, reason: event.target.value })}
          />
        </Field>
      </Modal>

      <Modal
        open={refundOpen}
        title="Record customer refund"
        onClose={() => setRefundOpen(false)}
        footer={
          <>
            <button type="button" onClick={() => setRefundOpen(false)}>
              Cancel
            </button>
            <button type="button" className="primary" onClick={submitRefund}>
              Post refund
            </button>
          </>
        }
      >
        <Field label="Customer" htmlFor="refund-customer">
          <select
            id="refund-customer"
            value={refundForm.customerContactId}
            onChange={(event) => setRefundForm({ ...refundForm, customerContactId: event.target.value })}
          >
            {customers.map((customer) => (
              <option key={customer.id} value={customer.id}>
                {customer.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Refund date" htmlFor="refund-date">
          <input
            id="refund-date"
            type="date"
            value={refundForm.date}
            onChange={(event) => setRefundForm({ ...refundForm, date: event.target.value })}
          />
        </Field>
        <Field label="Amount (PHP)" htmlFor="refund-amount">
          <input
            id="refund-amount"
            inputMode="decimal"
            value={refundForm.amount}
            onChange={(event) => setRefundForm({ ...refundForm, amount: event.target.value })}
          />
        </Field>
        <Field label="Bank account" htmlFor="refund-bank">
          <select
            id="refund-bank"
            value={refundForm.bankAccountId}
            onChange={(event) => setRefundForm({ ...refundForm, bankAccountId: event.target.value })}
          >
            {banks.map((bank) => (
              <option key={bank.id} value={bank.id}>
                {bank.bankName} {bank.accountNoMasked}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Reason" htmlFor="refund-reason">
          <input
            id="refund-reason"
            value={refundForm.reason}
            onChange={(event) => setRefundForm({ ...refundForm, reason: event.target.value })}
          />
        </Field>
      </Modal>

      <Modal
        open={returning !== null}
        title="Return a customer receipt"
        onClose={() => setReturning(null)}
        footer={
          <>
            <button type="button" onClick={() => setReturning(null)}>
              Cancel
            </button>
            <button type="button" className="danger" onClick={submitReturn} disabled={returnForm.reason.trim().length < 3}>
              Mark returned
            </button>
          </>
        }
      >
        <p>
          The receipt journal is reversed once and invoice allocations are reopened. The original
          receipt and its settlement links stay in history.
        </p>
        <Field label="Return date" htmlFor="return-date">
          <input
            id="return-date"
            type="date"
            value={returnForm.date}
            onChange={(event) => setReturnForm({ ...returnForm, date: event.target.value })}
          />
        </Field>
        <Field label="Reason" htmlFor="return-reason">
          <input
            id="return-reason"
            value={returnForm.reason}
            onChange={(event) => setReturnForm({ ...returnForm, reason: event.target.value })}
          />
        </Field>
      </Modal>
    </div>
  );
}
