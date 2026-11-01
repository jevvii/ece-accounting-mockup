import { useEffect, useMemo, useRef, useState } from 'react';
import { accessibleWorkspaces } from '../domain/shared/access';
import type { AppState } from '../domain/schema';
import { STORAGE_KEY } from '../adapters/storage';
import { USERS } from '../fixtures/seed';
import { AppProvider, useApp } from './useApp';
import { APPS, appDefinition } from './router';
import {
  NavigationProvider,
  UnsavedChangesProvider,
  useNavigation,
  useRouteFocus,
} from './navigation';
import { ConfirmDialog, Modal, StatusBadge, ToastStack } from './components';
import { humanDate, titleCase } from './format';
import { HomeScreen, appAvailability } from './screens/HomeScreen';
import { BillingScreen } from './screens/BillingScreen';
import { CashScreen } from './screens/CashScreen';
import { PurchasesScreen } from './screens/PurchasesScreen';
import { AssetsScreen } from './screens/AssetsScreen';
import { AdminScreen } from './screens/AdminScreen';
import { ReportsScreen } from './screens/ReportsScreen';
import { PayrollScreen } from './screens/PayrollScreen';
import { InventoryScreen } from './screens/InventoryScreen';
import { OtherScreen } from './screens/OtherScreen';

type Workspace = AppState['workspaces'][number];
type DemoUser = AppState['users'][number];

function downloadRaw(raw: string): void {
  const blob = new Blob([raw], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'ece-accounting-raw-corrupt-snapshot.json';
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function RecoveryScreen({
  corrupt,
  reset,
}: {
  corrupt: { reason: string; message: string; raw: string };
  reset: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  return (
    <main className="recovery">
      <div className="recovery-card">
        <h1>The saved demo data could not be opened</h1>
        <p>
          Reason: <strong>{titleCase(corrupt.reason)}</strong>. {corrupt.message}
        </p>
        <p>
          Nothing has been replaced. Download the raw snapshot for inspection before choosing
          reset. Resetting replaces this browser-local synthetic state with the demo fixture; it
          is not a recovery of production data.
        </p>
        <pre className="raw-preview" aria-label="Raw stored snapshot preview">
          {corrupt.raw.slice(0, 1200)}
          {corrupt.raw.length > 1200 ? '\n…' : ''}
        </pre>
        <div className="button-row">
          <button type="button" className="primary" onClick={() => downloadRaw(corrupt.raw)}>
            Download raw snapshot
          </button>
          <button type="button" className="danger" onClick={() => setConfirming(true)}>
            Reset synthetic demo
          </button>
        </div>
        <p className="muted">Local demo · Synthetic data. Nothing here is production recovery.</p>
      </div>
      <ConfirmDialog
        open={confirming}
        title="Reset the browser-local demo?"
        confirmLabel="Reset demo data"
        danger
        disabled={!acknowledged}
        onClose={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          reset();
        }}
      >
        <p>
          This removes the invalid snapshot under <code>{STORAGE_KEY}</code> and writes the
          synthetic seed again. Downloaded raw data is not affected.
        </p>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(event) => setAcknowledged(event.target.checked)}
          />
          I downloaded or inspected the raw snapshot and understand this reset discards it.
        </label>
      </ConfirmDialog>
    </main>
  );
}

function ModuleScreen() {
  const { route } = useNavigation();
  if (route.kind !== 'app') return null;
  switch (route.app) {
    case 'billing':
      return <BillingScreen />;
    case 'cash':
      return <CashScreen />;
    case 'purchases':
      return <PurchasesScreen />;
    case 'assets':
      return <AssetsScreen />;
    case 'admin':
      return <AdminScreen />;
    case 'reports':
      return <ReportsScreen />;
    case 'payroll':
      return <PayrollScreen />;
    case 'inventory':
      return <InventoryScreen />;
    case 'other':
      return <OtherScreen />;
    default:
      return (
        <p role="alert">
          This app is not available in this build. Return to <a href="#/home">Main</a>.
        </p>
      );
  }
}

function NotFoundScreen({ path }: { path: string }) {
  return (
    <div className="state-page">
      <p>
        <code>#{path}</code> is not a page in this mockup. The URL was not redirected, so you can
        correct it or go back.
      </p>
      <p>
        <a href="#/home">Return to Main</a>
      </p>
    </div>
  );
}

function UnavailableScreen({
  status,
  detail,
}: {
  status: string;
  detail: string;
}) {
  return (
    <div className="state-page">
      <div className="callout callout-warn" role="status">
        <strong>{status} for this company.</strong> {detail}
      </div>
      <p>
        <a href="#/home">Return to Main</a>
      </p>
    </div>
  );
}

function Shell({
  workspace,
  workspaces,
  actor,
}: {
  workspace: Workspace;
  workspaces: Workspace[];
  actor: DemoUser | undefined;
}) {
  const api = useApp();
  const { route, appHref, guard } = useNavigation();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [resetting, setResetting] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);

  useRouteFocus(route, headingRef);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const editable =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target?.isContentEditable;
      if (event.key === '?' && !editable && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        setShowShortcuts((current) => !current);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const app = route.kind === 'app' ? appDefinition(route.app) : undefined;
  const availability = app ? appAvailability(app, api.access, api.productStatus) : null;
  const activePage = route.kind === 'app' ? route.page : null;
  const access = api.access;

  return (
    <div className="app">
      <a
        className="skip-link"
        href="#main-content"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById('main-content')?.focus();
        }}
      >
        Skip to main content
      </a>
      <header className="app-header">
        <a className="brand" href="#/home" aria-label="ECE Accounting — Main">
          <span className="brand-mark" aria-hidden="true">
            ECE
          </span>
          <span className="brand-name">ECE Accounting</span>
        </a>
        <p className="header-company" title={workspace.legalName}>
          {workspace.legalName}
        </p>
        {app && <p className="header-app">{app.label}</p>}
        <div className="header-actions">
          <details
            className="apps-menu"
            onToggle={(event) => {
              if (event.currentTarget.open) {
                const demo = event.currentTarget.parentElement?.querySelector<HTMLDetailsElement>('.demo-controls');
                if (demo) demo.open = false;
              }
            }}
          >
            <summary>All apps</summary>
            <nav aria-label="All apps">
              <ul>
                {APPS.map((candidate) => (
                  <li key={candidate.id}>
                    <a
                      href={appHref(candidate.id)}
                      aria-current={route.kind === 'app' && route.app === candidate.id ? 'page' : undefined}
                      onClick={(event) => {
                        event.currentTarget.closest('details')?.removeAttribute('open');
                      }}
                    >
                      {candidate.label}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          </details>
          <details
            className="demo-controls"
            onToggle={(event) => {
              if (event.currentTarget.open) {
                const apps = event.currentTarget.parentElement?.querySelector<HTMLDetailsElement>('.apps-menu');
                if (apps) apps.open = false;
              }
            }}
          >
            <summary>Demo controls</summary>
            <div className="demo-panel">
              <label>
                <span>Company</span>
                <select
                  aria-label="Active demo company"
                  value={api.workspaceId}
                  onChange={(event) => {
                    const next = event.target.value;
                    guard(() => api.setWorkspaceId(next));
                  }}
                >
                  {workspaces.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Demo actor</span>
                <select
                  aria-label="Demo actor"
                  value={api.actorId}
                  onChange={(event) => {
                    const next = event.target.value;
                    guard(() => api.setActorId(next));
                  }}
                >
                  {USERS.map((user) => (
                    <option key={user.id} value={user.id}>
                      {user.name}
                    </option>
                  ))}
                </select>
              </label>
              <p className="demo-meta">
                Demo date {humanDate(api.clock.today)} · {actor?.title ?? 'Unknown actor'}
              </p>
              <p className="demo-meta">
                Roles: {access ? access.membership.roles.map(titleCase).join(', ') : 'No membership'}
              </p>
              {access && (
                <p className="demo-meta">
                  Payroll detail: {access.membership.payrollDetail ? 'granted' : 'not granted'} ·
                  Archive grant: {access.membership.archiveGrant ? 'granted' : 'not granted'}
                </p>
              )}
              <p className="demo-meta">
                Fixture version: <strong>{api.state.demoFixtureVersion ?? 'ece-accounting-demo-v1'}</strong>
              </p>
              <p className="demo-meta">
                Save: <StatusBadge status={api.saveStatus} />
              </p>
              <div className="button-row">
                <button type="button" className="link-button" onClick={() => setShowShortcuts(true)}>
                  Keyboard help
                </button>
                <button type="button" className="link-button" onClick={() => setResetting(true)}>
                  Refresh demo data
                </button>
              </div>
            </div>
          </details>
        </div>
        <p className="demo-stamp">Local demo · Synthetic data</p>
      </header>

      {api.externalChange && (
        <div className="callout callout-error external-banner" role="alert">
          <strong>Another browser tab changed the saved snapshot.</strong> This tab has stopped
          writing to avoid overwriting that work. Reload to continue from the saved version.
          <button type="button" className="primary" onClick={api.reloadPage}>
            Reload saved state
          </button>
        </div>
      )}
      {api.saveStatus === 'failed' && (
        <div className="callout callout-error" role="alert">
          <strong>The last change was not saved.</strong> The browser rejected the local write.
          Copy anything you need before reloading.
        </div>
      )}
      {!api.storagePersistent && (
        <div className="callout callout-warn" role="status">
          Browser storage is unavailable. Changes stay in memory for this tab only and disappear
          on reload. This is a session-only synthetic demo.
        </div>
      )}

      <main id="main-content" className="app-main" tabIndex={-1}>
        <ToastStack />
        {route.kind === 'home' && (
          <>
            <div className="page-head">
              <h1 ref={headingRef}>Main</h1>
            </div>
            <HomeScreen />
          </>
        )}

        {route.kind === 'notFound' && (
          <>
            <div className="page-head">
              <h1 ref={headingRef}>Page not found</h1>
            </div>
            <NotFoundScreen path={route.path} />
          </>
        )}

        {route.kind === 'app' && app && (
          <>
            <nav className="breadcrumbs" aria-label="Breadcrumb">
              <ol>
                <li>
                  <a href="#/home">Main</a>
                </li>
                <li>
                  <a
                    href={appHref(app.id, route.page)}
                    aria-current={route.recordId ? undefined : 'page'}
                  >
                    {app.label}
                  </a>
                </li>
                {route.recordId && <li aria-current="page">Record</li>}
                {route.action === 'new' && <li aria-current="page">New record</li>}
              </ol>
            </nav>
            <div className="page-head module-head">
              <h1 ref={headingRef}>{app.label}</h1>
              <p className="page-purpose">{app.purpose}</p>
            </div>
            <nav className="page-nav" aria-label={`${app.label} pages`}>
              {app.pages.map((page) => (
                <a
                  key={page.id}
                  href={appHref(app.id, page.id)}
                  aria-current={activePage === page.id ? 'page' : undefined}
                >
                  {page.label}
                </a>
              ))}
            </nav>

            {availability && !availability.canOpen ? (
              <UnavailableScreen status={availability.status} detail={availability.detail} />
            ) : (
              <ModuleScreen key={api.workspaceId} />
            )}
          </>
        )}
      </main>

      <ConfirmDialog
        open={resetting}
        title="Refresh the browser-local demo data?"
        confirmLabel="Refresh demo data"
        danger
        onClose={() => setResetting(false)}
        onConfirm={() => {
          setResetting(false);
          api.refreshDemo();
        }}
      >
        <p>
          This replaces only the app-owned synthetic snapshot (<code>{STORAGE_KEY}</code>) for the demo
          companies (<em>Northwind Advisory Inc.</em> and <em>Horizon Manufacturing Corp.</em>) with
          the validated <code>{api.state.demoFixtureVersion ?? 'ece-accounting-demo-v1'}</code> dataset.
        </p>
        <p>
          Unrelated browser storage keys, service credentials, and downloaded archives are not affected.
        </p>
      </ConfirmDialog>
      <Modal open={showShortcuts} title="Keyboard and demo notes" onClose={() => setShowShortcuts(false)}>
        <ul className="plain-list">
          <li>
            <kbd>Tab</kbd> moves through labelled controls; dialogs use the browser&apos;s native
            focus trap and <kbd>Esc</kbd> closes them.
          </li>
          <li>
            <kbd>?</kbd> on the page background opens this help.
          </li>
          <li>Every app, worklist and record is a hash link; copying the URL keeps that location.</li>
          <li>
            Numeric inputs accept decimal pesos, quantities, or minutes. Money is calculated in
            pesos and centavos.
          </li>
          <li>A failed command leaves the committed snapshot unchanged and shows a typed error code.</li>
          <li>Role, payroll-detail, and archive checks are simulation only, not production security.</li>
        </ul>
        <p>
          Save status: <StatusBadge status={api.saveStatus} />. Demo data is plaintext in this
          browser&apos;s local storage.
        </p>
      </Modal>
    </div>
  );
}

function NoCompanyScreen({ reset }: { reset: () => void }) {
  const [resetting, setResetting] = useState(false);
  return (
    <main className="recovery">
      <div className="recovery-card">
        <h1>No demo company is available</h1>
        <p>
          The selected demo actor does not hold an active membership in any company. Choose a
          different demo actor in a fresh session or reset the synthetic demo.
        </p>
        <button type="button" className="primary" onClick={() => setResetting(true)}>
          Reset synthetic demo
        </button>
        <ConfirmDialog
          open={resetting}
          title="Reset the browser-local demo?"
          confirmLabel="Reset demo data"
          danger
          onClose={() => setResetting(false)}
          onConfirm={() => {
            setResetting(false);
            reset();
          }}
        >
          <p>This writes the synthetic seed over the browser-local snapshot.</p>
        </ConfirmDialog>
      </div>
    </main>
  );
}

function AppFrame() {
  const api = useApp();
  const { state, actorId } = api;
  const workspaces = useMemo(() => accessibleWorkspaces(state, actorId), [state, actorId]);
  const workspace = state.workspaces.find((candidate) => candidate.id === api.workspaceId);
  const actor = state.users.find((candidate) => candidate.id === actorId);

  if (!workspace) {
    return <NoCompanyScreen reset={api.resetDemo} />;
  }

  return (
    <UnsavedChangesProvider>
      <NavigationProvider companyName={workspace.name}>
        {() => <Shell workspace={workspace} workspaces={workspaces} actor={actor} />}
      </NavigationProvider>
    </UnsavedChangesProvider>
  );
}

export function App() {
  return (
    <AppProvider>
      {({ corrupt, reset }) =>
        corrupt ? <RecoveryScreen corrupt={corrupt} reset={reset} /> : <AppFrame />
      }
    </AppProvider>
  );
}
