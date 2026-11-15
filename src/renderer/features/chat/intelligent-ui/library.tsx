import { action, createLibrary, defineComponent, FormNameContext, reactive, useFormName, useIsStreaming, useStateField, useTriggerAction } from '@openuidev/react-lang';
import { cloneElement, createContext, useContext, useId, useState, type CSSProperties, type ReactElement, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { z } from 'zod/v4';
import { normalizeBrowserWebUrl } from '../../../../shared/contracts/browser';
import { openBrowserLink } from '../../browser/browserLink';
import { intelligentFunctions } from './functions';
import { INTERNAL_ACTION_FUNCTION, isSafeActionPlan } from './safety';

export const AnswerActionsContext = createContext({ canFollowUp: false, busy: false, feedback: (_text: string) => {} });
const children = z.array(z.any()).max(512);
const text = z.string().max(16_000);
const label = z.string().max(240);
const gap = z.number().min(0).max(6).optional();
const tone = z.enum(['default', 'muted', 'accent', 'success', 'warning', 'danger']);
const size = z.enum(['sm', 'md', 'lg', 'xl']);
const align = z.enum(['start', 'center', 'end', 'stretch']);
const justify = z.enum(['start', 'center', 'end', 'between']);
const option = z.union([label, z.object({ value: label, label })]);
const clamp = (value: number | undefined, min: number, max: number, fallback: number) => Number.isFinite(value) ? Math.min(max, Math.max(min, value!)) : fallback;
const spacing = (value: number | undefined) => value === undefined ? undefined : `${clamp(value, 0, 6, 3) * 4}px`;
const flexAlign = (value: string | undefined) => value === 'start' ? 'flex-start' : value === 'end' ? 'flex-end' : value === 'between' ? 'space-between' : value;
const shown = (value: unknown): string => typeof value === 'string' ? value.slice(0, 16_000) : typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
const choices = (value: unknown) => Array.isArray(value) ? value.slice(0, 128).flatMap((item: unknown) => typeof item === 'string' ? [{ value: item, label: item }] : item && typeof item === 'object' && typeof (item as { value?: unknown }).value === 'string' && typeof (item as { label?: unknown }).label === 'string' ? [item as { value: string; label: string }] : []) : [];

function useFieldName(statementId: string | undefined, fallback: string | undefined) {
  const id = useId();
  return statementId || fallback || id;
}

function Field({ label, children }: { label: string | undefined; children: ReactElement<{ id?: string }> }) {
  const id = useId();
  return <div className="iui-field"><label htmlFor={id}>{label || 'Value'}</label>{cloneElement(children, { id })}</div>;
}

function useAction() {
  const trigger = useTriggerAction();
  const formName = useFormName();
  const streaming = useIsStreaming();
  const context = useContext(AnswerActionsContext);
  const [running, setRunning] = useState(false);
  const supported = isSafeActionPlan;
  const unavailable = (plan: unknown) => !supported(plan) || plan.steps.some((step) => step.type === 'continue_conversation') && !context.canFollowUp;
  return {
    disabled: (plan: unknown) => streaming || context.busy || running || unavailable(plan),
    reason: (plan: unknown) => streaming ? 'Available when the answer is complete' : !supported(plan) ? 'No action available' : plan.steps.some((step) => step.type === 'continue_conversation') && !context.canFollowUp ? 'Follow-up unavailable in this conversation' : undefined,
    run: async (message: string, plan: unknown) => {
      if (streaming || context.busy || running || unavailable(plan) || !supported(plan)) return;
      setRunning(true);
      try {
        await trigger(message, formName, plan);
        if (!plan.steps.some((step) => step.type === 'continue_conversation')) context.feedback('Updated');
      } catch {
        context.feedback('Action failed. Try again.');
      } finally {
        setRunning(false);
      }
    },
  };
}

const Col = defineComponent({ name: 'Col', description: 'Vertical article layout; the recommended root.', props: z.object({ children, gap, align: align.optional() }), component: ({ props, renderNode }) => <div className="iui-col" style={{ gap: spacing(props.gap), alignItems: flexAlign(props.align) }}>{renderNode(props.children)}</div> });
const Row = defineComponent({ name: 'Row', description: 'Responsive horizontal group; wraps by default.', props: z.object({ children, gap, align: align.optional(), justify: justify.optional(), wrap: z.boolean().optional() }), component: ({ props, renderNode }) => <div className="iui-row" style={{ gap: spacing(props.gap), alignItems: flexAlign(props.align), justifyContent: flexAlign(props.justify), flexWrap: props.wrap === false ? 'nowrap' : 'wrap' }}>{renderNode(props.children)}</div> });
const Grid = defineComponent({ name: 'Grid', description: 'Responsive equal columns, default two.', props: z.object({ children, columns: z.number().optional(), minChildWidth: z.number().optional(), gap }), component: ({ props, renderNode }) => <div className="iui-grid" style={{ '--iui-columns': clamp(props.columns, 1, 4, 2), '--iui-min-width': `${clamp(props.minChildWidth, 120, 480, 220)}px`, gap: spacing(props.gap) } as CSSProperties}>{renderNode(props.children)}</div> });
const Card = defineComponent({ name: 'Card', description: 'Group a related section; avoid cards inside cards.', props: z.object({ children, variant: z.enum(['outline', 'soft']).optional(), padding: z.number().optional(), gap }), component: ({ props, renderNode }) => <section className={`iui-card${props.variant === 'soft' ? ' iui-card-soft' : ''}`} style={{ padding: props.padding === undefined ? undefined : spacing(props.padding), gap: spacing(props.gap) }}>{renderNode(props.children)}</section> });
const Divider = defineComponent({ name: 'Divider', description: 'Section divider.', props: z.object({}), component: () => <hr className="iui-divider" /> });
const Spacer = defineComponent({ name: 'Spacer', description: 'Fill free horizontal space.', props: z.object({}), component: () => <span className="iui-spacer" aria-hidden="true" /> });
const Title = defineComponent({ name: 'Title', description: 'Plain-text heading. Use lg once at the top; md inside sections.', props: z.object({ text, size: size.optional() }), component: ({ props }) => <h3 className={`iui-title iui-title-${props.size ?? 'md'}`}>{shown(props.text)}</h3> });
const Text = defineComponent({ name: 'Text', description: 'Plain text, including computed values; no HTML.', props: z.object({ text: z.union([text, z.number()]), size: size.optional(), tone: tone.optional() }), component: ({ props }) => <p className={`iui-text iui-text-${props.size ?? 'md'} iui-tone-${props.tone ?? 'default'}`}>{shown(props.text)}</p> });
const Caption = defineComponent({ name: 'Caption', description: 'Small readable supporting text.', props: z.object({ text }), component: ({ props }) => <p className="iui-caption">{shown(props.text)}</p> });
const Badge = defineComponent({ name: 'Badge', description: 'Short factual status; tone conveys status.', props: z.object({ text: label, tone: tone.optional() }), component: ({ props }) => <span className={`iui-badge iui-tone-${props.tone ?? 'muted'}`}>{shown(props.text)}</span> });
const Metric = defineComponent({ name: 'Metric', description: 'One important computed value with its label and optional supporting detail.', props: z.object({ label, value: z.union([text, z.number()]), detail: label.optional(), tone: tone.optional() }), component: ({ props }) => <div className={`iui-metric iui-tone-${props.tone ?? 'default'}`}><span className="iui-caption">{shown(props.label)}</span><strong>{shown(props.value)}</strong>{props.detail ? <span className="iui-caption">{shown(props.detail)}</span> : null}</div> });
const Callout = defineComponent({ name: 'Callout', description: 'Short warning or useful result.', props: z.object({ title: label, text: text.optional(), tone: tone.optional() }), component: ({ props }) => <aside className={`iui-callout iui-tone-${props.tone ?? 'accent'}`}><strong>{shown(props.title)}</strong>{props.text ? <p>{shown(props.text)}</p> : null}</aside> });
const Progress = defineComponent({ name: 'Progress', description: 'Measured progress; default maximum 100.', props: z.object({ value: z.number(), max: z.number().optional(), label: label.optional() }), component: ({ props }) => {
  const max = clamp(props.max, 0.001, 1e12, 100), value = clamp(props.value, 0, max, 0);
  return <div className="iui-progress">{props.label ? <span>{props.label}</span> : null}<progress value={value} max={max} aria-label={props.label || 'Progress'} /><output>{Math.round(value / max * 100)}%</output></div>;
} });
const Code = defineComponent({ name: 'Code', description: 'Non-executing code or preformatted text.', props: z.object({ code: text, language: label.optional() }), component: ({ props }) => <pre className="iui-code" aria-label={props.language || 'Code'}><code>{props.code}</code></pre> });

function SafeLink({ href, children }: { href: string; children: ReactNode }) {
  const normalized = normalizeBrowserWebUrl(href);
  const context = useContext(AnswerActionsContext);
  if (!normalized) return <span className="iui-link-disabled">{children}<small> Link unavailable</small></span>;
  return <a className="iui-link" href={normalized} title={normalized} onClick={(event) => { event.preventDefault(); void openBrowserLink(normalized).catch(() => context.feedback('Link could not be opened.')); }} onAuxClick={(event) => { event.preventDefault(); if (event.button === 1) void openBrowserLink(normalized).catch(() => context.feedback('Link could not be opened.')); }}>{children}</a>;
}

const Link = defineComponent({ name: 'Link', description: 'Explicit safe HTTP(S) link; opens through Fate browser controls on click.', props: z.object({ label, url: z.string().max(8192) }), component: ({ props }) => <SafeLink href={props.url}>{props.label}</SafeLink> });
const Markdown = defineComponent({ name: 'Markdown', description: 'Formatted text; no HTML, embedded media or automatic resources.', props: z.object({ text }), component: ({ props }) => <div className="iui-markdown"><ReactMarkdown skipHtml remarkPlugins={[remarkGfm]} urlTransform={(url) => normalizeBrowserWebUrl(url) ?? ''} components={{ a: ({ href, children }) => <SafeLink href={href ?? ''}>{children}</SafeLink>, img: () => null }}>{props.text}</ReactMarkdown></div> });

const Button = defineComponent({ name: 'Button', description: 'Run explicit local @Set/@Reset or user-initiated @ToAssistant. No implicit action.', props: z.object({ label, action: action().optional(), variant: z.enum(['solid', 'outline', 'soft', 'ghost']).optional(), disabled: z.boolean().optional() }), component: ({ props }) => {
  const action = useAction();
  return <button type="button" className={`iui-button iui-button-${props.variant ?? 'solid'}`} disabled={Boolean(props.disabled) || action.disabled(props.action)} title={action.reason(props.action)} onClick={() => { void action.run(props.label, props.action); }}>{shown(props.label)}</button>;
} });
const Form = defineComponent({ name: 'Form', description: 'Group fields whose values accompany @ToAssistant; optional submit action enables Enter.', props: z.object({ children, action: action().optional() }), component: function FormView({ props, renderNode, statementId }) {
  const id = useId();
  return <FormNameContext.Provider value={statementId || id}><FormBody plan={props.action}>{renderNode(props.children)}</FormBody></FormNameContext.Provider>;
} });

function FormBody({ children, plan }: { children: ReactNode; plan: unknown }) {
  const action = useAction();
  return <form className="iui-col" onSubmit={(event) => { event.preventDefault(); if (plan) void action.run('Submit', plan); }}>{children}{plan ? <button className="iui-submit" type="submit" disabled={action.disabled(plan)} tabIndex={-1} aria-hidden="true">Submit</button> : null}</form>;
}

const Input = defineComponent({ name: 'Input', description: 'Bound text or number input; number inputs store numbers or null when empty.', props: z.object({ value: reactive(z.union([text, z.number(), z.null()])), label: label.optional(), type: z.enum(['text', 'number']).optional(), placeholder: label.optional(), disabled: z.boolean().optional() }), component: ({ props, statementId }) => {
  const field = useStateField(useFieldName(statementId, props.label), props.value), streaming = useIsStreaming();
  return <Field label={props.label}><input className="iui-input" type={props.type === 'number' ? 'number' : 'text'} value={shown(field.value)} placeholder={props.placeholder} maxLength={2000} disabled={streaming || Boolean(props.disabled)} onChange={(event) => { const value = event.target.value.slice(0, 2000); if (props.type !== 'number') field.setValue(value); else field.setValue(value.trim() && Number.isFinite(Number(value)) ? Number(value) : null); }} /></Field>;
} });
const TextArea = defineComponent({ name: 'TextArea', description: 'Bound multiline text.', props: z.object({ value: reactive(text), label: label.optional(), placeholder: label.optional(), rows: z.number().optional(), disabled: z.boolean().optional() }), component: ({ props, statementId }) => {
  const field = useStateField(useFieldName(statementId, props.label), props.value), streaming = useIsStreaming();
  return <Field label={props.label}><textarea className="iui-input" rows={clamp(props.rows, 2, 10, 3)} value={shown(field.value)} placeholder={props.placeholder} maxLength={4000} disabled={streaming || Boolean(props.disabled)} onChange={(event) => field.setValue(event.target.value.slice(0, 4000))} /></Field>;
} });
const Select = defineComponent({ name: 'Select', description: 'Bound choice; options are strings or {value,label}.', props: z.object({ value: reactive(label), options: z.array(option).max(128), label: label.optional(), placeholder: label.optional(), disabled: z.boolean().optional() }), component: ({ props, statementId }) => {
  const field = useStateField(useFieldName(statementId, props.label), props.value), streaming = useIsStreaming(), options = choices(props.options), value = shown(field.value);
  return <Field label={props.label}><select className="iui-input" value={value} disabled={streaming || Boolean(props.disabled)} onChange={(event) => field.setValue(event.target.value)}>{!options.some((option) => option.value === value) ? <option value="" disabled>{props.placeholder || 'Choose…'}</option> : null}{options.map((option, index) => <option key={`${index}:${option.value}`} value={option.value}>{option.label}</option>)}</select></Field>;
} });
const Slider = defineComponent({ name: 'Slider', description: 'Bound number with visible label and current value.', props: z.object({ value: reactive(z.number()), min: z.number(), max: z.number(), step: z.number().optional(), label: label.optional(), unit: label.optional(), disabled: z.boolean().optional() }), component: ({ props, statementId }) => {
  const field = useStateField(useFieldName(statementId, props.label), props.value), streaming = useIsStreaming(), id = useId(), min = clamp(props.min, -1e9, 1e9, 0), max = Math.max(min + 0.001, clamp(props.max, -1e9, 1e9, 100)), value = clamp(Number(field.value), min, max, min);
  return <div className="iui-field"><div className="iui-slider-label"><label htmlFor={id}>{props.label || 'Value'}</label><output htmlFor={id}>{value.toLocaleString()} {props.unit}</output></div><input id={id} className="iui-range" type="range" min={min} max={max} step={clamp(props.step, 0.001, max - min, 1)} value={value} disabled={streaming || Boolean(props.disabled)} onChange={(event) => field.setValue(Number(event.target.value))} /></div>;
} });
const Checkbox = defineComponent({ name: 'Checkbox', description: 'Bound boolean checkbox.', props: z.object({ checked: reactive(z.boolean()), label, disabled: z.boolean().optional() }), component: ({ props, statementId }) => {
  const field = useStateField(useFieldName(statementId, props.label), props.checked), streaming = useIsStreaming();
  return <label className="iui-checkbox"><input type="checkbox" checked={field.value === true} disabled={streaming || Boolean(props.disabled)} onChange={(event) => field.setValue(event.target.checked)} /><span>{props.label}</span></label>;
} });
const SegmentedControl = defineComponent({ name: 'SegmentedControl', description: 'Bound short choices rendered as a radio group.', props: z.object({ value: reactive(label), options: z.array(option).max(8), label: label.optional() }), component: ({ props, statementId }) => {
  const field = useStateField(useFieldName(statementId, props.label), props.value), streaming = useIsStreaming();
  return <div className="iui-segmented" role="radiogroup" aria-label={props.label || 'Choice'}>{choices(props.options).map((option, index) => <button key={`${index}:${option.value}`} type="button" role="radio" aria-checked={field.value === option.value} disabled={streaming} onClick={() => field.setValue(option.value)}>{option.label}</button>)}</div>;
} });
const RadioGroup = defineComponent({ name: 'RadioGroup', description: 'Bound radio choices with a visible group label.', props: z.object({ value: reactive(label), options: z.array(option).max(32), label: label.optional() }), component: ({ props, statementId }) => {
  const field = useStateField(useFieldName(statementId, props.label), props.value), streaming = useIsStreaming(), name = useId();
  return <fieldset className="iui-radio"><legend>{props.label || 'Choice'}</legend>{choices(props.options).map((option, index) => <label key={`${index}:${option.value}`} className="iui-checkbox"><input type="radio" name={name} checked={field.value === option.value} disabled={streaming} onChange={() => field.setValue(option.value)} /><span>{option.label}</span></label>)}</fieldset>;
} });
const DatePicker = defineComponent({ name: 'DatePicker', description: 'Bound YYYY-MM-DD calendar date.', props: z.object({ value: reactive(label), label: label.optional(), min: label.optional(), max: label.optional() }), component: ({ props, statementId }) => {
  const field = useStateField(useFieldName(statementId, props.label), props.value), streaming = useIsStreaming();
  const date = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value) ? value : '';
  return <Field label={props.label}><input className="iui-input" type="date" value={date(field.value)} min={date(props.min)} max={date(props.max)} disabled={streaming} onChange={(event) => field.setValue(event.target.value)} /></Field>;
} });
const Details = defineComponent({ name: 'Details', description: 'Expandable supporting content; optional bound open state.', props: z.object({ label, children, open: reactive(z.boolean()).optional() }), component: ({ props, renderNode, statementId }) => {
  const field = useStateField(useFieldName(statementId, props.label), props.open), streaming = useIsStreaming();
  return <details className="iui-details" open={field.value === true} onToggle={(event) => { if (!streaming && event.currentTarget.open !== (field.value === true)) field.setValue(event.currentTarget.open); }}><summary>{props.label}</summary><div className="iui-col">{renderNode(props.children)}</div></details>;
} });
const Tabs = defineComponent({ name: 'Tabs', description: 'Bound tab choice; labels and panels have matching order. Only the selected panel is shown.', props: z.object({ value: reactive(label), labels: z.array(label).max(8), panels: z.array(z.any()).max(8), label: label.optional() }), component: ({ props, renderNode, statementId }) => {
  const field = useStateField(useFieldName(statementId, props.label), props.value), streaming = useIsStreaming(), id = useId(), labels = props.labels ?? [], selected = Math.max(0, labels.indexOf(shown(field.value)));
  return <div className="iui-tabs"><div className="iui-segmented" role="tablist" aria-label={props.label || 'Sections'}>{labels.map((label, index) => <button type="button" key={index} id={`${id}-tab-${index}`} role="tab" aria-controls={`${id}-panel`} aria-selected={index === selected} disabled={streaming} onClick={() => field.setValue(label)}>{label}</button>)}</div><div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-tab-${selected}`}>{renderNode(props.panels?.[selected])}</div></div>;
} });

const Table = defineComponent({ name: 'Table', description: 'Comparison table; rows contain plain values or library components. At most 128 displayed rows.', props: z.object({ headers: z.array(label).max(16), rows: z.array(z.array(z.any()).max(16)).max(512), caption: label.optional() }), component: ({ props, renderNode }) => {
  const headers = Array.isArray(props.headers) ? props.headers.slice(0, 16) : [], rows = Array.isArray(props.rows) ? props.rows : [];
  return <div className="iui-table-scroll" tabIndex={0} role="region" aria-label={props.caption || 'Data table'}><table className="iui-table">{props.caption ? <caption>{props.caption}</caption> : null}<thead><tr>{headers.map((header, index) => <th key={index} scope="col">{header}</th>)}</tr></thead><tbody>{rows.slice(0, 128).map((row, index) => <tr key={index}>{headers.map((_, column) => <td key={column}>{renderNode(Array.isArray(row) ? row[column] : null)}</td>)}</tr>)}</tbody></table>{!rows.length ? <p className="iui-caption">No matching rows</p> : null}{rows.length > 128 ? <p className="iui-caption">Showing 128 of {rows.length} rows</p> : null}</div>;
} });

function chartValue(value: number, format: string | undefined) {
  if (format === 'currency') return value.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  return value.toLocaleString('en-US', { maximumFractionDigits: 2 }) + (format === 'percent' ? '%' : '');
}

const Chart = defineComponent({ name: 'Chart', description: 'Local bar, line, area or donut chart from data rows. x names the label field; series names numeric fields. No remote resources.', props: z.object({ type: z.enum(['bar', 'line', 'area', 'donut']), data: z.array(z.record(z.string(), z.any())).max(512), x: label, series: z.array(label).min(1).max(4), format: z.enum(['number', 'currency', 'percent']).optional(), label: label.optional() }), component: ({ props }) => {
  const data = (Array.isArray(props.data) ? props.data : []).slice(0, 64), series = (Array.isArray(props.series) ? props.series : []).slice(0, 4), values = data.map((row) => series.map((key) => typeof row[key] === 'number' && Number.isFinite(row[key]) ? row[key] as number : 0)), all = values.flat(), min = Math.min(0, ...all), max = Math.max(1, ...all), range = max - min;
  const chartLabel = props.label || `${series.join(', ')} by ${props.x}`;
  if (!data.length || !series.length) return <div className="iui-chart-empty" role="status">No chart data</div>;
  const description = data.map((row, index) => `${shown(row[props.x])}: ${series.map((key, column) => `${key} ${chartValue(values[index]?.[column] ?? 0, props.format)}`).join(', ')}`).join('; ');
  if (props.type === 'bar') return <figure className="iui-chart" aria-label={chartLabel}><figcaption>{chartLabel}</figcaption><div className="iui-bars">{data.map((row, index) => <div className="iui-bar-row" key={index}><span title={shown(row[props.x])}>{shown(row[props.x])}</span><div>{series.map((key, column) => <div className="iui-bar-track" key={key}><span className={`iui-chart-color-${column}`} style={{ width: `${Math.max(0.5, Math.abs(values[index]?.[column] ?? 0) / Math.max(Math.abs(min), max) * 100)}%` }} /><output>{chartValue(values[index]?.[column] ?? 0, props.format)}</output></div>)}</div></div>)}</div>{series.length > 1 ? <div className="iui-chart-legend">{series.map((key, column) => <span key={key}><i className={`iui-chart-color-${column}`} />{key}</span>)}</div> : null}</figure>;
  if (props.type === 'donut') {
    const positive = values.map((row) => Math.max(0, row[0] ?? 0)), total = positive.reduce((sum, value) => sum + value, 0);
    let angle = 0;
    const stops = positive.map((value, index) => { const start = angle; angle += total ? value / total * 360 : 0; return `var(--iui-chart-${index % 4}) ${start}deg ${angle}deg`; });
    return <figure className="iui-chart" aria-label={chartLabel}><figcaption>{chartLabel}</figcaption><div className="iui-donut-layout"><div className="iui-donut" role="img" aria-label={description} style={{ background: total ? `conic-gradient(${stops.join(',')})` : 'var(--theme-border)' }}><span>{chartValue(total, props.format)}</span></div><div className="iui-chart-legend iui-chart-legend-vertical">{data.map((row, index) => <span key={index}><i className={`iui-chart-color-${index % 4}`} />{shown(row[props.x])}<output>{chartValue(positive[index] ?? 0, props.format)}</output></span>)}</div></div></figure>;
  }
  const x = (index: number) => 36 + index / Math.max(1, data.length - 1) * 548, y = (value: number) => 190 - (value - min) / range * 164;
  return <figure className="iui-chart" aria-label={chartLabel}><figcaption>{chartLabel}</figcaption><svg className="iui-line-chart" viewBox="0 0 608 224" role="img" aria-label={description}><line x1="36" y1="190" x2="584" y2="190" className="iui-chart-axis" /><text x="36" y="16">{chartValue(max, props.format)}</text><text x="36" y="213">{shown(data[0]?.[props.x]).slice(0, 28)}</text><text x="584" y="213" textAnchor="end">{shown(data[data.length - 1]?.[props.x]).slice(0, 28)}</text>{series.map((key, column) => { const points = data.map((_, index) => `${x(index)},${y(values[index]?.[column] ?? 0)}`).join(' '); return <g key={key} className={`iui-line-series-${column}`}>{props.type === 'area' ? <polygon points={`36,190 ${points} 584,190`} fill="currentColor" opacity="0.1" /> : null}<polyline points={points} fill="none" stroke="currentColor" strokeWidth="2.5" vectorEffect="non-scaling-stroke" />{data.map((row, index) => <circle key={index} cx={x(index)} cy={y(values[index]?.[column] ?? 0)} r="3" fill="currentColor"><title>{shown(row[props.x])}: {chartValue(values[index]?.[column] ?? 0, props.format)}</title></circle>)}</g>; })}</svg><div className="iui-chart-legend">{series.map((key, column) => <span key={key}><i className={`iui-chart-color-${column}`} />{key}</span>)}</div></figure>;
} });

export const intelligentLibrary = createLibrary({ root: 'Col', components: [Col, Row, Grid, Card, Divider, Spacer, Title, Text, Caption, Badge, Metric, Callout, Progress, Code, Link, Markdown, Button, Form, Input, TextArea, Select, Slider, Checkbox, SegmentedControl, RadioGroup, DatePicker, Details, Tabs, Table, Chart], functions: intelligentFunctions });
export const intelligentComponentNames = Object.keys(intelligentLibrary.components);
export const intelligentFunctionNames = intelligentFunctions.map((fn) => fn.name).filter((name) => name !== INTERNAL_ACTION_FUNCTION);
