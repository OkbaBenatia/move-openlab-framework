import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Download, FileUp, GitCompareArrows, Lock, PanelLeft, PanelRight, Play, Plus, RotateCcw, ShieldCheck, Upload, PackageOpen } from 'lucide-react';
import { t } from '../i18n';
import type { ExpItem } from './api';
import { ExperimentPicker } from './ExperimentPicker';
import { useInViewport } from '../components/useInViewport';

export const NEW = '__new__';

/** Workspace toolbar: the experiment picker with its validation state, then the workflow actions in order —
 *  Generate, Import, Run (or Run again for a locked experiment), Compare, Export. Replay lives on the map. */
export function TopBar({ experiments, current, areaFilter, setAreaFilter, setExp, onGenerate, onRun, runLabel, runDisabled, runTitle, onCompare, canCompare,
  onImport, onTrySample, sampleAvailable, onExport, canExport, onPanel, onLibrary, comparePrimary }: {
  experiments: ExpItem[]; current: ExpItem | null; areaFilter: string; setAreaFilter: (a: string) => void; setExp: (id: string) => void;
  onGenerate: () => void; onRun: () => void; runLabel: 'run' | 'again'; runDisabled: boolean; runTitle: string; onCompare: () => void; canCompare: boolean;
  onImport: () => void; onTrySample: () => void; sampleAvailable: boolean; onExport: () => void; canExport: boolean;
  onPanel: (p: 'left' | 'right') => void; onLibrary: () => void; comparePrimary: boolean;
}) {
  const [imp, setImp] = useState(false);
  const impRef = useRef<HTMLDivElement>(null);
  const impBtn = useRef<HTMLButtonElement>(null);
  const impMenu = useRef<HTMLDivElement>(null);
  useInViewport(impMenu, imp);
  // keyboard: the first item takes the focus, arrows move between items, Escape closes and returns to the button
  const items = () => Array.from(impRef.current?.querySelectorAll<HTMLButtonElement>('[role=menuitem]:not(:disabled)') ?? []);
  useEffect(() => { if (imp) items()[0]?.focus(); }, [imp]);
  const onMenuKey = (e: React.KeyboardEvent) => {
    const list = items(), i = list.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); list[(i + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length]?.focus(); }
    if (e.key === 'Tab') setImp(false);
  };
  useEffect(() => {
    if (!imp) return;
    const down = (e: MouseEvent) => { if (impRef.current && !impRef.current.contains(e.target as Node)) setImp(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { setImp(false); impBtn.current?.focus(); } };
    document.addEventListener('mousedown', down); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); };
  }, [imp]);
  const v = current?.validation;
  return <div className="labbar" role="toolbar" aria-label="workspace">
    <button className="btn icon only-narrow" aria-label="scenario panel" onClick={() => onPanel('left')}><PanelLeft size={15} /></button>
    <ExperimentPicker experiments={experiments} current={current} areaFilter={areaFilter} setAreaFilter={setAreaFilter} onPick={setExp} onNew={() => setExp(NEW)} onLibrary={onLibrary} />
    <span className="row gap state-chips">
      {current && current.status !== 'draft' && v && v.runs > 0 && <span className={`badge ${v.accepted === v.runs ? 'ok' : 'warn'}`} title="Independent validation: solutions accepted by the validator"><ShieldCheck size={13} />{t('ev.validated')} {v.accepted}/{v.runs}</span>}
      {current?.locked && <span className="badge has-tip" tabIndex={0} data-tip={t('ws.locked.tip')} aria-label={`Locked. ${t('ws.locked.tip')}`}><Lock size={12} />Locked</span>}
      {current?.status === 'draft' && <span className="badge info">Ready to run</span>}
    </span>
    <span className="grow" />
    <div className="row gap actions-bar">
      <button className="btn" onClick={onGenerate} data-tour="generate"><Plus size={15} />{t('ws.generate')}</button>
      <div className="menu-wrap" ref={impRef}>
        <button ref={impBtn} className="btn" aria-haspopup="menu" aria-expanded={imp} onClick={() => setImp(!imp)}><Upload size={15} />{t('ws.import')}<ChevronDown size={13} /></button>
        {imp && <div ref={impMenu} className="menu left" role="menu" aria-label="import" onKeyDown={onMenuKey}>
          <button role="menuitem" className="mi" onClick={() => { setImp(false); onImport(); }}><FileUp size={15} /><span className="grow">Import a bundle file…</span></button>
          <button role="menuitem" className="mi" disabled={!sampleAvailable} onClick={() => { setImp(false); onTrySample(); }}><PackageOpen size={15} /><span className="grow">{t('sample.title')}</span>{!sampleAvailable && <span className="tag-planned">Unavailable</span>}</button>
        </div>}
      </div>
      <span className="vsep" />
      <button className={`btn ${comparePrimary ? '' : 'primary'}`} data-tour="run" onClick={onRun} disabled={runDisabled} title={runTitle}>
        {runLabel === 'again' ? <><RotateCcw size={15} />{t('ws.runAgain')}</> : <><Play size={15} />{t('ws.run')}</>}</button>
      <button className={`btn ${comparePrimary ? 'primary' : ''}`} data-tour="compare" onClick={onCompare} disabled={!canCompare}><GitCompareArrows size={15} />{t('ws.compare')}</button>
      <button className="btn" onClick={onExport} disabled={!canExport}><Download size={15} />{t('ws.export')}</button>
      <button className="btn icon only-narrow" aria-label="results panel" onClick={() => onPanel('right')}><PanelRight size={15} /></button>
    </div>
  </div>;
}
