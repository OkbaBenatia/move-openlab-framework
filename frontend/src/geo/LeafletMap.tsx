import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

export interface MapPoint { lat: number; lon: number; color: string; label?: string; radius?: number; fill?: boolean }
export interface MapLine { coords: [number, number][]; color: string; weight?: number; dash?: string; label?: string; opacity?: number }
export type BBox = [number, number, number, number];
export interface MapRect { bbox: BBox; color: string }
export interface EditBox { bbox: BBox; color: string; onChange?: (b: BBox) => void }
export interface Coverage { cells: [number, number, number][]; step: number }

const r5 = (x: number) => Number(x.toFixed(5));
/** Tooltip content as a text node: labels may come from imported data and are never interpreted as HTML. */
const text = (s: string) => { const el = document.createElement('span'); el.textContent = s; return el; };
const handle = (cls: string) => L.divIcon({ className: `box-handle ${cls}`, iconSize: [14, 14] });

/** Leaflet map without wrappers (BSD-2-Clause). Static layers refit the view when `fitKey` changes; `dynamic` points
 *  (e.g. playback positions) are redrawn without moving the view. Tiles and attribution come from the server config. */
export interface MapView { center: [number, number]; zoom: number }

export function LeafletMap({ tileUrl, attribution, points = [], lines = [], rects = [], dynamic = [], fitKey, onClick, height = 460, onBounds, box, coverage, focus, cursor, view, onView }: {
  tileUrl: string; attribution: string; points?: MapPoint[]; lines?: MapLine[]; rects?: MapRect[]; dynamic?: MapPoint[];
  fitKey?: string; onClick?: (lat: number, lon: number) => void; height?: number | string; onBounds?: (b: BBox) => void;
  box?: EditBox | null; coverage?: Coverage | null; focus?: { key: string; bbox: BBox } | null; cursor?: 'crosshair';
  /** Synchronised maps: `view` is applied when it differs from the current one; `onView` reports the user's moves. */
  view?: MapView | null; onView?: (v: MapView) => void;
}) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const stat = useRef<L.LayerGroup | null>(null);
  const dyn = useRef<L.LayerGroup | null>(null);
  const click = useRef(onClick);
  const bounds = useRef(onBounds);
  const viewCb = useRef(onView);
  const fitted = useRef<string | undefined>(undefined);
  const boxLayer = useRef<L.LayerGroup | null>(null);
  const covLayer = useRef<L.LayerGroup | null>(null);
  const focused = useRef<string | undefined>(undefined);
  const [tilesDown, setTilesDown] = useState(false);
  click.current = onClick;
  bounds.current = onBounds;
  viewCb.current = onView;

  useEffect(() => {
    if (!el.current) return;
    const m = L.map(el.current, { center: [46.6, 2.4], zoom: 5, preferCanvas: true });
    setTilesDown(!tileUrl);
    if (tileUrl) {
      // Tile servers such as tile.openstreetmap.org require a Referer; the page itself sends none cross-origin
      // (Referrer-Policy: same-origin), so the tile images send the page origin only.
      const tiles = L.tileLayer(tileUrl, { maxZoom: 19, attribution, referrerPolicy: 'strict-origin-when-cross-origin' }).addTo(m);
      let errors = 0, loaded = 0;
      tiles.on('tileload', () => { loaded += 1; errors = 0; setTilesDown(false); });
      tiles.on('tileerror', () => { errors += 1; if (errors >= 4 && loaded === 0) setTilesDown(true); });
    } else if (attribution) {
      m.attributionControl.addAttribution(attribution);
    }
    covLayer.current = L.layerGroup().addTo(m);
    stat.current = L.layerGroup().addTo(m);
    boxLayer.current = L.layerGroup().addTo(m);
    dyn.current = L.layerGroup().addTo(m);
    m.on('click', (e: L.LeafletMouseEvent) => click.current?.(Number(e.latlng.lat.toFixed(6)), Number(e.latlng.lng.toFixed(6))));
    const report = () => {
      const b = m.getBounds(); bounds.current?.([b.getSouth(), b.getWest(), b.getNorth(), b.getEast()].map((x) => Number(x.toFixed(5))) as [number, number, number, number]);
      const c = m.getCenter(); viewCb.current?.({ center: [Number(c.lat.toFixed(6)), Number(c.lng.toFixed(6))], zoom: m.getZoom() });
    };
    m.on('moveend', report);
    map.current = m;
    return () => { m.remove(); map.current = null; fitted.current = undefined; focused.current = undefined; };
  }, [tileUrl, attribution]);

  // synchronised view: applied only when it differs from the map's own (no feedback loop between two maps)
  useEffect(() => {
    const m = map.current;
    if (!m || !view) return;
    const c = m.getCenter();
    if (Math.abs(c.lat - view.center[0]) < 1e-6 && Math.abs(c.lng - view.center[1]) < 1e-6 && m.getZoom() === view.zoom) return;
    m.setView(view.center, view.zoom, { animate: false });
  }, [view]);

  useEffect(() => {
    const m = map.current;
    if (!m || !focus || focused.current === focus.key) return;
    const [s, w, n, e] = focus.bbox;
    m.flyToBounds([[s, w], [n, e]], { padding: [24, 24], maxZoom: 15, duration: 0.6 });
    focused.current = focus.key;
  }, [focus]);

  // editable bounding box: corner handles resize, the centre handle moves; the change is reported on drag end
  const boxKey = box ? `${box.bbox.join(',')}|${box.color}|${box.onChange ? 1 : 0}` : '';
  const boxChange = useRef(box?.onChange);
  boxChange.current = box?.onChange;
  useEffect(() => {
    const g = boxLayer.current;
    if (!g) return;
    g.clearLayers();
    if (!box) return;
    const [s, w, n, e] = box.bbox;
    const rect = L.rectangle([[s, w], [n, e]], { color: box.color, weight: 2, fillOpacity: 0.06 }).addTo(g);
    if (!box.onChange) return;
    const corners: [number, number][] = [[s, w], [s, e], [n, e], [n, w]];
    corners.forEach(([la, lo], i) => {
      const opp = corners[(i + 2) % 4];
      const mk = L.marker([la, lo], { draggable: true, icon: handle('corner'), keyboard: false, title: 'drag to resize' }).addTo(g);
      const bounds = () => { const p = mk.getLatLng(); return L.latLngBounds([p.lat, p.lng], opp); };
      mk.on('drag', () => rect.setBounds(bounds()));
      mk.on('dragend', () => { const b = bounds(); boxChange.current?.([r5(b.getSouth()), r5(b.getWest()), r5(b.getNorth()), r5(b.getEast())]); });
    });
    const c = L.marker([(s + n) / 2, (w + e) / 2], { draggable: true, icon: handle('centre'), keyboard: false, title: 'drag to move' }).addTo(g);
    c.on('drag', () => { const p = c.getLatLng(), dl = p.lat - (s + n) / 2, dn = p.lng - (w + e) / 2; rect.setBounds([[s + dl, w + dn], [n + dl, e + dn]]); });
    c.on('dragend', () => { const p = c.getLatLng(), dl = p.lat - (s + n) / 2, dn = p.lng - (w + e) / 2; boxChange.current?.([r5(s + dl), r5(w + dn), r5(n + dl), r5(e + dn)]); });
  }, [boxKey]);

  useEffect(() => {
    const g = covLayer.current;
    if (!g) return;
    g.clearLayers();
    if (!coverage) return;
    for (const [la, lo, v] of coverage.cells)
      L.rectangle([[la, lo], [la + coverage.step, lo + coverage.step]], { stroke: false, fillColor: COLORS.area, fillOpacity: 0.12 + 0.5 * v, interactive: false }).addTo(g);
  }, [coverage]);

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
      if (ln.label) pl.bindTooltip(text(ln.label), { sticky: true });
      all.push(...ln.coords);
    }
    for (const p of points) {
      const c = L.circleMarker([p.lat, p.lon], { radius: p.radius ?? 6, color: p.color, weight: 2, fillColor: p.color, fillOpacity: p.fill === false ? 0 : 0.85 }).addTo(g);
      if (p.label) c.bindTooltip(text(p.label));
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
      if (p.label) c.bindTooltip(text(p.label));
    }
  }, [dynamic]);

  // the Leaflet element keeps a constant className: React must never rewrite the classes Leaflet adds to it
  return (
    <div className={`map-wrap${cursor ? ' map-crosshair' : ''}${tilesDown ? ' map-no-tiles' : ''}`} style={{ height }}>
      <div ref={el} className="map" style={{ height: '100%' }} role="region" aria-label="map" />
      {tilesDown && <div className="map-banner" role="status">Basemap unavailable — data still shown</div>}
    </div>
  );
}

export const COLORS = { driver: '#1f5fd1', rider: '#c2410c', match: '#15803d', unserved: '#b91c1c', area: '#7c3aed', route: '#0f766e' };
