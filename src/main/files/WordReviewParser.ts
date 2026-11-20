import { crc32 } from 'node:zlib';
import { SaxesParser, type SaxesTagNS } from 'saxes';
import { fromBufferPromise, type Entry, type ZipFile } from 'yauzl';
import { MAX_WORD_PARAGRAPHS, MAX_WORD_RUNS, MAX_WORD_TEXT_LENGTH, type WordReviewParagraph, type WordReviewRun } from '../../shared/contracts/wordReview';
import { PiDesktopError } from '../pi/errors';

const DOCUMENT = 'word/document.xml';
const STYLES = 'word/styles.xml';
const PACKAGE_RELS = '_rels/.rels';
const RELATIONSHIPS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const documentTypes = new Set([
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument',
  'http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument',
]);
const MAX_ARCHIVE_ENTRIES = 2048;
const MAX_DOCUMENT_XML_BYTES = 2 * 1024 * 1024;
const MAX_STYLES_XML_BYTES = 512 * 1024;
const MAX_XML_NODES = 80_000;
const MAX_XML_DEPTH = 64;
const namespaces = new Set([
  'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  'http://purl.oclc.org/ooxml/wordprocessingml/main',
]);

export type WordSourceParagraph = Omit<WordReviewParagraph, 'note'>;

function unsupported(message = 'This .docx is damaged, encrypted, or not supported by Word preview.'): never {
  throw new PiDesktopError({ code: 'INVALID_REQUEST', message, retryable: false });
}

async function readPart(zip: ZipFile, entry: Entry, limit: number): Promise<Buffer> {
  if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize <= 0 || entry.uncompressedSize > limit) {
    unsupported('The Word XML exceeds preview limits (2 MiB for the document, 512 KiB for styles).');
  }
  const header = await zip.readLocalFileHeaderPromise(entry);
  if (!header.fileName.equals(entry.fileNameRaw) || header.compressionMethod !== entry.compressionMethod
    || header.generalPurposeBitFlag !== entry.generalPurposeBitFlag) unsupported();
  const output = Buffer.alloc(entry.uncompressedSize);
  let length = 0;
  const stream = await zip.openReadStreamPromise(entry);
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    if (length + chunk.length > output.length) unsupported();
    chunk.copy(output, length);
    length += chunk.length;
  }
  if (length !== output.length || crc32(output) !== entry.crc32) unsupported();
  return output;
}

function decodeXml(bytes: Buffer): { text: string; encoding: string } {
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le'
    : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
  return { text: new TextDecoder(encoding, { fatal: true }).decode(bytes), encoding };
}

function parseXml(bytes: Buffer, root: string, listeners: {
  open?: (name: string, parent: string, depth: number, val: (attribute: string) => string | undefined) => void;
  close?: (name: string, parent: string, depth: number) => void;
  text?: (value: string, name: string, depth: number) => void;
}, allowedNamespaces = namespaces): void {
  const { text, encoding } = decodeXml(bytes);
  const xml = new SaxesParser({ xmlns: true });
  const stack: string[] = [];
  let nodes = 0;
  let attrs = 0;
  let wordNamespace = '';
  xml.on('error', () => unsupported());
  xml.on('doctype', () => unsupported('Word previews do not support XML document type declarations.'));
  xml.on('xmldecl', (declaration) => {
    const declared = declaration.encoding?.toLowerCase();
    if (declared && declared !== encoding && !(declared === 'utf-16' && encoding.startsWith('utf-16'))) unsupported();
  });
  xml.on('opentagstart', (tag) => {
    attrs = 0;
    if (++nodes > MAX_XML_NODES || stack.length >= MAX_XML_DEPTH || tag.name.length > 256) {
      unsupported('The Word XML is too complex to preview.');
    }
  });
  xml.on('attribute', (attribute) => {
    if (++attrs > 64 || attribute.name.length > 256 || attribute.value.length > 4096) unsupported('The Word XML is too complex to preview.');
  });
  xml.on('opentag', (tag: SaxesTagNS) => {
    if (!stack.length) {
      if (!allowedNamespaces.has(tag.uri) || tag.local !== root) unsupported();
      wordNamespace = tag.uri;
    }
    const name = tag.uri === wordNamespace ? tag.local : '';
    listeners.open?.(name, stack.at(-1) ?? '', stack.length, (local) =>
      Object.values(tag.attributes).find((attribute) => attribute.local === local
        && attribute.uri === (wordNamespace === RELATIONSHIPS_NS ? '' : wordNamespace))?.value);
    stack.push(name);
  });
  xml.on('closetag', () => {
    const name = stack.pop()!;
    listeners.close?.(name, stack.at(-1) ?? '', stack.length);
  });
  const onText = (value: string) => listeners.text?.(value, stack.at(-1) ?? '', stack.length - 1);
  xml.on('text', onText);
  xml.on('cdata', onText);
  xml.write(text).close();
}

function assertStandardDocumentPart(bytes: Buffer): void {
  let standardParts = 0;
  parseXml(bytes, 'Relationships', { open(name, parent, depth, attr) {
    if (name !== 'Relationship' || parent !== 'Relationships' || depth !== 1 || !documentTypes.has(attr('Type') ?? '')) return;
    const target = attr('Target');
    const mode = attr('TargetMode');
    if (++standardParts !== 1 || (mode && mode !== 'Internal') || (target !== DOCUMENT && target !== `/${DOCUMENT}`)) {
      unsupported('This Word package uses an unsupported main document path.');
    }
  } }, new Set([RELATIONSHIPS_NS]));
  if (standardParts !== 1) unsupported('This file does not identify a main Word document.');
}

interface ParagraphStyle {
  level?: number | undefined;
  parent?: string | undefined;
}

const namedHeading = (value?: string): number | undefined => {
  const match = /^heading\s*([1-9])$/iu.exec(value ?? '');
  return match ? Number(match[1]) : undefined;
};
const outlineLevel = (value?: string): number | undefined => /^[0-9]$/u.test(value ?? '') ? Number(value) + 1 : undefined;

function readStyles(bytes: Buffer): Map<string, ParagraphStyle> {
  const styles = new Map<string, ParagraphStyle>();
  let style: (ParagraphStyle & { id: string }) | undefined;
  parseXml(bytes, 'styles', {
    open(name, parent, depth, attribute) {
      const val = attribute('val');
      if (name === 'style' && depth === 1 && attribute('type') === 'paragraph') {
        const id = attribute('styleId');
        if (id) style = { id };
      } else if (style && depth === 2 && name === 'name') style.level = namedHeading(val);
      else if (style && depth === 2 && name === 'basedOn') style.parent = val;
      else if (style && depth === 3 && name === 'outlineLvl' && parent === 'pPr') style.level = outlineLevel(val) ?? style.level;
    },
    close(name, _parent, depth) {
      if (name !== 'style' || depth !== 1 || !style) return;
      if (styles.size >= 1024 || styles.has(style.id)) unsupported('Word preview cannot read this document’s paragraph styles.');
      styles.set(style.id, { level: style.level ?? namedHeading(style.id), parent: style.parent });
      style = undefined;
    },
  });
  return styles;
}

function headingForStyle(id: string | undefined, styles: Map<string, ParagraphStyle>): number | undefined {
  for (let depth = 0; id && depth < 32; depth++) {
    const style = styles.get(id);
    const level = style?.level ?? namedHeading(id);
    if (level !== undefined) return level;
    id = style?.parent;
  }
  return undefined;
}

function readDocument(bytes: Buffer, styles: Map<string, ParagraphStyle>): WordSourceParagraph[] {
  const paragraphs: WordSourceParagraph[] = [];
  let paragraph: WordSourceParagraph | undefined;
  let styleId: string | undefined;
  let outline: number | undefined;
  let run: (Omit<WordReviewRun, 'text'> & { depth: number; chunks: string[] }) | undefined;
  let runProperties = false;
  let inRunText = false;
  let inParagraphProperties = false;
  let inHyperlink = false;
  let body = false;
  let totalText = 0;
  let totalRuns = 0;
  const append = (value: string) => {
    totalText += value.length;
    if (totalText > MAX_WORD_TEXT_LENGTH) unsupported('The Word document has too much text to preview.');
    if (value.length) run?.chunks.push(value);
  };
  parseXml(bytes, 'document', {
    open(name, parent, depth, attribute) {
      if (depth === 1 && name === 'body') {
        if (body) unsupported();
        body = true;
      } else if (depth === 2 && name === 'p' && parent === 'body') {
        if (paragraphs.length === MAX_WORD_PARAGRAPHS) unsupported('Word preview supports up to 512 body paragraphs.');
        paragraph = { id: paragraphs.length + 1, runs: [] };
      } else if (paragraph) {
        if (depth === 3 && name === 'pPr') inParagraphProperties = true;
        if (depth === 3 && name === 'hyperlink') inHyperlink = true;
        if (depth === 4 && inParagraphProperties) {
          if (name === 'pStyle') styleId = attribute('val');
          if (name === 'outlineLvl') outline = outlineLevel(attribute('val'));
        }
        if (name === 'r' && (depth === 3 || depth === 4 && inHyperlink)) run = { depth, chunks: [] };
        if (!run) return;
        if (depth === run.depth + 1) {
          if (name === 'rPr') runProperties = true;
          if (name === 't') inRunText = true;
          if (name === 'tab') append('\t');
          if (name === 'cr' || name === 'br' && !['page', 'column'].includes(attribute('type') ?? '')) append('\n');
        } else if (runProperties && depth === run.depth + 2) {
          const value = attribute('val');
          if (name === 'b' || name === 'i') {
            const field = name === 'b' ? 'bold' : 'italic';
            if (value === undefined || ['on', 'true', '1'].includes(value)) run[field] = true;
            else delete run[field];
          }
          if (name === 'u') {
            if (value && value !== 'none') run.underline = true;
            else delete run.underline;
          }
        }
      }
    },
    text(value, name, depth) {
      if (inRunText && name === 't' && run && depth === run.depth + 1) append(value);
    },
    close(name, _parent, depth) {
      if (run && depth === run.depth + 1) {
        if (name === 't') inRunText = false;
        if (name === 'rPr') runProperties = false;
      }
      if (run && name === 'r' && depth === run.depth && paragraph) {
        const { chunks, depth: _, ...format } = run;
        run = undefined;
        if (chunks.length) {
          if (++totalRuns > MAX_WORD_RUNS) unsupported('The Word document has too many text runs to preview.');
          paragraph.runs.push({ text: chunks.join(''), ...format });
        }
      }
      if (depth === 3 && name === 'hyperlink') inHyperlink = false;
      if (depth === 3 && name === 'pPr') inParagraphProperties = false;
      if (depth === 2 && name === 'p' && paragraph) {
        const level = outline ?? headingForStyle(styleId, styles);
        if (level !== undefined && level <= 9) paragraph.headingLevel = level;
        paragraphs.push(paragraph);
        paragraph = undefined;
        outline = undefined;
        styleId = undefined;
      }
    },
  });
  if (!body) unsupported();
  return paragraphs;
}

export async function parseWordReview(bytes: Buffer): Promise<WordSourceParagraph[]> {
  try {
    const zip = await fromBufferPromise(bytes, { lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true });
    try {
      if (zip.entryCount > MAX_ARCHIVE_ENTRIES) unsupported('The .docx archive contains too many parts to preview.');
      const entries = new Map<string, Entry>();
      for await (const entry of zip.eachEntry()) {
        if (entry.fileName !== DOCUMENT && entry.fileName !== STYLES && entry.fileName !== PACKAGE_RELS) continue;
        if (entries.has(entry.fileName) || !entry.canDecodeFileData()) unsupported();
        entries.set(entry.fileName, entry);
      }
      const document = entries.get(DOCUMENT);
      const relationships = entries.get(PACKAGE_RELS);
      if (!document || !relationships) unsupported();
      assertStandardDocumentPart(await readPart(zip, relationships, 128 * 1024));
      const styles = entries.get(STYLES);
      const styleMap = styles ? readStyles(await readPart(zip, styles, MAX_STYLES_XML_BYTES)) : new Map<string, ParagraphStyle>();
      return readDocument(await readPart(zip, document, MAX_DOCUMENT_XML_BYTES), styleMap);
    } finally {
      zip.close();
    }
  } catch (error) {
    if (error instanceof PiDesktopError) throw error;
    unsupported();
  }
}
