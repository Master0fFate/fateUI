import { z } from 'zod';

export const MAX_WORD_ARCHIVE_BYTES = 16 * 1024 * 1024;
export const MAX_WORD_PARAGRAPHS = 512;
export const MAX_WORD_RUNS = 4096;
export const MAX_WORD_TEXT_LENGTH = 200_000;
export const MAX_WORD_NOTE_LENGTH = 2000;

export const isWordReviewPath = (path: string): boolean => path.toLowerCase().endsWith('.docx');

export const wordReviewChannels = {
  read: 'word-review:read',
  saveNote: 'word-review:save-note',
} as const;

const relativeWordPath = z.string().min(6).max(4096)
  .refine((path) => !/[\\:\u0000-\u001f\u007f]/u.test(path) && isWordReviewPath(path)
    && path.split('/').every((part) => part && part !== '.' && part !== '..'), 'A project-relative .docx path is required.');
const revision = z.string().regex(/^[0-9a-f]{64}$/u);
const paragraphId = z.number().int().min(1).max(MAX_WORD_PARAGRAPHS);
export const wordReviewNoteSchema = z.string().max(MAX_WORD_NOTE_LENGTH);
const wordRunSchema = z.object({
  text: z.string().min(1).max(MAX_WORD_TEXT_LENGTH),
  bold: z.literal(true).optional(),
  italic: z.literal(true).optional(),
  underline: z.literal(true).optional(),
}).strict();
const wordParagraphSchema = z.object({
  id: paragraphId,
  headingLevel: z.number().int().min(1).max(9).optional(),
  runs: z.array(wordRunSchema).max(MAX_WORD_RUNS),
  note: wordReviewNoteSchema.nullable(),
}).strict();

export const wordReviewReadInputSchema = z.object({ path: relativeWordPath }).strict();
export const wordReviewViewSchema = z.object({
  revision,
  notesAvailable: z.boolean(),
  paragraphs: z.array(wordParagraphSchema).max(MAX_WORD_PARAGRAPHS),
}).strict().refine(({ paragraphs }) => {
  let runs = 0;
  let length = 0;
  return paragraphs.every((paragraph, index) => {
    runs += paragraph.runs.length;
    for (const run of paragraph.runs) length += run.text.length;
    return paragraph.id === index + 1 && runs <= MAX_WORD_RUNS && length <= MAX_WORD_TEXT_LENGTH;
  });
}, 'The Word review exceeds preview limits.');
export const wordReviewSaveNoteInputSchema = z.object({ path: relativeWordPath, revision, paragraphId, note: wordReviewNoteSchema }).strict();
export const wordReviewSaveNoteResultSchema = z.object({ saved: z.literal(true) }).strict();

export type WordReviewRun = z.infer<typeof wordRunSchema>;
export type WordReviewParagraph = z.infer<typeof wordParagraphSchema>;
export type WordReviewView = z.infer<typeof wordReviewViewSchema>;
export type WordReviewSaveNoteInput = z.infer<typeof wordReviewSaveNoteInputSchema>;
export interface WordReviewApi {
  readWordReview: (input: z.infer<typeof wordReviewReadInputSchema>) => Promise<WordReviewView>;
  saveWordReviewNote: (input: WordReviewSaveNoteInput) => Promise<z.infer<typeof wordReviewSaveNoteResultSchema>>;
}
