import { useMemo, useState, useEffect } from 'react';
import type { Asset } from '../../domain/schema';
import {
  assetNetBookValue,
  dailyDepreciationDisplay,
  monthlyDepreciation,
} from '../../domain/assets';
import { assetSchedule } from '../../domain/queries';
import { useApp } from '../useApp';
import { useAppRoute, useNavigation } from '../navigation';
import { appRoute } from '../router';
import { downloadText, toCsv } from '../../adapters/csv';
import { EmptyState, Field, Modal, Panel } from '../components';
import { humanDate, humanTimestamp, money, peso, titleCase } from '../format';
import { dateField, moneyField, positiveIntField, requiredField } from '../forms';
import { hasAnyRole } from '../permissions';

interface AssetFormState {
  companyVendorBrand: string;
  purchaseDate: string;
  description: string;
  supplierContactId: string;
  serialNo: string;
  assetAccountId: string;
  cost: string;
  usefulLifeYears: string;
  residualValue: string;
  depreciationStart: string;
  convention: 'full_month' | 'daily_prorated';
  depreciationExpenseAccountId: string;
  accumulatedDepreciationAccountId: string;
  sourceType: 'direct_purchase' | 'opening' | 'stock_reclass';
  postAcquisition: boolean;
}

export function AssetsScreen() {
  const api = useApp();
  const route = useAppRoute();
  const { navigate } = useNavigation();
  const page = route?.page === 'depreciation' ? 'depreciation' : 'register';
  const { state, workspaceId, access } = api;
  const accountingStatus = api.productStatus('accounting');
  const accountingActive = accountingStatus === 'active';
  const canWrite = accountingActive && hasAnyRole(access, 'accountant', 'company_admin');

  const accounts = useMemo(
    () => state.accounts.filter((account) => account.workspaceId === workspaceId && account.active),
    [state.accounts, workspaceId],
  );
  const vendors = useMemo(
    () =>
      state.contacts.filter(
        (contact) =>
          contact.workspaceId === workspaceId && contact.active && contact.roles.includes('vendor'),
      ),
    [state.contacts, workspaceId],
  );
  const assetAccounts = accounts.filter((account) => account.type === 'asset');
  const expenseAccounts = accounts.filter((account) => account.type === 'expense');
  const defaultAssetAccount = assetAccounts.find((account) => account.controlRole === 'asset_cost');
  const defaultAccumulated = assetAccounts.find(
    (account) => account.controlRole === 'accumulated_depreciation',
  );
  const defaultExpense = expenseAccounts.find(
    (account) => account.controlRole === 'depreciation_expense',
  );

  const assets = state.assets.filter((asset) => asset.workspaceId === workspaceId);
  const period = api.clock.today.slice(0, 7);
  const [selectedPeriod, setSelectedPeriod] = useState(period);
  const posts = state.depreciationPosts.filter(
    (post) => post.workspaceId === workspaceId && post.period === selectedPeriod,
  );
  const schedule = useMemo(
    () => assetSchedule(state, workspaceId, selectedPeriod),
    [state, workspaceId, selectedPeriod],
  );
  const calculatedPosts = posts.filter((post) => post.status === 'calculated');
  const approvedPosts = posts.filter((post) => post.status === 'approved');
  const makerConflict =
    calculatedPosts.length > 0 && calculatedPosts.some((post) => post.calculatedBy === api.actorId);

  const [createOpen, setCreateOpen] = useState(false);
  const [detail, setDetail] = useState<Asset | null>(null);
  const [detailPeriod, setDetailPeriod] = useState(period);

  useEffect(() => {
    const recordId = route?.recordId;
    if (!recordId) {
      setDetail(null);
      return;
    }
    const asset = state.assets.find(
      (candidate) => candidate.id === recordId && candidate.workspaceId === workspaceId,
    );
    setDetail(asset ?? null);
    if (route?.query.period) setDetailPeriod(route.query.period);
  }, [route?.recordId, route?.query.period, state.assets, workspaceId]);
  const [form, setForm] = useState<AssetFormState>(() => ({
    companyVendorBrand: '',
    purchaseDate: api.clock.today,
    description: '',
    supplierContactId: '',
    serialNo: '',
    assetAccountId: defaultAssetAccount?.id ?? '',
    cost: '',
    usefulLifeYears: '5',
    residualValue: '0.00',
    depreciationStart: api.clock.today,
    convention: 'full_month',
    depreciationExpenseAccountId: defaultExpense?.id ?? '',
    accumulatedDepreciationAccountId: defaultAccumulated?.id ?? '',
    sourceType: 'direct_purchase',
    postAcquisition: true,
  }));

  const totalCost = assets.reduce((total, asset) => total + asset.costCentavos, 0);
  const totalNetBook = assets.reduce(
    (total, asset) => total + assetNetBookValue(asset, state),
    0,
  );
  const totalAccumulated = assets.reduce((total, asset) => {
    const posted = state.depreciationPosts.filter(
      (post) => post.assetId === asset.id && post.status === 'posted',
    );
    return total + posted.reduce((sum, post) => sum + post.amountCentavos, 0);
  }, 0);

  const openCreate = () => {
    setForm({
      companyVendorBrand: '',
      purchaseDate: api.clock.today,
      description: '',
      supplierContactId: '',
      serialNo: '',
      assetAccountId: defaultAssetAccount?.id ?? '',
      cost: '',
      usefulLifeYears: '5',
      residualValue: '0.00',
      depreciationStart: api.clock.today,
      convention: 'full_month',
      depreciationExpenseAccountId: defaultExpense?.id ?? '',
      accumulatedDepreciationAccountId: defaultAccumulated?.id ?? '',
      sourceType: 'direct_purchase',
      postAcquisition: true,
    });
    setCreateOpen(true);
  };

  const submitAsset = () => {
    const brand = requiredField(form.companyVendorBrand, 'Company / vendor / brand');
    const description = requiredField(form.description, 'Item description');
    const purchase = dateField(form.purchaseDate, 'Purchase date');
    const start = dateField(form.depreciationStart, 'Depreciation start');
    const cost = moneyField(form.cost, 'cost');
    const residual = moneyField(form.residualValue, 'residual value');
    const life = positiveIntField(form.usefulLifeYears, 'useful life');
    const firstError = [brand, description, purchase, start, cost, residual, life].find(
      (field) => !field.ok,
    );
    if (firstError) {
      api.notify('error', 'Asset is incomplete', firstError.message);
      return;
    }
    if (!form.assetAccountId || !form.depreciationExpenseAccountId || !form.accumulatedDepreciationAccountId) {
      api.notify('error', 'Asset is incomplete', 'Choose cost, expense, and accumulated-depreciation accounts.');
      return;
    }
    if (cost.value === null || residual.value === null || life.value === null) return;
    const result = api.dispatch({
      type: 'asset.create',
      input: {
        companyVendorBrand: brand.value ?? '',
        purchaseDate: purchase.value ?? form.purchaseDate,
        description: description.value ?? '',
        supplierContactId: form.supplierContactId || null,
        serialNo: form.serialNo.trim(),
        assetAccountId: form.assetAccountId,
        costCentavos: cost.value,
        usefulLifeYears: life.value,
        residualValueCentavos: residual.value,
        depreciationStart: start.value ?? form.depreciationStart,
        convention: form.convention,
        depreciationExpenseAccountId: form.depreciationExpenseAccountId,
        accumulatedDepreciationAccountId: form.accumulatedDepreciationAccountId,
        sourceType: form.sourceType,
        sourceId: null,
        postAcquisition: form.postAcquisition,
      },
    });
    if (result) setCreateOpen(false);
  };

  const runDepreciation = (kind: 'calculate' | 'approve' | 'post') => {
    if (!/^\d{4}-\d{2}$/.test(selectedPeriod)) {
      api.notify('error', 'Select a period', 'Use a real YYYY-MM month.');
      return;
    }
    api.dispatch(
      kind === 'calculate'
        ? { type: 'depreciation.calculate', input: { period: selectedPeriod } }
        : kind === 'approve'
          ? { type: 'depreciation.approve', input: { period: selectedPeriod } }
          : { type: 'depreciation.post', input: { period: selectedPeriod } },
    );
  };

  const exportRegister = () => {
    downloadText(
      `ece-accounting-fixed-assets-${selectedPeriod}.csv`,
      toCsv(
        schedule.map((row) => ({
          asset_no: row.assetNo,
          description: row.description,
          cost_centavos: row.costCentavos,
          monthly_depreciation_centavos: row.monthlyCentavos,
          accumulated_depreciation_centavos: row.accumulatedCentavos,
          net_book_value_centavos: row.netBookValueCentavos,
          status: row.status,
          posted_in_period: row.periodPosted ?? '',
        })),
      ),
    );
  };

  return (
    <div className="screen">
      {!accountingActive && (
        <div className="callout callout-warn" role="status">
          <strong>Accounting is {accountingStatus}.</strong> The asset register and schedule stay
          readable, but acquisition and depreciation postings are blocked.
        </div>
      )}

      {page === 'register' && (
        <>
          <div className="stat-row">
            <div className="stat">
              <span>Assets on register</span>
              <strong>{assets.length}</strong>
            </div>
            <div className="stat">
              <span>Total cost</span>
              <strong>{peso(totalCost)}</strong>
            </div>
            <div className="stat">
              <span>Accumulated depreciation</span>
              <strong>{peso(totalAccumulated)}</strong>
            </div>
            <div className="stat">
              <span>Net carrying amount</span>
              <strong>{peso(totalNetBook)}</strong>
            </div>
          </div>

          <Panel
            title="Asset register"
            subtitle="Register fields keep the demo's required column names. Depreciation per day is a display only; posting uses the approved full-month convention unless an asset is explicitly daily-prorated in its acquisition month."
            actions={
              <>
                <button type="button" onClick={exportRegister}>
                  Export register CSV
                </button>
                <button type="button" className="primary" onClick={openCreate} disabled={!canWrite}>
                  New asset
                </button>
              </>
            }
          >
        {assets.length === 0 ? (
          <EmptyState title="No fixed assets yet">
            Add a synthetic asset to exercise acquisition, monthly depreciation, approval, and
            posting.
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <caption>Fixed asset register</caption>
              <thead>
                <tr>
                  <th scope="col">Asset no.</th>
                  <th scope="col">Company vendor/brand</th>
                  <th scope="col">Purchase Date</th>
                  <th scope="col">Item Description</th>
                  <th scope="col">Supplier</th>
                  <th scope="col">Serial No.</th>
                  <th scope="col">Account</th>
                  <th scope="col" className="numeric">
                    Cost
                  </th>
                  <th scope="col" className="numeric">
                    Useful life for Year
                  </th>
                  <th scope="col" className="numeric">
                    Depreciation per month
                  </th>
                  <th scope="col" className="numeric">
                    Depreciation per day
                  </th>
                  <th scope="col" className="numeric">
                    Accumulated
                  </th>
                  <th scope="col" className="numeric">
                    Net carrying amount
                  </th>
                  <th scope="col">Status</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {assets.map((asset) => {
                  const [year, month] = selectedPeriod.split('-').map(Number);
                  const supplier = state.contacts.find(
                    (contact) => contact.id === asset.supplierContactId,
                  );
                  const account = state.accounts.find(
                    (candidate) => candidate.id === asset.assetAccountId,
                  );
                  const accumulated = state.depreciationPosts
                    .filter((post) => post.assetId === asset.id && post.status === 'posted')
                    .reduce((sum, post) => sum + post.amountCentavos, 0);
                  return (
                    <tr key={asset.id}>
                      <th scope="row">{asset.assetNo}</th>
                      <td>{asset.companyVendorBrand}</td>
                      <td>{humanDate(asset.purchaseDate)}</td>
                      <td>{asset.description}</td>
                      <td>{supplier?.name ?? <span className="muted">—</span>}</td>
                      <td>{asset.serialNo || <span className="muted">—</span>}</td>
                      <td>
                        {account ? `${account.code} · ${account.name}` : asset.assetAccountId}
                      </td>
                      <td className="numeric">{money(asset.costCentavos)}</td>
                      <td className="numeric">{asset.usefulLifeYears}</td>
                      <td className="numeric">{money(monthlyDepreciation(asset))}</td>
                      <td className="numeric">
                        {money(dailyDepreciationDisplay(asset, year ?? 0, month ?? 1))}
                      </td>
                      <td className="numeric">{money(accumulated)}</td>
                      <td className="numeric">{money(assetNetBookValue(asset, state))}</td>
                      <td>{titleCase(asset.status)}</td>
                      <td className="actions">
                        <button
                          type="button"
                          className="link-button"
                          onClick={() =>
                            navigate(
                              appRoute('assets', 'register', { recordId: asset.id, query: { period: selectedPeriod } }),
                            )
                          }
                        >
                          Schedule
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="total-row">
                  <th scope="row" colSpan={7}>
                    Totals
                  </th>
                  <td className="numeric">{money(totalCost)}</td>
                  <td colSpan={2} />
                  <td className="numeric">{money(totalAccumulated)}</td>
                  <td className="numeric">{money(totalNetBook)}</td>
                  <td colSpan={2} />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Panel>
        </>
      )}

      {page === 'depreciation' && (
      <Panel
        title={`Monthly depreciation · ${selectedPeriod}`}
        subtitle="Calculate creates rows for every eligible asset; a different user must approve; posting writes one journal per asset. The run is idempotent per asset and period."
        actions={
          <>
            <label className="inline-control">
              <span>Period</span>
              <input
                type="month"
                value={selectedPeriod}
                onChange={(event) => setSelectedPeriod(event.target.value)}
              />
            </label>
            <button
              type="button"
              onClick={() => runDepreciation('calculate')}
              disabled={!canWrite}
            >
              Calculate
            </button>
            <button
              type="button"
              onClick={() => runDepreciation('approve')}
              disabled={!canWrite || calculatedPosts.length === 0 || makerConflict}
              title={
                makerConflict
                  ? 'Maker and approver must be different users. Switch demo actor.'
                  : undefined
              }
            >
              Approve calculated
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => runDepreciation('post')}
              disabled={!canWrite || approvedPosts.length === 0}
            >
              Post approved
            </button>
          </>
        }
        note={
          makerConflict
            ? 'The calculated rows were made by the selected demo actor; approval requires a second user.'
            : undefined
        }
      >
        {posts.length === 0 ? (
          <EmptyState title={`No depreciation rows for ${selectedPeriod}`}>
            Calculate the period to create rows for assets whose depreciation start falls on or
            before the period end.
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <caption>Depreciation rows for {selectedPeriod}</caption>
              <thead>
                <tr>
                  <th scope="col">Asset</th>
                  <th scope="col">Description</th>
                  <th scope="col" className="numeric">
                    Amount
                  </th>
                  <th scope="col" className="numeric">
                    Cumulative after
                  </th>
                  <th scope="col">Status</th>
                  <th scope="col">Calculated by</th>
                  <th scope="col">Approved by</th>
                  <th scope="col">Posted at</th>
                  <th scope="col">Journal</th>
                </tr>
              </thead>
              <tbody>
                {posts.map((post) => {
                  const asset = state.assets.find((candidate) => candidate.id === post.assetId);
                  const calculatedBy = state.users.find((user) => user.id === post.calculatedBy);
                  const approvedBy = state.users.find((user) => user.id === post.approvedBy);
                  return (
                    <tr key={post.id}>
                      <th scope="row">{asset?.assetNo ?? post.assetId}</th>
                      <td>{asset?.description ?? '—'}</td>
                      <td className="numeric">{money(post.amountCentavos)}</td>
                      <td className="numeric">{money(post.cumulativeAfterCentavos)}</td>
                      <td>{titleCase(post.status)}</td>
                      <td>{calculatedBy?.name ?? post.calculatedBy}</td>
                      <td>{approvedBy?.name ?? <span className="muted">—</span>}</td>
                      <td>{post.postedAt ? humanTimestamp(post.postedAt) : <span className="muted">—</span>}</td>
                      <td>{post.journalId ?? <span className="muted">—</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="total-row">
                  <th scope="row" colSpan={2}>
                    Period total
                  </th>
                  <td className="numeric">
                    {money(posts.reduce((sum, post) => sum + post.amountCentavos, 0))}
                  </td>
                  <td colSpan={6} />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Panel>
      )}

      <Modal
        open={createOpen}
        wide
        title="Add fixed asset"
        onClose={() => setCreateOpen(false)}
        footer={
          <>
            <button type="button" onClick={() => setCreateOpen(false)}>
              Cancel
            </button>
            <button type="button" className="primary" onClick={submitAsset}>
              Add asset
            </button>
          </>
        }
      >
        <div className="form-grid">
          <Field label="Company vendor/brand" htmlFor="asset-brand">
            <input
              id="asset-brand"
              value={form.companyVendorBrand}
              onChange={(event) => setForm({ ...form, companyVendorBrand: event.target.value })}
            />
          </Field>
          <Field label="Purchase Date" htmlFor="asset-purchase">
            <input
              id="asset-purchase"
              type="date"
              value={form.purchaseDate}
              onChange={(event) => setForm({ ...form, purchaseDate: event.target.value })}
            />
          </Field>
          <Field label="Item Description" htmlFor="asset-description">
            <input
              id="asset-description"
              value={form.description}
              onChange={(event) => setForm({ ...form, description: event.target.value })}
            />
          </Field>
          <Field label="Supplier" htmlFor="asset-supplier">
            <select
              id="asset-supplier"
              value={form.supplierContactId}
              onChange={(event) => setForm({ ...form, supplierContactId: event.target.value })}
            >
              <option value="">No supplier (opening or reclass)</option>
              {vendors.map((contact) => (
                <option key={contact.id} value={contact.id}>
                  {contact.contactNo} · {contact.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Serial No." htmlFor="asset-serial">
            <input
              id="asset-serial"
              value={form.serialNo}
              onChange={(event) => setForm({ ...form, serialNo: event.target.value })}
            />
          </Field>
          <Field label="Account" htmlFor="asset-account">
            <select
              id="asset-account"
              value={form.assetAccountId}
              onChange={(event) => setForm({ ...form, assetAccountId: event.target.value })}
            >
              {assetAccounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.code} · {account.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Cost (PHP)" htmlFor="asset-cost">
            <input
              id="asset-cost"
              inputMode="decimal"
              value={form.cost}
              onChange={(event) => setForm({ ...form, cost: event.target.value })}
            />
          </Field>
          <Field label="Useful life for Year" htmlFor="asset-life">
            <input
              id="asset-life"
              inputMode="numeric"
              value={form.usefulLifeYears}
              onChange={(event) => setForm({ ...form, usefulLifeYears: event.target.value })}
            />
          </Field>
          <Field label="Residual value (PHP)" htmlFor="asset-residual" hint="Must be less than cost.">
            <input
              id="asset-residual"
              inputMode="decimal"
              value={form.residualValue}
              onChange={(event) => setForm({ ...form, residualValue: event.target.value })}
            />
          </Field>
          <Field label="Depreciation start" htmlFor="asset-start">
            <input
              id="asset-start"
              type="date"
              value={form.depreciationStart}
              onChange={(event) => setForm({ ...form, depreciationStart: event.target.value })}
            />
          </Field>
          <Field label="Convention" htmlFor="asset-convention">
            <select
              id="asset-convention"
              value={form.convention}
              onChange={(event) =>
                setForm({ ...form, convention: event.target.value as AssetFormState['convention'] })
              }
            >
              <option value="full_month">Full month from start month</option>
              <option value="daily_prorated">Daily prorated in start month</option>
            </select>
          </Field>
          <Field label="Source" htmlFor="asset-source">
            <select
              id="asset-source"
              value={form.sourceType}
              onChange={(event) =>
                setForm({ ...form, sourceType: event.target.value as AssetFormState['sourceType'] })
              }
            >
              <option value="direct_purchase">Direct purchase</option>
              <option value="opening">Opening balance</option>
              <option value="stock_reclass">Reclass from stock</option>
            </select>
          </Field>
          <Field label="Depreciation expense account" htmlFor="asset-expense-account">
            <select
              id="asset-expense-account"
              value={form.depreciationExpenseAccountId}
              onChange={(event) =>
                setForm({ ...form, depreciationExpenseAccountId: event.target.value })
              }
            >
              {expenseAccounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.code} · {account.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Accumulated depreciation account" htmlFor="asset-accumulated-account">
            <select
              id="asset-accumulated-account"
              value={form.accumulatedDepreciationAccountId}
              onChange={(event) =>
                setForm({ ...form, accumulatedDepreciationAccountId: event.target.value })
              }
            >
              {assetAccounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.code} · {account.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={form.postAcquisition}
            onChange={(event) => setForm({ ...form, postAcquisition: event.target.checked })}
          />
          Post the acquisition journal now (Dr asset cost; Cr AP for a supplier purchase, opening
          equity for an opening, or inventory for a stock reclass).
        </label>
        <p className="callout callout-info">
          A direct purchase with a supplier credits Accounts Payable. Without a supplier it credits
          opening equity. Leaving the acquisition unposted keeps a schedule-only draft, reported as
          a warning.
        </p>
      </Modal>

      <Modal
        open={detail !== null}
        wide
        title={detail ? `${detail.assetNo} · ${detail.description}` : 'Asset schedule'}
        onClose={() => navigate(appRoute('assets', 'register'))}
      >
        {detail && (
          <>
            <dl className="definition-grid">
              <div>
                <dt>Company vendor/brand</dt>
                <dd>{detail.companyVendorBrand}</dd>
              </div>
              <div>
                <dt>Purchase Date</dt>
                <dd>{humanDate(detail.purchaseDate)}</dd>
              </div>
              <div>
                <dt>Supplier</dt>
                <dd>
                  {state.contacts.find((contact) => contact.id === detail.supplierContactId)?.name ??
                    '—'}
                </dd>
              </div>
              <div>
                <dt>Serial No.</dt>
                <dd>{detail.serialNo || '—'}</dd>
              </div>
              <div>
                <dt>Cost</dt>
                <dd>{money(detail.costCentavos)}</dd>
              </div>
              <div>
                <dt>Residual value</dt>
                <dd>{money(detail.residualValueCentavos)}</dd>
              </div>
              <div>
                <dt>Useful life for Year</dt>
                <dd>{detail.usefulLifeYears}</dd>
              </div>
              <div>
                <dt>Depreciation per month</dt>
                <dd>{money(monthlyDepreciation(detail))}</dd>
              </div>
              <div>
                <dt>Depreciation per day (display)</dt>
                <dd>
                  {money(
                    dailyDepreciationDisplay(
                      detail,
                      Number(detailPeriod.slice(0, 4)),
                      Number(detailPeriod.slice(5, 7)),
                    ),
                  )}
                </dd>
              </div>
              <div>
                <dt>Depreciation start</dt>
                <dd>{humanDate(detail.depreciationStart)}</dd>
              </div>
              <div>
                <dt>Convention</dt>
                <dd>{titleCase(detail.convention)}</dd>
              </div>
              <div>
                <dt>Net carrying amount</dt>
                <dd>{money(assetNetBookValue(detail, state))}</dd>
              </div>
            </dl>
            <label className="inline-control">
              <span>Schedule as of period</span>
              <input
                type="month"
                value={detailPeriod}
                onChange={(event) => setDetailPeriod(event.target.value)}
              />
            </label>
            <table className="data-table">
              <caption>Depreciation schedule</caption>
              <thead>
                <tr>
                  <th scope="col">Period</th>
                  <th scope="col" className="numeric">
                    Amount
                  </th>
                  <th scope="col" className="numeric">
                    Cumulative after
                  </th>
                  <th scope="col">Status</th>
                  <th scope="col">Journal</th>
                </tr>
              </thead>
              <tbody>
                {state.depreciationPosts
                  .filter((post) => post.assetId === detail.id)
                  .slice()
                  .sort((left, right) => left.period.localeCompare(right.period))
                  .map((post) => (
                    <tr key={post.id}>
                      <th scope="row">{post.period}</th>
                      <td className="numeric">{money(post.amountCentavos)}</td>
                      <td className="numeric">{money(post.cumulativeAfterCentavos)}</td>
                      <td>{titleCase(post.status)}</td>
                      <td>{post.journalId ?? <span className="muted">—</span>}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
            {state.depreciationPosts.every((post) => post.assetId !== detail.id) && (
              <p className="muted">No depreciation has been calculated for this asset yet.</p>
            )}
          </>
        )}
      </Modal>
    </div>
  );
}
