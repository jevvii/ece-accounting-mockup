import { describe, expect, it } from 'vitest';
import {
  APPS,
  appDefinition,
  appRoute,
  parseRoute,
  routeHref,
  routeTitle,
  type AppRoute,
} from '../../src/app/router';

describe('typed route registry', () => {
  it('treats the empty hash, slash and home as Main', () => {
    expect(parseRoute('')).toEqual({ kind: 'home' });
    expect(parseRoute('#')).toEqual({ kind: 'home' });
    expect(parseRoute('#/')).toEqual({ kind: 'home' });
    expect(parseRoute('#/home')).toEqual({ kind: 'home' });
  });

  it('resolves every app landing route to its documented default page', () => {
    for (const app of APPS) {
      const route = parseRoute(`#/${app.id}`);
      expect(route.kind).toBe('app');
      if (route.kind === 'app') {
        expect(route.app).toBe(app.id);
        expect(route.page).toBe(app.defaultPage);
      }
    }
  });

  it('parses nested task pages, immutable record IDs and query filters', () => {
    expect(parseRoute('#/billing/invoices')).toMatchObject({
      kind: 'app',
      app: 'billing',
      page: 'invoices',
    });
    expect(parseRoute('#/billing/invoices/new')).toMatchObject({
      kind: 'app',
      action: 'new',
    });
    expect(parseRoute('#/billing/invoices/INV-0001')).toMatchObject({
      kind: 'app',
      recordId: 'INV-0001',
    });
    expect(parseRoute('#/billing/invoices/inv%2F2026%2001')).toMatchObject({
      recordId: 'inv/2026 01',
    });
    expect(parseRoute('#/purchases/approvals?status=pending&owner=juan%20dela')).toMatchObject({
      query: { status: 'pending', owner: 'juan dela' },
    });
  });

  it('keeps unknown apps, unknown pages and malformed paths explicit', () => {
    expect(parseRoute('#/nope')).toEqual({ kind: 'notFound', path: '/nope' });
    expect(parseRoute('#/billing/nope')).toEqual({ kind: 'notFound', path: '/billing/nope' });
    expect(parseRoute('#/billing/invoices/id/extra/segment')).toEqual({
      kind: 'notFound',
      path: '/billing/invoices/id/extra/segment',
    });
    expect(parseRoute('#/billing/invoices/new/extra')).toEqual({
      kind: 'notFound',
      path: '/billing/invoices/new/extra',
    });
  });

  it('round-trips routes through hrefs', () => {
    const routes: AppRoute[] = [
      appRoute('billing', 'invoices'),
      appRoute('billing', 'invoices', { action: 'new' }),
      appRoute('billing', 'invoices', { recordId: 'inv/2026 01' }),
      appRoute('purchases', 'approvals', { query: { status: 'pending' } }),
      appRoute('other', 'journals', { recordId: 'jv-1', query: { tab: 'lines' } }),
    ];

    for (const route of routes) {
      expect(parseRoute(routeHref(route))).toMatchObject({
        kind: 'app',
        app: route.app,
        page: route.page,
        ...(route.recordId ? { recordId: route.recordId } : {}),
        ...(route.action ? { action: route.action } : {}),
      });
    }
  });

  it('builds document titles from the active app and page', () => {
    expect(routeTitle(parseRoute('#/home'), 'Northwind')).toBe('Main · Northwind · ECE Accounting');
    expect(routeTitle(parseRoute('#/billing/invoices'), 'Northwind')).toBe(
      'Billing and Collection · Invoices · Northwind · ECE Accounting',
    );
    expect(routeTitle(parseRoute('#/nope'), 'Northwind')).toBe(
      'Page not found · Northwind · ECE Accounting',
    );
  });

  it('does not let an unknown page definition silently fall through', () => {
    expect(appDefinition('billing')?.pages.map((page) => page.id)).toContain('invoices');
    expect(appDefinition('billing')?.pages.map((page) => page.id)).not.toContain('ledger');
  });
});
