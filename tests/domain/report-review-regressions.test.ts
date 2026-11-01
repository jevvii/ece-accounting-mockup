import { describe, expect, it } from 'vitest';
import { createBaseSeedState, createSeedState, WORKSPACE_A } from '../../src/fixtures/seed';
import { sourceBookTrialBalance, trialBalanceCellDrilldown } from '../../src/domain/queries';
import { createMemoryStorage, loadState, resetState, STORAGE_KEY } from '../../src/adapters/storage';
import { resolveJournalProvenance } from '../../src/domain/ledger';
import { parseRoute } from '../../src/app/router';

describe('post-execution reporting review regressions', () => {
  it('as-of drill-through ignores an activity start date, just like the report query', () => {
    const state = createBaseSeedState();
    const params = { mode: 'as_of' as const, fromDate: '2026-10-01', toDate: '2026-11-30' };
    expect(sourceBookTrialBalance(state, WORKSPACE_A, params).includedJournalCount).toBe(1);
    const accountId = state.accounts.find((row) => row.workspaceId === WORKSPACE_A && row.controlRole === 'bank')!.id;
    expect(trialBalanceCellDrilldown(state, WORKSPACE_A, { ...params, accountId })).toHaveLength(1);
  });

  it('payroll officer without the detail grant cannot read direct or reversed payroll memos', () => {
    const state = createBaseSeedState();
    const original = { ...state.journals[0]!, id: 'private-payroll', sourceType: 'payroll_run', sourceId: 'private-run',
      sourceProvenance: undefined, memo: 'Private employee salary detail',
      lines: state.journals[0]!.lines.map((line) => ({ ...line, memo: 'Private employee salary detail' })) };
    const reversal = { ...original, id: 'private-payroll-reversal', sourceType: 'journal_reversal', reversalOf: original.id };
    state.journals = [original, reversal];
    state.memberships = state.memberships.map((row) => row.userId === 'u-payroll' ? { ...row, payrollDetail: false } : row);
    const lines = trialBalanceCellDrilldown(state, WORKSPACE_A, {
      accountId: original.lines[0]!.accountId, actorId: 'u-payroll', toDate: '2026-11-30',
    });
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => !line.memo.includes('Private employee'))).toBe(true);
  });

  it('source links resolve to real pages and exact supported records or their exact journal', () => {
    const state = createSeedState();
    for (const journal of state.journals) {
      const line = trialBalanceCellDrilldown(state, journal.workspaceId, {
        accountId: journal.lines[0]!.accountId, toDate: '2026-11-30', actorId: 'u-accountant',
      }).find((row) => row.journalId === journal.id)!;
      expect(line).toBeDefined();
      const route = parseRoute(line.sourceRoute);
      expect(route.kind).toBe('app');
      if (route.kind === 'app') expect(route.recordId).toBeTruthy();
    }
  });

  it('captures a bank clearing target ID, preserving it through reversal after the row is unmatched', () => {
    const state = createBaseSeedState();
    const clearing = { ...state.journals[0]!, id: 'clearing-target-test', sourceType: 'bank_clearing', sourceId: 'bank-row-test', sourceProvenance: undefined };
    const provenance = resolveJournalProvenance(state, clearing, { clearingTargetType: 'customer_receipt', clearingTargetId: 'receipt-test' });
    expect(provenance.originSourceId).toBe('receipt-test');
    expect(provenance.clearingTargetId).toBe('receipt-test');
    const posted = { ...clearing, sourceProvenance: provenance };
    state.journals = [posted];
    const undo = { ...clearing, id: 'undo-test', sourceType: 'bank_clearing_undo', reversalOf: posted.id };
    expect(resolveJournalProvenance(state, undo).clearingTargetId).toBe('receipt-test');
  });

  it('reset advances beyond the saved revision so a prior writer cannot match it', () => {
    const existing = createBaseSeedState();
    existing.revision = 500;
    const storage = createMemoryStorage({ [STORAGE_KEY]: JSON.stringify(existing) });
    const result = resetState(storage);
    expect(result.ok).toBe(true);
    expect(result.state.revision).toBe(501);
    const again = resetState(storage);
    expect(again.state.revision).toBe(502);
  });

  it('repairs cached legacy clearing origins from scoped match audit even after operational links were cleared', () => {
    const state = createSeedState();
    const target = state.receipts[0]!.id;
    const clearing = { ...state.journals[0]!, id: 'legacy-clearing', journalNo: 'JV-LEGACY',
      sourceType: 'bank_clearing', sourceId: 'legacy-unmatched-row', effectKey: 'legacy-clearing-effect',
      sourceProvenance: { version: 1 as const, book: 'collections' as const, originSourceType: 'customer_receipt',
        originSourceId: 'legacy-unmatched-row', originJournalId: null, clearingTargetType: 'customer_receipt' as const,
        clearingTargetId: null, provisional: false, exceptionReason: null } };
    state.journals.push(clearing);
    state.auditEvents.push({ id: 'legacy-match-audit', workspaceId: WORKSPACE_A, actorId: 'u-accountant',
      action: 'bank.match', recordType: 'bank_row', recordId: clearing.sourceId, at: '2026-11-01T00:00:00Z',
      reason: 'Legacy reviewed bank match', detail: { sourceType: 'customer_receipt', sourceId: target, journalId: clearing.id } });
    const storage = createMemoryStorage({ [STORAGE_KEY]: JSON.stringify(state) });
    const loaded = loadState(storage);
    expect(loaded.status).toBe('ok');
    if (loaded.status !== 'ok') return;
    expect(loaded.state.journals.find((row) => row.id === clearing.id)!.sourceProvenance!.clearingTargetId).toBe(target);
    expect(JSON.parse(storage.getItem(STORAGE_KEY)!).journals.find((row: { id: string }) => row.id === clearing.id).sourceProvenance.originSourceId).toBe(target);
  });
});
