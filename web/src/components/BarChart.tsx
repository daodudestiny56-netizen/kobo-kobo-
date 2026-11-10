'use client';

import { useState } from 'react';

export interface Bar {
  label: string;
  value: number;
  detail: string;
  highlight?: boolean;
}

// Daily bars built from plain elements. Each bar is a focusable button, so it works with touch, mouse and keyboard.
export function BarChart({ bars, format, ariaLabel, height = 180 }: { bars: Bar[]; format: (v: number) => string; ariaLabel: string; height?: number }) {
  const [active, setActive] = useState<number | null>(null);
  const max = Math.max(...bars.map((b) => b.value), 1);
  const ticks = [max, max / 2, 0];
  const shown = bars[active ?? bars.length - 1];

  return (
    <div className="chart">
      <p className="chart-readout" aria-live="polite">
        <span className="muted">{shown.label}</span> <b className="num">{shown.detail}</b>
      </p>
      <div className="bars-frame">
        <div className="bars-y" style={{ height }} aria-hidden>
          {ticks.map((t, i) => <span key={i}>{format(t)}</span>)}
        </div>
        <div className="bars" style={{ height }} role="group" aria-label={ariaLabel} onPointerLeave={() => setActive(null)}>
          {bars.map((b, i) => (
            <button
              key={b.label + i}
              className="bar-col"
              aria-label={`${b.label}: ${b.detail}`}
              onPointerEnter={() => setActive(i)}
              onFocus={() => setActive(i)}
              onBlur={() => setActive(null)}
            >
              <span className={`bar ${b.highlight ? 'bar-hl' : ''} ${active === i ? 'bar-on' : ''}`} style={{ height: `${Math.max((b.value / max) * 100, b.value > 0 ? 3 : 0)}%` }} />
            </button>
          ))}
        </div>
      </div>
      <div className="bars-x" aria-hidden>
        {bars.map((b, i) => <span key={b.label + i}>{i % 2 === 0 ? b.label.split(' ')[0] : ''}</span>)}
      </div>
    </div>
  );
}
