import { tr } from '../i18n';

/** The two kinds of comparison, under one *Compare* entry: methods on the same scenarios, or experiments with each
 *  other (variants, imported results, reproductions). */
export function CompareTabs({ active, onMethods, onExperiments }: { active: 'methods' | 'experiments'; onMethods?: () => void; onExperiments?: () => void }) {
  return <><nav className="seg compare-kind" aria-label={tr('kind of comparison')}>
    <button className={active === 'methods' ? 'on' : ''} aria-pressed={active === 'methods'} onClick={active === 'methods' ? undefined : onMethods} disabled={active !== 'methods' && !onMethods}
      title={tr('Compare methods on the same matched scenarios')}>{tr('Methods')}</button>
    <button className={active === 'experiments' ? 'on' : ''} aria-pressed={active === 'experiments'} onClick={active === 'experiments' ? undefined : onExperiments}
      title={tr('Compare experiments: variants, imported results, reproductions')}>{tr('Experiments')}</button>
  </nav>
  <span className="small muted compare-kind-note" role="note">{active === 'methods'
    ? tr('Methods: different algorithms on the same matched scenarios.')
    : tr('Experiments: separate experiments with each other — controlled variants, imported results, reproductions.')}</span></>;
}
