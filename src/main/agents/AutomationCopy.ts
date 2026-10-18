import { createHash } from 'node:crypto';
import { automationDefinitionSchema } from '../../shared/contracts/automations';

const hash = (source: string) => createHash('sha256').update(source).digest('hex');

/** Copy-only migration proof. The archive is the exact source, not reserialized JSON. */
export function previewAutomationCopy(source: string) {
  if (Buffer.byteLength(source) > 2 * 1024 * 1024) throw new Error('Automation source exceeds the archive limit.');
  const automation = automationDefinitionSchema.parse(JSON.parse(source));
  return {
    source,
    sourceDigest: hash(source),
    sourceId: automation.id,
    task: {
      id: automation.id,
      name: automation.name,
      prompt: automation.prompt,
      messageRole: 'user' as const,
      permissionCeiling: automation.permissionLevel,
      projectPath: automation.projectPath,
    },
    archivedFields: ['createdAt', 'updatedAt', 'lastLaunchedAt', 'lastLaunchOutcome', 'launchCount'] as const,
    routine: null,
  };
}
