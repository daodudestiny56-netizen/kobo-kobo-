#!/usr/bin/env python3
"""
Synthetic trader archetypes + backtest for Smart Rate.

    python smart_rate_sim.py            # ~1 min: slides the as_of date across 30 days for 30 random traders per archetype

What it measures (rate held at 2.0% so we see the raw signal):
  * share of days the engine says INCREASE / HOLD / DECREASE
  * WRONG-direction rate: e.g. INCREASE for a volatile or declining trader, DECREASE for a steady one
  * flicker: how often the answer changes from one day to the next (a good engine does not flip-flop)

Caveat: archetypes are written by us, so this checks the engine behaves as designed. It is NOT proof
it matches real traders. Re-run it on real Access / ARM cohorts before trusting the thresholds.
"""
import sys as _sys
from pathlib import Path as _Path

_HERE = str(_Path(__file__).resolve().parent)       # lets sibling files (smart_rate.py ...) import from ANY folder
if _HERE not in _sys.path:
    _sys.path.insert(0, _HERE)
import math
import sys
from datetime import date, datetime, timedelta, timezone

import numpy as np

import smart_rate as sr

END = date(2026, 11, 5)
NOW = datetime(2026, 11, 6, 9, 0, tzinfo=timezone.utc)
WEEKLY = [0.7, 0.8, 0.9, 1.0, 1.4, 1.6, 0.6]      # Mon..Sun, mean 1.0


def make_series(n, mean, cv, rng, end=END, dow=None, zero_p=0.0, closed=(), level_fn=None,
                sick=None, outliers=0, outlier_mult=20.0, outlier_values=None):
    """Returns (start, {date: takings}). Oldest day first; the last day is `end`.
    level_fn(i, n) -> multiplier (trend or step change). sick=(first_index, length) forces zero days."""
    s = math.sqrt(math.log(1 + cv ** 2)) if cv > 0 else 0.0
    start = end - timedelta(days=n - 1)
    out_idx = set(int(i) for i in rng.choice(np.arange(n // 2, n), size=outliers, replace=False)) if outliers else set()
    daily = {}
    for i in range(n):
        d = start + timedelta(days=i)
        v = mean * (dow[d.weekday()] if dow else 1.0) * (level_fn(i, n) if level_fn else 1.0)
        if s:
            v *= float(rng.lognormal(-0.5 * s * s, s))
        if i in out_idx:
            v *= outlier_mult
        if d.weekday() in closed or rng.random() < zero_p:
            v = 0.0
        if sick and sick[0] <= i < sick[0] + sick[1]:
            v = 0.0
        daily[d] = round(v / 50.0) * 50.0
    return start, daily


N = 120
ARCHETYPES = {
    #  name                    kwargs                                                        ok actions               target
    "steady_high":        (dict(mean=45000, cv=0.12),                                       {"INCREASE", "HOLD"},     "INCREASE"),
    "weekly_rhythm":      (dict(mean=45000, cv=0.08, dow=WEEKLY),                           {"INCREASE", "HOLD"},     "INCREASE"),
    "closed_on_sundays":  (dict(mean=45000, cv=0.12, closed=(6,)),                          {"INCREASE", "HOLD"},     "INCREASE"),
    "steady_low":         (dict(mean=20000, cv=0.10),                                       {"HOLD"},                 "HOLD"),
    "volatile":           (dict(mean=30000, cv=0.90, zero_p=0.20),                          {"DECREASE", "HOLD"},     "DECREASE"),
    "short_illness":      (dict(mean=45000, cv=0.12, sick=(N - 25, 5)),                     {"INCREASE", "HOLD"},     "INCREASE"),
    "persistent_decline": (dict(mean=45000, cv=0.12,
                                level_fn=lambda i, n: 1.0 if i < n - 20 else 0.45),         {"DECREASE", "HOLD"},     "DECREASE"),
    "freak_big_days":     (dict(mean=45000, cv=0.12, outliers=3, outlier_mult=20.0),        {"INCREASE", "HOLD"},     "INCREASE"),
}


# Only score as_of days where the event is already visible (>= 3 days into the decline).
# Before that, raising the rate is the CORRECT call: nothing has happened yet.
SCORED_K_MAX = {"persistent_decline": 18}      # as_of = END-(k-1); decline starts at END-19
DECLINE_START = END - timedelta(days=19)


def backtest(seeds=30, days_back=30, n_boot=200, current_rate=2.0):
    rows = []
    for name, (kw, ok, target) in ARCHETYPES.items():
        counts = {"INCREASE": 0, "HOLD": 0, "DECREASE": 0}
        flips = 0
        steps = 0
        wrong = 0
        total = 0
        reaction = []
        for sd in range(seeds):
            rng = np.random.default_rng(1000 + sd)
            start, daily = make_series(N, rng=rng, **kw)
            prev = None
            first_dec = None
            for k in range(days_back, 0, -1):
                as_of = END - timedelta(days=k - 1)
                a = sr.recommend("bt", daily, start, as_of, current_rate, now=NOW, n_boot=n_boot)["action"]
                if name == "persistent_decline" and a == "DECREASE" and first_dec is None and as_of >= DECLINE_START:
                    first_dec = (as_of - DECLINE_START).days + 1
                if k > SCORED_K_MAX.get(name, 99):
                    prev = a
                    continue
                counts[a] += 1
                total += 1
                wrong += a not in ok
                if prev is not None:
                    steps += 1
                    flips += a != prev
                prev = a
            if name == "persistent_decline":
                reaction.append(first_dec if first_dec is not None else 99)
        rows.append((name, target, counts, total, wrong, flips, steps, reaction))
    return rows


def main():
    rows = backtest()
    print(f"{'archetype':<20}{'want':<10}{'INCREASE':>9}{'HOLD':>7}{'DECREASE':>10}{'WRONG':>8}{'flicker':>9}")
    worst_wrong = 0.0
    for name, target, c, total, wrong, flips, steps, reaction in rows:
        w = wrong / total
        worst_wrong = max(worst_wrong, w)
        print(f"{name:<20}{target:<10}{c['INCREASE'] / total:>9.0%}{c['HOLD'] / total:>7.0%}"
              f"{c['DECREASE'] / total:>10.0%}{w:>8.1%}{flips / steps:>9.1%}")
    dec = [r for r in rows if r[0] == "persistent_decline"][0][7]
    if dec:
        print(f"\nPersistent decline: first DECREASE on day {int(np.median(dec))} of the drop (median); "
              f"{sum(1 for d in dec if d == 99)} of {len(dec)} traders never triggered.")
    print(f"\n{rows[0][3]} runs per archetype. WRONG = acted in the harmful direction. flicker = day-to-day answer changes.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
