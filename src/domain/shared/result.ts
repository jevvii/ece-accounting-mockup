export type ErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'DUPLICATE_EFFECT'
  | 'INVALID_STATE'
  | 'CLOSED_PERIOD'
  | 'MAINTENANCE_ACTIVE'
  | 'ENTITLEMENT_EXPIRED'
  | 'NOT_ENTITLED'
  | 'INSUFFICIENT_STOCK'
  | 'NEGATIVE_STOCK'
  | 'AMOUNT_MISMATCH'
  | 'DUPLICATE_ROW'
  | 'STALE_REVISION'
  | 'PERSISTENCE_FAILED'
  | 'POLICY_INCOMPLETE';

export interface DomainError {
  code: ErrorCode;
  message: string;
  field?: string;
  detail?: string;
}

export interface Ok<T> {
  ok: true;
  value: T;
}

export interface Err {
  ok: false;
  error: DomainError;
}

export type Result<T> = Ok<T> | Err;

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err(code: ErrorCode, message: string, field?: string, detail?: string): Err {
  return { ok: false, error: { code, message, field, detail } };
}

export function isOk<T>(result: Result<T>): result is Ok<T> {
  return result.ok;
}

export function isErr<T>(result: Result<T>): result is Err {
  return !result.ok;
}

/** Unwrap for trusted seed/test setup only; never for user input or commands. */
export function expectOk<T>(result: Result<T>): T {
  if (!result.ok) {
    throw new Error(`${result.error.code}: ${result.error.message}`);
  }
  return result.value;
}
