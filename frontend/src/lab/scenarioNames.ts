import { tr as translate } from '../i18n';
import type { Translate } from './compareData';

/** The short name a scenario is known by: the first part of its name (before " · "), e.g. an identifier given by its
 *  source; a scenario without a short name is "Scenario k". Never "Sample k": a scenario is not a repetition.
 *  `tr` is the interface's translator unless an exported file asks for the English name. */
export const scenarioLabel = (s: { name?: string | null } | undefined, k: number, tr: Translate = translate): string => {
  const n = (s?.name ?? '').split(' · ')[0].trim();
  return n && n.length <= 28 ? n : tr('Scenario {k}', { k: k + 1 });
};
