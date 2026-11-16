import type { ReactNode } from 'react';
import type { Json, Metric } from '../api/client';
import { tr } from '../i18n';

export const sh = (h?: string | null, n = 10) => (h ? h.slice(0, n) : '—');
export const secs = (s?: number | null) => (s == null ? '—' : s < 1 ? `${(s * 1000).toFixed(s < 0.01 ? 2 : 1)} ms` : `${s.toFixed(2)} s`);
export const num = (v: unknown, d = 2) => (typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(d)) : '—');
export const errText = (e: unknown) => String(e instanceof Error ? e.message : e);
/** A (translated) sentence whose *starred* words are set in bold. */
export const bold = (s: string): ReactNode[] => s.split('*').map((x, i) => (i % 2 ? <b key={i}>{x}</b> : x));

export const KIND: Record<string, string> = {
  baseline: 'Baseline', reproduction: 'Re-execution', extended: 'Extended', variant: 'Controlled variant', 'threshold-study': 'Threshold study',
};
export const kindLabel = (c: Json) => (c.imported ? `Imported ${(KIND[c.kind] ?? c.kind).toLowerCase()}` : KIND[c.kind] ?? c.kind);

export function Lineage({ lineage }: { lineage: Json[] }) {
  const chain = [...lineage].reverse();
  return <div className="lineage" aria-label={tr('lineage')}>{chain.map((l, i) => <span key={l.campaign_id} className="row">
    {i > 0 && <span className="arrow" aria-hidden>→</span>}
    <span className="lin-node" title={`${l.campaign_id}${l.checksum ? ` · ${tr('checksum {h}', { h: sh(l.checksum, 16) })}` : ''}`}><b>{l.owner_display}</b> · {tr(KIND[l.kind] ?? l.kind)}</span></span>)}</div>;
}

export function MetricsCell({ metrics, defs }: { metrics: Json | null | undefined; defs: Metric[] }) {
  if (!metrics) return <>—</>;
  return <>{defs.map((m, i) => <span key={m.id}>{i > 0 && ' · '}<span title={tr(m.label)}>{num(metrics[m.id])}</span></span>)}</>;
}

export const STATUS_CLASS: Record<string, string> = { DIRECT: 'ok', CONDITIONAL: 'warn', INCOMPATIBLE: 'bad' };
export const STATUS_LABEL: Record<string, string> = { DIRECT: 'directly comparable', CONDITIONAL: 'conditionally comparable', INCOMPATIBLE: 'incompatible' };

export function ErrorNote({ text }: { text: string | null }) {
  return text ? <p className="note warn" role="alert">{text}</p> : null;
}
