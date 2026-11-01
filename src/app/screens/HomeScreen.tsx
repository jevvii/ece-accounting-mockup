import { useApp } from '../useApp';
import { useNavigation } from '../navigation';
import { APPS, appRoute, routeHref, type AppDefinition, type AppSlug } from '../router';
import { hasAnyRole } from '../permissions';
import type { AccessContext } from '../../domain/shared/access';

export type Availability = 'Available' | 'Read only' | 'Not licensed' | 'Restricted';

export interface AppAvailability {
  status: Availability;
  detail: string;
  canOpen: boolean;
}

const APP_ROLES: Record<AppSlug, Parameters<typeof hasAnyRole>[1][]> = {
  cash: ['company_admin', 'accountant', 'ap_ar_clerk'],
  billing: ['company_admin', 'accountant', 'ap_ar_clerk'],
  purchases: ['company_admin', 'accountant', 'ap_ar_clerk'],
  assets: ['company_admin', 'accountant'],
  admin: ['company_admin'],
  reports: ['company_admin', 'accountant'],
  payroll: ['company_admin', 'payroll_officer'],
  inventory: ['company_admin', 'inventory_officer', 'accountant'],
  other: ['company_admin', 'accountant'],
};

export function appAvailability(
  app: AppDefinition,
  access: AccessContext | null,
  productStatus: (product: 'accounting' | 'payroll' | 'inventory') => 'active' | 'expired' | 'inactive',
): AppAvailability {
  if (!access) {
    return { status: 'Restricted', detail: 'No active company membership for this demo actor.', canOpen: false };
  }
  if (app.product) {
    const status = productStatus(app.product);
    if (status === 'inactive') {
      return {
        status: 'Not licensed',
        detail: `${app.product} is not licensed for this company.`,
        canOpen: false,
      };
    }
    if (status === 'expired') {
      return {
        status: 'Read only',
        detail: `${app.product} has expired; existing records stay readable and writes are blocked.`,
        canOpen: true,
      };
    }
  }
  const roles = APP_ROLES[app.id];
  if (!hasAnyRole(access, ...roles)) {
    return {
      status: 'Restricted',
      detail: app.id === 'admin' ? 'Company administration needs the company-admin role.' : 'Your demo role does not include this app.',
      canOpen: app.id === 'admin',
    };
  }
  return { status: 'Available', detail: '', canOpen: true };
}

function AppSymbol({ app }: { app: AppSlug }) {
  const paths: Record<AppSlug, string> = {
    cash: 'M3 6h18M3 12h18M3 18h18M6 3v18M18 3v18',
    billing: 'M6 3h12v18l-3-2-3 2-3-2-3 2V3Zm3 5h6M9 12h6',
    purchases: 'M3 7h18M6 7l1 13h10l1-13M9 7V4h6v3',
    assets: 'M4 20V8l8-5 8 5v12M9 20v-6h6v6',
    admin: 'M12 3v3m0 12v3M3 12h3m12 0h3M6.3 6.3l2.1 2.1m7.2 7.2 2.1 2.1M17.7 6.3l-2.1 2.1M8.4 15.6l-2.1 2.1M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z',
    reports: 'M4 20V4m0 16h16M8 16v-5m4 5V8m4 8v-3',
    payroll: 'M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm8 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM2 20c0-3 2.5-5 6-5s6 2 6 5m2-5c3 0 6 1.6 6 5',
    inventory: 'M3 7l9-4 9 4v10l-9 4-9-4V7Zm0 0 9 4 9-4M12 11v10',
    other: 'M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3V4Zm3 5h8M8 13h8M8 17h5',
  };
  return (
    <svg className="app-symbol" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d={paths[app]} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function HomeScreen() {
  const api = useApp();
  const { hrefFor } = useNavigation();
  const availability = new Map(
    APPS.map((app) => [app.id, appAvailability(app, api.access, api.productStatus)] as const),
  );

  return (
    <div className="home">
      <p className="home-intro">
        Choose a work area. Each app opens with its own task pages, worklists and records.
      </p>
      <section aria-labelledby="apps-heading">
        <h2 id="apps-heading" className="home-section-title">
          Apps
        </h2>
        <ul className="app-grid">
          {APPS.map((app) => {
            const state = availability.get(app.id)!;
            return (
              <li key={app.id}>
                <a
                  className={`app-tile app-${state.status.toLowerCase().replace(/\s+/g, '-')}`}
                  href={hrefFor(appRoute(app.id))}
                  aria-label={`${app.label}. ${app.purpose}. ${state.status}.`}
                >
                  <AppSymbol app={app.id} />
                  <span className="app-tile-body">
                    <span className="app-name">{app.label}</span>
                    <span className="app-purpose">{app.purpose}</span>
                    <span className={`availability availability-${state.status.toLowerCase().replace(/\s+/g, '-')}`}>
                      {state.status}
                    </span>
                    {state.detail && <span className="app-detail">{state.detail}</span>}
                  </span>
                </a>
              </li>
            );
          })}
        </ul>
      </section>
      <p className="home-note">
        Availability comes from this company&apos;s product entitlements and the selected demo actor&apos;s
        roles. Opening a card does not grant access; the domain still checks every action.
      </p>
      <p className="muted">
        Use <strong>Demo controls</strong> above to change the actor, company or demo date.
      </p>
    </div>
  );
}

export function appHomeHref(): string {
  return routeHref({ kind: 'home' });
}
