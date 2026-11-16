import { useEffect, useState, type InputHTMLAttributes } from 'react';

/** A whole number between `min` and `max` that can be typed freely: the field may be empty while editing (deleting
 *  "3" to type "2" gives 2, not 12), a valid value is taken at once, and leaving the field clamps it. */
export function CountInput({ value, onChange, min, max, ...rest }: { value: number; onChange: (n: number) => void; min: number; max: number }
  & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'min' | 'max' | 'type'>) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return <input type="number" min={min} max={max} step={1} value={text} {...rest}
    onChange={(e) => { const t = e.target.value, n = Number(t); setText(t); if (t !== '' && Number.isInteger(n) && n >= min && n <= max) onChange(n); }}
    onBlur={(e) => { const n = Math.max(min, Math.min(max, Math.round(Number(text)) || min)); setText(String(n)); if (n !== value) onChange(n); rest.onBlur?.(e); }} />;
}
