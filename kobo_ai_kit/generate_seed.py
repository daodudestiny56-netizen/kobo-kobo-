#!/usr/bin/env python3
"""
Kobo Kobo - synthetic data generator (deterministic, seed=42). Matches PRD v2.0.0 schema.

    python generate_seed.py            # writes ./seed/*.json

  merchants.json       5 merchants (merchants table shape + `profile`, `business_name`)
  inflows.json         90 days of settled inflows (inflow_transactions shape).
                       No row for a day = no sales that day.
  daily_totals.json    per-merchant daily takings WITH explicit zero-sales days
  scenarios.json       "today" (2026-11-06) test cases: request body + expected Sweep Guard result
  kyc_name_pairs.json  labelled name pairs for /api/v1/ai/name-match

All data is synthetic: names, phones, NUBANs and hashes are made up.
"""
import argparse
import hashlib
import json
import math
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import numpy as np

SEED = 42
HISTORY_END = date(2026, 11, 5)      # last day of history (WAT date)
HISTORY_DAYS = 90                    # Aug 8 -> Nov 5, 2026
SCENARIO_DATE = date(2026, 11, 6)    # "today" in the test scenarios

CHANNELS = ["POS", "NIP_TRANSFER", "QR"]
CHANNEL_P = [0.50, 0.35, 0.15]
DOW_FACTOR = {0: 1.0, 1: 1.0, 2: 1.0, 3: 1.05, 4: 1.15, 5: 1.25, 6: 0.55}  # Mon..Sun, mean 1.0

PROFILES = [
    dict(id="m_0001", profile="steady", full_name="Ngozi Chiamaka Okafor", business="Mama Ngozi Provisions",
         lang="igbo", mean=38000, cv=0.12, zero_p=0.04, ticket=2500, days=90, sick_last=0),
    dict(id="m_0002", profile="volatile", full_name="Musa Ibrahim Danladi", business="Alhaji Musa Fabrics",
         lang="hausa", mean=30000, cv=0.80, zero_p=0.20, ticket=6000, days=90, sick_last=0),
    dict(id="m_0003", profile="new_trader", full_name="Chidi Emeka Nwosu", business="Chidi Phone Accessories",
         lang="pidgin", mean=22000, cv=0.30, zero_p=0.05, ticket=3000, days=9, sick_last=0),
    dict(id="m_0004", profile="sick_week", full_name="Bisi Folasade Adeyemi", business="Iya Bisi Foodstuff",
         lang="yoruba", mean=33000, cv=0.18, zero_p=0.04, ticket=2000, days=90, sick_last=6),
    dict(id="m_0005", profile="spike_demo", full_name="Tunde Olamide Bakare", business="Tunde Auto Parts",
         lang="pidgin", mean=45000, cv=0.20, zero_p=0.04, ticket=9000, days=90, sick_last=0),
]


def round50(x):
    return max(100.0, float(round(x / 50.0)) * 50.0)


def iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def day_total(rng, p, d, sick):
    if sick or rng.random() < p["zero_p"]:
        return 0.0
    s = math.sqrt(math.log(1 + p["cv"] ** 2))
    return p["mean"] * DOW_FACTOR[d.weekday()] * float(rng.lognormal(-0.5 * s * s, s))


def split_day(rng, total, ticket):
    k = int(np.clip(round(total / ticket * rng.uniform(0.7, 1.3)), 1, 60))
    w = rng.lognormal(0.0, 0.6, size=k)
    return [round50(total * float(x) / float(w.sum())) for x in w]


def stamps(rng, d, k):
    # 07:00-20:00 Lagos (WAT = UTC+1) -> 06:00-19:00 UTC
    mins = sorted(int(m) for m in rng.integers(6 * 60, 19 * 60, size=k))
    return [datetime(d.year, d.month, d.day, m // 60, m % 60, tzinfo=timezone.utc) for m in mins]


def build_history(rng):
    all_days = [HISTORY_END - timedelta(days=i) for i in range(HISTORY_DAYS - 1, -1, -1)]
    merchants, rows, daily = [], [], {}
    for idx, p in enumerate(PROFILES, start=1):
        days = all_days[-p["days"]:]
        daily[p["id"]] = []
        for d in days:
            sick = p["sick_last"] > 0 and d > HISTORY_END - timedelta(days=p["sick_last"])
            total = day_total(rng, p, d, sick)
            if total <= 0:
                daily[p["id"]].append({"date": d.isoformat(), "total": 0.0, "txn_count": 0})
                continue
            amounts = split_day(rng, total, p["ticket"])
            for a, t in zip(amounts, stamps(rng, d, len(amounts))):
                rows.append({"merchant_id": p["id"], "amount": a,
                             "channel": str(rng.choice(CHANNELS, p=CHANNEL_P)), "settled_at": iso(t)})
            daily[p["id"]].append({"date": d.isoformat(), "total": round(sum(amounts), 2),
                                   "txn_count": len(amounts)})
        merchants.append({
            "id": p["id"],
            "phone_number": f"+2348010000{idx:03d}",
            "full_name": p["full_name"],
            "bvn_hash": hashlib.sha256(f"synthetic-bvn-{p['id']}".encode()).hexdigest()[:32],
            "nin_hash": hashlib.sha256(f"synthetic-nin-{p['id']}".encode()).hexdigest()[:32],
            "access_nuban": f"08{int(rng.integers(0, 10 ** 8)):08d}",
            "access_wallet_id": f"wal_{idx:05d}",
            "preferred_language": p["lang"],
            "sweep_percentage": 2.0,
            "daily_cap": 5000.0,
            "min_buffer_balance": 1000.0,
            "is_paused": False,
            "paused_until": None,
            "created_at": f"{days[0].isoformat()}T08:00:00Z",
            "business_name": p["business"],
            "profile": p["profile"],
        })
    rows.sort(key=lambda r: (r["settled_at"], r["merchant_id"]))
    inflows = []
    for i, r in enumerate(rows, start=1):
        ref = f"HYD-TX-{i:06d}"
        inflows.append({
            "id": str(uuid.uuid5(uuid.NAMESPACE_URL, ref)),
            "merchant_id": r["merchant_id"],
            "bank_reference": ref,
            "amount": r["amount"],
            "channel": r["channel"],
            "is_excluded_from_sweep": False,
            "exclusion_reason": None,
            "settled_at": r["settled_at"],
        })
    return merchants, inflows, daily


# ----------------------------------------------------------------------------- scenarios
def tx(ref, amount, channel, hhmm, confirmed=False):
    d = {"bank_reference": ref, "amount": float(amount), "channel": channel,
         "settled_at": f"{SCENARIO_DATE.isoformat()}T{hhmm}:00Z"}
    if confirmed:
        d["trader_confirmed"] = True
    return d


def scenario(name, description, merchant_id, inflows, expected, **extra):
    req = {"merchant_id": merchant_id, "sweep_date": SCENARIO_DATE.isoformat(),
           "identity_status": "VERIFIED", "prior_sweep_status": None, "proposed_rate": 2.0,
           "inflows": inflows}
    req.update(extra)
    return {"name": name, "description": description, "request": req, "expected": expected}


def total(inflows, skip=()):
    return round(sum(i["amount"] for i in inflows if i["bank_reference"] not in skip), 2)


def build_scenarios():
    s1 = [tx(f"HYD-TX-S1-{n:02d}", a, c, t) for n, (a, c, t) in enumerate([
        (2500, "POS", "08:12"), (4150, "NIP_TRANSFER", "09:40"), (1800, "QR", "10:05"),
        (6200, "POS", "11:30"), (3000, "POS", "12:45"), (5400, "NIP_TRANSFER", "14:10"),
        (2250, "QR", "15:55"), (4800, "POS", "17:20")], start=1)]
    s2 = [tx("HYD-TX-S2-01", 12500, "POS", "08:30"), tx("HYD-TX-S2-02", 8300, "POS", "09:50"),
          tx("HYD-TX-S2-03", 21000, "NIP_TRANSFER", "11:15"), tx("HYD-TX-S2-04", 9750, "POS", "13:00"),
          tx("HYD-TX-S2-05", 10_000_000, "NIP_TRANSFER", "16:10"), tx("HYD-TX-S2-06", 15400, "QR", "17:45")]
    s5 = [tx("HYD-TX-S5-01", 15000, "POS", "10:00"), tx("HYD-TX-S5-02", 7200, "QR", "12:30"),
          tx("HYD-TX-S5-03", 650_000, "NIP_TRANSFER", "15:00")]
    s5b = [tx("HYD-TX-S8-01", 15000, "POS", "10:00"), tx("HYD-TX-S8-02", 7200, "QR", "12:30"),
           tx("HYD-TX-S8-03", 650_000, "NIP_TRANSFER", "15:00")]
    s6 = [tx("HYD-TX-S6-01", 8000, "POS", "09:00"), tx("HYD-TX-S6-02", 22000, "POS", "12:00"),
          tx("HYD-TX-S6-03", 5500, "QR", "16:00")]
    s7 = [tx("HYD-TX-S7-01", 10_000_000, "NIP_TRANSFER", "16:10", confirmed=True),
          tx("HYD-TX-S7-02", 9000, "POS", "17:00")]
    return [
        scenario("normal_day", "Ordinary day for a steady trader. Everything sweepable.", "m_0001", s1,
                 {"status": "CLEARED", "severity": "NONE", "sweepable_total": total(s1),
                  "alert_types": [], "flagged_bank_references": []}),
        scenario("spike_10m", "Accidental N10,000,000 transfer: only that inflow is held, the rest is swept.",
                 "m_0005", s2,
                 {"status": "PARTIAL", "severity": "HIGH", "sweepable_total": total(s2, {"HYD-TX-S2-05"}),
                  "alert_types": ["ANOMALOUS_INFLOW"], "flagged_bank_references": ["HYD-TX-S2-05"]}),
        scenario("duplicate_sweep", "Cron re-ran after a sweep already EXECUTED today: hold, never sweep twice.",
                 "m_0001", s1,
                 {"status": "HELD", "severity": "MEDIUM", "sweepable_total": 0.0,
                  "alert_types": ["SUSPECTED_DUPLICATE"], "flagged_bank_references": []},
                 prior_sweep_status="EXECUTED"),
        scenario("zero_sales_day", "No inflows. CLEARED with sweepable 0 -> executor logs SKIPPED_ZERO_SALES, no debit.",
                 "m_0004", [],
                 {"status": "CLEARED", "severity": "NONE", "sweepable_total": 0.0,
                  "alert_types": [], "flagged_bank_references": []}),
        scenario("new_trader_large_inflow", "9 days of history is enough (PRD v3: 7 days), so the normal statistics apply: N650,000 is ~200x this trader's sale.",
                 "m_0003", s5,
                 {"status": "PARTIAL", "severity": "HIGH", "sweepable_total": total(s5, {"HYD-TX-S5-03"}),
                  "alert_types": ["ANOMALOUS_INFLOW"], "flagged_bank_references": ["HYD-TX-S5-03"]}),
        scenario("brand_new_merchant_large_inflow", "No history at all: absolute cold-start thresholds apply (N500k = MEDIUM).",
                 "m_9999", s5b,
                 {"status": "PARTIAL", "severity": "MEDIUM", "sweepable_total": total(s5b, {"HYD-TX-S8-03"}),
                  "alert_types": ["ANOMALOUS_INFLOW"], "flagged_bank_references": ["HYD-TX-S8-03"]}),
        scenario("name_mismatch", "KYC name check failed: whole sweep held until Ops resolves it.",
                 "m_0002", s6,
                 {"status": "HELD", "severity": "HIGH", "sweepable_total": 0.0,
                  "alert_types": ["NAME_MISMATCH"], "flagged_bank_references": []},
                 identity_status="MISMATCH"),
        scenario("confirmed_release", "Trader confirmed the big inflow is legit: Guard stops flagging it.",
                 "m_0005", s7,
                 {"status": "CLEARED", "severity": "NONE", "sweepable_total": total(s7),
                  "alert_types": [], "flagged_bank_references": []}),
    ]


NAME_PAIRS = [
    ("ADEWALE BABATUNDE OGUNLEYE", "Babatunde Ogunleye", "MATCH", "missing first name"),
    ("Chukwuemeka Obi", "Obi Chukwuemeka", "MATCH", "word order swapped"),
    ("Folasade Bisi Adeyemi", "Adeyemi Folasade", "MATCH", "order swap + missing middle name"),
    ("Mr. Adewale Ogunleye", "ADEWALE OGUNLEYE", "MATCH", "title + casing"),
    ("Ibrahim Musa Danladi", "Musa I. Danladi", "MATCH", "initial"),
    ("Ngozi Okafor", "Ngozi Okafo", "MATCH", "typo"),
    ("Hauwa Abdullahi", "Hawa Abdullahi", "MATCH", "spelling variant"),
    ("Ahmed Yusuf", "Ahmad Yusuf", "MATCH", "spelling variant"),
    ("Fatima Bello", "Fatima Bello", "MATCH", "identical"),
    ("Chidi Emeka Nwosu", "Emeka Chidi Nwosu", "MATCH", "first/middle swapped"),
    ("Seyi Adebayo", "Seun Adebayo", "REVIEW", "different first name, same surname"),
    ("ADEBAYO OLUWASEUN JOHN", "Seun Adebayo", "REVIEW", "shortened form (Seun / Oluwaseun)"),
    ("Oluwatimilehin Abiodun", "Timilehin Abiodun", "REVIEW", "shortened form"),
    ("Aminu Kano", "Kano", "REVIEW", "single name only: never auto-match"),
    ("Tomiwa Owoeye", "Tomiwa Adeyemi", "REVIEW", "surname differs (e.g. after marriage): human check"),
    ("John Smith", "Jane Doe", "MISMATCH", "different person"),
    ("Chinedu Okeke", "Emeka Nwosu", "MISMATCH", "different person"),
]


def dump(path, obj, compact=False):
    with open(path, "w", encoding="utf-8") as f:
        if compact:
            json.dump(obj, f, separators=(",", ":"), ensure_ascii=False)
        else:
            json.dump(obj, f, indent=2, ensure_ascii=False)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(Path(__file__).parent / "seed"))
    out = Path(ap.parse_args().out)
    out.mkdir(parents=True, exist_ok=True)

    rng = np.random.default_rng(SEED)
    merchants, inflows, daily = build_history(rng)
    dump(out / "merchants.json", merchants)
    dump(out / "inflows.json", inflows, compact=True)
    dump(out / "daily_totals.json", daily, compact=True)
    dump(out / "scenarios.json", build_scenarios())
    dump(out / "kyc_name_pairs.json",
         [{"name_a": a, "name_b": b, "expected": e, "note": n} for a, b, e, n in NAME_PAIRS])

    print(f"Wrote {len(merchants)} merchants, {len(inflows)} inflows to {out}/")
    for m in merchants:
        mid = m["id"]
        rows = daily[mid]
        active = [r["total"] for r in rows if r["total"] > 0]
        last30 = rows[-30:]
        print(f"  {mid} {m['profile']:<11} days={len(rows):>2}  avg/day(active)=N{np.mean(active):>9,.0f}  "
              f"zero days in last 30={sum(1 for r in last30 if r['total'] == 0)}  lang={m['preferred_language']}")


if __name__ == "__main__":
    main()
