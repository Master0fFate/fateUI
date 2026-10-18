import path from 'node:path';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

export const MAX_PDF_BYTES = 25 * 1024 * 1024;
const MAX_PDF_TEXT_CHARACTERS = 50_000;
const MAX_MARKDOWN_CHARACTERS = 200_000;

export interface PdfFiles {
  read: (filePath: string) => Promise<Buffer>;
  sameFile: (left: string, right: string) => Promise<boolean>;
  write: (filePath: string, content: Uint8Array) => Promise<void>;
}

function text(content: string) {
  return { content: [{ type: 'text' as const, text: content }], details: undefined };
}

function formatBytes(bytes: number): string {
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function defaultFilledPath(source: string): string {
  return path.join(path.dirname(source), `${path.basename(source, path.extname(source))}-filled.pdf`);
}

export function createPdfTools(files: PdfFiles): ToolDefinition[] {
  return [
    defineTool({
      name: 'pdf_read',
      label: 'Read PDF',
      description: `Read a PDF file: page count, metadata, AcroForm fields (name, type, current value, options, label) and the text of the selected pages. Returns up to ${MAX_PDF_TEXT_CHARACTERS / 1000}k characters of text per call. Files up to ${MAX_PDF_BYTES / 1024 / 1024} MB.`,
      promptSnippet: 'Read PDF text, page count, metadata and form fields',
      promptGuidelines: [
        'Use pdf_read for .pdf files; read cannot open them.',
        'pdf_read extracts the existing text layer only. Scanned pages without one come back empty.',
      ],
      parameters: Type.Object({
        path: Type.String({ minLength: 1, description: 'Path to the PDF, relative to the project or absolute.' }),
        pages: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: 'Pages to extract, such as "1-3,7" or "10-". Defaults to all pages up to the output limit.' })),
      }, { additionalProperties: false }),
      async execute(_toolCallId, params) {
        const bytes = await files.read(params.path);
        const { readPdf } = await import('./PdfDocuments');
        return text(await readPdf(bytes, params.pages, params.path, MAX_PDF_TEXT_CHARACTERS));
      },
    }),
    defineTool({
      name: 'pdf_fill',
      label: 'Fill PDF form',
      description: 'Fill AcroForm fields in a PDF and save the result as a new PDF, by default <name>-filled.pdf next to the source. The source PDF is kept unless replaceSource is true. Nothing is written if any field name or value is invalid.',
      promptSnippet: 'Fill PDF form fields into a new PDF copy',
      promptGuidelines: [
        'Call pdf_read first and use its exact field names, types and options with pdf_fill.',
        'Pass replaceSource: true to pdf_fill only when the user asked to overwrite the original PDF.',
        'Show the user the filled values from the pdf_fill result before the PDF is sent anywhere.',
      ],
      parameters: Type.Object({
        path: Type.String({ minLength: 1, description: 'Source PDF with the form.' }),
        fields: Type.Array(Type.Object({
          name: Type.String({ minLength: 1, description: 'Exact field name from pdf_read.' }),
          value: Type.Union([Type.String(), Type.Boolean(), Type.Array(Type.String())], {
            description: 'A string for text fields, radio groups and dropdowns; true or false for checkboxes; an array of options for list boxes.',
          }),
        }, { additionalProperties: false }), { minItems: 1, description: 'Fields to set. Fields not listed keep their current values.' }),
        output: Type.Optional(Type.String({ minLength: 1, description: 'Where to save the filled PDF. Defaults to <name>-filled.pdf next to the source.' })),
        flatten: Type.Optional(Type.Boolean({ description: 'Bake the values into the pages so the form can no longer be edited. Defaults to false.' })),
        replaceSource: Type.Optional(Type.Boolean({ description: 'Allow output to overwrite the source PDF. Only when the user asked for it.' })),
      }, { additionalProperties: false }),
      executionMode: 'sequential',
      async execute(_toolCallId, params) {
        const output = params.output ?? defaultFilledPath(params.path);
        if (!params.replaceSource && await files.sameFile(params.path, output)) {
          throw new Error('The output is the source PDF. Choose another output path, or pass replaceSource: true if the user asked to overwrite the original.');
        }
        const source = await files.read(params.path);
        const { fillPdf } = await import('./PdfDocuments');
        const filled = await fillPdf(source, params.fields, params.flatten === true);
        await files.write(output, filled.bytes);
        const count = params.fields.length;
        return text([`Filled ${count} field${count === 1 ? '' : 's'} from ${params.path} into ${output} (${formatBytes(filled.bytes.length)}).`, ...filled.report].join('\n'));
      },
    }),
    defineTool({
      name: 'pdf_create',
      label: 'Create PDF',
      description: 'Render simple Markdown or plain text (headings, paragraphs, lists, quotes, code blocks, rules) to a new PDF file. Uses the built-in Helvetica and Courier fonts, so characters outside Western European Latin print as "?".',
      promptSnippet: 'Render Markdown or plain text to a PDF file',
      parameters: Type.Object({
        path: Type.String({ minLength: 1, description: 'Where to save the PDF.' }),
        markdown: Type.String({ minLength: 1, maxLength: MAX_MARKDOWN_CHARACTERS, description: 'Markdown or plain text content.' }),
        title: Type.Optional(Type.String({ minLength: 1, maxLength: 300, description: 'Document title stored in the PDF metadata.' })),
        pageSize: Type.Optional(Type.Union([Type.Literal('A4'), Type.Literal('Letter')], { description: 'Defaults to A4.' })),
      }, { additionalProperties: false }),
      executionMode: 'sequential',
      async execute(_toolCallId, params) {
        const { renderMarkdownPdf } = await import('./PdfDocuments');
        const bytes = await renderMarkdownPdf(params.markdown, params.title, params.pageSize ?? 'A4');
        await files.write(params.path, bytes);
        return text(`Created ${params.path} (${formatBytes(bytes.length)}).`);
      },
    }),
  ];
}
