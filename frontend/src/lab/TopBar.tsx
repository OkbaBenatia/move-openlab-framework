import { useRef } from 'react';
import { BarChart3, CircleHelp, Download, PanelLeft, PanelRight, Play, PlayCircle, Shuffle, Upload } from 'lucide-react';
import type { Json } from '../api/client';
import type { Area } from '../geo/api';
import { CATEGORIES, type ExpItem } from './api';

export const ALL = '';
export const NEW = '__new__';

/** Workspace top bar: Area, Mobility data and Experiment selectors (experiments grouped by category), then the
 *  actions of the workflow: Generate, Run, Compare, Replay, Import, Export. */
export function TopBar({ areas, areaId, setArea, datasets, datasetKey, setDataset, experiments, expId, setExp, onGenerate, onRun, runDisabled, runTitle,
  onCompare, canCompare, onReplay, canReplay, replaying, onImport, onExport, canExport, onTour, onPanel }: {
  areas: Area[]; areaId: string; setArea: (id: string) => void; datasets: Json[]; datasetKey: string; setDataset: (k: string) => void;
  experiments: ExpItem[]; expId: string; setExp: (id: string) => void; onGenerate: () => void; onRun: () => void; runDisabled: boolean; runTitle: string;
  onCompare: () => void; canCompare: boolean; onReplay: () => void; canReplay: boolean; replaying: boolean;
  onImport: (f: File) => void; onExport: () => void; canExport: boolean; onTour: () => void; onPanel: (p: 'left' | 'right') => void;
}) {
  const file = useRef<HTMLInputElement>(null);
  const groups = CATEGORIES.map((c) => [c, experiments.filter((x) => x.category === c)] as const).filter(([, xs]) => xs.length);
  return <div className="labbar" role="toolbar" aria-label="workspace">
    <div className="row gap selectors" data-tour="context">
      <button className="btn icon only-narrow" aria-label="scenario panel" onClick={() => onPanel('left')}><PanelLeft size={15} /></button>
      <label className="sel"><span>Area</span><select aria-label="area" value={areaId} onChange={(e) => setArea(e.target.value)}>
        <option value={ALL}>All areas</option>{areas.map((a) => <option key={a.area_id} value={a.area_id}>{a.name}</option>)}</select></label>
      <label className="sel"><span>Mobility data</span><select aria-label="mobility data" value={datasetKey} onChange={(e) => setDataset(e.target.value)}>
        <option value={ALL}>All data</option>{datasets.map((d) => <option key={d.dataset_key} value={d.dataset_key}>{d.label ?? d.name}</option>)}</select></label>
      <label className="sel grow"><span>Experiment</span><select aria-label="experiment" value={expId} onChange={(e) => setExp(e.target.value)}>
        {!expId && <option value="">—</option>}
        {groups.map(([c, xs]) => <optgroup key={c} label={c}>{xs.map((x) => <option key={x.campaign_id} value={x.campaign_id}>{x.title}</option>)}</optgroup>)}
        <option value={NEW}>New experiment…</option></select></label>
    </div>
    <div className="row gap actions-bar">
      <button className="btn" onClick={onGenerate} data-tour="generate"><Shuffle size={14} /> Generate</button>
      <button className="btn primary" data-tour="run" onClick={onRun} disabled={runDisabled} title={runTitle}><Play size={14} /> Run</button>
      <button className="btn" data-tour="compare" onClick={onCompare} disabled={!canCompare}><BarChart3 size={14} /> Compare</button>
      <button className={`btn ${replaying ? 'primary' : ''}`} data-tour="replay" onClick={onReplay} disabled={!canReplay} aria-pressed={replaying}><PlayCircle size={14} /> Replay</button>
      <button className="btn" onClick={() => file.current?.click()}><Upload size={14} /> Import</button>
      <input ref={file} type="file" accept=".zip" hidden aria-label="bundle file" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onImport(f); }} />
      <button className="btn" onClick={onExport} disabled={!canExport}><Download size={14} /> Export</button>
      <button className="btn icon" aria-label="quick tour" title="Quick tour" onClick={onTour}><CircleHelp size={15} /></button>
      <button className="btn icon only-narrow" aria-label="results panel" onClick={() => onPanel('right')}><PanelRight size={15} /></button>
    </div>
  </div>;
}
