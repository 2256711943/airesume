import { describe, expect, it } from 'vitest';

import { createResumeFormState, type ResumeVariant } from './resume';
import {
  clearResumeSessionConversationId,
  readResumeSessionSnapshot,
  writeResumeSessionSnapshot,
  type ResumeSessionStorageSnapshot,
} from './resume-session';

function createMemoryStorage(): Storage {
  const storage = new Map<string, string>();

  return {
    get length() {
      return storage.size;
    },
    clear() {
      storage.clear();
    },
    getItem(key: string) {
      return storage.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(storage.keys())[index] ?? null;
    },
    removeItem(key: string) {
      storage.delete(key);
    },
    setItem(key: string, value: string) {
      storage.set(key, value);
    },
  } as Storage;
}

function createSnapshot(
  overrides: Partial<ResumeSessionStorageSnapshot> = {},
): ResumeSessionStorageSnapshot {
  const draftVariant: ResumeVariant = {
    id: 'draft-1',
    mode: 'hybrid',
    summary: 'Recovered resume draft summary.',
    experience: [
      {
        company: 'Acme',
        role: 'Backend Engineer',
        highlights: ['Improved service reliability'],
      },
    ],
    projects: [
      {
        name: 'Resume Assistant',
        highlights: ['Built session recovery'],
      },
    ],
    skills: ['TypeScript', 'NestJS'],
  };

  return {
    conversationId: 'conv-stale-1',
    form: {
      ...createResumeFormState(),
      fullName: 'Alex Chen',
      background: 'Five years of backend experience.',
      targetRole: 'Backend Engineer',
      skillsText: 'TypeScript, NestJS',
    },
    resumeVariants: [draftVariant],
    selectedVariantIndex: 0,
    lastGenerateQuery: 'profile=alex',
    ...overrides,
  };
}

describe('resume session utils', () => {
  it('reads and writes a normalized session snapshot', () => {
    const storage = createMemoryStorage();
    const storageKey = 'resume-session';
    const snapshot = createSnapshot({
      selectedVariantIndex: 4,
    });

    writeResumeSessionSnapshot(storage, storageKey, snapshot);

    expect(readResumeSessionSnapshot(storage, storageKey)).toEqual({
      ...snapshot,
      selectedVariantIndex: 0,
    });
  });

  it('clears only the persisted conversation id and keeps the draft payload', () => {
    const storage = createMemoryStorage();
    const storageKey = 'resume-session';
    const snapshot = createSnapshot();

    writeResumeSessionSnapshot(storage, storageKey, snapshot);
    writeResumeSessionSnapshot(
      storage,
      storageKey,
      clearResumeSessionConversationId(snapshot),
    );

    expect(readResumeSessionSnapshot(storage, storageKey)).toEqual({
      ...snapshot,
      conversationId: '',
    });
  });
});
