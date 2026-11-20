import { assertScopedRead } from '../../core/handlers/agentHandlers';
import type { AdmissionAuthority } from '../../core/workspaces/WorkspaceAdmissionQueue';
import type { WorkspaceHandle } from '../../core/workspaces/WorkspaceHandle';
import { wordReviewChannels, wordReviewReadInputSchema, wordReviewSaveNoteInputSchema, wordReviewSaveNoteResultSchema, wordReviewViewSchema } from '../../shared/contracts/wordReview';
import type { FilesystemService } from '../files/FilesystemService';
import { WordReviewService } from '../files/WordReviewService';
import { PiDesktopError } from '../pi/errors';

type Scope = { workspace: WorkspaceHandle; authorize: () => AdmissionAuthority };
type Run<T> = (files: FilesystemService, current: () => boolean, scope?: Scope) => Promise<T>;

export function registerWordReviewIpc(
  register: (channel: string, handler: (event: Electron.IpcMainInvokeEvent, input: unknown) => Promise<unknown>) => void,
  settingsPath: () => string,
  withProject: <T>(event: Electron.IpcMainInvokeEvent, run: Run<T>) => Promise<T>,
): void {
  const reviews = new WordReviewService(settingsPath);
  const authorization = (files: FilesystemService, current: () => boolean, scope?: Scope) => {
    const assertFileScope = files.captureWordReviewScope();
    const assertCurrent = () => {
      if (!current()) throw new PiDesktopError({ code: 'INVALID_REQUEST', message: 'The local desktop project is no longer active.', retryable: true });
      assertFileScope();
      if (scope) assertScopedRead(scope.workspace, scope.authorize);
    };
    return async () => {
      assertCurrent();
      if (scope) await files.assertBoundRootIdentity();
      assertCurrent();
    };
  };
  register(wordReviewChannels.read, async (event, input) => {
    const { path } = wordReviewReadInputSchema.parse(input);
    return withProject(event, async (files, current, scope) =>
      wordReviewViewSchema.parse(await reviews.read(files, path, authorization(files, current, scope))));
  });
  register(wordReviewChannels.saveNote, async (event, input) => {
    const parsed = wordReviewSaveNoteInputSchema.parse(input);
    return withProject(event, async (files, current, scope) =>
      wordReviewSaveNoteResultSchema.parse(await reviews.saveNote(files, parsed, authorization(files, current, scope))));
  });
}
