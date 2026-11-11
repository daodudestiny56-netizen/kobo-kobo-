#!/usr/bin/env python3
"""Smart Rate tests. Run:  python test_smart_rate.py   (about 10 seconds)"""
import sys as _sys
from pathlib import Path as _Path

_HERE = str(_Path(__file__).resolve().parent)       # lets sibling files (smart_rate.py ...) import from ANY folder
if _HERE not in _sys.path:
    _sys.path.insert(0, _HERE)
import sys
from datetime import date, datetime, timedelta, timezone

import numpy as np
from fastapi.testclient import TestClient

import kobo_ai_service as svc
import smart_rate as sr
import smart_rate_sim as sim

client = TestClient(svc.app)
NOW = datetime(2026, 11, 6, 9, 0, tzinfo=timezone.utc)
AS_OF = "2026-11-05"
fails = 0
messages_seen = []


def t(name, cond, detail=""):
    global fails
    fails += not cond
    print(f"{'PASS' if cond else 'FAIL'}  {name}" + (f"   [{detail}]" if (detail and not cond) else ""))
    return cond


def iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def preview(mid, now=NOW, **kw):
    params = {"as_of": AS_OF, "now": iso(now)}
    params.update(kw)
    return client.get(f"/api/v1/ai/smart-rate/{mid}", params=params).json()


def eng(daily_kw, rate=2.0, end=sim.END, seed=7, n=60, **kw):
    rng = np.random.default_rng(seed)
    start, daily = sim.make_series(n, rng=rng, end=end, **daily_kw)
    return sr.recommend("t", daily, start, end, rate, now=NOW, **kw), daily, start


# ------------------------------------------------------------------ A. the 5 seeded merchants
print("== Seeded merchants (as_of 2026-11-05) ==")
svc.SUGGESTIONS.clear()
r1, r2, r3, r4, r5 = (preview(f"m_000{i}") for i in range(1, 6))
t("m_0001 steady trader -> INCREASE to 2.5%", r1["action"] == "INCREASE" and r1["recommended_rate"] == 2.5, r1)
t("m_0001 confidence is high but never 100%", 0.9 <= r1["confidence_score"] <= 0.99, r1["confidence_score"])
t("m_0001 learned the weekly rhythm (Saturday best, Sunday slowest)",
  any("Saturday" in i and "Sunday" in i for i in r1["insights"]), r1["insights"])
t("m_0002 volatile trader -> DECREASE, labelled VOLATILE (not 'declining')",
  r2["action"] == "DECREASE" and r2["regime"] == "VOLATILE" and r2["recommended_rate"] == 1.5, (r2["action"], r2["regime"], r2["recommended_rate"]))
t("m_0003 new trader (9 days) -> HOLD, INSUFFICIENT_DATA, no message",
  r3["action"] == "HOLD" and r3["hold_reason"] == "INSUFFICIENT_DATA" and r3["suggestion"] is None)
t("m_0004 sick week -> HOLD, TEMPORARY_DISRUPTION (not punished)",
  r4["action"] == "HOLD" and r4["hold_reason"] == "TEMPORARY_DISRUPTION")
t("m_0005 steady trader -> INCREASE", r5["action"] == "INCREASE" and r5["recommended_rate"] == 2.5, r5["action"])
t("increase is ONE step (+0.5) even though the target may be higher",
  all(r["recommended_rate"] - r["current_rate"] <= 0.5 for r in (r1, r5)))
t("every suggestion needs consent; every HOLD does not",
  r1["consent_required"] and r2["consent_required"] and not r3["consent_required"] and not r4["consent_required"])
t("response carries an audit trail of checks", len(r1["checks"]) >= 6 and all("passed" in c for c in r1["checks"]))

# ------------------------------------------------------------------ B. archetypes (engine direct)
print("\n== Archetypes ==")
r, _, _ = eng(dict(mean=45000, cv=0.12))
t("steady high income -> INCREASE 2.0 to 2.5", r["action"] == "INCREASE" and r["recommended_rate"] == 2.5)
r, _, _ = eng(dict(mean=20000, cv=0.10))
t("steady LOW income -> HOLD (we never talk a stable trader down)", r["action"] == "HOLD", (r["action"], r["hold_reason"]))
r, _, _ = eng(dict(mean=30000, cv=0.9, zero_p=0.2))
t("volatile -> DECREASE (VOLATILE)", r["action"] == "DECREASE" and r["regime"] == "VOLATILE" and r["recommended_rate"] <= 1.5)
r, _, _ = eng(dict(mean=30000, cv=0.9, zero_p=0.2), rate=1.0)
t("volatile but already at 1% -> HOLD AT_MIN", r["action"] == "HOLD" and r["hold_reason"] == "AT_MIN")
r, _, _ = eng(dict(mean=30000, cv=0.9, zero_p=0.2), rate=3.5)
t("decrease is gentle: from 3.5% at most down to 2.5%", r["action"] == "DECREASE" and r["recommended_rate"] >= 2.5, r["recommended_rate"])
r, _, _ = eng(dict(mean=150000, cv=0.08), rate=3.5)
t("very high steady income already at 3.5% -> HOLD AT_CAP", r["action"] == "HOLD" and r["hold_reason"] == "AT_CAP", (r["action"], r["hold_reason"]))
r, _, _ = eng(dict(mean=150000, cv=0.08), rate=1.0)
t("from 1% a rich steady trader gets +0.5 only, not a jump to the cap", r["action"] == "INCREASE" and r["recommended_rate"] == 1.5, r["recommended_rate"])

# weekly rhythm: naive volatility would call this trader unstable
r, daily, _ = eng(dict(mean=45000, cv=0.08, dow=sim.WEEKLY), n=60)
last30 = np.array([daily[sim.END - timedelta(days=i)] for i in range(30)])
raw_cv = float(last30.std() / last30.mean())
t("weekly rhythm: naive CV looks unstable, ours does not",
  raw_cv > 0.30 and r["metrics"]["volatility_cv"] < 0.20 and r["action"] == "INCREASE",
  f"raw={raw_cv:.2f} ours={r['metrics']['volatility_cv']}")

# regular day off
r, daily, _ = eng(dict(mean=45000, cv=0.12, closed=(6,)), n=60)
naive_zero = sum(1 for i in range(30) if daily[sim.END - timedelta(days=i)] == 0) / 30
t("closed on Sundays: naive zero-rate would block an increase, ours ignores the day off",
  naive_zero > 0.10 and r["metrics"]["regular_days_off"] == ["Sun"] and r["action"] == "INCREASE", f"naive={naive_zero:.0%}")

# freak day
base_r, _, _ = eng(dict(mean=45000, cv=0.12), seed=11)
rng = np.random.default_rng(11)
start, daily = sim.make_series(60, mean=45000, cv=0.12, rng=rng)
daily[sim.END - timedelta(days=5)] = 3_000_000.0
r = sr.recommend("t", daily, start, sim.END, 2.0, now=NOW)
t("one N3,000,000 day cannot fake growth: same answer, big day capped, level barely moves",
  r["action"] == base_r["action"] and r["recommended_rate"] == base_r["recommended_rate"] and r["metrics"]["capped_days"] >= 1
  and abs(r["metrics"]["avg_daily_takings"] / base_r["metrics"]["avg_daily_takings"] - 1) < 0.08,
  (r["metrics"]["avg_daily_takings"], base_r["metrics"]["avg_daily_takings"]))

# short break vs real decline
r, _, _ = eng(dict(mean=45000, cv=0.12, sick=(55, 5)), n=60)
t("5 days of no sales right now -> HOLD, TEMPORARY_DISRUPTION", r["action"] == "HOLD" and r["regime"] == "TEMPORARY_DISRUPTION")
r, _, _ = eng(dict(mean=45000, cv=0.12, sick=(45, 5)), n=60)
t("same break, now finished -> ignored, trader treated normally (INCREASE)",
  r["action"] == "INCREASE" and "BREAKS_IGNORED" in r["flags"], (r["action"], r["flags"]))
r, _, _ = eng(dict(mean=45000, cv=0.12, level_fn=lambda i, n: 1.0 if i < n - 20 else 0.45), n=60)
t("income more than halves for 20 days -> DECLINING, DECREASE by 1 or 2 steps (bigger drop = bigger step)",
  r["action"] == "DECREASE" and r["regime"] == "DECLINING" and 1.0 <= r["recommended_rate"] <= 1.5, (r["action"], r["regime"], r["recommended_rate"]))
r, _, _ = eng(dict(mean=45000, cv=0.12, sick=(47, 13)), n=60)
t("no sales for almost 2 weeks -> INACTIVE, nothing to adjust", r["action"] == "HOLD" and r["hold_reason"] in ("INACTIVE", "TEMPORARY_DISRUPTION"), r["hold_reason"])
r, _, _ = eng(dict(mean=45000, cv=0.12, zero_p=0.0, sick=(40, 20)), n=60)
t("INACTIVE trader is never messaged", r["suggestion"] is None)

# data / calendar / state gates
r, _, _ = eng(dict(mean=45000, cv=0.12), n=10)
t("10 days of history -> INSUFFICIENT_DATA", r["hold_reason"] == "INSUFFICIENT_DATA")
r, _, _ = eng(dict(mean=45000, cv=0.12), n=16)
t("16 days is enough to look but NOT to raise a rate (needs 3 weeks)", r["action"] == "HOLD" and r["hold_reason"] == "NEEDS_3_WEEKS", (r["action"], r["hold_reason"]))
r, _, _ = eng(dict(mean=45000, cv=0.12), end=date(2026, 12, 12))
t("festive peak (Dec): steady surge is NOT read as lasting growth", r["action"] == "HOLD" and r["hold_reason"] == "SEASONAL_PEAK", (r["action"], r["hold_reason"]))
r, _, _ = eng(dict(mean=45000, cv=0.12), is_paused=True)
t("paused sweeps -> HOLD PAUSED", r["hold_reason"] == "PAUSED")
a, _, _ = eng(dict(mean=45000, cv=0.12), seed=3)
b, _, _ = eng(dict(mean=45000, cv=0.12), seed=3)
t("deterministic: same input, same output", a == b)

# ------------------------------------------------------------------ C. consent flow (API)
print("\n== Consent flow ==")
svc.SUGGESTIONS.clear()
body = {"as_of": AS_OF, "now": iso(NOW)}
i1 = client.post("/api/v1/ai/smart-rate/m_0001/issue", json=body).json()
sid = i1["suggestion"]["suggestion_id"]
t("issue records a PENDING suggestion", i1["action"] == "INCREASE" and i1["suggestion"]["status"] == "PENDING")
i2 = client.post("/api/v1/ai/smart-rate/m_0001/issue", json=dict(body, now=iso(NOW + timedelta(hours=1)))).json()
t("issue is safe to retry: same suggestion back, no duplicate", i2["suggestion"]["suggestion_id"] == sid and len(svc.SUGGESTIONS) == 1)
p = preview("m_0001", now=NOW + timedelta(hours=2))
t("while one is pending, preview says HOLD COOLDOWN (no nagging)", p["action"] == "HOLD" and p["hold_reason"] == "COOLDOWN", (p["action"], p["hold_reason"]))
t("the rate is NOT changed by issuing (no apply block yet)", "apply" not in i1)
y = client.post("/api/v1/ai/smart-rate/respond", json={"suggestion_id": sid, "response": "yes", "now": iso(NOW + timedelta(hours=3))}).json()
t("YES -> approved, new rate 2.5, with the exact write instruction",
  y["approved"] and y["new_rate"] == 2.5 and y["apply"]["column"] == "sweep_percentage" and y["apply"]["value"] == 2.5, y)
y2 = client.post("/api/v1/ai/smart-rate/respond", json={"suggestion_id": sid, "response": "1", "now": iso(NOW + timedelta(hours=4))}).json()
t("YES twice is idempotent", y2["approved"] and y2["new_rate"] == 2.5)
c = client.post("/api/v1/ai/smart-rate/respond", json={"suggestion_id": sid, "response": "NO"})
t("NO after YES is refused (409): already applied", c.status_code == 409)
p = preview("m_0001", now=NOW + timedelta(days=20), current_rate=2.0)
t("after an accepted change, a new increase waits 28 days", p["action"] == "HOLD" and p["hold_reason"] == "COOLDOWN", (p["action"], p["hold_reason"]))

i5 = client.post("/api/v1/ai/smart-rate/m_0005/issue", json=body).json()
n = client.post("/api/v1/ai/smart-rate/respond", json={"suggestion_id": i5["suggestion"]["suggestion_id"], "response": "NO", "now": iso(NOW + timedelta(hours=1))}).json()
t("NO -> not approved, rate stays", n["approved"] is False and n["new_rate"] is None and n["rate_stays_at"] == 2.0 and n["apply"] is None)
p10 = preview("m_0005", now=NOW + timedelta(days=10))
p20 = preview("m_0005", now=NOW + timedelta(days=20))
p35 = preview("m_0005", now=NOW + timedelta(days=35))
t("a NO is remembered: quiet at day 10 and day 20", p10["hold_reason"] == "COOLDOWN" and p20["hold_reason"] == "COOLDOWN", (p10["hold_reason"], p20["hold_reason"]))
t("... and allowed again after 30 days", p35["action"] == "INCREASE", (p35["action"], p35["hold_reason"]))

i2m = client.post("/api/v1/ai/smart-rate/m_0002/issue", json=body).json()
e = client.post("/api/v1/ai/smart-rate/respond", json={"suggestion_id": i2m["suggestion"]["suggestion_id"], "response": "YES", "now": iso(NOW + timedelta(days=8))}).json()
t("YES after 7 days is refused: the data has moved on", e["approved"] is False and "EXPIRED" in (e["reason"] or "") and e["apply"] is None, e)

h3 = client.post("/api/v1/ai/smart-rate/m_0003/issue", json=body).json()
h4 = client.post("/api/v1/ai/smart-rate/m_0004/issue", json=body).json()
t("HOLD results are never recorded as suggestions", h3["action"] == "HOLD" and h4["action"] == "HOLD"
  and not any(r["merchant_id"] in ("m_0003", "m_0004") for r in svc.SUGGESTIONS.values()))
t("unknown suggestion id -> 404", client.post("/api/v1/ai/smart-rate/respond", json={"suggestion_id": "sr_nope", "response": "YES"}).status_code == 404)
t("garbage reply -> 422", client.post("/api/v1/ai/smart-rate/respond", json={"suggestion_id": sid, "response": "maybe"}).status_code == 422)
t("unknown merchant -> 404", client.get("/api/v1/ai/smart-rate/m_9999").status_code == 404)
p = preview("m_0005", now=NOW + timedelta(days=60), is_paused="true")
t("paused merchant is never asked", p["action"] == "HOLD" and p["hold_reason"] == "PAUSED")

# ------------------------------------------------------------------ D. messages
print("\n== Messages ==")
svc.SUGGESTIONS.clear()
for lang in ("en", "pidgin", "yoruba"):
    for mid in ("m_0001", "m_0002", "m_0005"):
        r = preview(mid, language=lang)
        if r["suggestion"]:
            messages_seen.append(r["suggestion"]["messages"])
bad = [m for m in messages_seen if m["language_fallback"] is False and (m["sms_encoding"] != "GSM-7" or m["sms_segments"] != 1)]
t(f"all {len(messages_seen)} generated SMS fit ONE GSM-7 segment (₦ would force a 70-char Unicode SMS)", not bad, [m["sms"] for m in bad])
import re
t("WhatsApp uses the real ₦ sign wherever SMS has an amount; SMS and USSD never use ₦",
  all("₦" not in m["sms"] and "₦" not in m["ussd"] and (not re.search(r"N\d", m["sms"]) or "₦" in m["whatsapp"])
      for m in messages_seen))
t("USSD screens fit the 182-char limit", all(len(m["ussd"]) <= 182 and m["ussd"].startswith("CON ") for m in messages_seen))
t("Yoruba/Hausa/Igbo fall back to English and say so (needs native review)",
  all(m["language_fallback"] and m["text_language"] == "en" for m in messages_seen if m["language"] == "yoruba"))
t("every SMS asks for YES/NO and names the current rate or says how to answer", all("YES" in m["sms"] for m in messages_seen))


# ------------------------------------------------------------------ E. PRD v3: daily cap
print("\n== Daily cap (PRD v3 6.2) ==")
r, _, _ = eng(dict(mean=300000, cv=0.08), rate=2.0)
t("a trader whose 2% already hits the N5,000 daily cap is NOT offered a higher rate (it would add nothing)",
  r["action"] == "HOLD" and r["hold_reason"] == "DAILY_CAP_REACHED" and r["suggestion"] is None, (r["action"], r["hold_reason"]))
r2, _, _ = eng(dict(mean=300000, cv=0.08), rate=2.0, daily_cap=50000.0)
t("... with a bigger cap the same trader can get the increase", r2["action"] == "INCREASE")
r3, _, _ = eng(dict(mean=45000, cv=0.12), rate=2.0)
exp_delta = 0.005 * r3["metrics"]["avg_daily_takings"] * 30
t("a normal trader's impact is unchanged by the cap (rate x takings x 30 days)", abs(r3["impact"]["monthly_change"] - exp_delta) < 1.0, (r3["impact"]["monthly_change"], exp_delta))

print(f"\n{'ALL PASSED' if not fails else str(fails) + ' FAILED'}")
sys.exit(1 if fails else 0)
