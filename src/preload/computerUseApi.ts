import {
  computerUseSetEnabledInputSchema,
  computerUseStateSchema,
  emptyInputSchema,
  ipcChannels,
  type PiDesktopApi,
} from '../shared/contracts/ipc';
import { invoke, subscribe } from './transport';

export const computerUseApi = {
  getComputerUseState: () => invoke(ipcChannels.computerUseGetState, emptyInputSchema, computerUseStateSchema),
  setComputerUseEnabled: (enabled) => invoke(ipcChannels.computerUseSetEnabled, computerUseSetEnabledInputSchema, computerUseStateSchema, { enabled }),
  onComputerUseState: (listener) => subscribe(ipcChannels.computerUseState, computerUseStateSchema, listener),
} satisfies Partial<PiDesktopApi>;
