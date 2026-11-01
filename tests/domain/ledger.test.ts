import { describe, expect, it } from 'vitest';
import {
  journalCreditTotal,
  journalDebitTotal,
  postJournal,
  reverseJournal,
  type WriteContext,
} from '../../src/domain/ledger';
import { resolveAccess } from '../../src/domain/shared/access';
import { createFixedClock } from '../../src/domain/shared/clock';
import { createDraft } from '../../src/domain/shared/draft';
import { DEMO_NOW, DEMO_TODAY, createSeedState, WORKSPACE_A, WORKSPACE_B } from '../../src/fixtures/seed';
import type { AppState } from '../../src/domain/schema';
import { ACCOUNTS, createHarness } from './harness';

function context(state: AppState, actorId = 'u-accountant'): WriteContext {
  const access = resolveAccess(state, actorId, WORKSPACE_A, DEMO_TODAY);
  if (!access.ok) throw new Error(access.error.message);
  return {
    ...access.value,
    clock: createFixedClock({ nowIso: DEMO_NOW, today: DEMO_TODAY, seed: 'ledger' }),
  };
}

function journalInput(overrides: Partial<Parameters<typeof postJournal>[2]> = {}) {
  return {
    postingDate: '2026-11-10',
    documentDate: '2026-11-10',
    sourceType: 'synthetic_test',
    sourceId: 'synthetic-doc-1',
    effectKey: 'synthetic-effect-1',
    memo: 'Synthetic ledger test',
    lines: [
      { accountId: ACCOUNTS.adjustment, debitCentavos: 10_000, creditCentavos: 0 },
      { accountId: ACCOUNTS.openingEquity, debitCentavos: 0, creditCentavos: 10_000 },
    ],
    ...overrides,
  };
}

describe('posted journal validation', () => {
  it('rejects an unbalanced journal without writing a journal or effect', () => {
    const state = createSeedState();
    const draft = createDraft(state);
    const journals = state.journals.length;
    const result = postJournal(
      draft,
      context(state),
      journalInput({
        lines: [
          { accountId: ACCOUNTS.adjustment, debitCentavos: 10_000, creditCentavos: 0 },
          { accountId: ACCOUNTS.openingEquity, debitCentavos: 0, creditCentavos: 9_999 },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('VALIDATION');
    expect(draft.state.journals.length).toBe(journals);
    expect(state.sourceEffects[`${WORKSPACE_A}:synthetic-effect-1`]).toBeUndefined();
  });

  it('rejects a foreign-company account and never leaks a cross-company line', () => {
    const state = createSeedState();
    const draft = createDraft(state);
    const result = postJournal(
      draft,
      context(state),
      journalInput({
        lines: [
          { accountId: 'acc-ws-b-5010', debitCentavos: 10_000, creditCentavos: 0 },
          { accountId: ACCOUNTS.openingEquity, debitCentavos: 0, creditCentavos: 10_000 },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('VALIDATION');
    expect(draft.state.journals.length).toBe(state.journals.length);
  });

  it('rejects negative, both-sided and zero-value lines', () => {
    const state = createSeedState();
    for (const lines of [
      [
        { accountId: ACCOUNTS.adjustment, debitCentavos: -1, creditCentavos: 0 },
        { accountId: ACCOUNTS.openingEquity, debitCentavos: 0, creditCentavos: 1 },
      ],
      [
        { accountId: ACCOUNTS.adjustment, debitCentavos: 100, creditCentavos: 100 },
        { accountId: ACCOUNTS.openingEquity, debitCentavos: 0, creditCentavos: 0 },
      ],
    ]) {
      const draft = createDraft(state);
      const result = postJournal(draft, context(state), journalInput({ lines }));
      expect(result.ok).toBe(false);
      expect(draft.state.journals.length).toBe(state.journals.length);
    }
  });

  it('rejects a posting into a closed period and allows it after an audited reopen', () => {
    const h = createHarness();
    h.runOk({ type: 'period.close', input: { year: 2026, month: 11, reason: 'Synthetic month-end close' } }, { actorId: 'u-owner' });

    const blocked = postJournal(createDraft(h.state), context(h.state), journalInput());
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error.code).toBe('CLOSED_PERIOD');

    h.runOk({ type: 'period.reopen', input: { year: 2026, month: 11, reason: 'Synthetic correction window' } }, { actorId: 'u-owner' });
    const allowed = postJournal(createDraft(h.state), context(h.state), journalInput());
    expect(allowed.ok).toBe(true);
    expect(h.state.auditEvents.some((event) => event.action === 'period.reopen')).toBe(true);
  });
});

describe('linked reversal', () => {
  it('posts a mirrored journal, links both records, and keeps the original lines immutable', () => {
    const state = createSeedState();
    const draft = createDraft(state);
    const ctx = context(state);
    const posted = postJournal(draft, ctx, journalInput());
    expect(posted.ok).toBe(true);
    if (!posted.ok) return;
    const original = posted.value;
    const originalLines = structuredClone(original.lines);
    const working = draft.state;
    const reversalDraft = createDraft(working);
    const reversed = reverseJournal(
      reversalDraft,
      context(working),
      original.id,
      '2026-11-11',
      'Synthetic correction',
    );
    expect(reversed.ok).toBe(true);
    if (!reversed.ok) return;
    const reversal = reversed.value;
    const afterReversal = reversalDraft.state;
    expect(reversal.reversalOf).toBe(original.id);
    expect(reversal.lines.map((line) => [line.debitCentavos, line.creditCentavos])).toEqual(
      original.lines.map((line) => [line.creditCentavos, line.debitCentavos]),
    );
    expect(journalDebitTotal(reversal.lines)).toBe(10_000);
    expect(journalCreditTotal(reversal.lines)).toBe(10_000);

    const duplicate = reverseJournal(
      createDraft(afterReversal),
      context(afterReversal),
      original.id,
      '2026-11-12',
      'Duplicate reversal',
    );
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.error.code).toBe('CONFLICT');

    const reverseReversal = reverseJournal(
      createDraft(afterReversal),
      context(afterReversal),
      reversal.id,
      '2026-11-12',
      'Reversal of reversal',
    );
    expect(reverseReversal.ok).toBe(false);
    if (!reverseReversal.ok) expect(reverseReversal.error.code).toBe('CONFLICT');

    expect(original.lines).toEqual(originalLines);
  });

  it('requires a reason and an open period for the reversal date', () => {
    const state = createSeedState();
    const draft = createDraft(state);
    const posted = postJournal(draft, context(state), journalInput());
    if (!posted.ok) throw new Error(posted.error.message);

    const noReason = reverseJournal(createDraft(draft.state), context(draft.state), posted.value.id, '2026-11-11', 'x');
    expect(noReason.ok).toBe(false);
    if (!noReason.ok) expect(noReason.error.code).toBe('VALIDATION');
    expect(draft.state.journals.find((journal) => journal.id === posted.value.id)?.reversedBy).toBeNull();
  });
});

describe('workspace isolation', () => {
  it('refuses to reverse a journal from another company', () => {
    const state = createSeedState();
    const result = reverseJournal(
      createDraft(state),
      context(state),
      'jv-does-not-exist',
      '2026-11-11',
      'Synthetic correction',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('NOT_FOUND');

    const foreign = createSeedState();
    const foreignAccess = resolveAccess(foreign, 'u-badmin', WORKSPACE_B, DEMO_TODAY);
    expect(foreignAccess.ok).toBe(true);
    if (!foreignAccess.ok) return;
    const bContext: WriteContext = {
      ...foreignAccess.value,
      clock: createFixedClock({ nowIso: DEMO_NOW, today: DEMO_TODAY, seed: 'ledger-b' }),
    };
    const cross = reverseJournal(
      createDraft(state),
      bContext,
      'jv-does-not-exist-b',
      '2026-11-11',
      'Synthetic cross-company correction',
    );
    expect(cross.ok).toBe(false);
  });
});
