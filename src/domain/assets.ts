import type { CommandResult, DomainCommand } from './commandTypes';
import { postJournal, recordAudit, type WriteContext } from './ledger';
import type { Asset, DepreciationPost } from './schema';
import { requireAccountByRole, requireProduct, requireRole } from './shared/access';
import { daysInMonth, parseDateOnly } from './shared/dates';
import { pushItem, updateItem, type StateDraft } from './shared/draft';
import { mulDivRound, sumCentavos } from './shared/money';
import { err, ok, type Result } from './shared/result';
import { allocateCode } from './numbering';


export function monthlyDepreciation(asset: Pick<Asset, 'costCentavos' | 'residualValueCentavos' | 'usefulLifeYears'>): number {
  const base = asset.costCentavos - asset.residualValueCentavos;
  if (base <= 0) return 0;
  return mulDivRound(base, 1, asset.usefulLifeYears * 12);
}

/** Display-only daily view; posting uses the approved full-month convention. */
export function dailyDepreciationDisplay(asset: Asset, year: number, month: number): number {
  return mulDivRound(
    asset.costCentavos - asset.residualValueCentavos,
    1,
    asset.usefulLifeYears * 12 * daysInMonth(year, month),
  );
}

export function createAsset(
  draft: StateDraft,
  ctx: WriteContext,
  input: Extract<DomainCommand, { type: 'asset.create' }>['input'],
): Result<CommandResult> {
  const product = requireProduct(ctx, 'accounting');
  if (!product.ok) return product;
  const role = requireRole(ctx, 'accountant', 'company_admin');
  if (!role.ok) return role;
  if (input.companyVendorBrand.trim().length === 0) {
    return err('VALIDATION', 'Company / vendor / brand is required.', 'companyVendorBrand');
  }
  if (input.description.trim().length === 0) return err('VALIDATION', 'Asset description is required.', 'description');
  const purchase = parseDateOnly(input.purchaseDate, 'purchaseDate');
  if (!purchase.ok) return purchase;
  const start = parseDateOnly(input.depreciationStart, 'depreciationStart');
  if (!start.ok) return start;
  if (!Number.isSafeInteger(input.costCentavos) || input.costCentavos <= 0) {
    return err('VALIDATION', 'Asset cost must be greater than zero.', 'costCentavos');
  }
  if (!Number.isSafeInteger(input.residualValueCentavos) || input.residualValueCentavos < 0) {
    return err('VALIDATION', 'Residual value must be zero or more.', 'residualValueCentavos');
  }
  if (input.residualValueCentavos >= input.costCentavos) {
    return err('VALIDATION', 'Residual value must be less than cost.', 'residualValueCentavos');
  }
  if (!Number.isSafeInteger(input.usefulLifeYears) || input.usefulLifeYears < 1 || input.usefulLifeYears > 50) {
    return err('VALIDATION', 'Useful life must be 1–50 years.', 'usefulLifeYears');
  }
  if (input.convention !== 'full_month' && input.convention !== 'daily_prorated') {
    return err('VALIDATION', 'Unknown depreciation convention.', 'convention');
  }
  const accounts = {
    asset: ctx.state.accounts.find(
      (account) => account.id === input.assetAccountId && account.workspaceId === ctx.workspaceId && account.active,
    ),
    expense: ctx.state.accounts.find(
      (account) =>
        account.id === input.depreciationExpenseAccountId && account.workspaceId === ctx.workspaceId && account.active,
    ),
    accumulated: ctx.state.accounts.find(
      (account) =>
        account.id === input.accumulatedDepreciationAccountId && account.workspaceId === ctx.workspaceId && account.active,
    ),
  };
  if (!accounts.asset) return err('VALIDATION', 'Asset cost account is not active in this workspace.', 'assetAccountId');
  if (!accounts.expense) {
    return err('VALIDATION', 'Depreciation expense account is not active in this workspace.', 'depreciationExpenseAccountId');
  }
  if (!accounts.accumulated) {
    return err(
      'VALIDATION',
      'Accumulated depreciation account is not active in this workspace.',
      'accumulatedDepreciationAccountId',
    );
  }
  if (input.supplierContactId) {
    const supplier = ctx.state.contacts.find(
      (contact) => contact.id === input.supplierContactId && contact.workspaceId === ctx.workspaceId,
    );
    if (!supplier) return err('VALIDATION', 'Supplier is not in this workspace.', 'supplierContactId');
  }
  const id = ctx.clock.newId('asset');
  const assetNo = allocateCode(draft, ctx.workspaceId, 'asset');
  if (!assetNo.ok) return assetNo;
  const asset: Asset = {
    id,
    workspaceId: ctx.workspaceId,
    assetNo: assetNo.value,
    companyVendorBrand: input.companyVendorBrand.trim(),
    purchaseDate: input.purchaseDate,
    description: input.description.trim(),
    supplierContactId: input.supplierContactId ?? null,
    serialNo: input.serialNo.trim(),
    assetAccountId: accounts.asset.id,
    costCentavos: input.costCentavos,
    usefulLifeYears: input.usefulLifeYears,
    residualValueCentavos: input.residualValueCentavos,
    depreciationStart: input.depreciationStart,
    convention: input.convention,
    depreciationExpenseAccountId: accounts.expense.id,
    accumulatedDepreciationAccountId: accounts.accumulated.id,
    status: 'active',
    sourceType: input.sourceType,
    sourceId: input.sourceId ?? null,
    createdAt: ctx.clock.nowIso,
    createdBy: ctx.actorId,
  };

  const journalIds: string[] = [];
  if (input.postAcquisition) {
    let creditAccountId: string;
    if (input.sourceType === 'direct_purchase' && input.supplierContactId) {
      const ap = requireAccountByRole(ctx.state, ctx.workspaceId, 'ap');
      if (!ap.ok) return ap;
      creditAccountId = ap.value.id;
    } else if (input.sourceType === 'stock_reclass') {
      const inventory = requireAccountByRole(ctx.state, ctx.workspaceId, 'inventory');
      if (!inventory.ok) return inventory;
      creditAccountId = inventory.value.id;
    } else {
      const equity = requireAccountByRole(ctx.state, ctx.workspaceId, 'opening_equity');
      if (!equity.ok) return equity;
      creditAccountId = equity.value.id;
    }
    const journal = postJournal(draft, ctx, {
      postingDate: input.purchaseDate,
      documentDate: input.purchaseDate,
      sourceType: 'asset_acquisition',
      sourceId: asset.id,
      effectKey: `asset-acquire:${asset.id}`,
      memo: `Acquire ${asset.assetNo} — ${asset.description}`,
      lines: [
        { accountId: asset.assetAccountId, debitCentavos: asset.costCentavos, creditCentavos: 0 },
        { accountId: creditAccountId, debitCentavos: 0, creditCentavos: asset.costCentavos },
      ],
    });
    if (!journal.ok) return journal;
    journalIds.push(journal.value.id);
  }
  pushItem(draft, 'assets', asset);
  recordAudit(draft, ctx, {
    action: 'asset.create',
    recordType: 'asset',
    recordId: asset.id,
    detail: { assetNo: asset.assetNo, costCentavos: asset.costCentavos, posted: input.postAcquisition },
  });
  return ok({
    summary: `Asset ${asset.assetNo} added${input.postAcquisition ? ' and acquisition posted' : ' without an acquisition journal'}.`,
    documentType: 'asset',
    documentId: asset.id,
    journalIds,
    warnings: input.postAcquisition ? [] : ['Acquisition was not posted; this asset is a schedule-only draft.'],
  });
}

function monthEnd(period: string): string {
  const [yearText, monthText] = period.split('-');
  const year = Number(yearText);
  const month = Number(monthText);
  return `${period}-${String(daysInMonth(year, month)).padStart(2, '0')}`;
}

function monthsBetween(start: string, end: string): number {
  const [sy, sm] = start.split('-').map(Number);
  const [ey, em] = end.split('-').map(Number);
  return (ey - sy) * 12 + (em - sm);
}

function depreciationForPeriod(
  asset: Asset,
  period: string,
  cumulativeBefore: number,
): number {
  const base = asset.costCentavos - asset.residualValueCentavos;
  const remaining = base - cumulativeBefore;
  if (remaining <= 0) return 0;
  const monthly = monthlyDepreciation(asset);
  const offset = monthsBetween(asset.depreciationStart.slice(0, 7), period);
  if (offset < 0) return 0;
  let amount = monthly;
  if (offset === 0 && asset.convention === 'daily_prorated') {
    const [yearText, monthText] = period.split('-').map(Number);
    const days = daysInMonth(yearText ?? 0, monthText ?? 1);
    const startDay = Number(asset.depreciationStart.slice(8, 10));
    const usedDays = days - startDay + 1;
    amount = mulDivRound(monthly, usedDays, days);
  }
  if (amount > remaining) amount = remaining;
  return amount;
}

function postedCumulative(
  state: WriteContext['state'],
  assetId: string,
  period: string,
  options: { includeCalculated: boolean },
): number {
  return state.depreciationPosts
    .filter(
      (post) =>
        post.assetId === assetId &&
        post.period < period &&
        (post.status === 'posted' || post.status === 'approved' || (options.includeCalculated && post.status === 'calculated')),
    )
    .reduce((total, post) => total + post.amountCentavos, 0);
}

export function calculateDepreciation(
  draft: StateDraft,
  ctx: WriteContext,
  input: { period: string },
): Result<CommandResult> {
  const product = requireProduct(ctx, 'accounting');
  if (!product.ok) return product;
  const role = requireRole(ctx, 'accountant', 'company_admin');
  if (!role.ok) return role;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.period)) {
    return err('VALIDATION', 'Period must be a real YYYY-MM month.', 'period');
  }
  const periodEnd = monthEnd(input.period);
  const assets = ctx.state.assets.filter(
    (asset) => asset.workspaceId === ctx.workspaceId && asset.depreciationStart <= periodEnd,
  );
  let created = 0;
  let skipped = 0;
  for (const asset of assets) {
    const existing = ctx.state.depreciationPosts.find(
      (post) => post.assetId === asset.id && post.period === input.period,
    );
    if (existing) {
      skipped += 1;
      continue;
    }
    const cumulativeBefore = postedCumulative(ctx.state, asset.id, input.period, { includeCalculated: true });
    const amount = depreciationForPeriod(asset, input.period, cumulativeBefore);
    if (amount <= 0) {
      skipped += 1;
      continue;
    }
    const post: DepreciationPost = {
      id: ctx.clock.newId('dep'),
      workspaceId: ctx.workspaceId,
      assetId: asset.id,
      period: input.period,
      amountCentavos: amount,
      cumulativeAfterCentavos: cumulativeBefore + amount,
      status: 'calculated',
      calculatedAt: ctx.clock.nowIso,
      calculatedBy: ctx.actorId,
      approvedBy: null,
      approvedAt: null,
      postedAt: null,
      journalId: null,
      effectKey: `depreciation:${asset.id}:${input.period}`,
    };
    pushItem(draft, 'depreciationPosts', post);
    created += 1;
  }
  recordAudit(draft, ctx, {
    action: 'depreciation.calculate',
    recordType: 'depreciation_period',
    recordId: input.period,
    detail: { created, skipped },
  });
  return ok({
    summary: `Depreciation calculated for ${created} asset(s) in ${input.period}; ${skipped} skipped.`,
    documentType: 'depreciation_period',
    documentId: input.period,
    journalIds: [],
    warnings: created === 0 ? ['No new depreciation rows were created for this period.'] : [],
  });
}

export function approveDepreciation(
  draft: StateDraft,
  ctx: WriteContext,
  input: { period: string },
): Result<CommandResult> {
  const role = requireRole(ctx, 'accountant', 'company_admin');
  if (!role.ok) return role;
  const posts = ctx.state.depreciationPosts.filter(
    (post) => post.workspaceId === ctx.workspaceId && post.period === input.period && post.status === 'calculated',
  );
  if (posts.length === 0) return err('CONFLICT', 'No calculated depreciation rows are waiting for approval.');
  for (const post of posts) {
    if (post.calculatedBy === ctx.actorId) {
      return err('FORBIDDEN', 'Depreciation maker and approver must be different users.');
    }
  }
  for (const post of posts) {
    updateItem(
      draft,
      'depreciationPosts',
      (candidate) => candidate.id === post.id,
      (candidate) => ({ ...candidate, status: 'approved', approvedBy: ctx.actorId, approvedAt: ctx.clock.nowIso }),
    );
  }
  recordAudit(draft, ctx, {
    action: 'depreciation.approve',
    recordType: 'depreciation_period',
    recordId: input.period,
    detail: { approved: posts.length },
  });
  return ok({
    summary: `Approved ${posts.length} depreciation row(s) for ${input.period}.`,
    documentType: 'depreciation_period',
    documentId: input.period,
    journalIds: [],
    warnings: [],
  });
}

export function postDepreciation(
  draft: StateDraft,
  ctx: WriteContext,
  input: { period: string },
): Result<CommandResult> {
  const product = requireProduct(ctx, 'accounting');
  if (!product.ok) return product;
  const role = requireRole(ctx, 'accountant', 'company_admin');
  if (!role.ok) return role;
  const posts = ctx.state.depreciationPosts.filter(
    (post) => post.workspaceId === ctx.workspaceId && post.period === input.period && post.status === 'approved',
  );
  if (posts.length === 0) return err('CONFLICT', 'No approved depreciation rows are waiting for posting.');
  const postingDate = monthEnd(input.period);
  const journalIds: string[] = [];
  for (const post of posts) {
    const asset = ctx.state.assets.find((candidate) => candidate.id === post.assetId);
    if (!asset) return err('INVALID_STATE', 'A depreciation row references a missing asset.');
    const journal = postJournal(draft, ctx, {
      postingDate,
      documentDate: postingDate,
      sourceType: 'depreciation',
      sourceId: post.id,
      effectKey: post.effectKey,
      memo: `Depreciation ${asset.assetNo} — ${input.period}`,
      lines: [
        { accountId: asset.depreciationExpenseAccountId, debitCentavos: post.amountCentavos, creditCentavos: 0 },
        { accountId: asset.accumulatedDepreciationAccountId, debitCentavos: 0, creditCentavos: post.amountCentavos },
      ],
      approvedBy: post.approvedBy,
    });
    if (!journal.ok) return journal;
    journalIds.push(journal.value.id);
    updateItem(
      draft,
      'depreciationPosts',
      (candidate) => candidate.id === post.id,
      (candidate) => ({
        ...candidate,
        status: 'posted',
        postedAt: ctx.clock.nowIso,
        journalId: journal.value.id,
      }),
    );
    if (post.cumulativeAfterCentavos >= asset.costCentavos - asset.residualValueCentavos) {
      updateItem(
        draft,
        'assets',
        (candidate) => candidate.id === asset.id,
        (candidate) => ({ ...candidate, status: 'fully_depreciated' }),
      );
    }
  }
  recordAudit(draft, ctx, {
    action: 'depreciation.post',
    recordType: 'depreciation_period',
    recordId: input.period,
    detail: { posted: posts.length, journalIds: journalIds.length },
  });
  return ok({
    summary: `Posted ${posts.length} depreciation row(s) for ${input.period}.`,
    documentType: 'depreciation_period',
    documentId: input.period,
    journalIds,
    warnings: [],
  });
}

export function assetsForWorkspace(state: WriteContext['state'], workspaceId: string): Asset[] {
  return state.assets.filter((asset) => asset.workspaceId === workspaceId);
}

export function depreciationForAsset(state: WriteContext['state'], assetId: string): DepreciationPost[] {
  return state.depreciationPosts
    .filter((post) => post.assetId === assetId)
    .sort((left, right) => left.period.localeCompare(right.period));
}

export function assetNetBookValue(asset: Asset, state: WriteContext['state']): number {
  const accumulated = state.depreciationPosts
    .filter((post) => post.assetId === asset.id && post.status === 'posted')
    .reduce((total, post) => total + post.amountCentavos, 0);
  return asset.costCentavos - accumulated;
}

export function depreciationTotals(posts: DepreciationPost[]): number {
  return sumCentavos(posts.map((post) => post.amountCentavos));
}
