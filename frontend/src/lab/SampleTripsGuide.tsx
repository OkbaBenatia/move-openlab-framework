import { useState } from 'react';
import { CheckCircle2, Database, Download, Shuffle, X } from 'lucide-react';
import { download, type Json } from '../api/client';
import { errText } from '../components/common';
import { tr } from '../i18n';

export interface SampleTrips { filename: string; title: string; rows: number; bytes: number; sha256: string; format: string; mapping: Record<string, string>;
  synthetic: boolean; licence: { id: string; name: string; url: string }; source: string }

/** "Try the sample trip dataset": the public scenario-import example through the real path — the same CSV import as
 *  Data setup › Mobility data (explicit column mapping, validation report), then Generate samples a scenario from it.
 *  A trip dataset is not an experiment bundle: results are imported with "Try an imported experiment". */
export function SampleTripsGuide({ sample, areaId, onClose, onGenerate, onLibrary, setErr }: {
  sample: SampleTrips; areaId?: string; onClose: () => void; onGenerate: (datasetKey: string) => void; onLibrary: () => void; setErr: (s: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<Json | null>(null);
  const add = async () => {
    setBusy(true); setErr(null);
    try {
      const raw = await fetch('/api/lab/sample/trips', { credentials: 'same-origin' });
      if (!raw.ok) throw new Error(`${raw.status}`);
      const fd = new FormData();
      fd.append('file', new File([await raw.blob()], sample.filename, { type: 'text/csv' }));
      fd.append('mapping', JSON.stringify(sample.mapping)); fd.append('name', sample.title.slice(0, 80)); fd.append('time_format', 'auto'); fd.append('date_format', 'YYYY-MM-DD');
      fd.append('save', 'true'); if (areaId) fd.append('area_id', areaId);
      const r = await fetch('/api/datasets/csv/import', { method: 'POST', body: fd, credentials: 'same-origin' });
      const body = await r.json();
      if (!r.ok) throw new Error(typeof body.detail === 'string' ? body.detail : `${r.status}`);
      setSaved(body.report);
    } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };
  return <div className="overlay" role="dialog" aria-label={tr('Try the sample trip dataset')} onClick={onClose}>
    <div className="drawer guide" onClick={(e) => e.stopPropagation()}>
      <div className="row gap drawer-head"><Database size={18} /><h2 className="grow">{tr('Try the sample trip dataset')}</h2><button className="btn icon ghost" aria-label={tr('close')} onClick={onClose}><X size={15} /></button></div>
      <section className="sec"><h3>{sample.title}</h3>
        <p className="small muted">{tr('A small public example of mobility data: {n} synthetic commuting trips in the Montbéliard area. It is generated (no observed or personal data) and dedicated to the public domain ({l}).', { n: sample.rows, l: sample.licence.id })}</p>
        <div className="row gap wrap"><button className="btn" onClick={() => download('/lab/sample/trips', sample.filename).catch((e) => setErr(errText(e)))}><Download size={14} /> {tr('Download the CSV file')}</button>
          <span className="small muted mono">{sample.filename} · {(sample.bytes / 1024).toFixed(1)} kB · SHA-256 {sample.sha256.slice(0, 12)}…</span></div>
        <p className="tiny muted">{sample.format} · {tr('columns')}: {Object.values(sample.mapping).join(', ')}</p></section>
      <section className="sec"><h3>1 · {tr('Add it to your mobility data')}</h3>
        <p className="small muted">{tr('The file goes through the normal CSV import: columns mapped explicitly, every row validated, a report of kept and rejected rows.')}</p>
        {!saved ? <button className="btn primary" disabled={busy} onClick={add}><Database size={14} /> {tr('Import the sample dataset')}</button>
          : <p className="note ok small"><CheckCircle2 size={14} /> {tr('Imported: {n} trips kept, {r} rejected.', { n: saved.trips ?? saved.rows_kept ?? sample.rows, r: Object.values((saved.rejected ?? {}) as Record<string, number>).reduce((a: number, b: number) => a + b, 0) })}</p>}
        <p className="tiny muted">{tr('By hand: Library › Data setup › 2 · Mobility data › upload the downloaded file and map its columns.')} <button className="btn link small" onClick={onLibrary}>{tr('Open Data setup')}</button></p></section>
      <section className="sec"><h3>2 · {tr('Generate a scenario from it')}</h3>
        <p className="small muted">{tr('Generate samples drivers and riders from the dataset on the area’s road network, then you choose methods and run. The road network of the area is needed: on a new installation it is downloaded once from OpenStreetMap.')}</p>
        <button className="btn" disabled={!saved} title={saved ? undefined : tr('Import the sample dataset first')} onClick={() => saved && onGenerate(saved.dataset_key)}><Shuffle size={14} /> {tr('Generate a scenario from this dataset')}</button></section>
      <p className="tiny muted">{tr('A trip dataset is not an experiment: to import results (an exported experiment), use Import › Try an imported experiment.')}</p>
    </div>
  </div>;
}
