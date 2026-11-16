import { useCallback, useEffect, useState } from 'react';
import { call, type Json, type MethodRef, type Problem } from '../api/client';
import { errText } from '../components/common';
import { geo, type Area, type GeoConfig } from '../geo/api';
import { lab, type ExpItem } from './api';

export const RIDE = 'public-ride-matching';
type BBox = [number, number, number, number];

export interface DatasetItem { dataset_key: string; name: string; bbox: BBox | null; provider: string; release: string | null; rows_kept?: number | null }

/** Display label of a dataset: "RPC <release> · <area name>" for open-data subsets, the file name otherwise. */
export const datasetLabel = (d: DatasetItem, areas: Area[]) => d.provider === 'rpc'
  ? `RPC ${d.release ?? ''} · ${areas.find((a) => d.bbox && a.bbox.join() === d.bbox.map((x) => Number(x.toFixed(5))).join())?.name ?? d.name.split(' · ')[1] ?? d.name}`.trim()
  : d.name;

export const overlaps = (a: BBox | null | undefined, b: BBox | null | undefined) =>
  !!a && !!b && a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];

/** Lists the workspace needs: map configuration, areas, datasets, experiments, scenario library, problems. */
export function useLabData(setErr: (s: string | null) => void) {
  const [cfg, setCfg] = useState<GeoConfig | null>(null);
  const [areas, setAreas] = useState<Area[]>([]);
  const [datasets, setDatasets] = useState<DatasetItem[]>([]);
  const [experiments, setExperiments] = useState<ExpItem[]>([]);
  const [lib, setLib] = useState<Json[]>([]);
  const [problems, setProblems] = useState<Problem[]>([]);
  const fail = useCallback((e: unknown) => setErr(errText(e)), [setErr]);
  const reloadExperiments = useCallback(() => lab.experiments().then((r) => { setExperiments(r.experiments); return r.experiments; }), []);
  const reloadLists = useCallback(() => {
    geo.areas().then((r) => setAreas(r.areas)).catch(fail);
    geo.scenarios().then((r) => setLib(r.scenarios)).catch(fail);
    geo.datasets().then((r) => setDatasets([
      ...r.shared.map((d: Json) => ({ dataset_key: d.dataset_key, name: d.name, bbox: d.area?.bbox ?? null, provider: d.provider ?? 'rpc', release: d.release ?? null, rows_kept: d.rows_kept ?? null })),
      ...r.mine.map((d: Json) => ({ dataset_key: d.dataset_key, name: d.name, bbox: d.coverage?.extent ?? null, provider: d.provider ?? 'upload', release: null, rows_kept: d.rows_kept ?? null }))])).catch(fail);
  }, [fail]);
  useEffect(() => {
    geo.config().then(setCfg).catch(fail);
    call<{ problems: Problem[] }>('/problems').then((r) => setProblems(r.problems)).catch(fail);
    reloadLists();
  }, [fail, reloadLists]);
  return { cfg, areas, datasets, experiments, lib, problems, reloadExperiments, reloadLists };
}

/** Methods that can run for a problem here: built-in ones and the plugins this researcher registered. */
export function useMethods(problemId: string, setErr: (s: string | null) => void, refresh = 0): MethodRef[] {
  const [methods, setMethods] = useState<MethodRef[]>([]);
  useEffect(() => {
    if (!problemId) return;
    // built-in methods carry their researcher-settable solver settings (schema and defaults), if they declare any
    call(`/problems/${problemId}/methods`).then((r) => setMethods([...r.builtin.map((m: MethodRef) => ({ ...m, settings: r.settings?.[`${m.method_id}@${m.version}`] })),
      ...r.registered.map((m: Json) => ({ source: 'plugin', method_id: m.method_id, version: m.version, name: m.name, kind: m.kind, author: m.author, code_sha256: m.code_sha256 }))]))
      .catch((e) => setErr(errText(e)));
  }, [problemId, setErr, refresh]);
  return methods;
}
