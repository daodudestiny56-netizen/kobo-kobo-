'use client';

import { useId, useRef, useState } from 'react';

export interface LinePoint {
  label: string;
  value: number;
}

// A single-series line chart. The SVG only draws shapes; every label is real text, so it stays sharp and readable.
// Hover, touch or the arrow keys move a marker and update the readout.
export function LineChart({
  points,
  format,
  ariaLabel,
  height = 220,
}: {
  points: LinePoint[];
  format: (v: number) => string;
  ariaLabel: string;
  height?: number;
}) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<number | null>(null);

  const W = 600;
  const H = 200;
  const pad = 6;
  const n = points.length;
  const values = points.map((p) => p.value);
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const x = (i: number) => pad + (n <= 1 ? 0 : (i * (W - 2 * pad)) / (n - 1));
  const y = (v: number) => H - pad - ((v - min) / span) * (H - 2 * pad);

  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const area = `${line} L${x(n - 1).toFixed(1)},${H - pad} L${x(0).toFixed(1)},${H - pad} Z`;

  const shown = active ?? n - 1;
  const point = points[shown];

  function fromPointer(e: React.PointerEvent) {
    const r = box.current?.getBoundingClientRect();
    if (!r || n < 2) return;
    const ratio = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    setActive(Math.round(ratio * (n - 1)));
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'ArrowLeft') setActive(Math.max(0, shown - 1));
    else if (e.key === 'ArrowRight') setActive(Math.min(n - 1, shown + 1));
    else if (e.key === 'Home') setActive(0);
    else if (e.key === 'End') setActive(n - 1);
    else if (e.key === 'Escape') setActive(null);
    else return;
    e.preventDefault();
  }

  return (
    <div className="chart">
      <p className="chart-readout" aria-live="polite" id={`${id}-readout`}>
        <span className="muted">{point.label}</span> <b className="num">{format(point.value)}</b>
      </p>
      <div
        ref={box}
        className="chart-plot"
        style={{ height }}
        tabIndex={0}
        role="img"
        aria-label={`${ariaLabel}. From ${format(points[0].value)} on ${points[0].label} to ${format(points[n - 1].value)} on ${points[n - 1].label}. Use the arrow keys to read each day.`}
        aria-describedby={`${id}-readout`}
        onPointerMove={fromPointer}
        onPointerDown={fromPointer}
        onPointerLeave={() => setActive(null)}
        onBlur={() => setActive(null)}
        onKeyDown={onKey}
      >
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
          {[0.25, 0.5, 0.75].map((g) => (
            <line key={g} x1={0} x2={W} y1={H * g} y2={H * g} stroke="var(--rule)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          ))}
          <path d={area} fill="var(--brand-tint)" />
          <path d={line} fill="none" stroke="var(--brand)" strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        </svg>
        {active !== null && (
          <>
            <span className="chart-rule" style={{ left: `${(x(shown) / W) * 100}%` }} />
            <span className="chart-dot" style={{ left: `${(x(shown) / W) * 100}%`, top: `${(y(point.value) / H) * 100}%` }} />
          </>
        )}
        <span className="chart-y chart-y-top">{format(max)}</span>
        <span className="chart-y chart-y-bottom">{format(min)}</span>
      </div>
      <div className="chart-x" aria-hidden>
        <span>{points[0].label}</span>
        <span>{points[Math.floor((n - 1) / 2)].label}</span>
        <span>{points[n - 1].label}</span>
      </div>
    </div>
  );
}
