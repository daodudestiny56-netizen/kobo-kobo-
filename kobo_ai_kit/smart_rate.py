#!/usr/bin/env python3
"""
Kobo Kobo - Smart Rate engine (PRD v2.0.0 section 3.4 + Tomiwa deliverable M1).

Pure Python + numpy. No web framework, no network. The only randomness is a bootstrap that is
seeded from (merchant, date), so the same input always gives the same answer.

Plain-language summary
  Looks at a trader's daily takings and answers one question: "is the sweep rate still right?"
  It can only SUGGEST. A rate changes only after the trader replies YES (see the API layer).

How it thinks
  1. Learns the trader's own weekly rhythm (busy Saturday, slow Sunday) so a normal pattern is not
     mistaken for instability.
  2. Ignores regular days off (a trader who never opens on Sunday is not punished for it).
  3. Caps freak days so one huge day cannot fake a growth story. (Sweep Guard also keeps flagged
     inflows out of the history this engine reads.)
  4. Tells a short bad patch (illness, holiday, rain) from a real decline. Short patch -> do nothing.
  5. Capacity = income level x stability x zero-sales frequency -> a target rate, then moves
     ONE step at a time (up 0.5, down at most 1.0), never above an affordability cap.
  6. Re-samples the last 30 days many ways. The share of re-samples that agree = confidence score.
  7. Raises only with strong evidence (80%+), lowers with less (60%+). Asymmetric on purpose.
  8. Does not nag: cooldowns, 7-day expiry, and a NO is remembered for 30 days.

Honest limits: this is statistics + rules, calibrated on synthetic archetypes (no real merchant data
exists yet). Every threshold is a constant below so it can be re-tuned on Access / ARM data.
"""
import hashlib
import math
import warnings
from datetime import date, datetime, timedelta, timezone

import numpy as np

MODEL_VERSION = "smart-rate-v1"

# ---- rate limits
RATE_MIN = 1.0
RATE_STEP = 0.5
RATE_CEILING = 3.5          # this engine never recommends above this
ASSUMED_MARGIN = 0.15       # assumption: informal retail keeps ~15% of takings as profit
MAX_PROFIT_SHARE = 0.25     # never recommend saving more than ~25% of estimated profit
MAX_STEP_UP = 0.5
MAX_STEP_DOWN = 1.0
HARD_MAX_RATE = 5.0         # PRD range is 1%-5%; trader may choose up to this themselves

# ---- data requirements
WINDOW_MAX_DAYS = 56
MIN_DAYS_ANY = 14
MIN_DAYS_INCREASE = 21
MIN_ACTIVE_DAYS = 8
MIN_DAYS_SEASONALITY = 24   # trading days needed before learning a weekly pattern
SEASON_K = 2.0              # shrink weekday factors toward 1.0 (fewer samples -> more shrinkage)
WINSOR_SIGMAS = 3.0         # cap a day at median x exp(3 x the trader's own log-spread, min 0.25)

# ---- statistics / decisions
BOOTSTRAP_B = 500
UP_CONF = 0.80
DOWN_CONF = 0.60
DECLINE_CONF = 0.95        # a drop must be bigger than normal ups and downs 95% of the time
MAX_CONFIDENCE = 0.99       # never claim certainty
DECLINE_RATIO = 0.75        # recent 14d vs the 4 weeks before
GROWTH_RATIO = 1.10
TREND_MIN_FOR_INCREASE = 0.90
CV_VOLATILE = 0.45
ZERO_VOLATILE = 0.15
CV_STEADY_FOR_INCREASE = 0.35
ZERO_STEADY_FOR_INCREASE = 0.10
INACTIVE_ZERO_SHARE = 0.85
SHOCK_LOW_FRACTION = 0.65   # a day below 65% of the normal active day is "low" (clear of normal noise)
SHOCK_MIN_RUN = 3
SHOCK_MAX_RUN = 10
SHOCK_BASELINE_CV = 0.45

# ---- suggestions
EXPIRY_DAYS = 7
COOLDOWN_UP_DAYS = 14
COOLDOWN_DOWN_DAYS = 7
DECLINED_QUIET_DAYS = 30
ACCEPTED_SETTLE_DAYS = 28

# Assumption to validate with real data: December is the festive trading peak, so a December surge is
# not read as sustainable growth. Each window is ((month, day), (month, day)).
SEASONAL_PEAK_WINDOWS = [((12, 1), (12, 31))]

DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
FULL = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]


def affordability_cap():
    by_profit = math.floor(100 * ASSUMED_MARGIN * MAX_PROFIT_SHARE / RATE_STEP) * RATE_STEP
    return float(min(RATE_CEILING, by_profit))


def snap(r):
    return np.floor(np.asarray(r, dtype=float) / RATE_STEP + 0.5) * RATE_STEP


# =============================================================================== small helpers
def _aware(dt):
    if dt is None:
        return datetime.now(timezone.utc)
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _iso(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _py(o):
    if isinstance(o, dict):
        return {k: _py(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_py(v) for v in o]
    if isinstance(o, np.generic):
        return o.item()
    return o


def _window(days, end, k):
    lo = end - timedelta(days=k - 1)
    return np.array([lo <= d <= end for d in days], dtype=bool)


def _between(days, lo, hi):
    return np.array([lo <= d <= hi for d in days], dtype=bool)


def _robust_cv(v, min_n=8):
    if len(v) < min_n:
        return None
    med = float(np.median(v))
    if med <= 0:
        return None
    return float(1.4826 * np.median(np.abs(v - med)) / med)


def _in_peak(d):
    md = (d.month, d.day)
    return any(a <= md <= b for a, b in SEASONAL_PEAK_WINDOWS)


def _approx(v):
    v = abs(float(v))
    step = 50 if v < 1000 else 100
    return int(round(v / step) * step)


def _pct(v):
    return f"{v:g}%"


def _stability_label(cv, zero_rate):
    if cv is None:
        return "UNKNOWN"
    if cv <= 0.25 and zero_rate <= 0.10:
        return "HIGH"
    if cv >= 0.50 or zero_rate >= 0.20:
        return "LOW"
    return "MEDIUM"


# =============================================================================== SMS helpers
_GSM7 = set("@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ ÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡"
            "ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà")
_GSM7_EXT = set("^{}\\[~]|€")


def sms_info(text):
    """Return (units, segments, encoding). The naira sign is NOT in GSM-7: it forces UCS-2 (70 chars/SMS)."""
    units = 0
    for ch in text:
        if ch in _GSM7:
            units += 1
        elif ch in _GSM7_EXT:
            units += 2
        else:
            n = len(text)
            return n, (1 if n <= 70 else math.ceil(n / 67)), "UCS-2"
    return units, (1 if units <= 160 else math.ceil(units / 153)), "GSM-7"


_TXT = {
    "en": {
        "INCREASE": ("Kobo Kobo: Your sales are steady (about {cs}{E:,}/day). Raise pension from {cur} to {rec}? "
                     "Adds about {cs}{d:,}/month. Reply YES to confirm or NO to keep {cur}."),
        "DECREASE_VOLATILE": ("Kobo Kobo: Your sales have been uneven lately. To protect your business money, "
                              "lower pension from {cur} to {rec}? Reply YES to confirm or NO to keep {cur}."),
        "DECREASE_DECLINING": ("Kobo Kobo: Your sales have dropped lately. To protect your business money, "
                               "lower pension from {cur} to {rec}? Reply YES to confirm or NO to keep {cur}."),
        "USSD_INCREASE": "CON Kobo Kobo Smart Rate\nRaise pension {cur} -> {rec}?\nAdds about N{d:,}/month\n1. Yes, change it\n2. No, keep {cur}",
        "USSD_DECREASE": "CON Kobo Kobo Smart Rate\nLower pension {cur} -> {rec}?\nThis protects your business money\n1. Yes, change it\n2. No, keep {cur}",
        "DONE": "Kobo Kobo: Done. Your pension rate is now {rec} and starts with the next nightly sweep.",
        "KEPT": "Kobo Kobo: No problem. Your pension rate stays at {cur}.",
    },
    "pidgin": {
        "INCREASE": ("Kobo Kobo: Your sales dey steady (about {cs}{E:,}/day). Make we move pension from {cur} to {rec}? "
                     "E go add about {cs}{d:,} every month. Reply YES or NO."),
        "DECREASE_VOLATILE": ("Kobo Kobo: Your sales dey up and down. To protect your business money, "
                              "make we reduce pension from {cur} to {rec}? Reply YES or NO."),
        "DECREASE_DECLINING": ("Kobo Kobo: Your sales don reduce. To protect your business money, "
                               "make we reduce pension from {cur} to {rec}? Reply YES or NO."),
        "USSD_INCREASE": "CON Kobo Kobo Smart Rate\nMake we move pension {cur} -> {rec}?\nE go add about N{d:,}/month\n1. Yes\n2. No, keep {cur}",
        "USSD_DECREASE": "CON Kobo Kobo Smart Rate\nMake we reduce pension {cur} -> {rec}?\nThis one dey protect your business money\n1. Yes\n2. No, keep {cur}",
        "DONE": "Kobo Kobo: E don do. Your pension rate na {rec} now. E go start for the next night sweep.",
        "KEPT": "Kobo Kobo: No wahala. Your pension rate go remain {cur}.",
    },
}


def _tl(language):
    return "pidgin" if language == "pidgin" else "en"


def confirmation_text(kind, language, cur, rec):
    """kind: 'DONE' or 'KEPT'."""
    return _TXT[_tl(language)][kind].format(cur=_pct(cur), rec=_pct(rec))


def build_messages(action, regime, cur, rec, E, delta, language):
    tl = _tl(language)
    t = _TXT[tl]
    kind = "INCREASE" if action == "INCREASE" else ("DECREASE_DECLINING" if regime == "DECLINING" else "DECREASE_VOLATILE")
    args = dict(cur=_pct(cur), rec=_pct(rec), E=_approx(E), d=_approx(delta))
    sms = t[kind].format(cs="N", **args)
    units, segs, enc = sms_info(sms)
    return {
        "language": language,
        "text_language": tl,
        "language_fallback": language not in ("en", "pidgin"),   # yo/ha/ig drafts need native review: voice phase
        "sms": sms,
        "sms_units": units,
        "sms_segments": segs,
        "sms_encoding": enc,
        "whatsapp": t[kind].format(cs="₦", **args),
        "ussd": t["USSD_INCREASE" if action == "INCREASE" else "USSD_DECREASE"].format(**args),
    }


# =============================================================================== data preparation
def _prepare(all_days, x):
    days = list(all_days[-WINDOW_MAX_DAYS:])
    x = np.asarray(x[-WINDOW_MAX_DAYS:], dtype=float)
    dows = np.array([d.weekday() for d in days], dtype=int)

    # regular days off: a weekday that is (almost) always zero over >= 4 occurrences
    closed = []
    for k in range(7):
        idx = dows == k
        if int(idx.sum()) >= 4 and float((x[idx] <= 0).mean()) >= 0.75:
            closed.append(k)
    if len(closed) > 2:          # that is inactivity, not a weekly rhythm
        closed = []
    keep = ~np.isin(dows, closed)
    days_t = [d for d, kp in zip(days, keep) if kp]
    x_t, dows_t = x[keep], dows[keep]

    # finished breaks: >= 3 trading days in a row with no sales, followed by sales again (even 1 day)
    # (illness, travel, holiday). They are removed so they never count as "volatility" or "decline".
    # A break still in progress is kept: the disruption logic handles it.
    breaks = []
    pos = x_t > 0
    keepb = np.ones(len(x_t), dtype=bool)
    i = 0
    while i < len(x_t):
        if pos[i]:
            i += 1
            continue
        j = i
        while j < len(x_t) and not pos[j]:
            j += 1
        if (j - i) >= SHOCK_MIN_RUN and j < len(x_t) and int(pos[j:j + 1].sum()) >= 1:
            keepb[i:j] = False
            breaks.append((days_t[i], days_t[j - 1], j - i))
        i = j
    days_t = [d for d, kp in zip(days_t, keepb) if kp]
    x_t, dows_t = x_t[keepb], dows_t[keepb]

    # winsorise freak days: cap at median x exp(3 x this trader's own log-spread)
    capped = 0
    nz = x_t[x_t > 0]
    if len(nz) >= 5:
        lg = np.log(nz)
        sig = max(1.4826 * float(np.median(np.abs(lg - np.median(lg)))), 0.25)
        cap = float(np.median(nz)) * math.exp(WINSOR_SIGMAS * sig)
        capped = int((x_t > cap).sum())
        x_w = np.minimum(x_t, cap)
    else:
        x_w = x_t.copy()

    # weekly rhythm (multiplicative, shrunk toward 1.0)
    f = np.ones(7)
    seasonal = False
    if len(x_w) >= MIN_DAYS_SEASONALITY and float(x_w.mean()) > 0:
        overall = float(x_w.mean())
        for k in range(7):
            idx = dows_t == k
            n = int(idx.sum())
            if n == 0:
                continue
            raw = float(x_w[idx].mean()) / overall
            f[k] = (n * raw + SEASON_K) / (n + SEASON_K)
        f = f / float(np.mean(f[dows_t]))
        seasonal = True
    y = x_w / f[dows_t]
    return {"days": days_t, "x": x_t, "y": y, "dows": dows_t, "factors": f, "seasonal": seasonal,
            "closed": closed, "capped": capped, "breaks": breaks}


def _batch_stats(Y):
    E = Y.mean(axis=1)
    zero_rate = (Y <= 0).mean(axis=1)
    Z = np.where(Y > 0, Y, np.nan)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        med = np.nanmedian(Z, axis=1)
        mad = np.nanmedian(np.abs(Z - med[:, None]), axis=1)
        cv = 1.4826 * mad / med
    return E, zero_rate, cv


def _rate_batch(E, zero_rate, cv, cap):
    E = np.asarray(E, float)
    zero_rate = np.asarray(zero_rate, float)
    cv = np.asarray(cv, float)
    cv = np.where(np.isnan(cv), 1.0, cv)
    g = np.clip((np.log(np.maximum(E, 1.0)) - math.log(10_000)) / (math.log(100_000) - math.log(10_000)), 0, 1)
    h = 1 - 0.65 * np.clip((cv - 0.20) / 0.60, 0, 1)
    k = 1 - 0.60 * np.clip((zero_rate - 0.05) / 0.25, 0, 1)
    c = g * h * k
    return RATE_MIN + (cap - RATE_MIN) * c, c


def _low_run(y):
    nz = y[y > 0]
    if len(nz) < 8:
        return 0, None
    base = float(np.median(nz))
    low = y < SHOCK_LOW_FRACTION * base
    run = 0
    for v in low[::-1]:
        if not v:
            break
        run += 1
    pre = y[: len(y) - run] if run else y
    return run, _robust_cv(pre[pre > 0][-30:])


def _cooldown(records, direction, now):
    if not records:
        return True, "No earlier suggestions."
    recs = sorted(records, key=lambda r: r["created_at"])
    last = recs[-1]
    if last["status"] == "PENDING" and now < last["expires_at"]:
        return False, f"Suggestion {last['id']} is still waiting for the trader's reply."
    gap = COOLDOWN_DOWN_DAYS if direction == "DECREASE" else COOLDOWN_UP_DAYS
    age = (now - last["created_at"]).days
    if age < gap:
        return False, f"The last suggestion was {age} day(s) ago (minimum gap {gap})."
    for r in recs:
        if (r["status"] == "DECLINED" and r["direction"] == direction and r.get("responded_at")
                and (now - r["responded_at"]).days < DECLINED_QUIET_DAYS):
            return False, f"The trader said NO to a {direction.lower()} less than {DECLINED_QUIET_DAYS} days ago."
    if direction == "INCREASE":
        for r in recs:
            if r["status"] == "ACCEPTED" and r.get("responded_at") and (now - r["responded_at"]).days < ACCEPTED_SETTLE_DAYS:
                return False, f"The rate was changed less than {ACCEPTED_SETTLE_DAYS} days ago; letting it settle."
    return True, "OK."


# =============================================================================== the recommendation
def recommend(merchant_id, daily, start, as_of, current_rate, language="en", is_paused=False,
              records=None, now=None, n_boot=BOOTSTRAP_B, daily_cap=5000.0):
    """
    daily: {date: takings}. Missing dates count as zero-sales days.
    start: first date the merchant could trade (account opened). as_of: last COMPLETE day to analyse.
    records: earlier suggestions for this merchant (dicts with id, direction, status, created_at,
             expires_at, responded_at) for cooldown rules.
    """
    now = _aware(now)
    records = records or []
    cap = affordability_cap()
    cur = float(min(max(float(snap(current_rate)), RATE_MIN), HARD_MAX_RATE))
    all_days = [start + timedelta(days=i) for i in range(max((as_of - start).days + 1, 0))]
    x_all = np.array([float(daily.get(d, 0.0)) for d in all_days], dtype=float)
    active_days = int((x_all > 0).sum())
    checks, flags, insights = [], [], []

    def check(name, passed, applies_to, detail):
        checks.append({"name": name, "passed": bool(passed), "applies_to": applies_to, "detail": detail})
        return bool(passed)

    base = {"merchant_id": merchant_id, "as_of": as_of.isoformat(), "current_rate": cur,
            "model_version": MODEL_VERSION,
            "limits": {"min_rate": RATE_MIN, "max_rate": cap, "step": RATE_STEP,
                       "max_step_up": MAX_STEP_UP, "max_step_down": MAX_STEP_DOWN}}

    def finish(action, hold_reason, rec, regime, confidence, metrics, rationale, suggestion=None, impact=None):
        out = dict(base)
        out.update({"recommended_rate": rec, "action": action, "hold_reason": hold_reason, "regime": regime,
                    "confidence_score": confidence, "consent_required": action != "HOLD",
                    "suggestion": suggestion, "impact": impact, "metrics": metrics,
                    "rationale": rationale, "insights": insights, "flags": flags, "checks": checks})
        return _py(out)

    # ---------------------------------------------------------------- 1. enough data?
    if not check("enough_history", len(all_days) >= MIN_DAYS_ANY and active_days >= MIN_ACTIVE_DAYS, "any",
                 f"{len(all_days)} days of history, {active_days} with sales "
                 f"(need {MIN_DAYS_ANY} days and {MIN_ACTIVE_DAYS} with sales)."):
        return finish("HOLD", "INSUFFICIENT_DATA", cur, "INSUFFICIENT_DATA", None,
                      {"days_of_history": len(all_days), "days_with_sales": active_days},
                      "We need at least 2 weeks of sales history before we can suggest a rate. "
                      "Keep selling and we will check again.")

    # ---------------------------------------------------------------- 2. clean the series
    P = _prepare(all_days, x_all)
    days, y, closed = P["days"], P["y"], P["closed"]
    y30, y14 = y[_window(days, as_of, 30)], y[_window(days, as_of, 14)]
    n14 = len(y14)
    E, zr30, cv30 = (float(a[0]) for a in _batch_stats(y30[None, :]))
    cv30f = None if math.isnan(cv30) else cv30
    zero30, zero14 = int((y30 <= 0).sum()), int((y14 <= 0).sum())
    nz30 = y30[y30 > 0]
    median_active = float(np.median(nz30)) if len(nz30) else 0.0

    y_prior = y[_between(days, as_of - timedelta(days=41), as_of - timedelta(days=14))]
    trend = None
    if len(y_prior) >= 7 and float(y_prior.mean()) > 0 and n14 > 0:
        trend = float(y14.mean()) / float(y_prior.mean())

    run, pre_cv = _low_run(y)

    # A "decline" only means something for a trader who was STEADY before the drop. For an already volatile
    # trader a dip is normal noise (and the VOLATILE rule already protects them).
    prior_cv = _robust_cv(y_prior[y_prior > 0])
    prior_zero = float((y_prior <= 0).mean()) if len(y_prior) else 1.0
    baseline_steady = prior_cv is not None and prior_cv <= CV_VOLATILE and prior_zero <= ZERO_VOLATILE

    # ---------------------------------------------------------------- 3. bootstrap (seeded: deterministic)
    rng = np.random.default_rng(int(hashlib.sha256(f"{merchant_id}|{as_of}".encode()).hexdigest()[:8], 16))
    idx = rng.integers(0, len(y30), size=(n_boot, len(y30)))
    Eb, zb, cvb = _batch_stats(y30[idx])
    rb, _ = _rate_batch(Eb, zb, cvb, cap)
    snapped_b = snap(rb)
    r_point, c_point = _rate_batch(E, zr30, cv30, cap)
    r_snap = float(snap(r_point))
    p_up = float((snapped_b >= cur + RATE_STEP - 1e-9).mean())
    p_down = float((snapped_b <= cur - RATE_STEP + 1e-9).mean())
    p_hold = max(0.0, 1.0 - p_up - p_down)

    # Is the recent drop bigger than this trader's own normal noise? Shuffle the 42 days many ways and count how
    # often a random 14-day block looks this bad. (A plain bootstrap would treat any dip in a noisy trader as real.)
    p_decline = None
    if trend is not None:
        pool = np.concatenate([y14, y_prior])
        perm = rng.permuted(np.tile(pool, (n_boot, 1)), axis=1)
        ma, mb = perm[:, :n14].mean(axis=1), perm[:, n14:].mean(axis=1)
        valid = mb > 0
        ratio_b = np.where(valid, ma / np.where(valid, mb, 1.0), np.nan)
        p_noise = float(((ratio_b <= trend) & valid).sum() / max(int(valid.sum()), 1))
        p_decline = 1.0 - p_noise

    # ---------------------------------------------------------------- 4. what kind of trader is this right now?
    if n14 >= 7 and zero14 / n14 >= INACTIVE_ZERO_SHARE:
        regime = "INACTIVE"
    elif SHOCK_MIN_RUN <= run <= SHOCK_MAX_RUN and pre_cv is not None and pre_cv <= SHOCK_BASELINE_CV:
        regime = "TEMPORARY_DISRUPTION"
    elif (baseline_steady and trend is not None and trend < DECLINE_RATIO
          and p_decline is not None and p_decline >= DECLINE_CONF):
        regime = "DECLINING"
    elif cv30f is None or cv30f > CV_VOLATILE or zr30 > ZERO_VOLATILE:
        regime = "VOLATILE"
    elif trend is not None and trend >= GROWTH_RATIO:
        regime = "GROWING"
    else:
        regime = "STABLE"

    peak = _in_peak(as_of)
    if closed:
        flags.append("REGULAR_DAYS_OFF")
        insights.append("You don't trade on " + " and ".join(FULL[k] + "s" for k in closed)
                        + ". We ignore those days, so they never count against you.")
    if P["breaks"]:
        flags.append("BREAKS_IGNORED")
        b0 = P["breaks"][-1]
        insights.append(f"We ignored {len(P['breaks'])} break(s) in selling (latest: {b0[0].strftime('%d %b')} to "
                        f"{b0[1].strftime('%d %b')}, {b0[2]} days). Illness, travel or holiday never count against you.")
    if P["capped"]:
        flags.append("OUTLIER_DAYS_CAPPED")
        insights.append(f"{P['capped']} unusually big day(s) were capped so one big day can't distort your numbers.")
    if peak:
        flags.append("SEASONAL_PEAK")
    if P["seasonal"]:
        fs = {k: float(P["factors"][k]) for k in range(7) if k not in closed}
        best, worst = max(fs, key=fs.get), min(fs, key=fs.get)
        if fs[best] - fs[worst] >= 0.25:
            insights.append(f"Your best day is {FULL[best]} ({fs[best] - 1:+.0%} vs a normal day) "
                            f"and your slowest is {FULL[worst]} ({fs[worst] - 1:+.0%}).")

    trading_per_month = 30.0 * (7 - len(closed)) / 7.0
    metrics = {
        "days_of_history": len(all_days), "trading_days_used": len(days), "days_with_sales": active_days,
        "avg_daily_takings": round(E, 2), "median_active_day": round(median_active, 2),
        "zero_sales_days_last_14": zero14, "zero_sales_days_last_30": zero30,
        "volatility_cv": None if cv30f is None else round(cv30f, 3),
        "cash_flow_stability": _stability_label(cv30f, zr30),
        "trend_14d_vs_prior": None if trend is None else round(trend, 3),
        "recent_low_run_days": run,
        "regular_days_off": [DOW[k] for k in closed],
        "weekly_pattern": ({DOW[k]: round(float(P["factors"][k]), 2) for k in range(7) if k not in closed}
                           if P["seasonal"] else None),
        "capped_days": P["capped"],
        "ignored_breaks": len(P["breaks"]),
        "capacity_score": round(float(c_point), 3),
        "target_rate_raw": round(float(r_point), 2),
        "target_rate_snapped": r_snap,
        "p_support_up": round(p_up, 3), "p_support_down": round(p_down, 3),
        "p_decline": None if p_decline is None else round(p_decline, 3),
        "bootstrap_samples": n_boot,
    }

    def hold(code, text, conf=None):
        return finish("HOLD", code, cur, regime, conf, metrics, text)

    # ---------------------------------------------------------------- 5. rule-driven holds
    if not check("not_paused", not is_paused, "any",
                 "Sweeps are paused, so no suggestions are made." if is_paused else "Sweeps are active."):
        return hold("PAUSED", "Your sweeps are paused, so we are not suggesting any rate change.")
    if not check("trader_active", regime != "INACTIVE", "any",
                 f"{zero14} of the last {n14} trading days had no sales."):
        return hold("INACTIVE", "There were almost no sales in the last 2 weeks, so there is nothing to adjust.")
    if not check("no_short_term_disruption", regime != "TEMPORARY_DISRUPTION", "any",
                 f"{run} slow day(s) in a row after a steady stretch."):
        return hold("TEMPORARY_DISRUPTION",
                    f"Sales have been very low for the last {run} days after a steady stretch. We think this is a short "
                    f"break (illness, holiday or weather), so we are not changing your rate. We will check again next week.")

    # ---------------------------------------------------------------- 6. candidate direction
    candidate = None
    if regime == "DECLINING":
        candidate = "DECREASE"
    elif regime == "VOLATILE" and r_snap <= cur - RATE_STEP:
        candidate = "DECREASE"
    elif regime in ("STABLE", "GROWING") and r_snap >= cur + RATE_STEP:
        candidate = "INCREASE"

    if candidate is None:
        if regime in ("VOLATILE", "DECLINING") and cur <= RATE_MIN:
            return hold("AT_MIN", f"Your sales are uneven, but you are already at the lowest rate ({_pct(RATE_MIN)}).", p_hold)
        if regime in ("STABLE", "GROWING") and cur >= cap and r_snap >= cap:
            return hold("AT_CAP", f"Your sales are steady and you are already at the highest rate we recommend ({_pct(cap)}).", p_hold)
        return hold("RATE_FITS", f"Your sales are {'steady' if regime in ('STABLE', 'GROWING') else 'uneven'} and your "
                                 f"current rate of {_pct(cur)} fits. We are not suggesting a change.", p_hold)

    # PRD v3 6.2: a sweep never exceeds the daily cap, so above it a higher rate adds nothing
    if candidate == "INCREASE" and cur / 100.0 * E >= float(daily_cap):
        check("below_daily_cap", False, "increase", f"At {_pct(cur)} the average day already reaches the daily cap of ₦{float(daily_cap):,.0f}.")
        return hold("DAILY_CAP_REACHED", f"Your saving already reaches the daily limit of ₦{float(daily_cap):,.0f}, so a higher rate would not add anything.")

    # ---------------------------------------------------------------- 7. gates (the audit trail)
    ok_cool, cool_detail = _cooldown(records, candidate, now)
    if candidate == "INCREASE":
        gates = [
            ("three_weeks_of_history", len(all_days) >= MIN_DAYS_INCREASE, "NEEDS_3_WEEKS",
             f"{len(all_days)} days of history (need {MIN_DAYS_INCREASE} before raising a rate).",
             f"You have {len(all_days)} days with us. We need 3 weeks of sales before we suggest a higher rate."),
            ("steady_enough", (cv30f is not None and cv30f <= CV_STEADY_FOR_INCREASE and zr30 <= ZERO_STEADY_FOR_INCREASE),
             "NOT_STEADY_ENOUGH", f"volatility {cv30f if cv30f is None else round(cv30f, 2)}, zero-sales share {zr30:.0%} "
             f"(need <= {CV_STEADY_FOR_INCREASE} and <= {ZERO_STEADY_FOR_INCREASE:.0%}).",
             "Your sales are not steady enough yet for a higher rate."),
            ("trend_not_falling", trend is None or trend >= TREND_MIN_FOR_INCREASE, "TREND_FALLING",
             f"last 14 days vs the 4 weeks before: {trend if trend is None else round(trend, 2)}x (need >= {TREND_MIN_FOR_INCREASE}).",
             "Your recent sales are lower than before, so we are not suggesting a higher rate."),
            ("not_seasonal_peak", not peak, "SEASONAL_PEAK",
             "Date is inside a festive peak window." if peak else "Not a seasonal peak.",
             "Your sales are steady and a higher rate would fit. But this is the festive peak, so we will wait to see "
             "if sales hold after the season before suggesting an increase."),
            ("cooldown_ok", ok_cool, "COOLDOWN", cool_detail,
             "We made a suggestion recently, so we are giving you space before asking again."),
            ("statistical_confidence", p_up >= UP_CONF, "LOW_CONFIDENCE",
             f"{p_up:.0%} of re-checks support {_pct(cur + RATE_STEP)} (need {UP_CONF:.0%}).",
             "The data is close to the line, so we are keeping your current rate for now."),
        ]
        applies = "increase"
    else:
        is_decl = regime == "DECLINING"
        gates = [
            ("above_minimum_rate", cur > RATE_MIN, "AT_MIN", f"Current {_pct(cur)}, minimum {_pct(RATE_MIN)}.",
             f"You are already at the lowest rate ({_pct(RATE_MIN)})."),
            ("cooldown_ok", ok_cool, "COOLDOWN", cool_detail,
             "We made a suggestion recently, so we are giving you space before asking again."),
            ("statistical_confidence", (p_decline if is_decl else p_down) is not None and
             (p_decline if is_decl else p_down) >= (DECLINE_CONF if is_decl else DOWN_CONF), "LOW_CONFIDENCE",
             (f"Normal ups and downs would give a drop this big {1 - (p_decline or 0):.0%} of the time (need <= {1 - DECLINE_CONF:.0%})." if is_decl
              else f"{p_down:.0%} of re-checks support {_pct(max(cur - RATE_STEP, RATE_MIN))} or lower (need {DOWN_CONF:.0%})."),
             "The data is close to the line, so we are keeping your current rate for now."),
        ]
        applies = "decrease"
    failed = None
    for name, passed, code, detail, text in gates:
        if not check(name, passed, applies, detail) and failed is None:
            failed = (code, text)
    if failed:
        return hold(failed[0], failed[1], p_hold if failed[0] == "LOW_CONFIDENCE" else None)

    # ---------------------------------------------------------------- 8. build the suggestion
    if candidate == "INCREASE":
        rec = min(cur + MAX_STEP_UP, cap)
        conf = p_up
    elif regime == "DECLINING":
        rec = max(cur - (MAX_STEP_DOWN if (trend is not None and trend < 0.5) else RATE_STEP), RATE_MIN)
        conf = p_decline
    else:
        rec = max(r_snap, cur - MAX_STEP_DOWN, RATE_MIN)
        conf = p_down
    rec = float(rec)
    conf = min(float(conf), MAX_CONFIDENCE)
    delta = (min(rec / 100.0 * E, float(daily_cap)) - min(cur / 100.0 * E, float(daily_cap))) * trading_per_month
    impact = {"monthly_change": round(delta, 2), "annual_change": round(delta * 12, 2),
              "implied_profit_share_at_new_rate": round(rec / 100.0 / ASSUMED_MARGIN, 3),
              "assumed_margin": ASSUMED_MARGIN}
    sid = "sr_" + hashlib.sha1(f"{merchant_id}|{as_of}|{cur}|{rec}|{candidate}".encode()).hexdigest()[:8]
    suggestion = {"suggestion_id": sid, "status": "PREVIEW", "expires_at": _iso(now + timedelta(days=EXPIRY_DAYS)),
                  "messages": build_messages(candidate, regime, cur, rec, E, delta, language)}

    Eshow = f"₦{_approx(E):,}"
    if candidate == "INCREASE":
        rationale = (f"Your sales have been steady: about {Eshow} a day over the last 30 days, with {zero30} day(s) of no sales. "
                     f"At this level {_pct(rec)} is comfortable and adds about ₦{_approx(delta):,} a month to your pension. "
                     f"We re-checked your last 30 days {n_boot} different ways and {conf:.0%} still support at least {_pct(rec)}.")
    elif regime == "DECLINING":
        rationale = (f"Your average daily sales over the last 2 weeks are about {1 - trend:.0%} lower than in the 4 weeks before, "
                     f"and this has lasted more than {SHOCK_MAX_RUN} days, so it is not just a short break. "
                     f"To protect your business money we suggest easing to {_pct(rec)}, "
                     f"which lowers your monthly saving by about ₦{_approx(delta):,}. Normal ups and downs would give a drop this big only {1 - conf:.0%} of the time.")
    else:
        rationale = (f"Your sales have been uneven (a typical day swings by about {cv30f:.0%}"
                     f"{', ' + str(zero30) + ' day(s) with no sales in the last 30' if zero30 else ''}). "
                     f"To protect your business money we suggest easing to {_pct(rec)}, "
                     f"which lowers your monthly saving by about ₦{_approx(delta):,}. {conf:.0%} of our re-checks agree.")
    return finish(candidate, None, rec, regime, conf, metrics, rationale, suggestion, impact)
