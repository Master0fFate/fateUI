import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Type } from 'typebox';
import { defineTool, type InlineExtension, type ToolDefinition, type ToolResultEventResult } from '@earendil-works/pi-coding-agent';
import type { LspDiagnostic, LspDocumentSymbol, LspLocation, LspSymbolInformation } from './LspClient';
import { LspUnavailableError, type LspWorkspace } from './LspWorkspace';

const MAX_DIAGNOSTIC_LINES = 50;
const MAX_LOCATION_LINES = 100;
const MAX_SYMBOL_LINES = 200;
const EDIT_DIAGNOSTICS_WAIT_MS = 3_000;
const EDIT_DIAGNOSTICS_LINES = 20;
const SEVERITY = ['', 'error', 'warning', 'info', 'hint'] as const;
const SYMBOL_KINDS = ['', 'file', 'module', 'namespace', 'package', 'class', 'method', 'property', 'field', 'constructor', 'enum', 'interface', 'function', 'variable', 'constant', 'string', 'number', 'boolean', 'array', 'object', 'key', 'null', 'enum member', 'struct', 'event', 'operator', 'type parameter'] as const;

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function confinedFile(root: string, input: string): Promise<string> {
  const resolved = path.resolve(root, input);
  const canonical = path.normalize(await fs.realpath(resolved));
  if (!isContained(root, canonical)) throw new Error('Language server tools can inspect only files inside the active project.');
  return canonical;
}

function text(content: string) {
  return { content: [{ type: 'text' as const, text: content }], details: {} };
}

function relative(root: string, filePath: string): string {
  return isContained(root, filePath) ? path.relative(root, filePath).split(path.sep).join('/') : filePath;
}

function formatDiagnostics(workspace: LspWorkspace, filePath: string, diagnostics: readonly LspDiagnostic[], limit: number): string[] {
  const shown = relative(workspace.rootPath, filePath);
  return [...diagnostics]
    .sort((left, right) => (left.severity ?? 9) - (right.severity ?? 9) || left.range.start.line - right.range.start.line)
    .slice(0, limit)
    .map((diagnostic) => `${shown}:${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1} ${SEVERITY[diagnostic.severity ?? 0] || 'diagnostic'} ${diagnostic.message.replace(/\s+/g, ' ').trim()}${diagnostic.code !== undefined ? ` [${diagnostic.source ? `${diagnostic.source} ` : ''}${diagnostic.code}]` : ''}`);
}

function formatLocations(workspace: LspWorkspace, locations: readonly LspLocation[]): string {
  if (locations.length === 0) return 'No locations found.';
  const lines = locations.slice(0, MAX_LOCATION_LINES).map((location) => `${relative(workspace.rootPath, workspace.pathFor(location.uri))}:${location.range.start.line + 1}:${location.range.start.character + 1}`);
  return locations.length > MAX_LOCATION_LINES ? `${lines.join('\n')}\n[${locations.length - MAX_LOCATION_LINES} more locations omitted]` : lines.join('\n');
}

function flattenSymbols(symbols: readonly (LspDocumentSymbol | LspSymbolInformation)[], depth: number, lines: string[], workspace: LspWorkspace): void {
  for (const symbol of symbols) {
    if (lines.length >= MAX_SYMBOL_LINES) return;
    const kind = SYMBOL_KINDS[symbol.kind] ?? 'symbol';
    if ('location' in symbol) {
      lines.push(`${kind} ${symbol.containerName ? `${symbol.containerName}.` : ''}${symbol.name} ${relative(workspace.rootPath, workspace.pathFor(symbol.location.uri))}:${symbol.location.range.start.line + 1}`);
      continue;
    }
    lines.push(`${'  '.repeat(depth)}${kind} ${symbol.name} :${symbol.selectionRange.start.line + 1}`);
    if (symbol.children?.length) flattenSymbols(symbol.children, depth + 1, lines, workspace);
  }
}

const filePath = Type.String({ minLength: 1, maxLength: 4_096, description: 'Project-relative or absolute path inside the active project.' });
const line = Type.Integer({ minimum: 1, description: '1-based line number.' });
const character = Type.Integer({ minimum: 1, description: '1-based column number.' });

export function createLspTools(workspace: LspWorkspace): ToolDefinition[] {
  const guidelines = ['Language server results reflect the file on disk; write or edit first, then inspect.', 'Prefer lsp_diagnostics over running a full build to check a single file.'];
  const run = async (work: () => Promise<string>) => {
    try {
      return text(await work());
    } catch (error) {
      if (error instanceof LspUnavailableError) return text(`Language server unavailable: ${error.message}`);
      throw error;
    }
  };
  return [
    defineTool({
      name: 'lsp_diagnostics',
      label: 'Diagnostics',
      description: 'Return compiler and linter diagnostics for one project file from its language server.',
      promptSnippet: 'Get language server diagnostics for a file',
      promptGuidelines: guidelines,
      parameters: Type.Object({ path: filePath }, { additionalProperties: false }),
      executionMode: 'parallel',
      execute: (_id, params) => run(async () => {
        const target = await confinedFile(workspace.rootPath, params.path);
        const result = await workspace.diagnosticsFor(target);
        if (result.diagnostics.length === 0) return result.received ? 'No diagnostics.' : 'No diagnostics received yet; the language server may still be indexing.';
        const lines = formatDiagnostics(workspace, target, result.diagnostics, MAX_DIAGNOSTIC_LINES);
        return `${result.diagnostics.length} diagnostics${result.diagnostics.length > lines.length ? ` (showing ${lines.length})` : ''}:\n${lines.join('\n')}`;
      }),
    }),
    defineTool({
      name: 'lsp_definition',
      label: 'Go to definition',
      description: 'Resolve the definition of the symbol at a position.',
      promptSnippet: 'Jump to a symbol definition through the language server',
      promptGuidelines: guidelines,
      parameters: Type.Object({ path: filePath, line, character }, { additionalProperties: false }),
      executionMode: 'parallel',
      execute: (_id, params) => run(async () => formatLocations(workspace, await workspace.definition(await confinedFile(workspace.rootPath, params.path), { line: params.line - 1, character: params.character - 1 }))),
    }),
    defineTool({
      name: 'lsp_references',
      label: 'Find references',
      description: 'List every reference to the symbol at a position across the project.',
      promptSnippet: 'Find all references to a symbol through the language server',
      promptGuidelines: guidelines,
      parameters: Type.Object({ path: filePath, line, character, includeDeclaration: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
      executionMode: 'parallel',
      execute: (_id, params) => run(async () => formatLocations(workspace, await workspace.references(await confinedFile(workspace.rootPath, params.path), { line: params.line - 1, character: params.character - 1 }, params.includeDeclaration ?? true))),
    }),
    defineTool({
      name: 'lsp_symbols',
      label: 'Symbols',
      description: 'List the symbols in one file, or search workspace symbols by name when a query is given.',
      promptSnippet: 'List file symbols or search workspace symbols through the language server',
      promptGuidelines: guidelines,
      parameters: Type.Object({ path: Type.Optional(filePath), query: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })) }, { additionalProperties: false }),
      executionMode: 'parallel',
      execute: (_id, params) => run(async () => {
        if (!params.path && !params.query) throw new Error('Provide a file path or a symbol query.');
        const symbols = params.path ? await workspace.documentSymbols(await confinedFile(workspace.rootPath, params.path)) : await workspace.workspaceSymbols(params.query!);
        const lines: string[] = [];
        flattenSymbols(symbols, 0, lines, workspace);
        return lines.length ? lines.join('\n') : 'No symbols found.';
      }),
    }),
  ];
}

export function createLspDiagnosticsExtension(workspace: LspWorkspace): InlineExtension {
  return {
    name: 'fate-lsp',
    hidden: true,
    factory(pi) {
      pi.on('tool_result', async (event): Promise<ToolResultEventResult | undefined> => {
        if (event.isError || (event.toolName !== 'write' && event.toolName !== 'edit')) return undefined;
        const edited = event.input.path;
        if (typeof edited !== 'string') return undefined;
        let target: string;
        try {
          target = await confinedFile(workspace.rootPath, edited);
        } catch {
          return undefined;
        }
        if (!workspace.serverFor(target)) return undefined;
        let result;
        try {
          result = await workspace.diagnosticsFor(target, EDIT_DIAGNOSTICS_WAIT_MS);
        } catch {
          return undefined;
        }
        const relevant = result.diagnostics.filter((diagnostic) => (diagnostic.severity ?? 1) <= 2);
        if (relevant.length === 0) return undefined;
        const lines = formatDiagnostics(workspace, target, relevant, EDIT_DIAGNOSTICS_LINES);
        return {
          content: [...event.content, { type: 'text', text: `\nDiagnostics after ${event.toolName} (${relevant.length}):\n${lines.join('\n')}` }],
          ...(event.structuredContent !== undefined ? { structuredContent: event.structuredContent } : {}),
        };
      });
    },
  };
}
