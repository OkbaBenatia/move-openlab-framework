import authoring from './fr/authoring';
import charts from './fr/charts';
import compare from './fr/compare';
import data from './fr/data';
import mleval from './fr/mleval';
import plugins from './fr/plugins';
import samples from './fr/samples';
import exportText from './fr/export';
import shell from './fr/shell';
import workspace from './fr/workspace';

/** French for the strings written in English in the components (`tr('English text')`). The key is the exact English
 *  text, placeholders included. An entry that is missing here is shown in English. The catalogue is split by part of
 *  the interface (./fr/*.ts); a text used in several parts needs one entry only. */
/** One English text used with two meanings in different parts gets one French wording that reads correctly in both. */
const shared: Record<string, string> = {
  Baseline: 'Base',            // an experiment's type, and the CO₂ baseline next to "Solution"
  Created: 'Créé',
  Validated: 'Validé',
  none: 'aucun',
};

const frText: Record<string, string> = { ...shell, ...data, ...workspace, ...compare, ...mleval, ...authoring, ...charts, ...plugins, ...samples, ...exportText, ...shared };

export default frText;
