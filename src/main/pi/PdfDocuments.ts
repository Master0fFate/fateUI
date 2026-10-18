import {
  PageSizes,
  PDFBool,
  PDFButton,
  PDFCheckBox,
  PDFDocument,
  PDFDropdown,
  PDFHexString,
  PDFName,
  PDFOptionList,
  PDFRadioGroup,
  PDFSignature,
  PDFString,
  PDFTextField,
  StandardFonts,
  type PDFField,
  type PDFFont,
  type PDFForm,
  type PDFPage,
} from 'pdf-lib';
import { getDocumentProxy } from 'unpdf';

const MAX_PDF_PAGES_PER_READ = 100;
const MAX_LISTED_FIELDS = 200;
const MAX_LISTED_OPTIONS = 50;

export type PdfFieldValue = string | boolean | string[];

function clip(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function formatPages(pages: readonly number[]): string {
  const ranges: string[] = [];
  for (let index = 0; index < pages.length;) {
    let end = index;
    while (end + 1 < pages.length && pages[end + 1] === pages[end]! + 1) end += 1;
    ranges.push(end === index ? `${pages[index]}` : `${pages[index]}-${pages[end]}`);
    index = end + 1;
  }
  return ranges.join(',');
}

function selectedPages(spec: string | undefined, pageCount: number): number[] {
  if (!spec?.trim()) return Array.from({ length: pageCount }, (_, index) => index + 1);
  const pages = new Set<number>();
  for (const part of spec.split(',')) {
    const match = /^\s*(\d+)\s*(?:-\s*(\d*)\s*)?$/u.exec(part);
    if (!match) throw new Error(`Invalid page range "${part.trim()}". Use forms like 1-3,7 or 10-.`);
    const first = Number(match[1]);
    const last = Math.min(match[2] === undefined ? first : match[2] === '' ? pageCount : Number(match[2]), pageCount);
    if (first < 1 || first > pageCount || last < first) throw new Error(`Page range ${part.trim()} is outside 1-${pageCount}.`);
    for (let page = first; page <= last; page += 1) pages.add(page);
  }
  return [...pages].sort((left, right) => left - right);
}

function fieldKind(field: PDFField): string {
  if (field instanceof PDFTextField) return 'text';
  if (field instanceof PDFCheckBox) return 'checkbox';
  if (field instanceof PDFRadioGroup) return 'radio';
  if (field instanceof PDFDropdown) return 'dropdown';
  if (field instanceof PDFOptionList) return 'list';
  if (field instanceof PDFSignature) return 'signature';
  if (field instanceof PDFButton) return 'button';
  return 'unknown';
}

function fieldValue(field: PDFField): string | undefined {
  if (field instanceof PDFTextField) return JSON.stringify(clip(field.getText() ?? '', 200));
  if (field instanceof PDFCheckBox) return String(field.isChecked());
  if (field instanceof PDFRadioGroup) return JSON.stringify(field.getSelected() ?? null);
  if (field instanceof PDFDropdown || field instanceof PDFOptionList) return JSON.stringify(field.getSelected());
  return undefined;
}

function fieldOptions(field: PDFField): string[] | undefined {
  return field instanceof PDFRadioGroup || field instanceof PDFDropdown || field instanceof PDFOptionList ? field.getOptions() : undefined;
}

function quotedOptions(options: readonly string[]): string {
  const listed = options.slice(0, MAX_LISTED_OPTIONS).map((option) => JSON.stringify(option)).join(', ');
  return options.length > MAX_LISTED_OPTIONS ? `${listed}, …${options.length - MAX_LISTED_OPTIONS} more` : listed;
}

function fieldLabel(field: PDFField): string | undefined {
  const label = field.acroField.dict.lookup(PDFName.of('TU'));
  return label instanceof PDFString || label instanceof PDFHexString ? label.decodeText().trim() || undefined : undefined;
}

function describeField(field: PDFField): string {
  const value = fieldValue(field);
  const options = fieldOptions(field);
  const label = fieldLabel(field);
  const maxLength = field instanceof PDFTextField ? field.getMaxLength() : undefined;
  const flags = [
    field.isRequired() ? 'required' : '',
    field.isReadOnly() ? 'read-only' : '',
    maxLength === undefined ? '' : `max ${maxLength} chars`,
    field instanceof PDFDropdown && field.isEditable() ? 'custom text allowed' : '',
    (field instanceof PDFDropdown || field instanceof PDFOptionList) && field.isMultiselect() ? 'multi-select' : '',
  ].filter(Boolean);
  return [
    `- ${JSON.stringify(field.getName())} ${fieldKind(field)}`,
    value === undefined ? '' : ` = ${value}`,
    options ? ` options: ${quotedOptions(options)}` : '',
    label ? ` label: ${JSON.stringify(clip(label, 200))}` : '',
    flags.length ? ` (${flags.join(', ')})` : '',
  ].join('');
}

async function describeForm(bytes: Uint8Array): Promise<string> {
  const document = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  if (document.isEncrypted) return 'Form fields: not listed, the PDF is encrypted.';
  const form = document.getForm();
  const fields = form.getFields();
  const xfa = form.hasXFA() ? ' The PDF also has an XFA layer; pdf_fill removes it so viewers show the filled fields.' : '';
  if (!fields.length) return `Form fields: none.${xfa}`;
  const listed = fields.slice(0, MAX_LISTED_FIELDS).map(describeField);
  if (fields.length > MAX_LISTED_FIELDS) listed.push(`- …${fields.length - MAX_LISTED_FIELDS} more fields not listed`);
  return [`Form fields (${fields.length}):${xfa}`, ...listed].join('\n');
}

export async function readPdf(bytes: Uint8Array, pagesSpec: string | undefined, displayPath: string, maxCharacters: number): Promise<string> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes), { disableFontFace: true, useSystemFonts: false, verbosity: 0 }).catch((error: unknown) => {
    throw error instanceof Error && error.name === 'PasswordException' ? new Error(`${displayPath} is password protected.`) : error;
  });
  try {
    const pages = selectedPages(pagesSpec, pdf.numPages);
    const { info } = await pdf.getMetadata();
    const form = Reflect.get(info, 'IsAcroFormPresent') === true
      ? await describeForm(bytes).catch((error: unknown) => `Form fields: unavailable (${clip(error instanceof Error ? error.message : String(error), 300)}).`)
      : Reflect.get(info, 'IsXFAPresent') === true ? 'Form fields: none that pdf_fill can set. The PDF uses an XFA-only form.' : 'Form fields: none.';
    const metadata = ['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer', 'CreationDate', 'ModDate'].flatMap((key) => {
      const value: unknown = Reflect.get(info, key);
      return typeof value === 'string' && value.trim() ? [`${key}: ${clip(value.trim(), 300)}`] : [];
    });
    const sections: string[] = [];
    let used = 0;
    let withText = 0;
    for (const pageNumber of pages) {
      if (sections.length >= MAX_PDF_PAGES_PER_READ || used >= maxCharacters) break;
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      page.cleanup();
      let pageText = content.items.map((item) => 'str' in item ? `${item.str}${item.hasEOL ? '\n' : ''}` : '').join('').trim();
      if (sections.length && used + pageText.length > maxCharacters) break;
      if (pageText.length > maxCharacters) pageText = `${pageText.slice(0, maxCharacters)}\n[rest of page ${pageNumber} cut at ${maxCharacters} characters]`;
      if (pageText) withText += 1;
      used += pageText.length;
      sections.push(`--- Page ${pageNumber} ---\n${pageText || '(no text layer)'}`);
    }
    const remaining = pages.slice(sections.length);
    return [
      `${displayPath}: ${pdf.numPages} page${pdf.numPages === 1 ? '' : 's'}`,
      ...metadata,
      '',
      form,
      '',
      ...sections,
      ...(remaining.length ? ['', `Output limit reached. Call pdf_read again with pages "${formatPages(remaining)}" for the rest.`] : []),
      ...(sections.length && !withText ? ['', 'None of these pages has a text layer, so they are probably scanned images. pdf_read does not run OCR.'] : []),
    ].join('\n');
  } finally {
    await pdf.loadingTask.destroy();
  }
}

function setField(field: PDFField, value: PdfFieldValue): void {
  if (field.isReadOnly()) throw new Error('the field is read-only');
  if (field instanceof PDFTextField) {
    if (typeof value !== 'string') throw new Error('text fields take a string');
    field.setText(value);
    return;
  }
  if (field instanceof PDFCheckBox) {
    if (typeof value !== 'boolean') throw new Error('checkboxes take true or false');
    if (value) field.check(); else field.uncheck();
    return;
  }
  const options = fieldOptions(field);
  if (!options) throw new Error(`${fieldKind(field)} fields cannot be filled`);
  const values = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
  const customAllowed = field instanceof PDFDropdown && field.isEditable();
  if (!values.length || (!customAllowed && values.some((item) => !options.includes(item)))) {
    throw new Error(`expected ${field instanceof PDFRadioGroup ? 'one' : 'one or more'} of ${quotedOptions(options)}`);
  }
  if (field instanceof PDFRadioGroup) {
    if (values.length !== 1) throw new Error('radio groups take one option');
    field.select(values[0]!);
    return;
  }
  (field as PDFDropdown | PDFOptionList).select(values);
}

function refreshAppearances(form: PDFForm): boolean {
  try {
    form.updateFieldAppearances();
    return true;
  } catch {
    form.acroForm.dict.set(PDFName.of('NeedAppearances'), PDFBool.True);
    return false;
  }
}

export async function fillPdf(bytes: Uint8Array, fields: readonly { name: string; value: PdfFieldValue }[], flatten: boolean): Promise<{ bytes: Uint8Array; report: string[] }> {
  const document = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  if (document.isEncrypted) throw new Error('The PDF is encrypted, so its form cannot be filled.');
  const form = document.getForm();
  const problems: string[] = [];
  const filled: PDFField[] = [];
  for (const { name, value } of fields) {
    const field = form.getFieldMaybe(name);
    if (!field) {
      problems.push(`${JSON.stringify(name)} is not a field in this PDF`);
      continue;
    }
    try {
      setField(field, value);
      filled.push(field);
    } catch (error) {
      problems.push(`${JSON.stringify(name)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (problems.length) throw new Error(`Nothing was written. ${problems.join('; ')}. Call pdf_read for the exact field names, types and options.`);
  const drawn = refreshAppearances(form);
  if (flatten && !drawn) throw new Error('Nothing was written. Some values use characters the built-in PDF font cannot draw, so the form cannot be flattened. Fill it without flatten.');
  const report = flatten ? fields.map(({ name, value }) => `- ${JSON.stringify(name)} = ${JSON.stringify(value)}`) : filled.map(describeField);
  const removedXfa = form.hasXFA();
  if (removedXfa) form.deleteXFA();
  if (flatten) form.flatten({ updateFieldAppearances: false });
  return {
    bytes: await document.save({ updateFieldAppearances: false }),
    report: [
      ...report,
      ...(flatten ? ['The form is flattened and can no longer be edited.'] : []),
      ...(drawn ? [] : ['Some values use characters the built-in PDF font cannot draw; PDF viewers redraw those fields when the file opens.']),
      ...(removedXfa ? ['Removed the XFA layer so viewers show the filled fields.'] : []),
    ],
  };
}

function inlineMarkdown(line: string): string {
  return line
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/gu, '$1 ($2)')
    .replace(/\*\*|__|`/gu, '');
}

export async function renderMarkdownPdf(markdown: string, title: string | undefined, pageSize: 'A4' | 'Letter'): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  if (title) document.setTitle(title);
  const body = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  const mono = await document.embedFont(StandardFonts.Courier);
  const supported = new Set(body.getCharacterSet());
  const encodable = (value: string) => Array.from(value.replace(/\t/gu, '    '), (character) => supported.has(character.codePointAt(0)!) ? character : '?').join('');
  const size = PageSizes[pageSize];
  const [pageWidth, pageHeight] = size;
  const margin = 56;
  const contentWidth = pageWidth - margin * 2;
  let page: PDFPage = document.addPage(size);
  let y = pageHeight - margin;
  const drawLine = (value: string, font: PDFFont, fontSize: number, indent = 0) => {
    const lineHeight = fontSize * 1.4;
    if (y - lineHeight < margin) {
      page = document.addPage(size);
      y = pageHeight - margin;
    }
    y -= lineHeight;
    if (value) page.drawText(value, { x: margin + indent, y, size: fontSize, font });
  };
  const breakWord = (word: string, font: PDFFont, fontSize: number, width: number): string[] => {
    const pieces: string[] = [];
    let piece = '';
    for (const character of word) {
      if (piece && font.widthOfTextAtSize(piece + character, fontSize) > width) {
        pieces.push(piece);
        piece = '';
      }
      piece += character;
    }
    return piece ? [...pieces, piece] : pieces;
  };
  const wrap = (value: string, font: PDFFont, fontSize: number, width: number): string[] => {
    const lines: string[] = [];
    let current = '';
    for (const word of value.split(/\s+/u).filter(Boolean).flatMap((item) => breakWord(item, font, fontSize, width))) {
      const candidate = current ? `${current} ${word}` : word;
      if (current && font.widthOfTextAtSize(candidate, fontSize) > width) {
        lines.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    return current ? [...lines, current] : lines;
  };
  const paragraph = (value: string, font: PDFFont, fontSize: number, indent = 0, marker = '') => {
    const markerWidth = marker ? font.widthOfTextAtSize(`${marker} `, fontSize) : 0;
    wrap(encodable(inlineMarkdown(value)), font, fontSize, contentWidth - indent - markerWidth).forEach((line, index) => {
      drawLine(index === 0 && marker ? `${marker} ${line}` : line, font, fontSize, index === 0 ? indent : indent + markerWidth);
    });
  };
  let pending: string[] = [];
  let fenced = false;
  const flush = () => {
    if (pending.length) paragraph(pending.join(' '), body, 11);
    pending = [];
  };
  for (const raw of markdown.replace(/\r\n?/gu, '\n').split('\n')) {
    if (/^\s*(```|~~~)/u.test(raw)) {
      flush();
      fenced = !fenced;
      continue;
    }
    if (fenced || /^\s*\|/u.test(raw)) {
      flush();
      for (const piece of breakWord(encodable(raw) || ' ', mono, 9.5, contentWidth)) drawLine(piece.trim() ? piece : '', mono, 9.5);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/u.exec(raw);
    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/u.exec(raw);
    if (heading) {
      flush();
      y -= 6;
      paragraph(heading[2]!, bold, [20, 16, 13, 12, 11, 11][heading[1]!.length - 1]!);
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/u.test(raw)) {
      flush();
      drawLine('', body, 6);
      page.drawLine({ start: { x: margin, y: y + 3 }, end: { x: pageWidth - margin, y: y + 3 }, thickness: 0.5 });
    } else if (item) {
      flush();
      paragraph(item[3]!, body, 11, 14 + Math.floor(item[1]!.length / 2) * 14, /^\d/u.test(item[2]!) ? item[2]! : '•');
    } else if (/^\s*>/u.test(raw)) {
      flush();
      paragraph(raw.replace(/^\s*>\s?/u, ''), body, 11, 14);
    } else if (!raw.trim()) {
      flush();
      y -= 5;
    } else {
      pending.push(raw.trim());
    }
  }
  flush();
  return document.save();
}
