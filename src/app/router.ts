/**
 * Small typed hash router. No routing dependency. Paths are validated against
 * one registry so an unknown or malformed route is an explicit Page not found,
 * never a silent Billing fallback.
 */

export type AppSlug =
  | 'cash'
  | 'billing'
  | 'purchases'
  | 'assets'
  | 'admin'
  | 'reports'
  | 'payroll'
  | 'inventory'
  | 'other';

export type ProductCode = 'accounting' | 'payroll' | 'inventory';

export interface PageDefinition {
  id: string;
  label: string;
}

export interface AppDefinition {
  id: AppSlug;
  label: string;
  short: string;
  purpose: string;
  product: ProductCode | null;
  pages: readonly PageDefinition[];
  defaultPage: string;
}

export const APPS: readonly AppDefinition[] = [
  {
    id: 'cash',
    label: 'Cash Management',
    short: 'Cash',
    purpose: 'Bank statements, matching and reconciliation',
    product: 'accounting',
    defaultPage: 'statements',
    pages: [
      { id: 'statements', label: 'Bank statements' },
      { id: 'matching', label: 'Matching' },
      { id: 'history', label: 'History' },
    ],
  },
  {
    id: 'billing',
    label: 'Billing and Collection',
    short: 'Billing',
    purpose: 'Invoices, receipts, credits and receivables',
    product: 'accounting',
    defaultPage: 'invoices',
    pages: [
      { id: 'invoices', label: 'Invoices' },
      { id: 'receipts', label: 'Receipts' },
      { id: 'credits', label: 'Credits' },
      { id: 'aging', label: 'Aging' },
    ],
  },
  {
    id: 'purchases',
    label: 'Purchases and Disbursement',
    short: 'Purchases',
    purpose: 'Bills, approvals, payments and advances',
    product: 'accounting',
    defaultPage: 'bills',
    pages: [
      { id: 'bills', label: 'Bills' },
      { id: 'orders', label: 'Orders and receipts' },
      { id: 'approvals', label: 'Approvals' },
      { id: 'payments', label: 'Payments' },
      { id: 'advances', label: 'Advances' },
    ],
  },
  {
    id: 'assets',
    label: 'Fixed Assets',
    short: 'Assets',
    purpose: 'Asset register and reviewed depreciation',
    product: 'accounting',
    defaultPage: 'register',
    pages: [
      { id: 'register', label: 'Asset register' },
      { id: 'depreciation', label: 'Depreciation' },
    ],
  },
  {
    id: 'admin',
    label: 'Admin',
    short: 'Admin',
    purpose: 'Company settings, access, numbering and recovery',
    product: null,
    defaultPage: 'company',
    pages: [
      { id: 'company', label: 'Company' },
      { id: 'access', label: 'Access' },
      { id: 'entitlements', label: 'Entitlements' },
      { id: 'masters', label: 'Contacts and accounts' },
      { id: 'numbering', label: 'Numbering' },
      { id: 'archive', label: 'Archive and recovery' },
    ],
  },
  {
    id: 'reports',
    label: 'Reports',
    short: 'Reports',
    purpose: 'Trial balance, expenses and sales',
    product: 'accounting',
    defaultPage: 'trial-balance',
    pages: [
      { id: 'trial-balance', label: 'Trial balance' },
      { id: 'expenses', label: 'Expenses' },
      { id: 'sales', label: 'Sales' },
    ],
  },
  {
    id: 'payroll',
    label: 'Payroll',
    short: 'Payroll',
    purpose: 'Employees, approved time, payroll and worksheets',
    product: 'payroll',
    defaultPage: 'runs',
    pages: [
      { id: 'runs', label: 'Payroll runs' },
      { id: 'employees', label: 'Employees' },
      { id: 'time', label: 'Time import' },
      { id: 'policy', label: 'Policy' },
      { id: 'worksheets', label: 'Worksheets' },
    ],
  },
  {
    id: 'inventory',
    label: 'Inventory',
    short: 'Inventory',
    purpose: 'Items, stock movements, locations and valuation',
    product: 'inventory',
    defaultPage: 'items',
    pages: [
      { id: 'items', label: 'Items' },
      { id: 'movements', label: 'Movements' },
      { id: 'locations', label: 'Locations' },
      { id: 'valuation', label: 'Valuation' },
    ],
  },
  {
    id: 'other',
    label: 'Other',
    short: 'Other',
    purpose: 'General journals, periods, tax registers and audit',
    product: 'accounting',
    defaultPage: 'journals',
    pages: [
      { id: 'journals', label: 'Journals' },
      { id: 'drafts', label: 'Journal drafts' },
      { id: 'periods', label: 'Periods' },
      { id: 'tax', label: 'Tax register' },
      { id: 'certificates', label: '2307 certificates' },
      { id: 'audit', label: 'Audit trail' },
    ],
  },
] as const;

const APP_BY_ID = new Map<string, AppDefinition>(APPS.map((app) => [app.id, app]));

export function appDefinition(slug: string): AppDefinition | undefined {
  return APP_BY_ID.get(slug);
}

export function isAppSlug(value: string): value is AppSlug {
  return APP_BY_ID.has(value);
}

export function pageDefinition(app: AppDefinition, page: string): PageDefinition | undefined {
  return app.pages.find((candidate) => candidate.id === page);
}

export interface HomeRoute {
  kind: 'home';
}

export interface AppRoute {
  kind: 'app';
  app: AppSlug;
  page: string;
  recordId?: string;
  action?: string;
  query: Readonly<Record<string, string>>;
}

export interface NotFoundRoute {
  kind: 'notFound';
  path: string;
}

export type Route = HomeRoute | AppRoute | NotFoundRoute;

export function homeRoute(): HomeRoute {
  return { kind: 'home' };
}

export function appRoute(
  app: AppSlug,
  page?: string,
  options?: { recordId?: string; action?: string; query?: Record<string, string> },
): AppRoute {
  const definition = APP_BY_ID.get(app);
  const resolvedPage =
    page && definition?.pages.some((candidate) => candidate.id === page)
      ? page
      : definition?.defaultPage ?? page ?? '';
  return {
    kind: 'app',
    app,
    page: resolvedPage,
    ...(options?.recordId ? { recordId: options.recordId } : {}),
    ...(options?.action ? { action: options.action } : {}),
    query: { ...(options?.query ?? {}) },
  };
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function parseQuery(raw: string): Record<string, string> {
  const query: Record<string, string> = {};
  if (!raw) return query;
  for (const pair of raw.split('&')) {
    if (!pair) continue;
    const [rawKey, rawValue = ''] = pair.split('=');
    const key = decodeSegment(rawKey);
    if (!key) continue;
    query[key] = decodeSegment(rawValue);
  }
  return query;
}

/**
 * Parse `window.location.hash`. `#`, `#/`, `#/home` and an empty hash are Main.
 * A legacy module hash such as `#/billing` resolves to that module's default page.
 */
export function parseRoute(hash: string): Route {
  const withoutHash = hash.replace(/^#/, '');
  const [rawPath, rawQuery = ''] = withoutHash.split('?');
  const trimmed = rawPath.replace(/^\/+|\/+$/g, '');
  if (trimmed.length === 0) return { kind: 'home' };
  const segments = trimmed.split('/').map(decodeSegment);
  const [appSlug, rawPage, third, fourth] = segments;
  if (appSlug === 'home' && segments.length === 1) return { kind: 'home' };
  const app = appSlug ? APP_BY_ID.get(appSlug) : undefined;
  if (!app) return { kind: 'notFound', path: withoutHash };
  if (segments.length > 4) return { kind: 'notFound', path: withoutHash };
  const page = rawPage ?? app.defaultPage;
  if (!pageDefinition(app, page)) return { kind: 'notFound', path: withoutHash };

  let recordId: string | undefined;
  let action: string | undefined;
  if (third) {
    if (third === 'new') action = 'new';
    else recordId = third;
  }
  if (fourth) {
    if (action) return { kind: 'notFound', path: withoutHash };
    action = fourth;
  }
  return {
    kind: 'app',
    app: app.id,
    page,
    ...(recordId ? { recordId } : {}),
    ...(action ? { action } : {}),
    query: parseQuery(rawQuery),
  };
}

function queryString(query: Readonly<Record<string, string>>): string {
  const entries = Object.entries(query).filter(([, value]) => value !== '');
  if (entries.length === 0) return '';
  return `?${entries
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&')}`;
}

export function routeHref(route: Route): string {
  if (route.kind === 'home') return '#/home';
  if (route.kind === 'notFound') return `#/${route.path.replace(/^\/+/, '')}`;
  const parts = [route.app, route.page];
  if (route.recordId) parts.push(encodeURIComponent(route.recordId));
  else if (route.action) parts.push(route.action);
  if (route.recordId && route.action) parts.push(route.action);
  return `#/${parts.join('/')}${queryString(route.query)}`;
}

export function legacyModuleHref(app: AppSlug): string {
  const definition = APP_BY_ID.get(app);
  return `#/${app}/${definition?.defaultPage ?? ''}`;
}

/** Page title used for `document.title`; the module H1 stays the app name. */
export function routeTitle(route: Route, companyName: string): string {
  if (route.kind === 'home') return `Main · ${companyName} · ECE Accounting`;
  if (route.kind === 'notFound') return `Page not found · ${companyName} · ECE Accounting`;
  const app = APP_BY_ID.get(route.app);
  const page = app ? pageDefinition(app, route.page) : undefined;
  const task = page?.label ?? route.page;
  const record = route.action === 'new' ? 'New record' : route.recordId ? 'Record' : '';
  return [app?.label ?? route.app, task, record, companyName, 'ECE Accounting']
    .filter(Boolean)
    .join(' · ');
}
