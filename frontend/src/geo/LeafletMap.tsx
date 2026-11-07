import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

export interface MapPoint { lat: number; lon: number; color: string; label?: string; radius?: number; fill?: boolean }
export interface MapLine { coords: [number, number][]; color: string; weight?: number; dash?: string; label?: string; opacity?: number }
export interface MapRect { bbox: [number, number, number, number]; color: string }

/** Leaflet map without wrappers (BSD-2-Clause). Static layers refit the view when `fitKey` changes; `dynamic` points
 *  (e.g. playback positions) are redrawn without moving the view. Tiles and attribution come from the server config. */
export function LeafletMap({ tileUrl, attribution, points = [], lines = [], rects = [], dynamic = [], fitKey, onClick, height = 460, onBounds }: {
  tileUrl: string; attribution: string; points?: MapPoint[]; lines?: MapLine[]; rects?: MapRect[]; dynamic?: MapPoint[];
  fitKey?: string; onClick?: (lat: number, lon: number) => void; height?: number; onBounds?: (b: [number, number, number, number]) => void;
}) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const stat = useRef<L.LayerGroup | null>(null);
  const dyn = useRef<L.LayerGroup | null>(null);
  const click = useRef(onClick);
  const bounds = useRef(onBounds);
  const fitted = useRef<string | undefined>(undefined);
  click.current = onClick;
  bounds.current = onBounds;

  useEffect(() => {
    if (!el.current) return;
    const m = L.map(el.current, { center: [46.6, 2.4], zoom: 5, preferCanvas: true });
    L.tileLayer(tileUrl, { maxZoom: 19, attribution }).addTo(m);
    stat.current = L.layerGroup().addTo(m);
    dyn.current = L.layerGroup().addTo(m);
    m.on('click', (e: L.LeafletMouseEvent) => click.current?.(Number(e.latlng.lat.toFixed(6)), Number(e.latlng.lng.toFixed(6))));
    const report = () => { const b = m.getBounds(); bounds.current?.([b.getSouth(), b.getWest(), b.getNorth(), b.getEast()].map((x) => Number(x.toFixed(5))) as [number, number, number, number]); };
    m.on('moveend', report);
    map.current = m;
    return () => { m.remove(); map.current = null; fitted.current = undefined; };
  }, [tileUrl, attribution]);

  useEffect(() => {
    const m = map.current, g = stat.current;
    if (!m || !g) return;
    g.clearLayers();
    const all: L.LatLngExpression[] = [];
    for (const r of rects) {
      const [s, w, n, e] = r.bbox;
      L.rectangle([[s, w], [n, e]], { color: r.color, weight: 1, fill: false, dashArray: '4 4' }).addTo(g);
      all.push([s, w], [n, e]);
    }
    for (const ln of lines) {
      const pl = L.polyline(ln.coords, { color: ln.color, weight: ln.weight ?? 3, dashArray: ln.dash, opacity: ln.opacity ?? 0.85 }).addTo(g);
      if (ln.label) pl.bindTooltip(ln.label, { sticky: true });
      all.push(...ln.coords);
    }
    for (const p of points) {
      const c = L.circleMarker([p.lat, p.lon], { radius: p.radius ?? 6, color: p.color, weight: 2, fillColor: p.color, fillOpacity: p.fill === false ? 0 : 0.85 }).addTo(g);
      if (p.label) c.bindTooltip(p.label);
      all.push([p.lat, p.lon]);
    }
    // refit only when the displayed subject changes (fitKey), never on edits: clicks must stay where the user aims
    if (all.length && fitKey !== undefined && fitted.current !== fitKey) { m.fitBounds(L.latLngBounds(all), { padding: [24, 24], maxZoom: 16 }); fitted.current = fitKey; }
  }, [points, lines, rects, fitKey]);

  useEffect(() => {
    const g = dyn.current;
    if (!g) return;
    g.clearLayers();
    for (const p of dynamic) {
      const c = L.circleMarker([p.lat, p.lon], { radius: p.radius ?? 7, color: '#ffffff', weight: 2, fillColor: p.color, fillOpacity: 1 }).addTo(g);
      if (p.label) c.bindTooltip(p.label);
    }
  }, [dynamic]);

  return <div ref={el} className="map" style={{ height }} role="region" aria-label="map" />;
}

export const COLORS = { driver: '#1f5fd1', rider: '#c2410c', match: '#15803d', unserved: '#b91c1c', area: '#7c3aed', route: '#0f766e' };
