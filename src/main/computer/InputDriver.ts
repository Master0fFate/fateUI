import type { KeyName } from './keys';

export type MouseButton = 'left' | 'right' | 'middle';

export type InputStep =
  | { readonly op: 'move'; readonly x: number; readonly y: number; readonly held: MouseButton | null }
  | { readonly op: 'button'; readonly button: MouseButton; readonly down: boolean; readonly clicks: number }
  | { readonly op: 'scroll'; readonly dx: number; readonly dy: number }
  | { readonly op: 'key'; readonly key: KeyName; readonly down: boolean }
  | { readonly op: 'text'; readonly text: string }
  | { readonly op: 'sleep'; readonly ms: number };

export interface InputDriver {
  readonly usesNativePixels: boolean;
  check(): Promise<string | null>;
  run(steps: readonly InputStep[]): Promise<void>;
  dispose(): void;
}
