import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

/** A map point. `glyph` (a driver: one letter for the vehicle type, or '') draws a small square instead of a circle;
 *  `kind` names what the point is (driver, rider, pickup, dropoff, unserved…) for the legend and for tests. */
export interface MapPoint { lat: number; lon: number; color: string; label?: string; radius?: number; fill?: boolean; glyph?: string; kind?: string }

/** One letter per powertrain on driver markers (the legend spells them out). */
export const POWERTRAIN_GLYPH: Record<string, string> = { ICE: 'C', HEV: 'H', PHEV: 'P', BEV: 'E' };
/** Driver markers: colour AND icon per vehicle type (never colour alone): combustion blue with a fuel drop, hybrid
 *  indigo with a leaf, plug-in hybrid teal with a plug, electric green with a bolt; no vehicle data: plain blue. */
export const GLYPH_STYLE: Record<string, { color: string; icon: string; name: string }> = {
  C: { color: '#1f5fd1', name: 'Combustion', icon: '<path d="M6 1.5C6 1.5 2.5 5.6 2.5 7.7a3.5 3.5 0 0 0 7 0C9.5 5.6 6 1.5 6 1.5z" fill="#fff"/>' },
  H: { color: '#4f46e5', name: 'Hybrid', icon: '<path d="M2 10.5C2 5 5.6 2 10.5 1.5 10.5 6.6 7.6 10.5 2 10.5z" fill="#fff"/><path d="M2 10.5 7 5.5" stroke="#4f46e5" stroke-width="1.2"/>' },
  P: { color: '#0e7490', name: 'Plug-in hybrid', icon: '<path d="M4 1v3M8 1v3" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/><path d="M2.5 4h7v2.2a3.5 3.5 0 0 1-7 0z" fill="#fff"/><path d="M6 9.6V11.5" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/>' },
  E: { color: '#15803d', name: 'Electric', icon: '<path d="M7 .8 2.4 6.9h3.1L4.8 11.2 9.6 5H6.4z" fill="#fff"/>' },
  '': { color: '#1f5fd1', name: 'Driver', icon: '<rect x="2" y="4" width="8" height="4.5" rx="1.4" fill="#fff"/><circle cx="4" cy="9" r="1" fill="#fff"/><circle cx="8" cy="9" r="1" fill="#fff"/>' },
};
const PERSON = (c: string, hollow = false) => `<svg viewBox="0 0 14 16" width="14" height="16" aria-hidden="true"><circle cx="7" cy="4" r="3" fill="${hollow ? '#fff' : c}" stroke="${hollow ? c : '#fff'}" stroke-width="1.4"/><path d="M1.6 15c0-3.4 2.4-5.6 5.4-5.6s5.4 2.2 5.4 5.6z" fill="${hollow ? '#fff' : c}" stroke="${hollow ? c : '#fff'}" stroke-width="1.4"${hollow ? ' stroke-dasharray="2 1.6"' : ''}/></svg>`;
const ARROW = (up: boolean, c: string, filled: boolean) => `<svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><circle cx="7" cy="7" r="6" fill="${filled ? c : '#fff'}" stroke="${filled ? '#fff' : c}" stroke-width="1.6"/><path d="${up ? 'M4 8.2 7 5l3 3.2' : 'M4 5.8 7 9l3-3.2'}" fill="none" stroke="${filled ? '#fff' : c}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
/** The marker icon of a kind, for legends (the same drawing as on the map). */
export const legendIcon = (kind: 'rider' | 'unserved' | 'pickup' | 'dropoff', color: string) =>
  kind === 'rider' ? PERSON(color) : kind === 'unserved' ? PERSON(color, true) : ARROW(kind === 'pickup', color, kind === 'pickup');
/** Inline marker content for the kinds that have an icon (null: a plain circle). */
function markerHtml(p: MapPoint): { html: string; size: [number, number] } | null {
  if (p.glyph !== undefined && (p.kind === 'driver' || p.kind === undefined)) {
    const st = GLYPH_STYLE[p.glyph] ?? GLYPH_STYLE[''];
    return { html: `<svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">${st.icon}</svg><span class="mk-letter">${p.glyph}</span>`, size: [18, 18] };
  }
  if (p.kind === 'rider') return { html: PERSON(p.color), size: [14, 16] };
  if (p.kind === 'unserved') return { html: PERSON(p.color, true), size: [14, 16] };
  if (p.kind === 'pickup') return { html: ARROW(true, p.color, true), size: [14, 14] };
  if (p.kind === 'dropoff') return { html: ARROW(false, p.color, false), size: [14, 14] };
  return null;
}
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

export function LeafletMap({ tileUrl, attribution, points = [], lines = [], rects = [], dynamic = [], fitKey, onClick, height = 460, onBounds, box, coverage, focus, cursor, view, onView, restore }: {
  tileUrl: string; attribution: string; points?: MapPoint[]; lines?: MapLine[]; rects?: MapRect[]; dynamic?: MapPoint[];
  fitKey?: string; onClick?: (lat: number, lon: number) => void; height?: number | string; onBounds?: (b: BBox) => void;
  box?: EditBox | null; coverage?: Coverage | null; focus?: { key: string; bbox: BBox } | null; cursor?: 'crosshair';
  /** Synchronised maps: `view` is applied when it differs from the current one; `onView` reports the user's moves. */
  view?: MapView | null; onView?: (v: MapView) => void;
  /** A view to restore instead of fitting the layers (the researcher's own view of this subject, kept from a visit). */
  restore?: MapView | null;
}) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const stat = useRef<L.LayerGroup | null>(null);
  const dyn = useRef<L.LayerGroup | null>(null);
  const click = useRef(onClick);
  const bounds = useRef(onBounds);
  const viewCb = useRef(onView);
  const restoreRef = useRef(restore);
  restoreRef.current = restore;
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
      if (map.current !== m) return;               // Leaflet can fire a debounced moveend after the map was removed
      const b = m.getBounds(); bounds.current?.([b.getSouth(), b.getWest(), b.getNorth(), b.getEast()].map((x) => Number(x.toFixed(5))) as [number, number, number, number]);
      const c = m.getCenter(); viewCb.current?.({ center: [Number(c.lat.toFixed(6)), Number(c.lng.toFixed(6))], zoom: m.getZoom() });
    };
    m.on('moveend', report);
    map.current = m;
    // the container can change size without a window resize (expanded map, side panels): keep tiles and layers right
    let alive = true;
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
      if (alive && map.current === m && m.getPane('mapPane')) m.invalidateSize({ pan: false, animate: false });
    });
    ro?.observe(el.current);
    return () => { alive = false; ro?.disconnect(); m.remove(); map.current = null; fitted.current = undefined; focused.current = undefined; };
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
  const boxNow = useRef(box);              // the effect below re-runs only when boxKey (bbox, colour, editability) changes
  boxNow.current = box;
  useEffect(() => {
    const g = boxLayer.current;
    if (!g) return;
    g.clearLayers();
    const box = boxNow.current;
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
    // points at the same place (a pickup where a driver starts, riders sharing a node) fan out around it by a few
    // pixels at every zoom, so that each stays visible and has its own tooltip; a small dot marks the true place
    const at = (p: MapPoint) => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`;
    const count = new Map<string, number>(), seen = new Map<string, number>();
    for (const p of points) count.set(at(p), (count.get(at(p)) ?? 0) + 1);
    for (const p of points) {
      const k = at(p), n = count.get(k) ?? 1, i = seen.get(k) ?? 0;
      seen.set(k, i + 1);
      all.push([p.lat, p.lon]);
      const icon0 = markerHtml(p);
      if (n === 1 && !icon0) {
        const c = L.circleMarker([p.lat, p.lon], { radius: p.radius ?? 6, color: p.color, weight: 2, fillColor: p.color, fillOpacity: p.fill === false ? 0 : 0.85 }).addTo(g);
        if (p.label) c.bindTooltip(text(p.label));
        continue;
      }
      const [sw, sh] = icon0 ? icon0.size : [2 * (p.radius ?? 6) + 2, 2 * (p.radius ?? 6) + 2];
      const off = n > 1 ? Math.max(9, 3 + 2.4 * n) : 0, ang = n > 1 ? (2 * Math.PI * i) / n - Math.PI / 2 : 0;
      const el = document.createElement('span');
      const sq = p.glyph !== undefined && (p.kind === 'driver' || p.kind === undefined);
      el.className = `mk${sq ? ' mk-sq' : icon0 ? ' mk-svg' : ''}${!icon0 && p.fill === false ? ' mk-hollow' : ''}`;
      el.style.setProperty('--c', sq ? (GLYPH_STYLE[p.glyph!] ?? GLYPH_STYLE['']).color : p.color); el.style.width = `${sw}px`; el.style.height = `${sh}px`;
      if (icon0) el.innerHTML = icon0.html;
      if (p.kind) el.dataset.kind = p.kind;
      if (sq) el.dataset.glyph = p.glyph;
      const icon = L.divIcon({ className: 'mk-icon', html: el, iconSize: [sw, sh],
        iconAnchor: [sw / 2 - off * Math.cos(ang), sh / 2 - off * Math.sin(ang)], tooltipAnchor: [off * Math.cos(ang), off * Math.sin(ang) - sh / 2] });
      const mk = L.marker([p.lat, p.lon], { icon, keyboard: false }).addTo(g);
      if (p.label) mk.bindTooltip(text(n > 1 ? `${p.label} · ${n} at this place` : p.label), { direction: 'top' });
      if (n > 1 && i === 0) L.circleMarker([p.lat, p.lon], { radius: 2, color: '#6b7a8c', weight: 1, fillColor: '#6b7a8c', fillOpacity: 1, interactive: false }).addTo(g);
    }
    // refit only when the displayed subject changes (fitKey), never on edits: clicks must stay where the user aims
    if (all.length && fitKey !== undefined && fitted.current !== fitKey) {
      const r = restoreRef.current;
      if (r) m.setView(r.center, r.zoom, { animate: false }); else m.fitBounds(L.latLngBounds(all), { padding: [24, 24], maxZoom: 16 });
      fitted.current = fitKey;
    }
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
