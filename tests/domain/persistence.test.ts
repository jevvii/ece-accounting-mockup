import { describe, expect, it } from 'vitest';
import {
  createMemoryStorage,
  isStateStorageEvent,
  loadState,
  resetState,
  saveState,
  STORAGE_KEY,
} from '../../src/adapters/storage';
import { createBaseSeedState, createSeedState } from '../../src/fixtures/seed';
import { parseAppState } from '../../src/domain/schema';

describe('browser-local persistence', () => {
  it('seeds an empty installation once and round-trips a saved snapshot', () => {
    const storage = createMemoryStorage();
    const seeded = loadState(storage);
    expect(seeded.status).toBe('ok');
    if (seeded.status !== 'ok') return;
    expect(seeded.source).toBe('seed');
    expect(seeded.persisted).toBe(true);
    expect(parseAppState(JSON.parse(storage.getItem(STORAGE_KEY)!)).ok).toBe(true);

    const edited = structuredClone(seeded.state);
    edited.revision += 1;
    expect(saveState(storage, edited)).toEqual({ ok: true });
    const reloaded = loadState(storage);
    expect(reloaded.status).toBe('ok');
    if (reloaded.status !== 'ok') return;
    expect(reloaded.source).toBe('existing');
    expect(reloaded.state.revision).toBe(edited.revision);
  });

  it('reports invalid JSON with raw text and does not reseed', () => {
    const raw = '{"schemaVersion":1,';
    const storage = createMemoryStorage({ [STORAGE_KEY]: raw });
    const loaded = loadState(storage);
    expect(loaded.status).toBe('corrupt');
    if (loaded.status !== 'corrupt') return;
    expect(loaded.reason).toBe('invalid_json');
    expect(loaded.raw).toBe(raw);
    expect(storage.getItem(STORAGE_KEY)).toBe(raw);
  });

  it('migrates a valid v1 snapshot in place and persists the validated v2 candidate', () => {
    const seed = JSON.parse(JSON.stringify(createBaseSeedState())) as Record<string, unknown>;
    seed.schemaVersion = 1;
    delete seed.numberingPolicies;
    for (const row of seed.contacts as Array<Record<string, unknown>>) delete row.contactNo;
    const raw = JSON.stringify(seed);
    const storage = createMemoryStorage({ [STORAGE_KEY]: raw });
    const loaded = loadState(storage);
    expect(loaded.status).toBe('ok');
    if (loaded.status !== 'ok') return;
    expect(loaded.source).toBe('existing');
    expect(loaded.persisted).toBe(true);
    expect(loaded.state.schemaVersion).toBe(2);
    expect(loaded.state.numberingPolicies.length).toBeGreaterThan(0);
    expect(JSON.parse(storage.getItem(STORAGE_KEY)!).schemaVersion).toBe(2);
  });

  it('keeps the old raw snapshot if a migrated candidate cannot be written', () => {
    const seed = JSON.parse(JSON.stringify(createBaseSeedState())) as Record<string, unknown>;
    seed.schemaVersion = 1;
    delete seed.numberingPolicies;
    for (const row of seed.contacts as Array<Record<string, unknown>>) delete row.contactNo;
    const raw = JSON.stringify(seed);
    const storage = createMemoryStorage({ [STORAGE_KEY]: raw });
    const failing = {
      getItem: storage.getItem,
      removeItem: storage.removeItem,
      setItem() {
        throw new Error('QuotaExceededError');
      },
    };
    const loaded = loadState(failing);
    expect(loaded.status).toBe('ok');
    if (loaded.status !== 'ok') return;
    expect(loaded.persisted).toBe(false);
    expect(storage.getItem(STORAGE_KEY)).toBe(raw);
  });

  it('reports an unsupported schema version without guessing a migration', () => {
    const seed = createSeedState();
    const storage = createMemoryStorage({
      [STORAGE_KEY]: JSON.stringify({ ...seed, schemaVersion: 99 }),
    });
    const loaded = loadState(storage);
    expect(loaded.status).toBe('corrupt');
    if (loaded.status !== 'corrupt') return;
    expect(loaded.reason).toBe('unsupported_version');
    expect(loaded.message).toContain('99');
    expect(storage.getItem(STORAGE_KEY)).toContain('"schemaVersion":99');
  });

  it('reports an invalid shape without mutating the stored snapshot', () => {
    const seed = createSeedState() as unknown as Record<string, unknown>;
    const broken = { ...seed, journals: 'not-an-array' };
    const raw = JSON.stringify(broken);
    const storage = createMemoryStorage({ [STORAGE_KEY]: raw });
    const loaded = loadState(storage);
    expect(loaded.status).toBe('corrupt');
    if (loaded.status !== 'corrupt') return;
    expect(loaded.reason).toBe('invalid_shape');
    expect(storage.getItem(STORAGE_KEY)).toBe(raw);
  });

  it('keeps the previous snapshot and reports a failed write', () => {
    const seed = createSeedState();
    const old = JSON.stringify(seed);
    const storage = createMemoryStorage({ [STORAGE_KEY]: old });
    const failing = {
      getItem: storage.getItem,
      removeItem: storage.removeItem,
      setItem() {
        throw new Error('QuotaExceededError');
      },
    };
    const next = structuredClone(seed);
    next.revision += 7;
    const saved = saveState(failing, next);
    expect(saved.ok).toBe(false);
    if (!saved.ok) expect(saved.message).toContain('QuotaExceededError');
    expect(storage.getItem(STORAGE_KEY)).toBe(old);
    const reloaded = loadState(storage);
    expect(reloaded.status).toBe('ok');
    if (reloaded.status === 'ok') expect(reloaded.state.revision).toBe(seed.revision);
  });

  it('resets only when explicitly requested', () => {
    const storage = createMemoryStorage({ [STORAGE_KEY]: '{broken' });
    expect(loadState(storage).status).toBe('corrupt');
    expect(storage.getItem(STORAGE_KEY)).toBe('{broken');

    const reset = resetState(storage);
    expect(reset.ok).toBe(true);
    if (reset.ok) expect(reset.state.revision).toBe(createSeedState().revision);
    const reloaded = loadState(storage);
    expect(reloaded.status).toBe('ok');
    if (reloaded.status === 'ok') expect(reloaded.source).toBe('existing');
  });

  it('recognizes only the app snapshot as an external-write event', () => {
    expect(isStateStorageEvent(STORAGE_KEY)).toBe(true);
    expect(isStateStorageEvent(`${STORAGE_KEY}:other`)).toBe(false);
    expect(isStateStorageEvent(null)).toBe(false);
  });
});
