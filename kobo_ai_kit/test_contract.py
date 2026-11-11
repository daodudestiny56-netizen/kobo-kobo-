#!/usr/bin/env python3
"""Runs every scenario in seed/scenarios.json and every pair in seed/kyc_name_pairs.json against the service.

    python test_contract.py
"""
import sys as _sys
from pathlib import Path as _Path

_HERE = str(_Path(__file__).resolve().parent)       # lets sibling files (smart_rate.py ...) import from ANY folder
if _HERE not in _sys.path:
    _sys.path.insert(0, _HERE)
import json
import sys
from pathlib import Path

from fastapi.testclient import TestClient

import kobo_ai_service as svc

client = TestClient(svc.app)
seed = Path(__file__).parent / "seed"
fails = 0

print("== Sweep Guard scenarios ==")
for s in json.loads((seed / "scenarios.json").read_text(encoding="utf-8")):
    r = client.post("/api/v1/ai/sweep-guard/check", json=s["request"])
    b, e = r.json(), s["expected"]
    got_types = sorted(a["alert_type"] for a in b["alerts"])
    got_flagged = sorted(a["bank_reference"] for a in b["alerts"] if a["bank_reference"])
    ok = (r.status_code == 200 and b["status"] == e["status"] and b["severity"] == e["severity"]
          and abs(b["sweepable"]["total"] - e["sweepable_total"]) < 0.01
          and got_types == sorted(e["alert_types"]) and got_flagged == sorted(e["flagged_bank_references"]))
    # idempotent: same payload -> same answer
    again = client.post("/api/v1/ai/sweep-guard/check", json=s["request"]).json()
    ok = ok and again == b
    fails += not ok
    print(f"{'PASS' if ok else 'FAIL'}  {s['name']:<26} {b['status']:<8} {b['severity']:<6} "
          f"sweepable=N{b['sweepable']['total']:,.0f}")
    if not ok:
        print("   expected:", e)
        print("   got     :", json.dumps(b, ensure_ascii=False)[:600])

print("\n== Name matching ==")
for p in json.loads((seed / "kyc_name_pairs.json").read_text(encoding="utf-8")):
    b = client.post("/api/v1/ai/name-match", json={"name_a": p["name_a"], "name_b": p["name_b"]}).json()
    ok = b["decision"] == p["expected"]
    fails += not ok
    print(f"{'PASS' if ok else 'FAIL'}  {b['score']:.3f} {b['decision']:<8} (want {p['expected']:<8}) "
          f"{p['name_a']} | {p['name_b']}")

print(f"\n{'ALL PASSED' if not fails else str(fails) + ' FAILED'}")
sys.exit(1 if fails else 0)
