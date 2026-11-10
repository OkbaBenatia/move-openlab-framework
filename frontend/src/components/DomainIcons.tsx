import type { SVGProps } from 'react';

/** Mobility icons drawn on the same 24 px grid and 2 px round strokes as the interface's other icons, so that a rider
 *  and each kind of vehicle read at a glance in participant lists, fleet summaries, map legends and the wizard. */
type P = SVGProps<SVGSVGElement> & { size?: number; title?: string };

function Svg({ size = 16, title, children, className, ...rest }: P & { children: React.ReactNode }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
    role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true} {...rest} className={`dicon ${className ?? ''}`}>
    {title && <title>{title}</title>}{children}</svg>;
}

/** A car seen from the side: body, cabin and two wheels (the shared base of every vehicle icon). */
const Body = () => <><path d="M 3 16v -3.2a 2 2 0 0 1 .7-1.5L 6 9.5l 1.6-3A 2 2 0 0 1 9.4 5.5h 4.4a 2 2 0 0 1 1.6.8l 2.6 3.2 2.4.8a 2 2 0 0 1 1.4 1.9V 16" />
  <path d="M 6.2 9.5h 11.6" /><path d="M 3 16h 1.6M 9.4 16h 5.2M 19.4 16H 21" /><circle cx="7" cy="16.4" r="2.2" /><circle cx="17" cy="16.4" r="2.2" /></>;

/** Rider / passenger: a person waiting with a raised hand (hailing a ride). */
export function RiderIcon(p: P) {
  return <Svg {...p}><circle cx="10" cy="4.5" r="2.2" /><path d="M 10 7.5v 6.5" /><path d="M 10 9.5l 4.5-3 1.5-3" /><path d="M 10 9.5l -3.5 2.5" /><path d="M 7.5 21l 2.5-7 2.5 7" /></Svg>;
}
/** Combustion car (ICE) — the standard car. */
export function CarIcon(p: P) { return <Svg {...p}><Body /></Svg>; }
/** Battery-electric car (BEV): the car with a lightning bolt above the cabin. */
export function ElectricCarIcon(p: P) {
  return <Svg {...p}><Body /><path d="M 12.6 0.8l -2 3h 2.6l -2 2.9" strokeWidth={1.8} /></Svg>;
}
/** Hybrid car (HEV): the car with a small leaf. */
export function HybridCarIcon(p: P) {
  return <Svg {...p}><Body /><path d="M 10 4.4c 0-2 1.6-3.4 4.4-3.4 0 2.6-1.4 4.2-4.4 3.4z" strokeWidth={1.6} /></Svg>;
}
/** Plug-in hybrid (PHEV): the car with a plug. */
export function PlugInCarIcon(p: P) {
  return <Svg {...p}><Body /><path d="M 10.6 1 v 1.8 M 13.4 1 v 1.8 M 9.8 2.8 h 4.4 v .6 a 2.2 2.2 0 0 1 -4.4 0 z" strokeWidth={1.6} /></Svg>;
}

/** The icon of a powertrain code (ICE, HEV, PHEV, BEV, custom). */
export function VehicleIcon({ powertrain, ...p }: P & { powertrain?: string | null }) {
  if (powertrain === 'BEV') return <ElectricCarIcon {...p} />;
  if (powertrain === 'PHEV') return <PlugInCarIcon {...p} />;
  if (powertrain === 'HEV') return <HybridCarIcon {...p} />;
  return <CarIcon {...p} />;
}
