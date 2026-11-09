import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Download, FileUp, GitCompareArrows, Lock, PanelLeft, PanelRight, Play, Plus, RotateCcw, ShieldCheck, Upload, PackageOpen } from 'lucide-react';
import { t } from '../i18n';
import type { ExpItem } from './api';
import { ExperimentPicker } from './ExperimentPicker';

export const NEW = '__new__';

/** Workspace toolbar: the experiment picker with its validation state, then the workflow actions in order —
 *  Generate, Import, Run (or Run again for a locked experiment), Compare, Export. Replay lives on the map. */
export function TopBar({ experiments, current, areaFilter, setAreaFilter, setExp, onGenerate, onRun, runLabel, runDisabled, runTitle, onCompare, canCompare,
  onImportFile, onTrySample, sampleAvailable, onExport, canExport, onPanel, onLibrary, comparePrimary }: {
  experiments: ExpItem[]; current: ExpItem | null; areaFilter: string; setAreaFilter: (a: string) => void; setExp: (id: string) => void;
  onGenerate: () => void; onRun: () => void; runLabel: 'run' | 'again'; runDisabled: boolean; runTitle: string; onCompare: () => void; canCompare: boolean;
  onImportFile: (f: File) => void; onTrySample: () => void; sampleAvailable: boolean; onExport: () => void; canExport: boolean;
  onPanel: (p: 'left' | 'right') => void; onLibrary: () => void; comparePrimary: boolean;
}) {
  const file = useRef<HTMLInputElement>(null);
  const [imp, setImp] = useState(false);
  const impRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!imp) return;
    const down = (e: MouseEvent) => { if (impRef.current && !impRef.current.contains(e.target as Node)) setImp(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setImp(false); };
    document.addEventListener('mousedown', down); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); };
  }, [imp]);
  const v = current?.validation;
  return <div className="labbar" role="toolbar" aria-label="workspace">
    <button className="btn icon only-narrow" aria-label="scenario panel" onClick={() => onPanel('left')}><PanelLeft size={15} /></button>
    <ExperimentPicker experiments={experiments} current={current} areaFilter={areaFilter} setAreaFilter={setAreaFilter} onPick={setExp} onNew={() => setExp(NEW)} onLibrary={onLibrary} />
    <span className="row gap state-chips">
      {current && current.status !== 'draft' && v && v.runs > 0 && <span className={`badge ${v.accepted === v.runs ? 'ok' : 'warn'}`} title="Independent validation: solutions accepted by the validator"><ShieldCheck size={13} />{t('ev.validated')} {v.accepted}/{v.runs}</span>}
      {current?.locked && <span className="badge"><Lock size={12} />Locked</span>}
      {current?.status === 'draft' && <span className="badge info">Ready to run</span>}
    </span>
    <span className="grow" />
    <div className="row gap actions-bar">
      <button className="btn" onClick={onGenerate} data-tour="generate"><Plus size={15} />{t('ws.generate')}</button>
      <div className="menu-wrap" ref={impRef}>
        <button className="btn" aria-haspopup="menu" aria-expanded={imp} onClick={() => setImp(!imp)}><Upload size={15} />{t('ws.import')}<ChevronDown size={13} /></button>
        {imp && <div className="menu left" role="menu">
          <button role="menuitem" className="mi" onClick={() => { setImp(false); file.current?.click(); }}><FileUp size={15} /><span className="grow">Import a bundle file…</span></button>
          <button role="menuitem" className="mi" disabled={!sampleAvailable} onClick={() => { setImp(false); onTrySample(); }}><PackageOpen size={15} /><span className="grow">{t('sample.title')}</span>{!sampleAvailable && <span className="tag-planned">Unavailable</span>}</button>
        </div>}
      </div>
      <input ref={file} type="file" accept=".zip" hidden aria-label="bundle file" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onImportFile(f); }} />
      <span className="vsep" />
      <button className={`btn ${comparePrimary ? '' : 'primary'}`} data-tour="run" onClick={onRun} disabled={runDisabled} title={runTitle}>
        {runLabel === 'again' ? <><RotateCcw size={15} />{t('ws.runAgain')}</> : <><Play size={15} />{t('ws.run')}</>}</button>
      <button className={`btn ${comparePrimary ? 'primary' : ''}`} data-tour="compare" onClick={onCompare} disabled={!canCompare}><GitCompareArrows size={15} />{t('ws.compare')}</button>
      <button className="btn" onClick={onExport} disabled={!canExport}><Download size={15} />{t('ws.export')}</button>
      <button className="btn icon only-narrow" aria-label="results panel" onClick={() => onPanel('right')}><PanelRight size={15} /></button>
    </div>
  </div>;
}
