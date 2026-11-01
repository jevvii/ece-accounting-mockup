import type { AppState, Journal } from './schema';
import { hasPayrollDetail } from './shared/access';

export function canViewPayrollDetail(state: AppState, workspaceId: string, actorId?: string): boolean {
  const membership = state.memberships.find((row) => row.workspaceId === workspaceId && row.userId === actorId && row.active);
  return membership ? hasPayrollDetail(membership) : false;
}

export function payrollSensitiveJournal(state: AppState, journal: Journal): boolean {
  const seen = new Set<string>();
  let current: Journal | undefined = journal;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    if (current.sourceType.startsWith('payroll_') || current.sourceProvenance?.originSourceType.startsWith('payroll_')) return true;
    const id: string | null | undefined = current.reversalOf ?? current.sourceProvenance?.originJournalId;
    current = id ? state.journals.find((row) => row.id === id && row.workspaceId === journal.workspaceId) : undefined;
  }
  return false;
}

/** Preserve GL amounts/references while protecting descriptive payroll details. */
export function journalForViewer(state: AppState, journal: Journal, actorId?: string): Journal {
  if (!payrollSensitiveJournal(state, journal) || canViewPayrollDetail(state, journal.workspaceId, actorId)) return journal;
  const memo = `Payroll journal · ${journal.journalNo}`;
  return { ...journal, memo, lines: journal.lines.map((line) => ({ ...line, memo })) };
}
