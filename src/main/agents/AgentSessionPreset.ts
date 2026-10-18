import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getAgentDir, type AgentSession, type Skill } from '@earendil-works/pi-coding-agent';
import { savedAgentSessionSchema, type SavedAgentSession } from '../../shared/contracts/agents';
import type { PermissionLevel } from '../../shared/contracts/ipc';
import { effectivePermission } from './RoutinePolicy';

export const SAVED_AGENT_SESSION_TYPE = 'fate-saved-agent-v1';
const presets = new WeakMap<AgentSession, SavedAgentSession>();
const allowed = new WeakMap<AgentSession, ReadonlySet<string>>();
export function readAgentSessionPreset(manager: { getEntries(): readonly unknown[] }): SavedAgentSession | null {
  const entries = manager.getEntries().filter((entry): entry is { type: string; customType: string; data: unknown } => Boolean(entry && typeof entry === 'object' && 'type' in entry && entry.type === 'custom' && 'customType' in entry && entry.customType === SAVED_AGENT_SESSION_TYPE));
  if (!entries.length) return null;
  if (entries.length !== 1) throw new Error('Saved Agent session has ambiguous ownership.');
  return savedAgentSessionSchema.parse(entries[0]!.data);
}
export function bindAgentSessionPreset(session: AgentSession, preset: SavedAgentSession, toolNames: readonly string[]): void {
  presets.set(session, preset);
  allowed.set(session, new Set(toolNames));
}
export const getAgentSessionPreset = (session: AgentSession): SavedAgentSession | undefined => presets.get(session);
export const presetPermission = (preset: SavedAgentSession, requested: PermissionLevel): PermissionLevel => effectivePermission(requested, preset.defaults.permission);
export function agentSessionPermission(session: AgentSession, requested: PermissionLevel): PermissionLevel {
  const preset = presets.get(session);
  return preset ? presetPermission(preset, requested) : requested;
}
export function filterAgentSessionTools(session: AgentSession, names: readonly string[]): string[] {
  const permitted = allowed.get(session);
  return permitted ? names.filter((name) => permitted.has(name)) : [...names];
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
export async function validateAgentSkills(skills: readonly Skill[], projectPath: string, agentDir = getAgentDir(), desktop = true): Promise<void> {
  const roots = await Promise.all([projectPath, agentDir, ...(desktop ? [path.join(os.homedir(), '.agents', 'skills')] : [])].map((root) => fs.realpath(root).catch(() => null)));
  for (const skill of skills) {
    const [file, directory, stat] = await Promise.all([fs.realpath(skill.filePath), fs.realpath(skill.baseDir), fs.stat(skill.filePath)]);
    if (!stat.isFile() || stat.size > 65_536 || !inside(directory, file) || !roots.some((root) => root && inside(root, directory))) throw new Error(`Skill ${skill.name} is outside trusted resource roots or exceeds 64 KiB.`);
  }
}
