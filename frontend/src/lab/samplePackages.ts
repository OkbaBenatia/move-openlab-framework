// Pure logic of the sample packages and of scenario-package reports (no React, no translation): what was verified, in
// which order it is shown, and what the composition check says. Unit-tested in tests/samplePackages.test.ts.

/** The fields of a scenario-package report (server: ``scenario_packages.verify``) this module reads. */
export interface ScenarioReport {
  kind?: string; format?: string; files_checked?: number; spec_match?: boolean; executable_code_in_package?: boolean;
  instance?: { verified?: boolean } | null;
  geometry?: { included?: boolean; verified?: boolean; legs?: number } | null;
  composition?: { included?: boolean; consistent?: boolean; network_installed?: boolean; rebuilt?: boolean; identical?: boolean | null } | null;
}

export const SCENARIO_FORMAT = 'move-openlab-scenario/1';

/** A report of the inspection of a file: a scenario package (routed to the scenario importer) or an experiment bundle. */
export const isScenarioReport = (rep: ScenarioReport | null | undefined): boolean => rep?.kind === 'scenario' || rep?.format === SCENARIO_FORMAT;

/** What the import says about the editable composition (ride matching): rebuilt here and identical, consistent but not
 *  rebuilt because the road network is not installed, or none (a problem without a composition). */
export type CompositionState = 'rebuilt-identical' | 'network-missing' | 'none';
export function compositionState(rep: ScenarioReport | null | undefined): CompositionState {
  const c = rep?.composition;
  if (!c) return 'none';
  if (c.rebuilt && c.identical) return 'rebuilt-identical';
  return 'network-missing';
}

export type CheckId = 'archive' | 'instance' | 'geometry' | 'composition' | 'problem' | 'code';
/** One line of the verification list. `ok: false` with `info: true` is a limitation stated plainly, not a failure. */
export interface CheckRow { id: CheckId; ok: boolean; info?: boolean; n?: number }

/** The checks of a scenario-package report, in the order the import performs them. A refused package has no report
 *  (the server answers with the reason), so every row of a report passed — except what could not be done here. */
export function scenarioChecks(rep: ScenarioReport): CheckRow[] {
  const rows: CheckRow[] = [
    { id: 'archive', ok: true, n: rep.files_checked },
    { id: 'problem', ok: !!rep.spec_match },
    { id: 'instance', ok: !!rep.instance?.verified },
  ];
  if (rep.geometry) rows.push(rep.geometry.included ? { id: 'geometry', ok: !!rep.geometry.verified, n: rep.geometry.legs } : { id: 'geometry', ok: false, info: true });
  const cs = compositionState(rep);
  if (cs !== 'none') rows.push({ id: 'composition', ok: cs === 'rebuilt-identical', info: cs === 'network-missing' });
  rows.push({ id: 'code', ok: rep.executable_code_in_package === false });
  return rows;
}

/** The first characters of a digest, for display next to its full value in a tooltip. */
export const shortSha = (s: string | null | undefined, n = 12): string => (s ? `${s.slice(0, n)}…` : '—');

/** A file size as people read it: kB under one megabyte, MB with two decimals above. */
export function sizeLabel(bytes: number | null | undefined): string {
  const b = Number(bytes ?? 0);
  return b < 1e6 ? `${(b / 1e3).toFixed(1)} kB` : `${(b / 1e6).toFixed(2)} MB`;
}

/** `{filename: sha256}` from the text of a `sha256sum` file (examples/SHA256SUMS). */
export function parseSha256Sums(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([0-9a-f]{64})\s+\*?(.+?)\s*$/);
    if (m) out[m[2]] = m[1];
  }
  return out;
}

/** Which sample cards can be offered (each package is offered only when it ships with the installation). */
export function samplesOffered(st: { sample?: { available?: boolean } | null; sample_scenario?: { available?: boolean } | null } | null | undefined) {
  const scenario = !!st?.sample_scenario?.available, experiment = !!st?.sample?.available;
  return { scenario, experiment, any: scenario || experiment };
}
