import type { SweepRecord, SweepStatus } from './api/types';
import { naira, pct } from './money';

export type Tone = 'positive' | 'neutral' | 'attention';
export type ActivityFilter = 'all' | 'saved' | 'skipped' | 'attention';

export interface SweepView {
  title: string;
  detail: string;
  tone: Tone;
  amount: string;
  filter: Exclude<ActivityFilter, 'all'>;
}

// Plain-language wording for every sweep state (PRD 6.3). Nothing here assumes the reader knows the word "sweep".
export function describeSweep(s: SweepRecord): SweepView {
  const share = `${pct(s.rateBps)} of ${naira(s.takingsKobo)}`;
  const map: Record<SweepStatus, SweepView> = {
    SETTLED: { title: 'Saved to your pension', detail: share, tone: 'positive', amount: naira(s.sweepKobo), filter: 'saved' },
    SKIPPED_ZERO_SALES: { title: 'No sales, nothing taken', detail: 'You only save when you sell', tone: 'neutral', amount: naira(0), filter: 'skipped' },
    SKIPPED_PAUSED: { title: 'Paused, nothing taken', detail: 'Restock mode was on', tone: 'neutral', amount: naira(0), filter: 'skipped' },
    SKIPPED_LOW_BALANCE: { title: 'Skipped to protect your balance', detail: 'Your account would have dropped below the safety minimum', tone: 'attention', amount: naira(0), filter: 'attention' },
    HELD_GUARD: { title: 'Held for a safety check', detail: 'An unusual payment is being reviewed', tone: 'attention', amount: naira(0), filter: 'attention' },
    FAILED: { title: 'Did not go through', detail: 'Nothing was taken from your account', tone: 'attention', amount: naira(0), filter: 'attention' },
    UNKNOWN: { title: 'Confirming with the bank', detail: share, tone: 'attention', amount: naira(s.sweepKobo), filter: 'attention' },
    REVERSED: { title: 'Reversed by the bank', detail: 'The money went back to your account', tone: 'attention', amount: naira(s.sweepKobo), filter: 'attention' },
  };
  return map[s.status];
}

export function greeting(d = new Date()): string {
  const h = d.getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}
