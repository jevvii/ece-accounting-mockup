import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import type { EntitlementStatus } from '../domain/shared/access';
import { useApp } from './useApp';

export function Panel({
  title,
  subtitle,
  actions,
  children,
  note,
  id,
}: {
  title?: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
  note?: string;
  id?: string;
}) {
  return (
    <section className="panel" id={id} aria-label={title}>
      {(title || actions) && (
        <header className="panel-head">
          <div>
            {title && <h2>{title}</h2>}
            {subtitle && <p className="panel-sub">{subtitle}</p>}
          </div>
          {actions && <div className="panel-actions">{actions}</div>}
        </header>
      )}
      <div className="panel-body">{children}</div>
      {note && <p className="panel-note">{note}</p>}
    </section>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
  htmlFor?: string;
}) {
  const hintId = useId();
  const errorId = useId();
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ');
  let control = children;
  if (
    isValidElement(children) &&
    typeof children.type === 'string' &&
    ['input', 'select', 'textarea'].includes(children.type)
  ) {
    const props = children.props as { 'aria-describedby'?: string };
    control = cloneElement(children as ReactElement<Record<string, unknown>>, {
      'aria-describedby': [props['aria-describedby'], describedBy].filter(Boolean).join(' ') || undefined,
      ...(error ? { 'aria-invalid': 'true' } : {}),
    });
  }
  return (
    <div className={`field${error ? ' field-error' : ''}`}>
      <label htmlFor={htmlFor}>{label}</label>
      {control}
      {hint && (
        <p id={hintId} className="field-hint">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="field-message" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const tone =
    status === 'posted' || status === 'paid' || status === 'active' || status === 'saved' || status === 'approved'
      ? 'ok'
      : status === 'reversed' || status === 'returned' || status === 'rejected' || status === 'inactive'
        ? 'neutral'
        : status === 'held' || status === 'pending' || status === 'calculated' || status === 'partially_paid'
          ? 'warn'
          : status === 'missing' || status === 'expired' || status === 'failed'
            ? 'error'
            : 'neutral';
  return <span className={`badge badge-${tone}`}>{status.replace(/_/g, ' ')}</span>;
}

export function EntitlementBadge({
  product,
  status,
}: {
  product: string;
  status: EntitlementStatus;
}) {
  return (
    <span className={`product-badge product-${status}`} title={`${product}: ${status}`}>
      {product} · {status}
    </span>
  );
}

export function ProductNotice({ product }: { product: 'accounting' | 'payroll' | 'inventory' }) {
  const { productStatus, state, workspaceId } = useApp();
  const status = productStatus(product);
  if (status === 'active') return null;
  const workspace = state.workspaces.find((candidate) => candidate.id === workspaceId);
  const entitlement = workspace?.entitlements[product];
  return (
    <div className="callout callout-warn" role="status">
      <strong>{product} is {status} for this company.</strong>{' '}
      {status === 'expired'
        ? `Records stay readable and exportable, but writes are blocked. Expired on ${entitlement?.expiresOn ?? 'an earlier date'}.`
        : 'Operational records from a standalone product remain visible. Accounting posting actions are unavailable until the product is enabled.'}{' '}
      An authorized company administrator can change entitlements in Admin.
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <p>
        <strong>{title}</strong>
      </p>
      {children && <div>{children}</div>}
    </div>
  );
}

export function SearchField({
  value,
  onChange,
  label = 'Search',
  placeholder = 'Search records',
}: {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  placeholder?: string;
}) {
  const id = useId();
  return (
    <div className="search">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="search"
        value={value}
        placeholder={placeholder}
        onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
      />
    </div>
  );
}

export function Pagination({
  page,
  pageCount,
  onPage,
  total,
  pageSize,
}: {
  page: number;
  pageCount: number;
  onPage: (page: number) => void;
  total: number;
  pageSize: number;
}) {
  if (pageCount <= 1) return <p className="pagination-count">{total} record(s)</p>;
  return (
    <div className="pagination">
      <button type="button" onClick={() => onPage(page - 1)} disabled={page <= 1}>
        Previous
      </button>
      <span>
        Page {page} of {pageCount} · {total} record(s)
      </span>
      <button type="button" onClick={() => onPage(page + 1)} disabled={page >= pageCount}>
        Next
      </button>
      <span className="pagination-size">{pageSize} per page</span>
    </div>
  );
}

export function usePager<T>(items: readonly T[], pageSize = 20) {
  const [page, setPage] = useState(1);
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.min(page, pageCount);
  const pageItems = useMemo(
    () => items.slice((safePage - 1) * pageSize, safePage * pageSize),
    [items, safePage, pageSize],
  );
  useEffect(() => {
    setPage(1);
  }, [items.length]);
  return { page: safePage, setPage, pageCount, pageItems, pageSize };
}

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  if (!open) return null;
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      className={wide ? 'modal modal-wide' : 'modal'}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header className="modal-head">
        <h2 id={titleId}>{title}</h2>
        <button type="button" className="link-button" onClick={onClose} aria-label="Close dialog">
          Close
        </button>
      </header>
      <div className="modal-body">{children}</div>
      {footer && <footer className="modal-foot">{footer}</footer>}
    </dialog>
  );
}

export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  onConfirm,
  onClose,
  danger,
  disabled,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <Modal
      open={open}
      title={title}
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={danger ? 'danger' : 'primary'}
            onClick={onConfirm}
            disabled={disabled}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      {children}
    </Modal>
  );
}

export function ToastStack() {
  const { toasts, dismissToast } = useApp();
  const lastErrorRef = useRef<HTMLDivElement>(null);
  const lastError = [...toasts].reverse().find((toast) => toast.kind === 'error');
  useEffect(() => {
    if (lastError) lastErrorRef.current?.focus();
  }, [lastError?.id]);
  if (toasts.length === 0) return null;
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          ref={toast.id === lastError?.id ? lastErrorRef : undefined}
          tabIndex={toast.kind === 'error' ? -1 : undefined}
          className={`toast toast-${toast.kind}`}
          role={toast.kind === 'error' ? 'alert' : 'status'}
        >
          <p>
            <strong>{toast.title}</strong>
            {toast.detail ? ` — ${toast.detail}` : ''}
          </p>
          <button type="button" className="link-button" onClick={() => dismissToast(toast.id)}>
            Dismiss
          </button>
        </div>
      ))}
    </div>
  );
}

export function SourceLinks({ journalIds }: { journalIds: readonly string[] }) {
  const { state } = useApp();
  if (journalIds.length === 0) return <span className="muted">No journal created</span>;
  return (
    <span className="source-links">
      {journalIds.map((journalId) => {
        const journal = state.journals.find((candidate) => candidate.id === journalId);
        return (
          <a key={journalId} href="#/other">
            {journal?.journalNo ?? journalId}
          </a>
        );
      })}
    </span>
  );
}
