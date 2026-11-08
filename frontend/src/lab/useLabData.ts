import { useCallback, useEffect, useState } from 'react';
import { call, type Json, type MethodRef, type Problem } from '../api/client';
import { errText } from '../components/common';
import { geo, type Area, type GeoConfig } from '../geo/api';
import { lab, type ExpItem } from './api';

export const RIDE = 'public-ride-matching';
type BBox = [number, number, number, number];

export interface DatasetItem { dataset_key: string; name: string; bbox: BBox | null }

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
  const reloadExperiments = useCallback(() => lab.experiments().then((r) => setExperiments(r.experiments)).catch(fail), [fail]);
  const reloadLists = useCallback(() => {
    geo.areas().then((r) => setAreas(r.areas)).catch(fail);
    geo.scenarios().then((r) => setLib(r.scenarios)).catch(fail);
    geo.datasets().then((r) => setDatasets([
      ...r.shared.map((d: Json) => ({ dataset_key: d.dataset_key, name: d.name, bbox: d.area?.bbox ?? null })),
      ...r.mine.map((d: Json) => ({ dataset_key: d.dataset_key, name: d.name, bbox: d.coverage?.extent ?? null }))])).catch(fail);
  }, [fail]);
  useEffect(() => {
    geo.config().then(setCfg).catch(fail);
    call<{ problems: Problem[] }>('/problems').then((r) => setProblems(r.problems)).catch(fail);
    reloadLists();
  }, [fail, reloadLists]);
  return { cfg, areas, datasets, experiments, lib, problems, reloadExperiments, reloadLists };
}

/** Methods that can run for a problem here: built-in ones and the plugins this researcher registered. */
export function useMethods(problemId: string, setErr: (s: string | null) => void): MethodRef[] {
  const [methods, setMethods] = useState<MethodRef[]>([]);
  useEffect(() => {
    if (!problemId) return;
    call(`/problems/${problemId}/methods`).then((r) => setMethods([...r.builtin,
      ...r.registered.map((m: Json) => ({ source: 'plugin', method_id: m.method_id, version: m.version, name: m.name, kind: m.kind, author: m.author, code_sha256: m.code_sha256 }))]))
      .catch((e) => setErr(errText(e)));
  }, [problemId, setErr]);
  return methods;
}
