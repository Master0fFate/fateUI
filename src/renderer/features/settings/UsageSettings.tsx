import { useEffect, useState } from 'react';
import type { UsageQueryResult, UsageTotals } from '../../../shared/contracts/usage';
import { SelectControl } from '../../components/SelectControl';
import { ipcErrorMessage } from '../../lib/ipcError';
import { getDesktopApi } from '../../platform/api';
import { useUiStore } from '../../stores/uiStore';

const usd = (value: number) => `$${value.toFixed(value >= 10 ? 2 : 4)}`;
const tokens = (value: number) => value >= 1_000_000 ? `${(value / 1_000_000).toFixed(2)}M` : value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
const WINDOW_OPTIONS = [7, 30, 90, 365].map((value) => ({ value: String(value), label: `${value} days` }));
const TOTAL_ROWS: readonly (readonly [string, (totals: UsageTotals) => string])[] = [
  ['Turns', (totals) => String(totals.turns)],
  ['Tokens in / out', (totals) => `${tokens(totals.input)} / ${tokens(totals.output)}`],
  ['Cache read / write', (totals) => `${tokens(totals.cacheRead)} / ${tokens(totals.cacheWrite)}`],
];

export function UsageSettings() {
  const compact = useUiStore((state) => state.compactMode);
  const [days, setDays] = useState(30);
  const [result, setResult] = useState<UsageQueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void getDesktopApi().queryUsage({ days }).then((value) => {
      if (!active) return;
      setResult(value);
      setError(null);
    }).catch((reason: unknown) => { if (active) setError(ipcErrorMessage(reason, 'Usage could not be loaded.')); });
    return () => { active = false; };
  }, [days]);
  const peak = Math.max(0, ...(result?.days.map((day) => day.costUsd) ?? []));
  const status = error ?? (!result ? 'Loading usage…' : result.window.turns ? null : `No turns recorded in the last ${days} days.`);
  return (
    <div className="settings-panel" role="tabpanel" id="settings-panel-usage" aria-labelledby="settings-tab-usage">
      <div className="settings-title">
        <div><h3>Usage</h3><p>Provider-reported cost for the open project. Unknown cost counts as zero.</p></div>
        <SelectControl compact={compact} label="Usage window" value={String(days)} options={WINDOW_OPTIONS} className="settings-theme-select" onValueChange={(value) => setDays(Number(value))} />
      </div>
      {result && result.window.turns > 0 && (
        <>
          <table className="usage-table"><thead><tr><th /><th>Today</th><th>{days} days</th></tr></thead>
            <tbody>
              <tr><td>Cost</td><td>{usd(result.today.costUsd)}{result.dailyBudgetUsd !== null ? ` of ${usd(result.dailyBudgetUsd)}` : ''}</td><td>{usd(result.window.costUsd)}</td></tr>
              {TOTAL_ROWS.map(([label, format]) => <tr key={label}><td>{label}</td><td>{format(result.today)}</td><td>{format(result.window)}</td></tr>)}
            </tbody>
          </table>
          {result.days.length > 0 && (
            <div className="usage-days" role="list" aria-label="Cost per day">
              {result.days.map((day) => (
                <div className="usage-day" role="listitem" key={day.day} title={`${day.day}: ${usd(day.costUsd)} · ${day.turns} turns`}>
                  <small>{day.day.slice(5)}</small>
                  <span className="usage-day-track"><span className="usage-day-bar" style={{ width: `${peak > 0 ? Math.max(2, (day.costUsd / peak) * 100) : 2}%` }} /></span>
                  <em>{usd(day.costUsd)}</em>
                </div>
              ))}
            </div>
          )}
          {result.models.length > 0 && (
            <section className="usage-section" aria-labelledby="usage-by-model"><h4 id="usage-by-model" className="usage-caption">By model</h4><table className="usage-table" aria-labelledby="usage-by-model"><thead><tr><th>Model</th><th>Turns</th><th>In</th><th>Out</th><th>Cost</th></tr></thead>
              <tbody>{result.models.map((row) => <tr key={row.model}><td>{row.model}</td><td>{row.turns}</td><td>{tokens(row.input)}</td><td>{tokens(row.output)}</td><td>{usd(row.costUsd)}</td></tr>)}</tbody></table></section>
          )}
          {result.sessions.length > 0 && (
            <section className="usage-section" aria-labelledby="usage-by-session"><h4 id="usage-by-session" className="usage-caption">By session</h4><table className="usage-table" aria-labelledby="usage-by-session"><thead><tr><th>Session</th><th>Turns</th><th>In</th><th>Out</th><th>Cost</th></tr></thead>
              <tbody>{result.sessions.map((row) => <tr key={row.sessionId}><td title={row.sessionId}>{row.sessionId.slice(0, 8)}</td><td>{row.turns}</td><td>{tokens(row.input)}</td><td>{tokens(row.output)}</td><td>{usd(row.costUsd)}</td></tr>)}</tbody></table></section>
          )}
        </>
      )}
      {status && <p className="settings-empty" role={error ? 'alert' : 'status'}>{status}</p>}
    </div>
  );
}
