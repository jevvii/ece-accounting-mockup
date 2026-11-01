import type { AppState } from '../schema';

export interface StateDraft {
  state: AppState;
}

/**
 * Shallow working copy. Handlers replace the collections they touch; they must
 * never mutate an array already reachable from the previous snapshot.
 */
export function createDraft(base: AppState): StateDraft {
  return { state: { ...base } };
}

type ArrayCollectionKey = {
  [K in keyof AppState]-?: AppState[K] extends readonly unknown[] ? K : never;
}[keyof AppState];

type RecordCollectionKey = {
  [K in keyof AppState]-?: AppState[K] extends Record<string, unknown> ? K : never;
}[keyof AppState];

export type { ArrayCollectionKey, RecordCollectionKey };

export function pushItem<K extends ArrayCollectionKey>(
  draft: StateDraft,
  key: K,
  item: AppState[K][number],
): void {
  const current = draft.state[key];
  // The mapped key guarantees the element type; the cast is the one localized
  // bridge TypeScript needs for a heterogeneous collection key.
  draft.state[key] = [...current, item] as AppState[K];
}

export function replaceItems<K extends ArrayCollectionKey>(
  draft: StateDraft,
  key: K,
  items: AppState[K],
): void {
  draft.state[key] = items;
}

export function updateItem<K extends ArrayCollectionKey>(
  draft: StateDraft,
  key: K,
  predicate: (item: AppState[K][number]) => boolean,
  update: (item: AppState[K][number]) => AppState[K][number],
): AppState[K][number] | undefined {
  const items = draft.state[key];
  const index = items.findIndex(predicate);
  if (index < 0) return undefined;
  const existing = items[index];
  if (existing === undefined) return undefined;
  const nextItem = update(existing);
  const copy = items.slice();
  copy[index] = nextItem;
  draft.state[key] = copy as AppState[K];
  return nextItem;
}

export function findItem<K extends ArrayCollectionKey>(
  state: AppState,
  key: K,
  predicate: (item: AppState[K][number]) => boolean,
): AppState[K][number] | undefined {
  return state[key].find(predicate);
}

export function setRecordValue<K extends RecordCollectionKey>(
  draft: StateDraft,
  key: K,
  recordKey: string,
  value: AppState[K][string],
): void {
  const current = draft.state[key];
  draft.state[key] = { ...current, [recordKey]: value };
}
