import { create } from 'zustand';
import type { LearningScope, LearningTurn } from '../../../shared/contracts/learning';

export const learningDraftKey = (projectPath: string | undefined, sessionId: string | null) => `${projectPath ?? ''}\0${sessionId ?? ''}`;
interface LearningUiState {
  open: boolean;
  correction: string | null;
  focus: LearningScope | null;
  turns: Record<string, LearningTurn>;
  show(correction?: string, focus?: LearningScope): void;
  close(): void;
  setTurn(key: string, turn: LearningTurn): void;
  clearTurn(key: string, expected?: LearningTurn): void;
}
export const useLearningStore = create<LearningUiState>((set) => ({
  open: false, correction: null, focus: null, turns: {},
  show: (correction, focus) => set({ open: true, correction: correction ?? null, focus: focus ?? null }),
  close: () => set({ open: false, correction: null, focus: null }),
  setTurn: (key, turn) => set((state) => ({ turns: Object.fromEntries([...Object.entries(state.turns).filter(([id]) => id !== key).slice(-31), [key, turn]]) })),
  clearTurn: (key, expected) => set((state) => {
    if (expected && state.turns[key] !== expected) return state;
    const turns = { ...state.turns };
    delete turns[key];
    return { turns };
  }),
}));
