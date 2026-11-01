import { useEffect, useMemo, useState } from 'react';
import type { Bill, GoodsReceipt, PurchaseOrder, Rfp } from '../../domain/schema';
import { addDays } from '../../domain/shared/dates';
import { mulDivRound } from '../../domain/shared/money';
import { useApp } from '../useApp';
import { useAppRoute, useNavigation } from '../navigation';
import { appRoute } from '../router';
import { EmptyState, Field, Modal, Panel, StatusBadge } from '../components';
import { centsInput, humanDate, money, peso, quantity, titleCase } from '../format';
import { moneyField, quantityField, requiredField } from '../forms';
import { hasAnyRole } from '../permissions';

type PurchasesTab = 'bills' | 'orders' | 'approvals' | 'payments' | 'advances';

interface BillLineDraft {
  description: string;
  accountId: string;
  amount: string;
  taxTreatment: 'none' | 'input_vat12';
  ewtPercent: string;
  stockReceiptId: string | null;
  itemId: string | null;
  quantityMilli: number | null;
}

interface BillForm {
  vendorContactId: string;
  supplierInvoiceNo: string;
  billDate: string;
  dueDate: string;
  lines: BillLineDraft[];
}

function BillEditor({
  open,
  receipt,
  onClose,
}: {
  open: boolean;
  receipt: GoodsReceipt | null;
  onClose: () => void;
}) {
  const api = useApp();
  const vendors = useMemo(
    () =>
      api.state.contacts.filter(
        (contact) => contact.workspaceId === api.workspaceId && contact.active && contact.roles.includes('vendor'),
      ),
    [api.state.contacts, api.workspaceId],
  );
  const accounts = useMemo(
    () =>
      api.state.accounts.filter(
        (account) =>
          account.workspaceId === api.workspaceId &&
          account.active &&
          (account.type === 'expense' || account.type === 'asset'),
      ),
    [api.state.accounts, api.workspaceId],
  );
  const inventoryAccount = accounts.find((account) => account.code === '1200') ?? accounts[0];
  const today = api.clock.today;
  const [form, setForm] = useState<BillForm>(() => ({
    vendorContactId: vendors[0]?.id ?? '',
    supplierInvoiceNo: '',
    billDate: today,
    dueDate: addDays(today, 30),
    lines: [
      {
        description: '',
        accountId: accounts[0]?.id ?? '',
        amount: '',
        taxTreatment: 'none',
        ewtPercent: '0',
        stockReceiptId: null,
        itemId: null,
        quantityMilli: null,
      },
    ],
  }));
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    if (receipt) {
      const itemName = (itemId: string) =>
        api.state.items.find((item) => item.id === itemId)?.name ?? 'Received item';
      setForm({
        vendorContactId: receipt.vendorContactId,
        supplierInvoiceNo: '',
        billDate: today,
        dueDate: addDays(today, 30),
        lines: receipt.lines.map((line) => ({
          description: `${itemName(line.itemId)} — received ${humanDate(receipt.receiptDate)}`,
          accountId: inventoryAccount?.id ?? accounts[0]?.id ?? '',
          amount: centsInput(mulDivRound(line.quantityMilli, line.unitCostCentavos, 1000)),
          taxTreatment: 'none',
          ewtPercent: '0',
          stockReceiptId: receipt.id,
          itemId: line.itemId,
          quantityMilli: line.quantityMilli,
        })),
      });
    } else {
      setForm({
        vendorContactId: vendors[0]?.id ?? '',
        supplierInvoiceNo: '',
        billDate: today,
        dueDate: addDays(today, 30),
        lines: [
          {
            description: '',
            accountId: accounts[0]?.id ?? '',
            amount: '',
            taxTreatment: 'none',
            ewtPercent: '0',
            stockReceiptId: null,
            itemId: null,
            quantityMilli: null,
          },
        ],
      });
    }
    setError('');
  }, [open, receipt, today, vendors, accounts, inventoryAccount, api.state.items]);

  const submit = () => {
    const lines = [];
    for (const [index, line] of form.lines.entries()) {
      const description = requiredField(line.description, `Line ${index + 1} description`);
      const amount = moneyField(line.amount, `Line ${index + 1} amount`);
      if (!description.ok || !amount.ok || amount.value === null) {
        setError(description.message || amount.message);
        return;
      }
      const rate = Number(line.ewtPercent || '0');
      if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
        setError(`Line ${index + 1} withholding rate must be between 0 and 100.`);
        return;
      }
      lines.push({
        description: description.value ?? '',
        accountId: line.accountId,
        amountCentavos: amount.value,
        taxTreatment: line.taxTreatment,
        ...(line.stockReceiptId && line.itemId && line.quantityMilli
          ? {
              stockReceiptId: line.stockReceiptId,
              itemId: line.itemId,
              quantityMilli: line.quantityMilli,
            }
          : {}),
        ewtRateBp: Math.round(rate * 100),
      });
    }
    if (!form.vendorContactId) {
      setError('Select a vendor.');
      return;
    }
    const result = api.dispatch({
      type: 'bill.create',
      input: {
        vendorContactId: form.vendorContactId,
        supplierInvoiceNo: form.supplierInvoiceNo,
        billDate: form.billDate,
        dueDate: form.dueDate,
        lines,
      },
    });
    if (result) onClose();
  };

  return (
    <Modal
      open={open}
      wide
      title={receipt ? 'Create bill from goods receipt' : 'New supplier bill'}
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="primary" onClick={submit}>
            Post bill
          </button>
        </>
      }
    >
      <p className="callout callout-info">
        A stock-linked bill clears goods-received-not-invoiced and must equal the received value.
        A duplicate supplier invoice number is held without posting expense or payable.
      </p>
      <div className="form-grid">
        <Field label="Vendor" htmlFor="bill-vendor">
          <select
            id="bill-vendor"
            value={form.vendorContactId}
            onChange={(event) => setForm({ ...form, vendorContactId: event.target.value })}
          >
            {vendors.map((vendor) => (
              <option key={vendor.id} value={vendor.id}>
                {vendor.contactNo} · {vendor.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Supplier invoice number" htmlFor="bill-supplier-no">
          <input
            id="bill-supplier-no"
            value={form.supplierInvoiceNo}
            onChange={(event) => setForm({ ...form, supplierInvoiceNo: event.target.value })}
          />
        </Field>
        <Field label="Bill date" htmlFor="bill-date">
          <input
            id="bill-date"
            type="date"
            value={form.billDate}
            onChange={(event) => setForm({ ...form, billDate: event.target.value })}
          />
        </Field>
        <Field label="Due date" htmlFor="bill-due">
          <input
            id="bill-due"
            type="date"
            value={form.dueDate}
            onChange={(event) => setForm({ ...form, dueDate: event.target.value })}
          />
        </Field>
      </div>
      <table className="form-table">
        <caption>Bill lines — amounts are net of VAT</caption>
        <thead>
          <tr>
            <th scope="col">Description</th>
            <th scope="col">Account</th>
            <th scope="col">Net amount</th>
            <th scope="col">VAT</th>
            <th scope="col">EWT %</th>
            <th scope="col" />
          </tr>
        </thead>
        <tbody>
          {form.lines.map((line, index) => (
            <tr key={index}>
              <td>
                <input
                  aria-label={`Line ${index + 1} description`}
                  value={line.description}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      lines: form.lines.map((candidate, candidateIndex) =>
                        candidateIndex === index ? { ...candidate, description: event.target.value } : candidate,
                      ),
                    })
                  }
                />
              </td>
              <td>
                <select
                  aria-label={`Line ${index + 1} account`}
                  value={line.accountId}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      lines: form.lines.map((candidate, candidateIndex) =>
                        candidateIndex === index ? { ...candidate, accountId: event.target.value } : candidate,
                      ),
                    })
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
                  aria-label={`Line ${index + 1} amount`}
                  inputMode="decimal"
                  value={line.amount}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      lines: form.lines.map((candidate, candidateIndex) =>
                        candidateIndex === index ? { ...candidate, amount: event.target.value } : candidate,
                      ),
                    })
                  }
                />
              </td>
              <td>
                <select
                  aria-label={`Line ${index + 1} VAT treatment`}
                  value={line.taxTreatment}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      lines: form.lines.map((candidate, candidateIndex) =>
                        candidateIndex === index
                          ? {
                              ...candidate,
                              taxTreatment: event.target.value === 'input_vat12' ? 'input_vat12' : 'none',
                            }
                          : candidate,
                      ),
                    })
                  }
                >
                  <option value="none">None</option>
                  <option value="input_vat12">Input VAT 12% (demo)</option>
                </select>
              </td>
              <td>
                <input
                  aria-label={`Line ${index + 1} EWT percent`}
                  inputMode="decimal"
                  value={line.ewtPercent}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      lines: form.lines.map((candidate, candidateIndex) =>
                        candidateIndex === index ? { ...candidate, ewtPercent: event.target.value } : candidate,
                      ),
                    })
                  }
                />
              </td>
              <td>
                <button
                  type="button"
                  className="link-button"
                  disabled={form.lines.length <= 1 || line.stockReceiptId !== null}
                  onClick={() =>
                    setForm({
                      ...form,
                      lines: form.lines.filter((_, candidateIndex) => candidateIndex !== index),
                    })
                  }
                >
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button
        type="button"
        disabled={receipt !== null}
        onClick={() =>
          setForm({
            ...form,
            lines: [
              ...form.lines,
              {
                description: '',
                accountId: accounts[0]?.id ?? '',
                amount: '',
                taxTreatment: 'none',
                ewtPercent: '0',
                stockReceiptId: null,
                itemId: null,
                quantityMilli: null,
              },
            ],
          })
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

function PoEditor({ open, onClose }: { open: boolean; onClose: () => void }) {
  const api = useApp();
  const vendors = useMemo(
    () =>
      api.state.contacts.filter(
        (contact) =>
          contact.workspaceId === api.workspaceId && contact.active && contact.roles.includes('vendor'),
      ),
    [api.state.contacts, api.workspaceId],
  );
  const accounts = useMemo(
    () =>
      api.state.accounts.filter(
        (account) =>
          account.workspaceId === api.workspaceId &&
          account.active &&
          (account.type === 'expense' || account.type === 'asset'),
      ),
    [api.state.accounts, api.workspaceId],
  );
  const items = useMemo(
    () => api.state.items.filter((item) => item.workspaceId === api.workspaceId && item.active),
    [api.state.items, api.workspaceId],
  );
  const [vendorId, setVendorId] = useState(vendors[0]?.id ?? '');
  const [poDate, setPoDate] = useState(api.clock.today);
  const [lines, setLines] = useState([
    { itemId: items[0]?.id ?? '', description: items[0]?.name ?? '', quantity: '1', unitCost: '', accountId: accounts[0]?.id ?? '' },
  ]);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setVendorId(vendors[0]?.id ?? '');
    setPoDate(api.clock.today);
    setLines([
      {
        itemId: items[0]?.id ?? '',
        description: items[0]?.name ?? '',
        quantity: '1',
        unitCost: '',
        accountId: accounts[0]?.id ?? '',
      },
    ]);
    setError('');
  }, [open, vendors, items, accounts, api.clock.today]);

  const submit = () => {
    const parsed = [];
    for (const [index, line] of lines.entries()) {
      const quantityResult = quantityField(line.quantity);
      const cost = moneyField(line.unitCost, `Line ${index + 1} unit cost`);
      const description = requiredField(line.description, `Line ${index + 1} description`);
      if (!quantityResult.ok || !cost.ok || !description.ok || quantityResult.value === null || cost.value === null) {
        setError(quantityResult.message || cost.message || description.message);
        return;
      }
      parsed.push({
        itemId: line.itemId || null,
        description: description.value ?? '',
        quantityMilli: quantityResult.value,
        unitCostCentavos: cost.value,
        accountId: line.accountId,
      });
    }
    const result = api.dispatch({
      type: 'po.create',
      input: { vendorContactId: vendorId, poDate, lines: parsed },
    });
    if (result) onClose();
  };

  return (
    <Modal
      open={open}
      wide
      title="New purchase order"
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="primary" onClick={submit}>
            Create PO
          </button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="Vendor" htmlFor="po-vendor">
          <select id="po-vendor" value={vendorId} onChange={(event) => setVendorId(event.target.value)}>
            {vendors.map((vendor) => (
              <option key={vendor.id} value={vendor.id}>
                {vendor.contactNo} · {vendor.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="PO date" htmlFor="po-date">
          <input id="po-date" type="date" value={poDate} onChange={(event) => setPoDate(event.target.value)} />
        </Field>
      </div>
      <table className="form-table">
        <caption>Purchase order lines</caption>
        <thead>
          <tr>
            <th scope="col">Item</th>
            <th scope="col">Description</th>
            <th scope="col">Quantity</th>
            <th scope="col">Unit cost</th>
            <th scope="col">Account</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line, index) => (
            <tr key={index}>
              <td>
                <select
                  aria-label={`PO line ${index + 1} item`}
                  value={line.itemId}
                  onChange={(event) => {
                    const item = items.find((candidate) => candidate.id === event.target.value);
                    setLines(
                      lines.map((candidate, candidateIndex) =>
                        candidateIndex === index
                          ? { ...candidate, itemId: event.target.value, description: item?.name ?? candidate.description }
                          : candidate,
                      ),
                    );
                  }}
                >
                  <option value="">Non-stock</option>
                  {items.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.sku} · {item.name}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <input
                  aria-label={`PO line ${index + 1} description`}
                  value={line.description}
                  onChange={(event) =>
                    setLines(
                      lines.map((candidate, candidateIndex) =>
                        candidateIndex === index ? { ...candidate, description: event.target.value } : candidate,
                      ),
                    )
                  }
                />
              </td>
              <td>
                <input
                  aria-label={`PO line ${index + 1} quantity`}
                  inputMode="decimal"
                  value={line.quantity}
                  onChange={(event) =>
                    setLines(
                      lines.map((candidate, candidateIndex) =>
                        candidateIndex === index ? { ...candidate, quantity: event.target.value } : candidate,
                      ),
                    )
                  }
                />
              </td>
              <td>
                <input
                  aria-label={`PO line ${index + 1} unit cost`}
                  inputMode="decimal"
                  value={line.unitCost}
                  onChange={(event) =>
                    setLines(
                      lines.map((candidate, candidateIndex) =>
                        candidateIndex === index ? { ...candidate, unitCost: event.target.value } : candidate,
                      ),
                    )
                  }
                />
              </td>
              <td>
                <select
                  aria-label={`PO line ${index + 1} account`}
                  value={line.accountId}
                  onChange={(event) =>
                    setLines(
                      lines.map((candidate, candidateIndex) =>
                        candidateIndex === index ? { ...candidate, accountId: event.target.value } : candidate,
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
            </tr>
          ))}
        </tbody>
      </table>
      <button
        type="button"
        onClick={() =>
          setLines([
            ...lines,
            { itemId: '', description: '', quantity: '1', unitCost: '', accountId: accounts[0]?.id ?? '' },
          ])
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

function ReceiptEditor({ po, open, onClose }: { po: PurchaseOrder | null; open: boolean; onClose: () => void }) {
  const api = useApp();
  const locations = useMemo(
    () =>
      api.state.locations.filter(
        (location) => location.workspaceId === api.workspaceId && location.active,
      ),
    [api.state.locations, api.workspaceId],
  );
  const [locationId, setLocationId] = useState(locations[0]?.id ?? '');
  const [receiptDate, setReceiptDate] = useState(api.clock.today);
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open || !po) return;
    setLocationId(locations[0]?.id ?? '');
    setReceiptDate(api.clock.today);
    setQuantities(
      Object.fromEntries(
        po.lines.map((line) => [line.id, ((line.quantityMilli - line.receivedMilli) / 1000).toString()]),
      ),
    );
    setError('');
  }, [open, po, locations, api.clock.today]);

  if (!po) return null;

  const submit = () => {
    const lines = [];
    for (const line of po.lines) {
      const raw = quantities[line.id];
      if (!raw || !raw.trim()) continue;
      const parsed = quantityField(raw);
      if (!parsed.ok || parsed.value === null) {
        setError(parsed.message);
        return;
      }
      lines.push({ poLineId: line.id, quantityMilli: parsed.value });
    }
    if (lines.length === 0) {
      setError('Enter at least one received quantity.');
      return;
    }
    const result = api.dispatch({
      type: 'goodsReceipt.create',
      input: { poId: po.id, receiptDate, locationId, lines },
    });
    if (result) onClose();
  };

  return (
    <Modal
      open={open}
      title={`Receive against ${po.poNo}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="primary" onClick={submit}>
            Post goods receipt
          </button>
        </>
      }
    >
      <p>
        Receiving stock increases inventory at the PO unit cost and accrues goods received not
        invoiced. It does not record the supplier bill or any expense.
      </p>
      <Field label="Location" htmlFor="gr-location">
        <select id="gr-location" value={locationId} onChange={(event) => setLocationId(event.target.value)}>
          {locations.map((location) => (
            <option key={location.id} value={location.id}>
              {location.code} · {location.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Receipt date" htmlFor="gr-date">
        <input id="gr-date" type="date" value={receiptDate} onChange={(event) => setReceiptDate(event.target.value)} />
      </Field>
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">PO line</th>
            <th scope="col" className="numeric">
              Ordered
            </th>
            <th scope="col" className="numeric">
              Received
            </th>
            <th scope="col">Receive now (base units)</th>
          </tr>
        </thead>
        <tbody>
          {po.lines.map((line) => (
            <tr key={line.id}>
              <td>{line.description}</td>
              <td className="numeric">{(line.quantityMilli / 1000).toString()}</td>
              <td className="numeric">{(line.receivedMilli / 1000).toString()}</td>
              <td>
                <input
                  aria-label={`Receive quantity for ${line.description}`}
                  inputMode="decimal"
                  value={quantities[line.id] ?? ''}
                  onChange={(event) => setQuantities({ ...quantities, [line.id]: event.target.value })}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {error && (
        <p className="field-message" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}

export function PurchasesScreen() {
  const api = useApp();
  const route = useAppRoute();
  const { navigate } = useNavigation();
  const { state, workspaceId, access } = api;
  const [billOpen, setBillOpen] = useState(false);
  const [billReceipt, setBillReceipt] = useState<GoodsReceipt | null>(null);
  const [poOpen, setPoOpen] = useState(false);
  const [receivingPo, setReceivingPo] = useState<PurchaseOrder | null>(null);
  const [rfpBill, setRfpBill] = useState<Bill | null>(null);
  const [rfpAmount, setRfpAmount] = useState('');
  const [approving, setApproving] = useState<Rfp | null>(null);
  const [rejecting, setRejecting] = useState<Rfp | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [paying, setPaying] = useState<Rfp | null>(null);
  const [paymentForm, setPaymentForm] = useState({
    date: api.clock.today,
    method: 'outgoing_clearing' as 'outgoing_clearing' | 'bank_direct',
    bankAccountId: '',
  });
  const [advanceOpen, setAdvanceOpen] = useState(false);
  const [advanceForm, setAdvanceForm] = useState({
    employeeId: '',
    date: api.clock.today,
    amount: '',
    bankAccountId: '',
  });
  const [liquidating, setLiquidating] = useState<string | null>(null);
  const [liquidationForm, setLiquidationForm] = useState({
    date: api.clock.today,
    accountId: '',
    description: '',
    amount: '',
    bankAccountId: '',
  });

  const accountingStatus = api.productStatus('accounting');
  const active = accountingStatus === 'active';
  const canWrite = active && hasAnyRole(access, 'accountant', 'ap_ar_clerk', 'company_admin');
  const canApprove = active && hasAnyRole(access, 'accountant', 'company_admin');
  const tab: PurchasesTab =
    route?.page === 'orders' ||
    route?.page === 'approvals' ||
    route?.page === 'payments' ||
    route?.page === 'advances'
      ? route.page
      : 'bills';
  const bills = state.bills
    .filter((bill) => bill.workspaceId === workspaceId)
    .slice()
    .sort((left, right) => right.billNo.localeCompare(left.billNo));
  const orders = state.purchaseOrders
    .filter((po) => po.workspaceId === workspaceId)
    .slice()
    .sort((left, right) => right.poNo.localeCompare(left.poNo));
  const receipts = state.goodsReceipts.filter((receipt) => receipt.workspaceId === workspaceId);
  const payments = state.payments
    .filter((payment) => payment.workspaceId === workspaceId)
    .slice()
    .sort((left, right) => right.paymentNo.localeCompare(left.paymentNo));
  const advances = state.advances.filter((advance) => advance.workspaceId === workspaceId);
  const employees = state.employees.filter((employee) => employee.workspaceId === workspaceId && employee.status === 'active');
  const banks = state.bankAccounts.filter((bank) => bank.workspaceId === workspaceId && bank.active);
  const expenseAccounts = state.accounts.filter(
    (account) => account.workspaceId === workspaceId && account.active && account.type === 'expense',
  );
  const rfpsForBill = (billId: string) => state.rfps.filter((rfp) => rfp.workspaceId === workspaceId && rfp.billId === billId);
  const allRfps = state.rfps
    .filter((rfp) => rfp.workspaceId === workspaceId)
    .slice()
    .sort((left, right) => right.rfpNo.localeCompare(left.rfpNo));
  const billDetail =
    tab === 'bills' && route?.recordId
      ? bills.find((bill) => bill.id === route.recordId) ?? null
      : null;
  const advanceDetail =
    tab === 'advances' && route?.recordId
      ? advances.find((candidate) => candidate.id === route.recordId) ?? null
      : null;

  const openRfp = (bill: Bill) => {
    setRfpBill(bill);
    setRfpAmount(centsInput(bill.outstandingCentavos));
    setPaying(null);
  };

  const startPayment = (rfp: Rfp) => {
    setPaying(rfp);
    setPaymentForm({
      date: api.clock.today,
      method: 'outgoing_clearing',
      bankAccountId: banks[0]?.id ?? '',
    });
  };

  const submitRfp = () => {
    if (!rfpBill) return;
    const parsed = moneyField(rfpAmount, 'requested amount');
    if (!parsed.ok || parsed.value === null) {
      api.notify('error', 'Amount invalid', parsed.message);
      return;
    }
    const result = api.dispatch({
      type: 'rfp.create',
      input: { billId: rfpBill.id, amountCentavos: parsed.value },
    });
    if (result) setRfpBill(null);
  };

  const submitPayment = () => {
    if (!paying) return;
    const result = api.dispatch({
      type: 'payment.create',
      input: {
        rfpId: paying.id,
        paymentDate: paymentForm.date,
        method: paymentForm.method,
        bankAccountId: paymentForm.method === 'bank_direct' ? paymentForm.bankAccountId : null,
      },
    });
    if (result) setPaying(null);
  };

  const submitAdvance = () => {
    const amount = moneyField(advanceForm.amount, 'advance amount');
    if (!amount.ok || amount.value === null) {
      api.notify('error', 'Advance amount invalid', amount.message);
      return;
    }
    const result = api.dispatch({
      type: 'advance.create',
      input: {
        employeeId: advanceForm.employeeId,
        advanceDate: advanceForm.date,
        amountCentavos: amount.value,
        bankAccountId: advanceForm.bankAccountId,
      },
    });
    if (result) setAdvanceOpen(false);
  };

  const advance = advances.find((candidate) => candidate.id === liquidating);
  const liquidationExpense = moneyField(liquidationForm.amount, 'expense amount');
  const expenseValue = liquidationExpense.value ?? 0;
  const computedUnused = advance ? Math.max(0, advance.amountCentavos - expenseValue) : 0;
  const computedExcess = advance ? Math.max(0, expenseValue - advance.amountCentavos) : 0;

  const submitLiquidation = () => {
    if (!advance) return;
    if (!liquidationExpense.ok || liquidationExpense.value === null) {
      api.notify('error', 'Liquidation amount invalid', liquidationExpense.message);
      return;
    }
    const result = api.dispatch({
      type: 'advance.liquidate',
      input: {
        advanceId: advance.id,
        liquidationDate: liquidationForm.date,
        expenses: [
          {
            accountId: liquidationForm.accountId,
            description: liquidationForm.description,
            amountCentavos: liquidationExpense.value,
          },
        ],
        unusedReturnCentavos: computedUnused,
        excessReimbursementCentavos: computedExcess,
        bankAccountId: liquidationForm.bankAccountId,
      },
    });
    if (result) setLiquidating(null);
  };

  return (
    <div className="screen">
      {accountingStatus !== 'active' && (
        <div className="callout callout-warn" role="status">
          <strong>Accounting is {accountingStatus}.</strong> Goods receipt remains available when
          Inventory is active, but bills, payment requests, payments and advances are unavailable.
        </div>
      )}
      {tab === 'bills' && (
        <Panel
          title="Supplier bills and payment requests"
          subtitle="A bill posts expense or GRNI and accounts payable. A payment request creates no expense; approval separates the requester from the checker."
          actions={
            <button type="button" className="primary" onClick={() => { setBillReceipt(null); setBillOpen(true); }} disabled={!canWrite}>
              New bill
            </button>
          }
        >
          {bills.length === 0 ? (
            <EmptyState title="No supplier bills yet">
              Create a non-PO expense bill, or receive stock against a purchase order and bill the
              receipt.
            </EmptyState>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <caption>Supplier bills</caption>
                <thead>
                  <tr>
                    <th scope="col">Bill</th>
                    <th scope="col">Vendor / supplier invoice</th>
                    <th scope="col">Date</th>
                    <th scope="col" className="numeric">
                      Total
                    </th>
                    <th scope="col" className="numeric">
                      Outstanding
                    </th>
                    <th scope="col">Status</th>
                    <th scope="col">Requests</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {bills.map((bill) => {
                    const rfps = rfpsForBill(bill.id);
                    return (
                      <tr key={bill.id}>
                        <th scope="row">
                          <button
                            type="button"
                            className="link-button"
                            onClick={() => navigate(appRoute('purchases', 'bills', { recordId: bill.id }))}
                          >
                            {bill.billNo}
                          </button>
                          {bill.duplicateFlag && <span className="flag"> duplicate</span>}
                        </th>
                        <td>
                          {bill.vendorSnapshot.name}
                          <br />
                          <span className="muted">{bill.supplierInvoiceNo}</span>
                        </td>
                        <td>{humanDate(bill.billDate)}</td>
                        <td className="numeric">{money(bill.totalCentavos)}</td>
                        <td className="numeric">{money(bill.outstandingCentavos)}</td>
                        <td>
                          <StatusBadge status={bill.status} />
                        </td>
                        <td>
                          {rfps.length === 0 ? (
                            <span className="muted">None</span>
                          ) : (
                            <ul className="compact-list">
                              {rfps.map((rfp) => (
                                <li key={rfp.id}>
                                  {rfp.rfpNo} · {money(rfp.amountCentavos)} · <StatusBadge status={rfp.status} />
                                  {rfp.status === 'pending' && canApprove && rfp.requestedBy === api.actorId && (
                                    <span className="muted"> · requester cannot approve</span>
                                  )}
                                  {rfp.status === 'pending' && canApprove && rfp.requestedBy !== api.actorId && (
                                    <>
                                      {' '}
                                      <button type="button" className="link-button" onClick={() => setApproving(rfp)}>
                                        Approve
                                      </button>{' '}
                                      <button
                                        type="button"
                                        className="link-button"
                                        onClick={() => {
                                          setRejecting(rfp);
                                          setRejectReason('');
                                        }}
                                      >
                                        Reject
                                      </button>
                                    </>
                                  )}
                                  {rfp.status === 'approved' && canApprove && (
                                    <>
                                      {' '}
                                      <button type="button" className="link-button" onClick={() => startPayment(rfp)}>
                                        Pay
                                      </button>
                                    </>
                                  )}
                                </li>
                              ))}
                            </ul>
                          )}
                        </td>
                        <td className="actions">
                          <button
                            type="button"
                            className="link-button"
                            onClick={() => openRfp(bill)}
                            disabled={!canWrite || bill.outstandingCentavos <= 0 || bill.status === 'held'}
                            title={bill.status === 'held' ? 'Resolve the duplicate before requesting payment' : undefined}
                          >
                            Request payment
                          </button>
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

      {tab === 'approvals' && (
        <Panel
          title="Payment request approvals"
          subtitle="A payment request reserves nothing until it is approved. The requester cannot approve their own request."
        >
          {allRfps.length === 0 ? (
            <EmptyState title="No payment requests yet">
              Create a request from a supplier bill, then approve it here with a different actor.
            </EmptyState>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <caption>Payment requests for the active company</caption>
                <thead>
                  <tr>
                    <th scope="col">Request</th>
                    <th scope="col">Bill</th>
                    <th scope="col">Requester</th>
                    <th scope="col" className="numeric">
                      Amount
                    </th>
                    <th scope="col">Status</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {allRfps.map((rfp) => {
                    const bill = state.bills.find((candidate) => candidate.id === rfp.billId);
                    const requester = state.users.find((user) => user.id === rfp.requestedBy);
                    const ownRequest = rfp.requestedBy === api.actorId;
                    return (
                      <tr key={rfp.id}>
                        <th scope="row">{rfp.rfpNo}</th>
                        <td>{bill?.billNo ?? rfp.billId}</td>
                        <td>{requester?.name ?? rfp.requestedBy}</td>
                        <td className="numeric">{money(rfp.amountCentavos)}</td>
                        <td>
                          <StatusBadge status={rfp.status} />
                        </td>
                        <td className="actions">
                          {rfp.status === 'pending' && canApprove && ownRequest && (
                            <span className="muted">Requester cannot approve</span>
                          )}
                          {rfp.status === 'pending' && canApprove && !ownRequest && (
                            <>
                              <button type="button" className="link-button" onClick={() => setApproving(rfp)}>
                                Approve
                              </button>
                              <button
                                type="button"
                                className="link-button"
                                onClick={() => {
                                  setRejecting(rfp);
                                  setRejectReason('');
                                }}
                              >
                                Reject
                              </button>
                            </>
                          )}
                          {rfp.status === 'approved' && canApprove && (
                            <button type="button" className="link-button" onClick={() => startPayment(rfp)}>
                              Create payment
                            </button>
                          )}
                          {!canApprove && <span className="muted">Approver role required</span>}
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

      {tab === 'orders' && (
        <Panel
          title="Purchase orders and goods receipts"
          subtitle="Receiving stock posts inventory and GRNI at the PO cost. A stock-linked bill later clears GRNI and cannot exceed the received quantity or value."
          actions={
            <button type="button" className="primary" onClick={() => setPoOpen(true)} disabled={!canWrite}>
              New purchase order
            </button>
          }
        >
          {orders.length === 0 ? (
            <EmptyState title="No purchase orders yet" />
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">PO</th>
                    <th scope="col">Vendor</th>
                    <th scope="col">Date</th>
                    <th scope="col">Lines</th>
                    <th scope="col" className="numeric">
                      Value
                    </th>
                    <th scope="col">Status</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((po) => {
                    const value = po.lines.reduce(
                      (total, line) => total + mulDivRound(line.quantityMilli, line.unitCostCentavos, 1000),
                      0,
                    );
                    const fullyReceived = po.lines.every((line) => line.receivedMilli >= line.quantityMilli);
                    return (
                      <tr key={po.id}>
                        <th scope="row">{po.poNo}</th>
                        <td>{state.contacts.find((contact) => contact.id === po.vendorContactId)?.name ?? 'Unknown vendor'}</td>
                        <td>{humanDate(po.poDate)}</td>
                        <td>{po.lines.length}</td>
                        <td className="numeric">{money(value)}</td>
                        <td>
                          <StatusBadge status={po.status} />
                        </td>
                        <td className="actions">
                          <button
                            type="button"
                            className="link-button"
                            onClick={() => setReceivingPo(po)}
                            disabled={!hasAnyRole(access, 'inventory_officer', 'accountant', 'ap_ar_clerk', 'company_admin') || fullyReceived || api.productStatus('inventory') !== 'active'}
                          >
                            Receive
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {receipts.length > 0 && (
            <>
              <h3>Goods receipts awaiting bill</h3>
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">Receipt</th>
                    <th scope="col">PO</th>
                    <th scope="col">Date</th>
                    <th scope="col" className="numeric">
                      Value
                    </th>
                    <th scope="col">Lines</th>
                    <th scope="col">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {receipts.map((receipt) => {
                    const value = receipt.lines.reduce(
                      (total, line) => total + mulDivRound(line.quantityMilli, line.unitCostCentavos, 1000),
                      0,
                    );
                    return (
                      <tr key={receipt.id}>
                        <th scope="row">{receipt.receiptNo}</th>
                        <td>{receipt.poId}</td>
                        <td>{humanDate(receipt.receiptDate)}</td>
                        <td className="numeric">{money(value)}</td>
                        <td>
                          <ul className="compact-list">
                            {receipt.lines.map((line) => (
                              <li key={line.poLineId}>
                                {state.items.find((item) => item.id === line.itemId)?.name ?? line.itemId} ·{' '}
                                {quantity(line.quantityMilli, 'unit')}
                              </li>
                            ))}
                          </ul>
                        </td>
                        <td>
                          <button
                            type="button"
                            className="link-button"
                            onClick={() => {
                              setBillReceipt(receipt);
                              setBillOpen(true);
                            }}
                            disabled={!canWrite}
                          >
                            Bill receipt
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </>
          )}
        </Panel>
      )}

      {tab === 'payments' && (
        <Panel title="Payments" subtitle="A payment settles only an approved request. Withholding is separated from cash and recorded as creditable EWT.">
          {payments.length === 0 ? (
            <EmptyState title="No payments posted" />
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">Payment</th>
                    <th scope="col">Vendor</th>
                    <th scope="col">Date</th>
                    <th scope="col" className="numeric">
                      Request
                    </th>
                    <th scope="col" className="numeric">
                      EWT withheld
                    </th>
                    <th scope="col">Method</th>
                    <th scope="col">Approved by</th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {payments.map((payment) => (
                    <tr key={payment.id}>
                      <th scope="row">{payment.paymentNo}</th>
                      <td>{state.contacts.find((contact) => contact.id === payment.vendorContactId)?.name ?? payment.vendorContactId}</td>
                      <td>{humanDate(payment.paymentDate)}</td>
                      <td className="numeric">{money(payment.amountCentavos)}</td>
                      <td className="numeric">{money(payment.ewtCentavos)}</td>
                      <td>{titleCase(payment.method)}</td>
                      <td>{state.users.find((user) => user.id === payment.approvedBy)?.name ?? payment.approvedBy}</td>
                      <td>
                        <StatusBadge status={payment.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      )}

      {tab === 'advances' && (
        <Panel
          title="Employee advances and liquidation"
          subtitle="An advance is a receivable, not payroll. Liquidation records supported expenses, unused cash returned, or an excess reimbursement."
          actions={
            <button
              type="button"
              className="primary"
              onClick={() => {
                setAdvanceForm({
                  employeeId: employees[0]?.id ?? '',
                  date: api.clock.today,
                  amount: '',
                  bankAccountId: banks[0]?.id ?? '',
                });
                setAdvanceOpen(true);
              }}
              disabled={!canWrite}
            >
              New advance
            </button>
          }
        >
          {advances.length === 0 ? (
            <EmptyState title="No employee advances" />
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Advance</th>
                  <th scope="col">Employee</th>
                  <th scope="col">Date</th>
                  <th scope="col" className="numeric">
                    Amount
                  </th>
                  <th scope="col" className="numeric">
                    Liquidated
                  </th>
                  <th scope="col" className="numeric">
                    Returned
                  </th>
                  <th scope="col">Status</th>
                  <th scope="col">Action</th>
                </tr>
              </thead>
              <tbody>
                {advances.map((advance) => (
                  <tr key={advance.id}>
                    <th scope="row">
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => navigate(appRoute('purchases', 'advances', { recordId: advance.id }))}
                      >
                        {advance.advanceNo}
                      </button>
                    </th>
                    <td>{state.employees.find((employee) => employee.id === advance.employeeId)?.name ?? advance.employeeId}</td>
                    <td>{humanDate(advance.advanceDate)}</td>
                    <td className="numeric">{money(advance.amountCentavos)}</td>
                    <td className="numeric">{money(advance.liquidatedCentavos)}</td>
                    <td className="numeric">{money(advance.returnedCentavos)}</td>
                    <td>
                      <StatusBadge status={advance.status} />
                    </td>
                    <td>
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => {
                          setLiquidating(advance.id);
                          setLiquidationForm({
                            date: api.clock.today,
                            accountId: expenseAccounts[0]?.id ?? '',
                            description: '',
                            amount: centsInput(advance.amountCentavos),
                            bankAccountId: banks[0]?.id ?? '',
                          });
                        }}
                        disabled={!canWrite || advance.status !== 'open'}
                      >
                        Liquidate
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      )}

      <BillEditor open={billOpen} receipt={billReceipt} onClose={() => setBillOpen(false)} />
      <PoEditor open={poOpen} onClose={() => setPoOpen(false)} />
      <ReceiptEditor po={receivingPo} open={receivingPo !== null} onClose={() => setReceivingPo(null)} />

      <Modal
        open={rfpBill !== null}
        title={rfpBill ? `Request payment for ${rfpBill.billNo}` : 'Payment request'}
        onClose={() => setRfpBill(null)}
        footer={
          <>
            <button type="button" onClick={() => setRfpBill(null)}>
              Cancel
            </button>
            <button type="button" className="primary" onClick={submitRfp}>
              Create request
            </button>
          </>
        }
      >
        <p>
          This creates a request only. It posts no expense and pays nothing. A different
          accountant or company administrator must approve it before release.
        </p>
        <Field label={'Amount (PHP, maximum ' + (rfpBill ? peso(rfpBill.outstandingCentavos) : '') + ')'} htmlFor="rfp-amount">
          <input id="rfp-amount" inputMode="decimal" value={rfpAmount} onChange={(event) => setRfpAmount(event.target.value)} />
        </Field>
      </Modal>

      <Modal
        open={approving !== null}
        title={approving ? `Approve ${approving.rfpNo}?` : 'Approve request'}
        onClose={() => setApproving(null)}
        footer={
          <>
            <button type="button" onClick={() => setApproving(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => {
                if (!approving) return;
                const result = api.dispatch({ type: 'rfp.approve', input: { rfpId: approving.id } });
                if (result) setApproving(null);
              }}
            >
              Approve as checker
            </button>
          </>
        }
      >
        <p>
          The approver is <strong>{state.users.find((user) => user.id === api.actorId)?.name}</strong>.
          The requester cannot approve their own request; the command seam enforces this even if
          the control were re-enabled in the browser.
        </p>
      </Modal>

      <Modal
        open={rejecting !== null}
        title={rejecting ? `Reject ${rejecting.rfpNo}` : 'Reject request'}
        onClose={() => setRejecting(null)}
        footer={
          <>
            <button type="button" onClick={() => setRejecting(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="danger"
              onClick={() => {
                if (!rejecting) return;
                const result = api.dispatch({
                  type: 'rfp.reject',
                  input: { rfpId: rejecting.id, reason: rejectReason },
                });
                if (result) setRejecting(null);
              }}
              disabled={rejectReason.trim().length < 3}
            >
              Reject request
            </button>
          </>
        }
      >
        <Field label="Rejection reason" htmlFor="reject-reason">
          <input id="reject-reason" value={rejectReason} onChange={(event) => setRejectReason(event.target.value)} />
        </Field>
      </Modal>

      <Modal
        open={paying !== null}
        title={paying ? `Pay approved request ${paying.rfpNo}` : "Pay request"}
        onClose={() => setPaying(null)}
        footer={
          <>
            <button type="button" onClick={() => setPaying(null)}>
              Cancel
            </button>
            <button type="button" className="primary" onClick={submitPayment}>
              Post payment
            </button>
          </>
        }
      >
        {paying && (
          <p>
            Approved by {state.users.find((user) => user.id === paying.approvedBy)?.name ?? 'another user'}.
            Amount {peso(paying.amountCentavos)}. Cash paid is net of any demo withholding.
          </p>
        )}
        <Field label="Payment date" htmlFor="payment-date">
          <input
            id="payment-date"
            type="date"
            value={paymentForm.date}
            onChange={(event) => setPaymentForm({ ...paymentForm, date: event.target.value })}
          />
        </Field>
        <Field label="Method" htmlFor="payment-method">
          <select
            id="payment-method"
            value={paymentForm.method}
            onChange={(event) =>
              setPaymentForm({
                ...paymentForm,
                method: event.target.value === 'bank_direct' ? 'bank_direct' : 'outgoing_clearing',
              })
            }
          >
            <option value="outgoing_clearing">Outgoing clearing</option>
            <option value="bank_direct">Direct bank payment</option>
          </select>
        </Field>
        <Field label="Bank account" htmlFor="payment-bank">
          <select
            id="payment-bank"
            value={paymentForm.bankAccountId}
            onChange={(event) => setPaymentForm({ ...paymentForm, bankAccountId: event.target.value })}
          >
            {banks.map((bank) => (
              <option key={bank.id} value={bank.id}>
                {bank.bankName} {bank.accountNoMasked}
              </option>
            ))}
          </select>
        </Field>
      </Modal>

      <Modal
        open={advanceOpen}
        title="Release employee advance"
        onClose={() => setAdvanceOpen(false)}
        footer={
          <>
            <button type="button" onClick={() => setAdvanceOpen(false)}>
              Cancel
            </button>
            <button type="button" className="primary" onClick={submitAdvance}>
              Post advance
            </button>
          </>
        }
      >
        <Field label="Employee" htmlFor="advance-employee">
          <select
            id="advance-employee"
            value={advanceForm.employeeId}
            onChange={(event) => setAdvanceForm({ ...advanceForm, employeeId: event.target.value })}
          >
            {employees.map((employee) => (
              <option key={employee.id} value={employee.id}>
                {employee.employeeNo} · {employee.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Advance date" htmlFor="advance-date">
          <input
            id="advance-date"
            type="date"
            value={advanceForm.date}
            onChange={(event) => setAdvanceForm({ ...advanceForm, date: event.target.value })}
          />
        </Field>
        <Field label="Amount (PHP)" htmlFor="advance-amount">
          <input
            id="advance-amount"
            inputMode="decimal"
            value={advanceForm.amount}
            onChange={(event) => setAdvanceForm({ ...advanceForm, amount: event.target.value })}
          />
        </Field>
        <Field label="Bank account" htmlFor="advance-bank">
          <select
            id="advance-bank"
            value={advanceForm.bankAccountId}
            onChange={(event) => setAdvanceForm({ ...advanceForm, bankAccountId: event.target.value })}
          >
            {banks.map((bank) => (
              <option key={bank.id} value={bank.id}>
                {bank.bankName} {bank.accountNoMasked}
              </option>
            ))}
          </select>
        </Field>
      </Modal>

      <Modal
        open={advance !== undefined && advance !== null}
        title={advance ? `Liquidate ${advance.advanceNo}` : 'Liquidate advance'}
        onClose={() => setLiquidating(null)}
        footer={
          <>
            <button type="button" onClick={() => setLiquidating(null)}>
              Cancel
            </button>
            <button type="button" className="primary" onClick={submitLiquidation}>
              Post liquidation
            </button>
          </>
        }
      >
        {advance && (
          <p>
            Advance {peso(advance.amountCentavos)}. Any remainder is treated as unused cash
            returned; spending above it becomes an excess reimbursement payable. This demo form
            records one supported expense line.
          </p>
        )}
        <Field label="Liquidation date" htmlFor="liq-date">
          <input
            id="liq-date"
            type="date"
            value={liquidationForm.date}
            onChange={(event) => setLiquidationForm({ ...liquidationForm, date: event.target.value })}
          />
        </Field>
        <Field label="Expense account" htmlFor="liq-account">
          <select
            id="liq-account"
            value={liquidationForm.accountId}
            onChange={(event) => setLiquidationForm({ ...liquidationForm, accountId: event.target.value })}
          >
            {expenseAccounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.code} · {account.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Description" htmlFor="liq-description">
          <input
            id="liq-description"
            value={liquidationForm.description}
            onChange={(event) => setLiquidationForm({ ...liquidationForm, description: event.target.value })}
          />
        </Field>
        <Field label="Supported expense (PHP)" htmlFor="liq-amount">
          <input
            id="liq-amount"
            inputMode="decimal"
            value={liquidationForm.amount}
            onChange={(event) => setLiquidationForm({ ...liquidationForm, amount: event.target.value })}
          />
        </Field>
        <p className="muted">
          Unused return: {money(computedUnused)} · Excess reimbursement: {money(computedExcess)}
        </p>
        <Field label="Bank account for cash settlement" htmlFor="liq-bank">
          <select
            id="liq-bank"
            value={liquidationForm.bankAccountId}
            onChange={(event) => setLiquidationForm({ ...liquidationForm, bankAccountId: event.target.value })}
          >
            {banks.map((bank) => (
              <option key={bank.id} value={bank.id}>
                {bank.bankName} {bank.accountNoMasked}
              </option>
            ))}
          </select>
        </Field>
      </Modal>

      <Modal
        open={Boolean(billDetail)}
        title={billDetail ? `${billDetail.billNo} · ${billDetail.vendorSnapshot.name}` : 'Bill'}
        onClose={() => navigate(appRoute('purchases', 'bills'))}
        wide
      >
        {billDetail && (
          <>
            <dl className="definition-grid">
              <div>
                <dt>Supplier invoice</dt>
                <dd>{billDetail.supplierInvoiceNo}</dd>
              </div>
              <div>
                <dt>Bill date</dt>
                <dd>{humanDate(billDetail.billDate)}</dd>
              </div>
              <div>
                <dt>Due</dt>
                <dd>{humanDate(billDetail.dueDate)}</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd><StatusBadge status={billDetail.status} /></dd>
              </div>
              <div>
                <dt>Total</dt>
                <dd>{money(billDetail.totalCentavos)}</dd>
              </div>
              <div>
                <dt>Outstanding</dt>
                <dd>{money(billDetail.outstandingCentavos)}</dd>
              </div>
            </dl>
            <div className="table-wrap">
              <table className="data-table">
                <caption>{billDetail.billNo} lines</caption>
                <thead>
                  <tr>
                    <th scope="col">Description</th>
                    <th scope="col">Account</th>
                    <th scope="col" className="numeric">Amount</th>
                    <th scope="col" className="numeric">Tax</th>
                  </tr>
                </thead>
                <tbody>
                  {billDetail.lines.map((line) => {
                    const account = state.accounts.find((candidate) => candidate.id === line.accountId);
                    return (
                      <tr key={line.id}>
                        <th scope="row">{line.description}</th>
                        <td>{account ? `${account.code} · ${account.name}` : line.accountId}</td>
                        <td className="numeric">{money(line.amountCentavos)}</td>
                        <td className="numeric">{money(line.taxCentavos)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Modal>

      <Modal
        open={Boolean(advanceDetail)}
        title={advanceDetail ? `${advanceDetail.advanceNo} · advance` : 'Advance'}
        onClose={() => navigate(appRoute('purchases', 'advances'))}
      >
        {advanceDetail && (
          <dl className="definition-grid">
            <div>
              <dt>Employee</dt>
              <dd>{state.employees.find((employee) => employee.id === advanceDetail.employeeId)?.name ?? advanceDetail.employeeId}</dd>
            </div>
            <div>
              <dt>Released</dt>
              <dd>{humanDate(advanceDetail.advanceDate)}</dd>
            </div>
            <div>
              <dt>Amount</dt>
              <dd>{money(advanceDetail.amountCentavos)}</dd>
            </div>
            <div>
              <dt>Liquidated</dt>
              <dd>{money(advanceDetail.liquidatedCentavos)}</dd>
            </div>
            <div>
              <dt>Returned</dt>
              <dd>{money(advanceDetail.returnedCentavos)}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd><StatusBadge status={advanceDetail.status} /></dd>
            </div>
          </dl>
        )}
      </Modal>
    </div>
  );
}
