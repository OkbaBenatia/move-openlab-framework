/** Chart scales (no imports: unit-tested on its own). */
/** Axis ticks covering [lo, hi] (lo may be negative: avoided emissions can be below zero). */
export function ticks(lo: number, hi: number): number[] {
  const span = Math.max(1e-9, hi - lo), raw = span / 4, p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((x) => x >= raw) ?? raw;
  const a = Math.floor(lo / step) * step, out: number[] = [];
  for (let v = a; out.length < 12; v += step) {                    // up to the first tick at or above hi: no mark above the axis
    out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
    if (v >= hi - step * 1e-9) break;
  }
  return out.length >= 2 ? out : [a, a + step];
}
