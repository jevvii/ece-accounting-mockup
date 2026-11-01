import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { executeCommand } from '../domain/commands';
import type { CommandResult, DomainCommand } from '../domain/commandTypes';
import type { AppState } from '../domain/schema';
import type { AccessContext, EntitlementStatus } from '../domain/shared/access';
import { accessibleWorkspaces, entitlementStatus, resolveAccess } from '../domain/shared/access';
import { createSystemClock } from '../domain/shared/clock';
import {
  createMemoryStorage,
  loadState,
  resetState,
  saveState,
  watchExternalWrites,
  type KeyValueStorage,
  type LoadResult,
} from '../adapters/storage';
import { DEFAULT_ACTOR_ID, WORKSPACE_A } from '../fixtures/seed';

export type ToastKind = 'success' | 'error' | 'info';

export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  detail: string;
}

type SaveStatus = 'saved' | 'failed' | 'unavailable';

interface BrowserStorage {
  storage: KeyValueStorage;
  persistent: boolean;
}

function browserStorage(): BrowserStorage {
  try {
    const storage = window.localStorage;
    const probe = 'fin-axis-mockup:probe';
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return { storage, persistent: true };
  } catch {
    return { storage: createMemoryStorage(), persistent: false };
  }
}

function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `key-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export interface AppApi {
  state: AppState;
  actorId: string;
  workspaceId: string;
  setActorId: (actorId: string) => void;
  setWorkspaceId: (workspaceId: string) => void;
  access: AccessContext | null;
  productStatus: (product: 'accounting' | 'payroll' | 'inventory') => EntitlementStatus;
  dispatch: (command: DomainCommand) => CommandResult | null;
  notify: (kind: ToastKind, title: string, detail?: string) => void;
  dismissToast: (id: number) => void;
  toasts: Toast[];
  saveStatus: SaveStatus;
  externalChange: boolean;
  reloadPage: () => void;
  refreshDemo: () => boolean;
  resetDemo: () => void;
  storagePersistent: boolean;
  clock: ReturnType<typeof createSystemClock>;
}

const AppContext = createContext<AppApi | null>(null);

export function useApp(): AppApi {
  const value = useContext(AppContext);
  if (!value) throw new Error('useApp must be used inside AppProvider');
  return value;
}

interface AppProviderProps {
  children: (loaded: { corrupt: Extract<LoadResult, { status: 'corrupt' }> | null; reset: () => void }) => ReactNode;
}

export function AppProvider({ children }: AppProviderProps) {
  const storageRef = useRef<BrowserStorage | null>(null);
  if (!storageRef.current) storageRef.current = browserStorage();
  const { storage, persistent } = storageRef.current;
  const clockRef = useRef(createSystemClock());

  const [loaded, setLoaded] = useState<LoadResult>(() => loadState(storage));
  const [state, setState] = useState<AppState | null>(loaded.status === 'ok' ? loaded.state : null);
  // Screens sometimes dispatch two commands in one event (for example create-then-post).
  // The ref gives the second command the state the first one just produced, instead of the
  // stale render-closure snapshot that would make it fail its revision/not-found checks.
  const stateRef = useRef<AppState | null>(loaded.status === 'ok' ? loaded.state : null);
  const commitState = useCallback((next: AppState) => {
    stateRef.current = next;
    setState(next);
  }, []);
  const [actorId, setActorIdState] = useState(DEFAULT_ACTOR_ID);
  const [workspaceId, setWorkspaceIdState] = useState(WORKSPACE_A);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>(
    loaded.status === 'ok' && loaded.persisted && persistent ? 'saved' : 'unavailable',
  );
  const [externalChange, setExternalChange] = useState(false);
  const toastCounter = useRef(0);

  useEffect(() => {
    if (!persistent) return undefined;
    return watchExternalWrites(() => setExternalChange(true));
  }, [persistent]);

  const notify = useCallback((kind: ToastKind, title: string, detail = '') => {
    toastCounter.current += 1;
    const id = toastCounter.current;
    setToasts((current) => [...current.slice(-4), { id, kind, title, detail }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, kind === 'error' ? 12000 : 7000);
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const setActorId = useCallback((nextActorId: string) => {
    setActorIdState(nextActorId);
  }, []);

  const setWorkspaceId = useCallback((nextWorkspaceId: string) => {
    setWorkspaceIdState(nextWorkspaceId);
  }, []);

  useEffect(() => {
    if (!state) return;
    const allowed = accessibleWorkspaces(state, actorId);
    if (allowed.length > 0 && !allowed.some((candidate) => candidate.id === workspaceId)) {
      setWorkspaceIdState(allowed[0]!.id);
    }
  }, [actorId, state, workspaceId]);

  const access = useMemo(() => {
    if (!state) return null;
    const resolved = resolveAccess(state, actorId, workspaceId, clockRef.current.today);
    return resolved.ok ? resolved.value : null;
  }, [state, actorId, workspaceId]);

  const productStatus = useCallback(
    (product: 'accounting' | 'payroll' | 'inventory'): EntitlementStatus => {
      if (!state) return 'inactive';
      const workspace = state.workspaces.find((candidate) => candidate.id === workspaceId);
      return workspace ? entitlementStatus(workspace.entitlements[product], clockRef.current.today) : 'inactive';
    },
    [state, workspaceId],
  );

  const dispatch = useCallback(
    (command: DomainCommand): CommandResult | null => {
      const current = stateRef.current;
      if (!current) return null;
      if (externalChange) {
        notify('error', 'Another tab changed the saved data', 'Reload before making more changes.');
        return null;
      }
      const outcome = executeCommand(
        current,
        {
          workspaceId,
          actorId,
          idempotencyKey: newIdempotencyKey(),
          expectedRevision: current.revision,
          command,
        },
        clockRef.current,
      );
      if (!outcome.ok) {
        notify('error', outcome.error.code, outcome.error.message);
        return null;
      }
      const saved = saveState(storage, outcome.value.state);
      if (!saved.ok) {
        setSaveStatus('failed');
        notify('error', 'Snapshot not saved', saved.message);
        return null;
      }
      commitState(outcome.value.state);
      setSaveStatus('saved');
      const { result } = outcome.value;
      notify('success', result.summary);
      for (const warning of result.warnings) notify('info', warning);
      return result;
    },
    [workspaceId, actorId, externalChange, storage, notify, commitState],
  );

  const refreshDemo = useCallback((): boolean => {
    if (externalChange) {
      notify(
        'error',
        'STALE_TAB_GUARD',
        'Another browser tab updated the saved snapshot. Reload before refreshing demo data.',
      );
      return false;
    }
    const res = resetState(storage);
    if (!res.ok) {
      setSaveStatus('failed');
      notify(
        'error',
        'STORAGE_WRITE_FAILED',
        'The browser rejected the local storage write. Your existing session data was preserved.',
      );
      return false;
    }
    commitState(res.state);
    setLoaded({ status: 'ok', state: res.state, source: 'seed', persisted: true });
    setSaveStatus(persistent ? 'saved' : 'unavailable');
    setExternalChange(false);
    notify(
      'success',
      'Refreshed demo data to connected ECE Accounting synthetic dataset (ece-accounting-demo-v1).',
    );
    return true;
  }, [externalChange, storage, notify, commitState, persistent]);

  const resetDemo = useCallback(() => {
    refreshDemo();
  }, [refreshDemo]);

  const reloadPage = useCallback(() => window.location.reload(), []);

  const value = useMemo<AppApi | null>(() => {
    if (!state) return null;
    return {
      state,
      actorId,
      workspaceId,
      setActorId,
      setWorkspaceId,
      access,
      productStatus,
      dispatch,
      notify,
      dismissToast,
      toasts,
      saveStatus,
      externalChange,
      reloadPage,
      refreshDemo,
      resetDemo,
      storagePersistent: persistent,
      clock: clockRef.current,
    };
  }, [
    state,
    actorId,
    workspaceId,
    setActorId,
    setWorkspaceId,
    access,
    productStatus,
    dispatch,
    notify,
    dismissToast,
    toasts,
    saveStatus,
    externalChange,
    reloadPage,
    refreshDemo,
    resetDemo,
    persistent,
  ]);

  const corrupt = loaded.status === 'corrupt' ? loaded : null;

  if (corrupt) {
    return <>{children({ corrupt, reset: resetDemo })}</>;
  }
  if (!value) {
    return <p role="alert">The stored demo data could not be opened.</p>;
  }
  return <AppContext.Provider value={value}>{children({ corrupt: null, reset: resetDemo })}</AppContext.Provider>;
}
