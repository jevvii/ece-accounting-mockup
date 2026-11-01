import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ConfirmDialog } from './components';
import {
  appRoute,
  parseRoute,
  routeHref,
  routeTitle,
  type AppSlug,
  type AppRoute,
  type Route,
} from './router';

export interface NavigationApi {
  route: Route;
  hrefFor: (route: Route) => string;
  navigate: (target: Route | string, options?: { replace?: boolean }) => void;
  appHref: (app: AppSlug, page?: string) => string;
  /** Run an action immediately, or after the user confirms discarding a draft. */
  guard: (action: () => void) => void;
}

interface UnsavedApi {
  isDirty: boolean;
  register: (key: string, dirty: boolean) => void;
  clear: () => void;
}

const UnsavedContext = createContext<UnsavedApi | null>(null);

export function UnsavedChangesProvider({ children }: { children: ReactNode }) {
  const [dirtyKeys, setDirtyKeys] = useState<ReadonlySet<string>>(() => new Set());
  const register = useCallback((key: string, dirty: boolean) => {
    setDirtyKeys((current) => {
      const has = current.has(key);
      if (has === dirty) return current;
      const next = new Set(current);
      if (dirty) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);
  const clear = useCallback(() => setDirtyKeys(new Set()), []);
  const isDirty = dirtyKeys.size > 0;
  useEffect(() => {
    if (!isDirty) return undefined;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [isDirty]);
  const value = useMemo(() => ({ isDirty, register, clear }), [isDirty, register, clear]);
  return <UnsavedContext.Provider value={value}>{children}</UnsavedContext.Provider>;
}

export function useUnsavedChanges(key: string, dirty: boolean): void {
  const value = useContext(UnsavedContext);
  useEffect(() => {
    if (!value) return undefined;
    value.register(key, dirty);
    return () => value.register(key, false);
  }, [value, key, dirty]);
}

const NavigationContext = createContext<NavigationApi | null>(null);

export function useNavigation(): NavigationApi {
  const value = useContext(NavigationContext);
  if (!value) throw new Error('useNavigation must be used inside NavigationProvider');
  return value;
}

/** Route-aware helpers used by the shared shell and every module screen. */
export function useAppRoute(): AppRoute | null {
  const { route } = useNavigation();
  return route.kind === 'app' ? route : null;
}

function currentHref(): string {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

export function NavigationProvider({
  companyName,
  children,
}: {
  companyName: string;
  children: (api: NavigationApi) => ReactNode;
}) {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  const unsaved = useContext(UnsavedContext);
  const isDirty = unsaved?.isDirty ?? false;
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);

  useEffect(() => {
    const onHashChange = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const performNavigation = useCallback((target: Route | string, options?: { replace?: boolean }) => {
    const href = typeof target === 'string' ? target : routeHref(target);
    if (options?.replace) {
      const url = new URL(currentHref(), window.location.origin);
      url.hash = href.replace(/^#/, '');
      window.history.replaceState(null, '', url);
      setRoute(parseRoute(url.hash));
      return;
    }
    if (window.location.hash === href) return;
    window.location.hash = href.replace(/^#/, '');
  }, []);

  const guard = useCallback(
    (action: () => void) => {
      if (isDirty) setPendingAction(() => action);
      else action();
    },
    [isDirty],
  );

  const navigate = useCallback(
    (target: Route | string, options?: { replace?: boolean }) => {
      const href = typeof target === 'string' ? target : routeHref(target);
      if (isDirty) {
        setPendingAction(() => () => performNavigation(href, options));
        return;
      }
      performNavigation(href, options);
    },
    [isDirty, performNavigation],
  );

  useEffect(() => {
    if (!isDirty) return undefined;
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as Element | null;
      const anchor = target?.closest('a[href]') as HTMLAnchorElement | null;
      if (!anchor || anchor.target || anchor.hasAttribute('download')) return;
      const href = anchor.getAttribute('href');
      if (!href || !href.startsWith('#/') || href === window.location.hash) return;
      event.preventDefault();
      setPendingAction(() => () => {
        window.location.hash = href.replace(/^#/, '');
      });
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [isDirty]);

  const value = useMemo<NavigationApi>(
    () => ({
      route,
      hrefFor: routeHref,
      navigate,
      appHref: (app, page) => routeHref(appRoute(app, page)),
      guard,
    }),
    [route, navigate, guard],
  );

  useEffect(() => {
    document.title = routeTitle(route, companyName);
  }, [route, companyName]);

  return (
    <NavigationContext.Provider value={value}>
      {children(value)}
      <ConfirmDialog
        open={pendingAction !== null}
        title="Discard unsaved changes?"
        confirmLabel="Discard changes"
        danger
        onClose={() => setPendingAction(null)}
        onConfirm={() => {
          const action = pendingAction;
          setPendingAction(null);
          unsaved?.clear();
          action?.();
        }}
      >
        <p>
          You have entered information that has not been saved. Continue editing to keep it, or
          discard the draft and continue to the selected page.
        </p>
      </ConfirmDialog>
    </NavigationContext.Provider>
  );
}

/**
 * Move focus to the page heading after a committed route change. Ordinary
 * filtering/typing does not call this. The caller owns the ref.
 */
export function useRouteFocus(route: Route, headingRef: React.RefObject<HTMLElement | null>): void {
  const routeKey = route.kind === 'app' ? `${route.app}/${route.page}/${route.recordId ?? ''}` : route.kind;
  const lastKey = useRef(routeKey);
  useEffect(() => {
    // Do not steal focus on first load (including StrictMode's repeat mount):
    // the skip link must be the first Tab stop.
    if (lastKey.current === routeKey) return undefined;
    lastKey.current = routeKey;
    const id = window.setTimeout(() => {
      const heading = headingRef.current;
      if (!heading) return;
      if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
      heading.focus({ preventScroll: false });
    }, 0);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeKey]);
}
