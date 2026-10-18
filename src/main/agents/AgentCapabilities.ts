import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { GoogleStatus } from '../../shared/contracts/google';
import type { PermissionLevel } from '../../shared/contracts/ipc';

export const CAPABILITIES_TOOL_NAME = 'fate_capabilities';

export interface CapabilityState {
  permission: PermissionLevel;
  agentPermission: PermissionLevel;
  tools: ReadonlySet<string>;
  google: { enabled: boolean; status: GoogleStatus | null };
  memory: { global: boolean; project: boolean } | null;
  mcpServers: number;
}

const AGENT_CARD = 'Settings → Agent → Saved agents';
const levelNames: Record<PermissionLevel, string> = { 'read-only': 'Read only', edit: 'Edit files', 'full-access': 'Full access' };

function raise(state: CapabilityState, level: PermissionLevel): string {
  return state.agentPermission === level || state.agentPermission === 'full-access'
    ? `pick ${levelNames[level]} in the permission menu next to the chat box`
    : `set this Agent's permission to ${levelNames[level]} on its card in ${AGENT_CARD}, then pick it in the permission menu next to the chat box`;
}

function googleLine(state: CapabilityState): string {
  const { tools, google } = state;
  if (tools.has('google_mail_search')) {
    return google.status?.access === 'write'
      ? 'Gmail and Google Calendar: on. Read mail and events freely; every send or event change waits for the user\'s approval in this chat.'
      : 'Gmail and Google Calendar: on, read only. To send mail or change events, the user selects Allow sending in Settings → Agent → Google.';
  }
  const steps = [
    'In Google Cloud Console: create a project, enable the Gmail API and the Google Calendar API, set the OAuth consent screen to External with their own address as a test user, publish it to In production (in Testing the sign-in expires every 7 days), and create an OAuth client of type Desktop app.',
    'In Settings → Agent → Google: paste the client ID and secret, select Save client, then Connect and sign in. Select Allow sending if you should send mail or change events.',
    `On this Agent's card in ${AGENT_CARD}: turn on Google. This chat restarts with the mail and calendar tools.`,
  ];
  const status = google.status;
  const remaining = !status?.clientId ? steps : !status.account ? steps.slice(1) : steps.slice(2);
  return `Gmail and Google Calendar: off. Setup steps left:\n${remaining.map((step, index) => `  ${index + 1}. ${step}`).join('\n')}`;
}

export function describeCapabilities(state: CapabilityState): string {
  const { tools } = state;
  const has = (name: string) => tools.has(name);
  const memory = state.memory;
  return [
    `Permission: ${levelNames[state.permission]} in this chat; this Agent's limit is ${levelNames[state.agentPermission]}.`,
    'Projects: on. run_in_project starts background work in any project the user trusts (opened in Fate UI with Trust and open). Mode goal adds GoalMax with checked completion; runs can delegate to Agent Teams.',
    `Your folder: read, grep, find and ls${has('write') ? ', write and edit' : `; writing needs Edit files: ${raise(state, 'edit')}`}.`,
    has('bash') ? 'Shell: on.' : `Shell: off. It needs Full access: ${raise(state, 'full-access')}.`,
    has('web_search') ? 'Web: web_search and web_fetch are on.' : `Web: web_fetch is on; web_search is off. The user turns it on in Settings → Agent → Web search (queries go to Parallel).`,
    [...tools].some((name) => name.startsWith('browser_')) ? 'Browser: on while this chat is the open one.' : 'Browser: available only while this chat is the open one in the window.',
    googleLine(state),
    !memory ? 'Memory: unavailable here.'
      : memory.global || memory.project ? `Memory: on (${[memory.global ? 'GLOBAL profile' : '', memory.project ? 'this Agent\'s PROJECT store' : ''].filter(Boolean).join(' and ')}). remember saves a draft the user approves in Learning.`
        : 'Memory: off. The user turns on Settings → Memory Learning and its GLOBAL and PROJECT layers; then remember saves drafts they approve in Learning.',
    state.mcpServers === 0 ? 'MCP servers: none. The user adds them in Settings → MCP; calling them needs Full access.'
      : has('fate_mcp') && state.permission === 'full-access' ? `MCP servers: ${state.mcpServers} enabled, use fate_mcp.` : `MCP servers: ${state.mcpServers} enabled, but calling them needs Full access: ${raise(state, 'full-access')}.`,
    `PDFs: pdf_read is on${has('pdf_fill') ? '; pdf_fill and pdf_create are on' : '; filling and creating PDFs needs Edit files'}.`,
    has('generate_image') ? 'Images: generate_image is on.' : 'Images: off.',
    `Schedules: the user adds them on this Agent's card in ${AGENT_CARD}. A Routine posts a message into this chat on an interval; a Watch checks a public page for a change, text or a price and messages you only on a hit. Both run while Fate UI is open.`,
    'Results: every finished run lands in the Agents inbox and raises a notification.',
  ].join('\n');
}

export function createCapabilitiesTool(read: (sessionId: string) => Promise<CapabilityState>): ToolDefinition {
  return defineTool({
    name: CAPABILITIES_TOOL_NAME,
    label: 'Capabilities',
    promptSnippet: 'List what you can do right now and the exact steps to turn the rest on',
    description: 'Live list of what this Agent can do right now (projects, files, shell, web, browser, Gmail and Calendar, memory, MCP servers, PDFs, images, schedules) and, for anything off, the exact setup steps for the user. Call it when the user asks what you can do or wants something you lack.',
    parameters: Type.Object({}, { additionalProperties: false }),
    executionMode: 'parallel',
    execute: async (_id, _params, _signal, _update, ctx) => ({
      content: [{ type: 'text' as const, text: describeCapabilities(await read(ctx.sessionManager.getSessionId())) }],
      details: {},
    }),
  });
}
