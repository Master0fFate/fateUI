import { defineFunction } from '@openuidev/react-lang';
import { z } from 'zod/v4';
import { guardActionPlan, INTERNAL_ACTION_FUNCTION, isRuntimeData } from './safety';

const MAX_ITEMS = 512;
const list = z.array(z.unknown()).max(MAX_ITEMS);
const numbers = z.array(z.number()).max(MAX_ITEMS);
const text = z.string().max(16_000);
const date = z.union([text, z.number()]);
const aggregation = z.enum(['sum', 'avg', 'count', 'min', 'max']);
type Aggregation = z.infer<typeof aggregation>;

function bounded(value: unknown, depth = 0, budget = { left: 12_000, text: 32_000 }): unknown {
  if (--budget.left < 0 || depth > 24) throw new Error('Computation is too large.');
  if (typeof value === 'string' && (value.length > 16_000 || (budget.text -= value.length) < 0)) throw new Error('Text is too long.');
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Result is not finite.');
  if (Array.isArray(value)) {
    if (value.length > MAX_ITEMS) throw new Error('Too many items.');
    for (const item of value) bounded(item, depth + 1, budget);
  } else if (value && typeof value === 'object') {
    if (isRuntimeData(value)) throw new Error('Runtime expressions are not data.');
    for (const item of Object.values(value)) bounded(item, depth + 1, budget);
  }
  return value;
}

function define<T extends z.ZodRawShape>(name: string, description: string, shape: T, returns: z.ZodType, compute: (args: z.infer<z.ZodObject<T>>) => unknown) {
  const params = z.object(shape);
  return defineFunction({ name, description, params, returns, fn: (args) => { const input = params.parse(args); bounded(input); return bounded(compute(input)); } });
}

function read(value: unknown, field: string): unknown {
  if (!field) return value;
  let result = value;
  for (const key of field.split('.')) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype' || !result || typeof result !== 'object' || !Object.hasOwn(result, key)) return undefined;
    result = (result as Record<string, unknown>)[key];
  }
  return result;
}

function same(a: unknown, b: unknown): boolean {
  return a === b || (a != null && b != null && typeof a !== 'object' && typeof b !== 'object' && String(a) === String(b)) || JSON.stringify(a) === JSON.stringify(b);
}

function numeric(value: unknown): number | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function aggregate(rows: unknown[], field = '', how: Aggregation = 'sum'): number {
  if (how === 'count') return rows.length;
  const values = rows.map((row) => numeric(read(row, field))).filter((value): value is number => value !== null);
  if (!values.length) return 0;
  if (how === 'min') return Math.min(...values);
  if (how === 'max') return Math.max(...values);
  const sum = values.reduce((total, value) => total + value, 0);
  return how === 'avg' ? sum / values.length : sum;
}

function grouped(rows: unknown[], field: string): Map<string | number, unknown[]> {
  const groups = new Map<string | number, unknown[]>();
  for (const row of rows) {
    const raw = read(row, field);
    const key = typeof raw === 'number' ? raw : raw == null || raw === '' ? 'Unknown' : String(raw);
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  return groups;
}

function calendarDay(value: string | number): number {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    const timestamp = Date.parse(`${value}T00:00:00Z`);
    if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) throw new Error('Invalid date.');
    return timestamp / 86_400_000;
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid date.');
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000;
}

const isoDay = (day: number) => new Date(day * 86_400_000).toISOString().slice(0, 10);
const count = (value: number) => Math.max(0, Math.min(MAX_ITEMS, Math.trunc(value)));
const keyValues = z.array(z.object({ key: z.union([text, z.number()]), value: z.number() }));

export const intelligentFunctions = [
  defineFunction({ name: INTERNAL_ACTION_FUNCTION, description: 'Internal verified action.', params: z.object({ plan: z.unknown() }), returns: z.unknown(), fn: ({ plan }) => guardActionPlan(plan, actionFunctionNames) }),
  define('BoundedAdd', 'Bounded internal addition.', { left: z.unknown(), right: z.unknown() }, z.unknown(), ({ left, right }) => {
    if (typeof left === 'string' || typeof right === 'string') {
      const a = left == null ? '' : String(left), b = right == null ? '' : String(right);
      if (a.length + b.length > 16_000) throw new Error('Text is too long.');
      return a + b;
    }
    return (numeric(left) ?? (left === true ? 1 : 0)) + (numeric(right) ?? (right === true ? 1 : 0));
  }),
  define('BoundedValue', 'Bounded internal state value.', { value: z.unknown() }, z.unknown(), ({ value }) => value),
  define('Append', 'Copy with item added at the end.', { list, item: z.unknown() }, list, ({ list, item }) => [...list, item]),
  define('Prepend', 'Copy with item added at the start.', { list, item: z.unknown() }, list, ({ list, item }) => [item, ...list]),
  define('Concat', 'Join two lists.', { list, more: list }, list, ({ list, more }) => [...list, ...more]),
  define('Remove', 'Remove items whose field equals value; empty field compares items.', { list, field: text, value: z.unknown() }, list, ({ list, field, value }) => list.filter((item) => !same(read(item, field), value))),
  define('RemoveAt', 'Remove index; negative counts from the end.', { list, index: z.number() }, list, ({ list, index }) => list.filter((_, at) => at !== (index < 0 ? list.length + Math.trunc(index) : Math.trunc(index)))),
  define('Update', 'Copy matching rows with setField changed to setValue.', { list, field: text, value: z.unknown(), setField: text, setValue: z.unknown() }, list, ({ list, field, value, setField, setValue }) => {
    if (['__proto__', 'constructor', 'prototype'].includes(setField)) throw new Error('Invalid field.');
    return list.map((item) => item && typeof item === 'object' && !Array.isArray(item) && same(read(item, field), value) ? { ...item, [setField]: setValue } : item);
  }),
  define('Toggle', 'Add item if missing, remove it if present.', { list, item: z.unknown() }, list, ({ list, item }) => list.some((value) => same(value, item)) ? list.filter((value) => !same(value, item)) : [...list, item]),
  define('Includes', 'Whether a list has item or text contains it.', { list: z.union([list, text]), item: z.unknown() }, z.boolean(), ({ list, item }) => typeof list === 'string' ? list.includes(String(item)) : list.some((value) => same(value, item))),
  define('Find', 'First matching row, or null.', { list, field: text, value: z.unknown() }, z.unknown(), ({ list, field, value }) => list.find((item) => same(read(item, field), value)) ?? null),
  define('IndexOf', 'Item index, or -1.', { list, item: z.unknown() }, z.number(), ({ list, item }) => list.findIndex((value) => same(value, item))),
  define('Take', 'First n items; negative n takes the last n.', { list, n: z.number() }, list, ({ list, n }) => n < 0 ? list.slice(Math.trunc(n)) : list.slice(0, Math.trunc(n))),
  define('Slice', 'Items or characters from start to end, excluding end.', { list: z.union([list, text]), start: z.number(), end: z.number().optional() }, z.union([list, text]), ({ list, start, end }) => list.slice(Math.trunc(start), end === undefined ? undefined : Math.trunc(end))),
  define('Unique', 'Distinct items in first-seen order.', { list }, list, ({ list }) => {
    const seen = new Set<string>();
    return list.filter((item) => { const key = JSON.stringify(item) ?? 'undefined'; if (seen.has(key)) return false; seen.add(key); return true; });
  }),
  define('Reverse', 'Copy in reverse order.', { list }, list, ({ list }) => [...list].reverse()),
  define('Range', 'Numbers from start up to end, excluding end; step defaults to 1.', { start: z.number(), end: z.number(), step: z.number().optional() }, numbers, ({ start, end, step = 1 }) => {
    const length = Math.max(0, Math.ceil((end - start) / step));
    if (!step || !Number.isFinite(length) || length > MAX_ITEMS) throw new Error('Range is too large.');
    return Array.from({ length }, (_, index) => Number((start + index * step).toPrecision(12)));
  }),
  define('Pick', 'Random item; call inside @Set so it stays still.', { list }, z.unknown(), ({ list }) => list[Math.floor(Math.random() * list.length)] ?? null),
  define('Shuffle', 'Random order; call inside @Set.', { list }, list, ({ list }) => {
    const result = [...list];
    for (let index = result.length - 1; index > 0; index--) { const other = Math.floor(Math.random() * (index + 1)); [result[index], result[other]] = [result[other], result[index]]; }
    return result;
  }),
  define('Flatten', 'Flatten one level.', { list }, list, ({ list }) => list.flat()),
  define('Chunk', 'Split list into lists of size items.', { list, size: z.number() }, z.array(list), ({ list, size }) => {
    const length = Math.trunc(size);
    if (length < 1) throw new Error('Size must be positive.');
    return Array.from({ length: Math.ceil(list.length / length) }, (_, index) => list.slice(index * length, (index + 1) * length));
  }),
  define('Pow', 'Base raised to exponent.', { base: z.number(), exponent: z.number() }, z.number(), ({ base, exponent }) => Math.pow(base, exponent)),
  define('Sqrt', 'Square root.', { number: z.number() }, z.number(), ({ number }) => Math.sqrt(number)),
  define('Random', 'Random from min to max; integer includes max. Call inside @Set.', { min: z.number(), max: z.number(), integer: z.boolean().optional() }, z.number(), ({ min, max, integer }) => {
    const low = integer ? Math.ceil(Math.min(min, max)) : Math.min(min, max);
    const high = integer ? Math.floor(Math.max(min, max)) : Math.max(min, max);
    if (high < low) throw new Error('No integer in range.');
    return integer ? low + Math.floor(Math.random() * (high - low + 1)) : low + Math.random() * (high - low);
  }),
  define('Clamp', 'Keep number between min and max.', { number: z.number(), min: z.number(), max: z.number() }, z.number(), ({ number, min, max }) => Math.min(Math.max(number, Math.min(min, max)), Math.max(min, max))),
  define('Percent', 'Part / total * 100; zero for a zero total.', { part: z.number(), total: z.number() }, z.number(), ({ part, total }) => total === 0 ? 0 : part / total * 100),
  define('Lerp', 'Fraction t of the way from a to b.', { a: z.number(), b: z.number(), t: z.number() }, z.number(), ({ a, b, t }) => a + (b - a) * t),
  define('Payment', 'Payment per period; rate is percent per period.', { principal: z.number(), rate: z.number(), periods: z.number() }, z.number(), ({ principal, rate, periods }) => {
    if (periods <= 0) throw new Error('Periods must be positive.');
    const interest = rate / 100;
    return interest === 0 ? principal / periods : principal * interest / (1 - Math.pow(1 + interest, -periods));
  }),
  define('Format', 'Number, currency, percent (45 means 45%), or compact.', { value: z.number(), kind: z.enum(['number', 'currency', 'percent', 'compact']).optional(), decimals: z.number().optional(), currency: text.optional() }, text, ({ value, kind = 'number', decimals, currency = 'USD' }) => {
    const digits = decimals === undefined ? kind === 'currency' ? 2 : 2 : Math.max(0, Math.min(10, Math.trunc(decimals)));
    const options: Intl.NumberFormatOptions = { maximumFractionDigits: digits };
    if (kind === 'currency') { options.style = 'currency'; options.currency = /^[A-Z]{3}$/u.test(currency) ? currency : 'USD'; options.minimumFractionDigits = digits; }
    if (kind === 'compact') options.notation = 'compact';
    return value.toLocaleString('en-US', options) + (kind === 'percent' ? '%' : '');
  }),
  define('Join', 'Join items or their field, skipping nulls.', { list, sep: text.optional(), field: text.optional() }, text, ({ list, sep = ', ', field = '' }) => {
    const parts: string[] = [];
    let length = 0;
    for (const item of list) {
      const value = read(item, field);
      if (value == null) continue;
      const part = typeof value === 'object' ? JSON.stringify(value) : String(value);
      length += part.length + (parts.length ? sep.length : 0);
      if (length > 16_000) throw new Error('Joined text is too long.');
      parts.push(part);
    }
    return parts.join(sep);
  }),
  define('Plural', 'Count and word, using plural when count is not one.', { n: z.number(), word: text, plural: text.optional() }, text, ({ n, word, plural }) => `${n.toLocaleString('en-US')} ${Math.abs(n) === 1 ? word : plural ?? `${word}s`}`),
  define('Pad', 'Pad start to length, using char (default zero).', { value: z.union([text, z.number()]), length: z.number(), char: text.optional() }, text, ({ value, length, char = '0' }) => String(value).padStart(Math.min(1000, Math.max(0, Math.trunc(length))), char || '0')),
  define('Upper', 'Upper case.', { text }, text, ({ text }) => text.toUpperCase()),
  define('Lower', 'Lower case.', { text }, text, ({ text }) => text.toLowerCase()),
  define('Trim', 'Trim surrounding whitespace.', { text }, text, ({ text }) => text.trim()),
  define('Capitalize', 'Capitalize each word.', { text }, text, ({ text }) => text.replace(/(^|[\s\-(/"])(\p{L})/gu, (_, before: string, letter: string) => before + letter.toUpperCase())),
  define('Split', 'Split on sep (default comma), trimming and dropping empty parts.', { text, sep: text.optional() }, z.array(text), ({ text, sep = ',' }) => text.split(sep).map((part) => part.trim()).filter(Boolean)),
  define('Replace', 'Replace every literal find with replacement.', { text, find: text, replacement: text }, text, ({ text, find, replacement }) => {
    if (!find) return text;
    let matches = 0, offset = 0;
    while ((offset = text.indexOf(find, offset)) !== -1) { matches++; offset += find.length; }
    if (text.length + matches * (replacement.length - find.length) > 16_000) throw new Error('Replaced text is too long.');
    return text.split(find).join(replacement);
  }),
  define('Duration', 'Seconds as short text or clock.', { seconds: z.number(), style: z.enum(['short', 'clock']).optional() }, text, ({ seconds, style = 'short' }) => {
    const total = Math.round(Math.abs(seconds));
    const hours = Math.floor(total / 3600), minutes = Math.floor(total % 3600 / 60), remaining = total % 60;
    const pad = (value: number) => String(value).padStart(2, '0');
    const result = style === 'clock' ? hours ? `${hours}:${pad(minutes)}:${pad(remaining)}` : `${minutes}:${pad(remaining)}` : hours ? `${hours}h ${minutes}m` : minutes ? `${minutes}m ${pad(remaining)}s` : `${remaining}s`;
    return (seconds < 0 ? '-' : '') + result;
  }),
  define('Default', 'Fallback for null, empty text or a non-finite number.', { value: z.unknown().optional(), fallback: z.unknown() }, z.unknown(), ({ value, fallback }) => value == null || value === '' || typeof value === 'number' && !Number.isFinite(value) ? fallback : value),
  define('Now', 'Current time as ISO text; snapshot inside @Set.', {}, text, () => new Date().toISOString()),
  define('Today', 'Today in the viewer time zone as YYYY-MM-DD.', {}, text, () => isoDay(calendarDay(Date.now()))),
  define('FormatDate', 'Date as date, short, long, weekday, month, time, datetime or iso.', { date, style: z.enum(['date', 'short', 'long', 'weekday', 'month', 'time', 'datetime', 'iso']).optional() }, text, ({ date, style = 'date' }) => {
    if (style === 'iso') return isoDay(calendarDay(date));
    const calendar = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(date);
    const instant = calendar ? new Date(calendarDay(date) * 86_400_000) : new Date(date);
    const styles: Record<string, Intl.DateTimeFormatOptions> = { date: { month: 'short', day: 'numeric', year: 'numeric' }, short: { month: 'short', day: 'numeric' }, long: { dateStyle: 'full' }, weekday: { weekday: 'short' }, month: { month: 'short', year: 'numeric' }, time: { hour: 'numeric', minute: '2-digit' }, datetime: { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' } };
    return instant.toLocaleString('en-US', { ...styles[style], ...(calendar ? { timeZone: 'UTC' } : {}) });
  }),
  define('AddDays', 'Date days later as YYYY-MM-DD.', { date, days: z.number() }, text, ({ date, days }) => isoDay(calendarDay(date) + Math.trunc(days))),
  define('AddMonths', 'Date months later, clamped to the destination month.', { date, months: z.number() }, text, ({ date, months }) => {
    const value = new Date(calendarDay(date) * 86_400_000), target = value.getUTCMonth() + Math.trunc(months);
    const last = new Date(Date.UTC(value.getUTCFullYear(), target + 1, 0)).getUTCDate();
    return isoDay(Date.UTC(value.getUTCFullYear(), target, Math.min(value.getUTCDate(), last)) / 86_400_000);
  }),
  define('DaysBetween', 'Calendar days from one date to another.', { from: date, to: date }, z.number(), ({ from, to }) => calendarDay(to) - calendarDay(from)),
  define('MonthsBetween', 'Whole calendar months from one date to another.', { from: date, to: date }, z.number(), ({ from, to }) => {
    const first = new Date(calendarDay(from) * 86_400_000), last = new Date(calendarDay(to) * 86_400_000);
    let months = (last.getUTCFullYear() - first.getUTCFullYear()) * 12 + last.getUTCMonth() - first.getUTCMonth();
    if (months > 0 && last.getUTCDate() < first.getUTCDate()) months--;
    if (months < 0 && last.getUTCDate() > first.getUTCDate()) months++;
    return months;
  }),
  define('StartOf', 'First day of week (Monday), month or year.', { date, unit: z.enum(['week', 'month', 'year']) }, text, ({ date, unit }) => {
    const day = calendarDay(date), value = new Date(day * 86_400_000);
    return isoDay(unit === 'week' ? day - (value.getUTCDay() + 6) % 7 : Date.UTC(value.getUTCFullYear(), unit === 'month' ? value.getUTCMonth() : 0, 1) / 86_400_000);
  }),
  define('GroupBy', 'Rows {key,value}, aggregating field or counting rows without a field.', { rows: list, key: text, field: text.optional(), agg: aggregation.optional() }, keyValues, ({ rows, key, field, agg }) => [...grouped(rows, key)].map(([key, group]) => ({ key, value: aggregate(group, field, agg ?? (field ? 'sum' : 'count')) }))),
  define('Top', 'Largest n rows by field, or smallest with asc.', { rows: list, field: text, n: z.number(), direction: z.enum(['desc', 'asc']).optional() }, list, ({ rows, field, n, direction = 'desc' }) => [...rows].sort((a, b) => ((numeric(read(a, field)) ?? 0) - (numeric(read(b, field)) ?? 0)) * (direction === 'asc' ? 1 : -1)).slice(0, count(n))),
  define('Between', 'Rows with field between min and max inclusive; null leaves an open end.', { rows: list, field: text, min: z.unknown().optional(), max: z.unknown().optional() }, list, ({ rows, field, min, max }) => rows.filter((row) => {
    const value = read(row, field);
    if (value == null) return false;
    const compare = (other: unknown) => numeric(value) !== null && numeric(other) !== null ? numeric(value)! - numeric(other)! : String(value).localeCompare(String(other));
    return (min == null || compare(min) >= 0) && (max == null || compare(max) <= 0);
  })),
  define('Cumulative', 'Copy with field replaced by running total; empty field for numeric lists.', { rows: list, field: text }, list, ({ rows, field }) => {
    let total = 0;
    return rows.map((row) => { total += numeric(read(row, field)) ?? 0; return field ? { ...(row as object), [field]: total } : total; });
  }),
  define('MovingAvg', 'Copy with field replaced by average of its last window values.', { rows: list, field: text, window: z.number() }, list, ({ rows, field, window }) => {
    const size = Math.trunc(window);
    if (size < 1) throw new Error('Window must be positive.');
    const values = rows.map((row) => numeric(read(row, field)) ?? 0);
    let total = 0;
    return rows.map((row, index) => { total += values[index]!; if (index >= size) total -= values[index - size]!; const value = total / Math.min(index + 1, size); return field ? { ...(row as object), [field]: value } : value; });
  }),
  define('Change', 'Percent change from previous; null for zero previous.', { current: z.number(), previous: z.number() }, z.number().nullable(), ({ current, previous }) => previous === 0 ? null : (current - previous) / Math.abs(previous) * 100),
  define('Stats', 'Count, min, max, mean, median and population stdev; zeros for empty.', { values: numbers }, z.object({ count: z.number(), min: z.number(), max: z.number(), mean: z.number(), median: z.number(), stdev: z.number() }), ({ values }) => {
    if (!values.length) return { count: 0, min: 0, max: 0, mean: 0, median: 0, stdev: 0 };
    const sorted = [...values].sort((a, b) => a - b), count = values.length, mean = aggregate(values) / count, middle = Math.floor(count / 2);
    return { count, min: sorted[0], max: sorted[count - 1], mean, median: count % 2 ? sorted[middle] : (sorted[middle - 1]! + sorted[middle]!) / 2, stdev: Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / count) };
  }),
];

const actionFunctionNames: ReadonlySet<string> = new Set(intelligentFunctions.map((fn) => fn.name).filter((name) => name !== INTERNAL_ACTION_FUNCTION));
