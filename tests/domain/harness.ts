import { expect } from 'vitest';
import { createBaseSeedState, DEMO_NOW, DEMO_TODAY, DEFAULT_ACTOR_ID, WORKSPACE_A } from '../../src/fixtures/seed';
import { executeCommand } from '../../src/domain/commands';
import type { CommandEnvelope, CommandResult, DomainCommand } from '../../src/domain/commandTypes';
import type { AppState } from '../../src/domain/schema';
import { createFixedClock, type Clock } from '../../src/domain/shared/clock';
import type { Result } from '../../src/domain/shared/result';

export interface Harness {
  readonly state: AppState;
  readonly clock: Clock;
  run(command: DomainCommand, options?: { key?: string; actorId?: string; workspaceId?: string; expectedRevision?: number }): Result<CommandResult>;
  runOk(command: DomainCommand, options?: { key?: string; actorId?: string; workspaceId?: string; expectedRevision?: number }): CommandResult;
  setState(next: AppState): void;
}

export function createHarness(options?: {
  actorId?: string;
  workspaceId?: string;
  state?: AppState;
}): Harness {
  let state = options?.state ?? createBaseSeedState();
  const clock = createFixedClock({ nowIso: DEMO_NOW, today: DEMO_TODAY, seed: 'test' });
  let keyCounter = 0;
  const actorId = options?.actorId ?? DEFAULT_ACTOR_ID;
  const workspaceId = options?.workspaceId ?? WORKSPACE_A;

  const run: Harness['run'] = (command, runOptions) => {
    keyCounter += 1;
    const envelope: CommandEnvelope = {
      workspaceId: runOptions?.workspaceId ?? workspaceId,
      actorId: runOptions?.actorId ?? actorId,
      idempotencyKey: runOptions?.key ?? `test-key-${keyCounter}`,
      ...(runOptions?.expectedRevision !== undefined
        ? { expectedRevision: runOptions.expectedRevision }
        : {}),
      command,
    };
    const outcome = executeCommand(state, envelope, clock);
    if (!outcome.ok) return outcome;
    state = outcome.value.state;
    return { ok: true, value: outcome.value.result };
  };

  return {
    get state() {
      return state;
    },
    clock,
    run,
    runOk(command, runOptions) {
      const result = run(command, runOptions);
      expect(result.ok, result.ok ? '' : `${result.error.code}: ${result.error.message}`).toBe(true);
      if (!result.ok) throw new Error('unreachable');
      return result.value;
    },
    setState(next) {
      state = next;
    },
  };
}

export const ACCOUNTS = {
  bank: 'acc-ws-a-1020',
  incomingClearing: 'acc-ws-a-1030',
  outgoingClearing: 'acc-ws-a-1040',
  ar: 'acc-ws-a-1100',
  inventory: 'acc-ws-a-1200',
  inputVat: 'acc-ws-a-1400',
  employeeAdvance: 'acc-ws-a-1300',
  employeePayable: 'acc-ws-a-2090',
  assetCost: 'acc-ws-a-1500',
  accumulated: 'acc-ws-a-1590',
  ap: 'acc-ws-a-2010',
  grni: 'acc-ws-a-2020',
  unapplied: 'acc-ws-a-2030',
  ewtPayable: 'acc-ws-a-2040',
  outputVat: 'acc-ws-a-2100',
  openingEquity: 'acc-ws-a-3010',
  revenue: 'acc-ws-a-4010',
  cogs: 'acc-ws-a-5010',
  salaries: 'acc-ws-a-6010',
  employer: 'acc-ws-a-6020',
  depreciation: 'acc-ws-a-6050',
  adjustment: 'acc-ws-a-6060',
} as const;

export function journalFor(h: Harness, sourceId: string) {
  return h.state.journals.find((journal) => journal.sourceId === sourceId);
}

export function linesByCode(accountCode: string, journalId: string, h: Harness) {
  const journal = h.state.journals.find((candidate) => candidate.id === journalId);
  expect(journal, `journal ${journalId}`).toBeDefined();
  return journal?.lines.filter((line) => line.accountCode === accountCode) ?? [];
}

export function debitTotal(h: Harness, journalId: string): number {
  const journal = h.state.journals.find((candidate) => candidate.id === journalId);
  return journal?.lines.reduce((total, line) => total + line.debitCentavos, 0) ?? -1;
}

export function creditTotal(h: Harness, journalId: string): number {
  const journal = h.state.journals.find((candidate) => candidate.id === journalId);
  return journal?.lines.reduce((total, line) => total + line.creditCentavos, 0) ?? -1;
}
