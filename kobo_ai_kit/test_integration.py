#!/usr/bin/env python3
"""Tests for the contract in AI_ML_HANDOFF.md (core <-> AI service). Run:  python test_integration.py   (~10 s, offline)

Core is replaced by a mocked server, so these prove OUR side of the contract:
  /evaluate request + response shapes, decimal-string money, tokens, whole-sweep HOLD semantics, fail-open safety,
  and every answer core can give to a Smart Rate suggestion (201 / 409 pending / 409 cooldown / 422 / 404 / 401 / 5xx)."""
import sys as _sys
from pathlib import Path as _Path

_HERE = str(_Path(__file__).resolve().parent)
if _HERE not in _sys.path:
    _sys.path.insert(0, _HERE)

import json
import os
import re
import sys
import tempfile
import time
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

TMP = Path(tempfile.mkdtemp(prefix="kobo_integration_test_"))
os.environ["VOICE_PROVIDER"] = "fake"
os.environ["VOICE_CACHE_DIR"] = str(TMP / "cache")
os.environ["VOICE_URL_SECRET"] = "test-secret"
os.environ["PUBLIC_BASE_URL"] = "https://kobo.test"
for k in ("GUARD_TOKEN", "AI_SERVICE_TOKEN", "GUARD_HOLD_MIN_SEVERITY"):
    os.environ.pop(k, None)

import httpx
from fastapi.testclient import TestClient

import core_client
import kobo_ai_service as svc
import voice as vc

client = TestClient(svc.app)
fails = 0


def t(name, cond, detail=""):
    global fails
    fails += not cond
    print(f"{'PASS' if cond else 'FAIL'}  {name}" + (f"   [{str(detail)[:300]}]" if (detail and not cond) else ""))
    return cond


def ref():
    return "NIP-" + uuid.uuid4().hex[:10]


def inflow(amount, hh="10", mm="15", day="2026-11-08", reference=None):
    hh, mm = str(hh).zfill(2), str(mm).zfill(2)
    return {"bank_reference": reference or ref(), "amount": amount, "settled_at": f"{day}T{hh}:{mm}:00.000Z"}


def ev(merchant_id, inflows, day="2026-11-08", headers=None):
    total = sum(float(i["amount"]) for i in inflows)
    return client.post("/evaluate", headers=headers or {}, json={"merchant_id": merchant_id, "sweep_date": day, "takings": f"{total:.2f}", "inflows": inflows})


ALLOWED = {"ANOMALOUS_INFLOW", "SUSPECTED_DUPLICATE", "NAME_MISMATCH", "LOW_BUFFER"}

# ------------------------------------------------------------------------------ A. /evaluate (core calls us)
print("== /evaluate: Sweep Guard as core expects it ==")
r = ev("m_0001", [inflow("7000.00"), inflow("5000.00", "12", "30")])
t("normal day, money as decimal strings -> exactly {\"verdict\":\"CLEAR\"}", r.status_code == 200 and r.json() == {"verdict": "CLEAR"}, r.text)

spike = ev("m_0005", [inflow("12500.00"), inflow("10000000.00", "16", "10"), inflow("9000.00", "17", "0")], day="2026-11-06")
j = spike.json()
t("a N10,000,000 accident -> HOLD with an allowed alert_type", spike.status_code == 200 and j["verdict"] == "HOLD" and j["alert_type"] in ALLOWED, spike.text)
t("HOLD carries details for ops: score 0-1, a plain reason, which payment",
  isinstance(j["details"]["score"], float) and 0 < j["details"]["score"] <= 1 and "10,000,000" in j["details"]["reason"] and j["details"]["bank_reference"], j)
t("response has ONLY the documented keys (no partial-sweep fields core would not understand)", set(j) == {"verdict", "alert_type", "details"}, set(j))
t("HOLD is for the whole sweep: the normal sales in the same batch do not make it partial", "sweepable" not in j and "sweepable" not in j["details"])
t("the score grows with how extreme it is", j["details"]["score"] >= 0.9, j["details"]["score"])

uid = str(uuid.uuid4())
r = ev(uid, [inflow("15000.00"), inflow("7200.00", "12", "0")])
t("a brand-new UUID merchant with ordinary sales -> CLEAR (never held for lack of history)", r.json() == {"verdict": "CLEAR"})
big = ev(str(uuid.uuid4()), [inflow("650000.00")])
t("new merchant, N650,000: not held by default (MEDIUM; 'a false HOLD costs a trader one night of savings')", big.json() == {"verdict": "CLEAR"}, big.text)
os.environ["GUARD_HOLD_MIN_SEVERITY"] = "MEDIUM"
big2 = ev(str(uuid.uuid4()), [inflow("650000.00")])
os.environ.pop("GUARD_HOLD_MIN_SEVERITY")
t("... but GUARD_HOLD_MIN_SEVERITY=MEDIUM makes it hold", big2.json()["verdict"] == "HOLD" and big2.json()["alert_type"] == "ANOMALOUS_INFLOW", big2.text)
huge = ev(str(uuid.uuid4()), [inflow("1200000.00")])
t("new merchant, N1,200,000 -> HOLD at the default threshold", huge.json()["verdict"] == "HOLD", huge.text)

dup_ref = ref()
d1 = ev(str(uuid.uuid4()), [inflow("5000.00", reference=dup_ref), inflow("5000.00", "11", "0", reference=dup_ref)])
t("the same payment twice in one sweep -> HOLD SUSPECTED_DUPLICATE", d1.json()["verdict"] == "HOLD" and d1.json()["alert_type"] == "SUSPECTED_DUPLICATE", d1.text)
mid, rr = str(uuid.uuid4()), ref()
a = ev(mid, [inflow("5000.00", reference=rr)], day="2026-11-08")
b = ev(mid, [inflow("5000.00", reference=rr)], day="2026-11-09")
t("a payment already counted on an earlier day shows up again -> HOLD SUSPECTED_DUPLICATE (webhook replay)",
  a.json() == {"verdict": "CLEAR"} and b.json()["verdict"] == "HOLD" and b.json()["alert_type"] == "SUSPECTED_DUPLICATE", (a.text, b.text))
mid, rr = str(uuid.uuid4()), ref()
a1 = ev(mid, [inflow("5000.00", reference=rr)])
a2 = ev(mid, [inflow("5000.00", reference=rr)])
t("core retrying the SAME call is not a duplicate (idempotent)", a1.json() == a2.json() == {"verdict": "CLEAR"})

t("no inflows at all (zero-sales day) -> CLEAR", client.post("/evaluate", json={"merchant_id": str(uuid.uuid4()), "sweep_date": "2026-11-08", "takings": "0.00", "inflows": []}).json() == {"verdict": "CLEAR"})
bad = client.post("/evaluate", json={"merchant_id": "x", "sweep_date": "2026-11-08", "inflows": [{"bank_reference": "B", "amount": "abc", "settled_at": "2026-11-08T10:00:00Z"}]})
t("garbage amount -> still a valid CLEAR answer (never an error that blocks core)", bad.status_code == 200 and bad.json() == {"verdict": "CLEAR"}, bad.text)
t("missing fields -> 422 (core treats non-200 as fail-open and logs it)", client.post("/evaluate", json={"merchant_id": "x"}).status_code == 422)
many = [inflow(f"{1000 + i}.00", hh=f"{8 + i % 12:02d}", mm=f"{i % 60:02d}") for i in range(300)]
t0 = time.time()
rl = ev("m_0001", many)
t("300 inflows answered well inside core's 3-second limit", rl.status_code == 200 and time.time() - t0 < 1.0, time.time() - t0)

os.environ["GUARD_TOKEN"] = "guard-secret"
no, wrong, ok = ev("m_0001", [inflow("1000.00")]), ev("m_0001", [inflow("1000.00")], headers={"Authorization": "Bearer nope"}), ev("m_0001", [inflow("1000.00")], headers={"Authorization": "Bearer guard-secret"})
os.environ.pop("GUARD_TOKEN")
t("GUARD_TOKEN: missing -> 401, wrong -> 401, right -> 200", (no.status_code, wrong.status_code, ok.status_code) == (401, 401, 200), (no.status_code, wrong.status_code, ok.status_code))
t("with GUARD_TOKEN unset the endpoint is open (demo mode, as core's)", ev("m_0001", [inflow("1000.00")]).status_code == 200)

os.environ["AI_SERVICE_TOKEN"] = "svc-secret"
s1, s2 = client.get("/api/v1/ai/voice/status"), client.get("/api/v1/ai/voice/status", headers={"Authorization": "Bearer svc-secret"})
open_paths = (client.get("/health").status_code, client.get("/api/v1/ai/voice/audio/zzz.mp3").status_code,
              client.post("/api/v1/ai/voice/ivr/answer", data={"isActive": "0"}).status_code, ev("m_0001", [inflow("1000.00")]).status_code)
os.environ.pop("AI_SERVICE_TOKEN")
t("AI_SERVICE_TOKEN protects /api/v1/ai/*: 401 without, 200 with", s1.status_code == 401 and s2.status_code == 200)
t("... but not /health, signed audio links, the Africa's Talking callbacks, or /evaluate (own token)", open_paths == (200, 404, 200, 200), open_paths)

# ------------------------------------------------------------------------------ B. history for UUID merchants
print("\n== History for core's merchants ==")
muid = str(uuid.uuid4())
start = date(2026, 9, 20)
rows, n = [], 0
for d in range(47):
    day = start + timedelta(days=d)
    for k in range(8):
        n += 1
        rows.append({"bank_reference": f"HIST-{muid[:6]}-{n}", "amount": f"{5000 + (k * 300) + (d % 5) * 100}.00", "settled_at": f"{day.isoformat()}T{8 + k:02d}:10:00Z"})
h1 = client.post("/api/v1/ai/history", json={"merchant_id": muid, "inflows": rows}).json()
h2 = client.post("/api/v1/ai/history", json={"merchant_id": muid, "inflows": rows}).json()
t("backfill: records history without judging it; repeating it adds nothing", h1["added"] == len(rows) and h2["added"] == 0 and h2["skipped"] == len(rows), (h1, h2))
dry = client.post("/api/v1/ai/smart-rate/propose", json={"merchant_id": muid, "current_rate": 2.0, "as_of": (start + timedelta(days=46)).isoformat(), "dry_run": True}).json()
t("a core merchant with 47 steady days -> Smart Rate would suggest 2.5 (dry run, nothing sent)",
  dry["status"] == "DRY_RUN" and dry["would_send"]["suggested_rate"] == "2.5" and dry["would_send"]["merchant_id"] == muid and len(dry["would_send"]["reason"]) <= 500, dry)
t("current_rate is required for merchants we only know from core", client.post("/api/v1/ai/smart-rate/propose", json={"merchant_id": muid}).status_code == 422)
t("a merchant with no history -> 404", client.post("/api/v1/ai/smart-rate/propose", json={"merchant_id": str(uuid.uuid4()), "current_rate": 2}).status_code == 404)

# ------------------------------------------------------------------------------ C. Smart Rate -> core (mocked core)
print("\n== Smart Rate -> core ==")
calls = []
script = {"open": None, "post": (201, {"id": "sug_1", "status": "PENDING"}), "get_fail": False, "net_fail": False}


def core_handler(request):
    calls.append(request)
    if script["net_fail"]:
        raise httpx.ConnectError("core is down")
    if request.method == "GET":
        if script["get_fail"]:
            return httpx.Response(500, json={"error": "oops"})
        return httpx.Response(200, json=script["open"])
    code, body = script["post"]
    return httpx.Response(code, json=body)


def install_core(token="svc-tok"):
    c = core_client.CoreClient(base_url="http://core.test", token=token,
                               client=httpx.Client(transport=httpx.MockTransport(core_handler), base_url="http://core.test"))
    svc.set_core_client(c)


def propose(mid="m_0001", **kw):
    calls.clear()
    return client.post("/api/v1/ai/smart-rate/propose", json={"merchant_id": mid, "as_of": "2026-11-05", "now": "2026-11-06T09:00:00Z", **kw}).json()


install_core()
r = propose()
posts = [c for c in calls if c.method == "POST"]
body = json.loads(posts[0].content) if posts else {}
t("SENT: POSTs to /api/v1/smart-rate/suggestions with the documented body and nothing else",
  r["status"] == "SENT" and len(posts) == 1 and posts[0].url.path == "/api/v1/smart-rate/suggestions"
  and set(body) == {"merchant_id", "suggested_rate", "reason"} and body["merchant_id"] == "m_0001" and body["suggested_rate"] == "2.5", (r["status"], body))
t("the rate is a string, 1-5, at most 2 decimals, and different from the current rate",
  re.fullmatch(r"[1-5](\.\d{1,2})?", body["suggested_rate"]) and float(body["suggested_rate"]) != 2.0)
t("the reason is kept to core's 500-character limit and is plain language", 0 < len(body["reason"]) <= 500 and "steady" in body["reason"], body["reason"])
t("service token is sent as a Bearer header on both calls", all(c.headers.get("authorization") == "Bearer svc-tok" for c in calls))
t("the pre-check (GET open suggestion) happens first", calls[0].method == "GET" and calls[0].url.path == "/api/v1/merchants/m_0001/smart-rate")

script["open"] = {"id": "sug_0", "suggested_rate": "3", "status": "PENDING"}
r = propose()
t("an open suggestion already exists -> SKIPPED_PENDING and we do not even POST", r["status"] == "SKIPPED_PENDING" and not [c for c in calls if c.method == "POST"])
script["open"] = None
script["post"] = (409, {"error": {"code": "SUGGESTION_PENDING", "message": "one open at a time"}})
t("core says 409 SUGGESTION_PENDING -> SKIPPED_PENDING (not an error)", propose()["status"] == "SKIPPED_PENDING")
script["post"] = (409, {"error": {"code": "SUGGESTION_COOLDOWN", "details": {"retry_after": "2026-11-22T00:00:00.000Z"}}})
r = propose()
t("core says 409 SUGGESTION_COOLDOWN -> SKIPPED_COOLDOWN with retry_after surfaced", r["status"] == "SKIPPED_COOLDOWN" and r["retry_after"] == "2026-11-22T00:00:00.000Z", r)
script["post"] = (409, {"code": "SUGGESTION_COOLDOWN", "details": {"retry_after": "2026-12-01"}})
t("... also when the code is at the top level of the body", propose()["status"] == "SKIPPED_COOLDOWN")
script["post"] = (422, {"error": {"code": "RATE_UNCHANGED"}})
t("422 RATE_UNCHANGED -> SKIPPED_UNCHANGED", propose()["status"] == "SKIPPED_UNCHANGED")
script["post"] = (404, {"error": {"code": "NOT_FOUND"}})
t("404 -> ERROR_UNKNOWN_MERCHANT", propose()["status"] == "ERROR_UNKNOWN_MERCHANT")
script["post"] = (401, {"error": "unauthorized"})
t("401 -> ERROR_AUTH (tells you to check SERVICE_TOKEN)", propose()["status"] == "ERROR_AUTH")
script["post"] = (503, {"error": "down"})
r = propose()
t("5xx -> ERROR_UNREACHABLE, marked retryable", r["status"] == "ERROR_UNREACHABLE" and r["retryable"] is True)
script["net_fail"] = True
r = propose()
t("core down -> ERROR_UNREACHABLE, no crash, nothing lost", r["status"] == "ERROR_UNREACHABLE" and r["retryable"] is True and "cannot reach core" in r["error"], r)
script["net_fail"] = False
script["post"] = (201, {"id": "sug_2"})
script["get_fail"] = True
t("if the pre-check fails we still try the POST (core enforces the rules anyway)", propose()["status"] == "SENT")
script["get_fail"] = False

r = propose("m_0003")
t("a merchant who needs no change (new trader, 9 days) -> NO_SUGGESTION and core is never called", r["status"] == "NO_SUGGESTION" and r["hold_reason"] == "INSUFFICIENT_DATA" and not calls)
r = propose("m_0004")
t("a trader on a short break is not bothered (NO_SUGGESTION, TEMPORARY_DISRUPTION)", r["status"] == "NO_SUGGESTION" and r["hold_reason"] == "TEMPORARY_DISRUPTION" and not calls)
script["post"] = (201, {"id": "sug_3"})
r = propose("m_0002")
b2 = json.loads([c for c in calls if c.method == "POST"][0].content)
t("a volatile trader gets a gentle DECREASE suggestion ('1.5')", r["status"] == "SENT" and b2["suggested_rate"] == "1.5", b2)
r = propose("m_0001", dry_run=True)
t("dry_run shows exactly what would be sent and sends nothing", r["status"] == "DRY_RUN" and not calls and r["would_send"]["suggested_rate"] == "2.5")

calls.clear()
bt = client.post("/api/v1/ai/smart-rate/propose-batch", json={"items": [
    {"merchant_id": "m_0001", "as_of": "2026-11-05"}, {"merchant_id": "m_0003", "as_of": "2026-11-05"},
    {"merchant_id": str(uuid.uuid4()), "current_rate": 2.0}, {"merchant_id": "m_0005", "as_of": "2026-11-05"}]})
bj = bt.json()
t("batch: a bad merchant never stops the others; counts are reported",
  bt.status_code == 200 and bj["counts"].get("SENT") == 2 and bj["counts"].get("NO_SUGGESTION") == 1 and bj["counts"].get("ERROR") == 1, bj["counts"])
log = client.get("/api/v1/ai/smart-rate-proposals", params={"merchant_id": "m_0001"}).json()
t("an audit log of proposals is kept", len(log) >= 2 and all(p["merchant_id"] == "m_0001" for p in log))

t("format_rate: 2.0 -> '2', 2.5 -> '2.5', 3.456 -> '3.46'", (core_client.format_rate(2.0), core_client.format_rate(2.5), core_client.format_rate(3.456)) == ("2", "2.5", "3.46"))
bad_rates = []
for br in (0.5, 5.5, 0, -1):
    try:
        core_client.format_rate(br)
        bad_rates.append(br)
    except ValueError:
        pass
t("format_rate raises for 0.5, 5.5, 0 and -1", not bad_rates, bad_rates)
t("build_reason truncates to 500 and keeps the confidence note when short",
  len(core_client.build_reason("x" * 900, 0.9, "m")) <= 500 and "confidence 91%" in core_client.build_reason("Steady sales.", 0.91, "smart-rate-v1"))
no_token = core_client.CoreClient(base_url="http://core.test", token="", client=httpx.Client(transport=httpx.MockTransport(core_handler), base_url="http://core.test"))
calls.clear()
no_token.propose("m_0001", 2.5, "demo")
t("demo mode (no SERVICE_TOKEN): no Authorization header is sent", "authorization" not in calls[0].headers)
svc.set_core_client(None)

# ------------------------------------------------------------------------------ D. money as decimal strings, in voice
print("\n== Voice with core-style money ==")
studio = vc.VoiceStudio(vc.FakeProvider(), cache_dir=TMP / "v", signer=vc.UrlSigner("test-secret", "https://kobo.test"))
svc.set_voice_studio(studio, vc.JobManager(studio, retry_delays=(), sleep=lambda s: None))
sc = lambda body: client.post("/api/v1/ai/voice/script", json=body)
num = sc({"intent": "balance", "language": "en", "facts": {"total": 36800, "emergency": 18400, "retirement": 18400, "vesting_days": 0, "cooldown_days": 0}}).json()
dec = sc({"intent": "balance", "language": "en", "facts": {"total": "36800.00", "emergency": "18400.00", "retirement": "18400.00", "vesting_days": 0, "cooldown_days": 0}}).json()
t("decimal strings ('36800.00') speak exactly like numbers", num["text"] == dec["text"] and "thirty six thousand eight hundred naira" in dec["text"])
t('a "0.00" balance is "nothing saved yet", not zero-pronounced garbage', sc({"intent": "balance", "language": "en", "facts": {"total": "0.00"}}).json()["variant"] == "empty")
t('takings "0.00" -> zero_sales variant', sc({"intent": "sweep_receipt", "language": "en", "facts": {"takings": "0.00", "sweep": "0.00"}}).json()["variant"] == "zero_sales")
t('held_amount "0.00" does NOT announce a big payment',
  "big payment" not in sc({"intent": "sweep_receipt", "language": "en", "facts": {"takings": "12000.00", "sweep": "240.00", "emergency": "120.00", "retirement": "120.00", "held_amount": "0.00"}}).json()["text"])
t("a null balance is an error, never 'you have not saved anything'", sc({"intent": "balance", "language": "en", "facts": {"total": None}}).status_code == 422)
t("a missing takings figure is an error, never 'no sales today'", sc({"intent": "sweep_receipt", "language": "en", "facts": {}}).status_code == 422)
t("sales without a sweep amount is an error (we do not guess what was saved)", sc({"intent": "sweep_receipt", "language": "en", "facts": {"takings": "9000.00"}}).status_code == 422)
t('negative strings are refused ("-5.00")', sc({"intent": "balance", "language": "en", "facts": {"total": "-5.00", "emergency": "1", "retirement": "1"}}).status_code == 422)
dr = sc({"intent": "rate_suggestion", "language": "en", "facts": {"direction": "DECREASE", "rate_cur": "2.00", "rate_new": "1.50", "monthly_change": "-4500.00"}}).json()
t("a decrease with a negative decimal string is spoken as a positive amount that 'lowers'", "four thousand five hundred naira" in dr["text"] and "minus" not in dr["text"], dr["text"])

# ------------------------------------------------------------------------------ E. IVR knows core's merchants
print("\n== IVR with core's merchants ==")
muid = str(uuid.uuid4())
client.post("/api/v1/ai/voice/prewarm", json={"languages": ["en"]})
for _ in range(100):
    if svc.JOBS.pending() == 0:
        break
    time.sleep(0.1)
prep = client.post("/api/v1/ai/voice/prepare", json={"items": [{"merchant_id": muid, "phone_number": "+2348099999999", "language": "pidgin", "name": "Ada",
      "renders": [{"intent": "balance", "facts": {"total": "36800.00", "emergency": "18400.00", "retirement": "18400.00", "vesting_days": 0, "cooldown_days": 0}}]}]}).json()
for _ in range(100):
    if svc.JOBS.pending() == 0:
        break
    time.sleep(0.1)
call = dict(isActive="1", direction="Outbound", sessionId="CORE-1", destinationNumber="+2348099999999", callerNumber="+254711082000")
ans = client.post("/api/v1/ai/voice/ivr/answer", data=call)
t("core pushes phone + language with the nightly facts, so the IVR recognises that merchant's call", "<GetDigits" in ans.text and prep["rejected"] == 0, ans.text[:200])
lat = studio.latest(muid, "balance")
menu = client.post("/api/v1/ai/voice/ivr/menu", data={"sessionId": "CORE-1", "dtmfDigits": "1", "isActive": "1"})
t("press 1 plays that merchant's balance clip", lat and lat["audio_id"] in menu.text, menu.text[:200])
fresh = vc.VoiceStudio(vc.FakeProvider(), cache_dir=TMP / "v")
t("the directory survives a restart (it is on disk)", fresh.directory().get(muid, {}).get("phone_number") == "+2348099999999")
t("a stranger's number is still refused", "<GetDigits" not in client.post("/api/v1/ai/voice/ivr/answer", data={**call, "sessionId": "CORE-2", "destinationNumber": "+2348000000000"}).text)


# ------------------------------------------------------------------------------ F. PRD v3: partial mode, kobo, cutoff, 7 days
print("\n== PRD v3 changes ==")
from datetime import datetime as _dt


def evp(merchant_id, inflows, mode="partial", day="2026-11-08"):
    return client.post("/evaluate", json={"merchant_id": merchant_id, "sweep_date": day, "mode": mode, "inflows": inflows}).json()


sp_ref = ref()
pj = evp("m_0005", [inflow("12500.00", day="2026-11-06"), inflow("10000000.00", "16", "10", day="2026-11-06", reference=sp_ref), inflow("54450.00", "17", "0", day="2026-11-06")], day="2026-11-06")
d = pj.get("details", {})
t("partial mode: only the N10M credit is excluded and the rest still sweeps",
  pj["verdict"] == "HOLD" and d["mode"] == "partial" and d["excluded_references"] == [sp_ref] and d["sweepable_total"] == "66950.00" and d["sweepable_total_kobo"] == 6695000, pj)
t("... excluded amount is reported too (naira string + integer kobo)", d["excluded_total"] == "10000000.00" and d["excluded_total_kobo"] == 1_000_000_000)
t("... top-level keys are still exactly verdict / alert_type / details (old core is not confused)", set(pj) == {"verdict", "alert_type", "details"}, set(pj))
t("... every excluded credit is listed with its own reason", d["alerts"][0]["bank_reference"] == sp_ref and "10,000,000" in d["alerts"][0]["reason"])
t("partial mode on a normal day -> exactly {\"verdict\":\"CLEAR\"}", evp("m_0001", [inflow("7000.00"), inflow("5000.00", "12", "30")]) == {"verdict": "CLEAR"})
cold_ref = ref()
pc = evp(str(uuid.uuid4()), [inflow("15000.00"), inflow("650000.00", reference=cold_ref)])
t("partial mode excludes a MEDIUM anomaly too (a partial hold is cheap), whole mode would not",
  pc["verdict"] == "HOLD" and pc["details"]["excluded_references"] == [cold_ref] and pc["details"]["sweepable_total"] == "15000.00", pc)
os.environ["GUARD_MODE"] = "partial"
env_default = client.post("/evaluate", json={"merchant_id": str(uuid.uuid4()), "sweep_date": "2026-11-08", "inflows": [inflow("1200000.00")]}).json()
forced_whole = client.post("/evaluate", json={"merchant_id": str(uuid.uuid4()), "sweep_date": "2026-11-08", "mode": "whole", "inflows": [inflow("1200000.00")]}).json()
os.environ.pop("GUARD_MODE")
t("GUARD_MODE=partial sets the default; a request's mode overrides it", env_default["details"].get("mode") == "partial" and "mode" not in forced_whole["details"], (env_default, forced_whole))

dr = ref()
dj = evp(str(uuid.uuid4()), [inflow("5000.00", reference=dr), inflow("5000.00", "11", "0", reference=dr), inflow("2000.00", "12", "0")])
t("partial: the same payment twice is IGNORED (counted once, no alarm)", dj["verdict"] == "CLEAR" and dj["details"]["ignored_duplicates"] == [dr] and dj["details"]["sweepable_total"] == "7000.00", dj)
mid, rr_ = str(uuid.uuid4()), ref()
evp(mid, [inflow("5000.00", reference=rr_)], day="2026-11-08")
rj = evp(mid, [inflow("5000.00", reference=rr_), inflow("3000.00", "13", "0")], day="2026-11-09")
t("partial: a payment already counted on an earlier day is ignored, today's other sales still count", rj["verdict"] == "CLEAR" and rj["details"]["ignored_duplicates"] == [rr_] and rj["details"]["sweepable_total"] == "3000.00", rj)

lk = lambda sender, narr, hh, mm, ref_=None: {**inflow("9000.00", hh, mm, reference=ref_), "sender": sender, "narration": narr}
mid = str(uuid.uuid4())
first, second = ref(), ref()
lj = evp(mid, [lk("Ada Obi", "Rice 5kg", "10", "00", first), lk("ADA OBI", "rice 5kg", "10", "02", second)])
t("look-alike credits (same sender, amount, narration within 5 min) -> the second is flagged SUSPECTED_DUPLICATE and held out",
  lj["verdict"] == "HOLD" and lj["alert_type"] == "SUSPECTED_DUPLICATE" and lj["details"]["excluded_references"] == [second] and lj["details"]["sweepable_total"] == "9000.00", lj)
far = evp(str(uuid.uuid4()), [lk("Ada Obi", "Rice 5kg", "10", "00"), lk("Ada Obi", "Rice 5kg", "10", "20")])
other = evp(str(uuid.uuid4()), [lk("Ada Obi", "Rice 5kg", "10", "00"), lk("Ada Obi", "Beans 5kg", "10", "01")])
nosender = evp(str(uuid.uuid4()), [inflow("9000.00", "10", "00"), inflow("9000.00", "10", "01")])
t("... but not when 20 minutes apart, a different narration, or no sender given (two real identical sales are normal)",
  far["verdict"] == other["verdict"] == nosender["verdict"] == "CLEAR", (far, other, nosender))

kj = client.post("/evaluate", json={"merchant_id": "m_0005", "sweep_date": "2026-11-06", "mode": "partial", "takings_kobo": 1_005_966_950, "inflows": [
    {"bank_reference": ref(), "amount_kobo": 1250000, "settled_at": "2026-11-06T08:30:00Z"},
    {"bank_reference": sp_ref + "k", "amount_kobo": 1_000_000_000, "settled_at": "2026-11-06T15:10:00Z"},
    {"bank_reference": ref(), "amount_kobo": 5445000, "settled_at": "2026-11-06T17:00:00Z"}]}).json()
t("integer kobo in, integer kobo out (PRD v3: money is kobo everywhere): 1,000,000,000 kobo = N10,000,000", kj["verdict"] == "HOLD" and kj["details"]["sweepable_total_kobo"] == 6695000 and kj["details"]["excluded_total_kobo"] == 1_000_000_000, kj)
kw = client.post("/evaluate", json={"merchant_id": str(uuid.uuid4()), "sweep_date": "2026-11-08", "inflows": [{"bank_reference": ref(), "amount_kobo": 120_000_000, "settled_at": "2026-11-08T10:00:00Z"}]}).json()
t("kobo works in the whole-sweep mode too (N1,200,000 -> HOLD)", kw["verdict"] == "HOLD")

uid = str(uuid.uuid4())
r1, r2, r3 = ref(), ref(), ref()
client.post("/api/v1/ai/history", json={"merchant_id": uid, "inflows": [
    {"bank_reference": r1, "amount_kobo": 500000, "settled_at": "2026-11-08T21:59:00Z"},     # 22:59 WAT -> sweep of the 8th
    {"bank_reference": r2, "amount_kobo": 500000, "settled_at": "2026-11-08T22:00:00Z"},     # 23:00 WAT -> already the NEXT sweep
    {"bank_reference": r3, "amount_kobo": 500000, "settled_at": "2026-11-08T22:30:00Z"}]})   # 23:30 WAT -> next sweep
t("23:00 WAT cutoff: a credit at 22:59 belongs to today's sweep, at 23:00 and 23:30 to the NEXT (nothing missed or counted twice)",
  (svc.SEEN_DATE[r1], svc.SEEN_DATE[r2], svc.SEEN_DATE[r3]) == (date(2026, 11, 8), date(2026, 11, 9), date(2026, 11, 9)), (svc.SEEN_DATE[r1], svc.SEEN_DATE[r2], svc.SEEN_DATE[r3]))
mid = str(uuid.uuid4())
client.post("/evaluate", json={"merchant_id": mid, "sweep_date": "2026-11-20", "inflows": [inflow("4000.00", day="2026-11-20")]})
t("an /evaluate call records its credits under the sweep it belongs to", any(d == date(2026, 11, 20) for d, _ in svc.HISTORY[mid]))


def history_days(n, mid):
    rows, k = [], 0
    for dday in range(n):
        for j in range(8):
            k += 1
            rows.append({"bank_reference": f"H7-{mid[:6]}-{k}", "amount": f"{4000 + j * 200}.00", "settled_at": f"2026-10-{10 + dday:02d}T{8 + j:02d}:00:00Z"})
    client.post("/api/v1/ai/history", json={"merchant_id": mid, "inflows": rows})


m8, m5 = str(uuid.uuid4()), str(uuid.uuid4())
history_days(8, m8)
history_days(5, m5)
v8 = client.post("/evaluate", json={"merchant_id": m8, "sweep_date": "2026-10-20", "inflows": [inflow("650000.00", day="2026-10-20")]}).json()
v5 = client.post("/evaluate", json={"merchant_id": m5, "sweep_date": "2026-10-20", "inflows": [inflow("650000.00", day="2026-10-20")]}).json()
t("PRD v3 9.1: with 8 days of history the real statistics apply (N650k is far outside this merchant's range -> HOLD)", v8["verdict"] == "HOLD" and v8["details"]["severity"] == "HIGH", v8)
t("... with only 5 days it still uses the cautious cold-start thresholds (N650k = MEDIUM, not held by default)", v5 == {"verdict": "CLEAR"}, v5)
t("GET /healthz -> instant 200 for Kubernetes", client.get("/healthz").status_code == 200 and client.get("/healthz").json() == {"ok": True})
os.environ["AI_SERVICE_TOKEN"] = "svc-secret"
hz = client.get("/healthz").status_code
os.environ.pop("AI_SERVICE_TOKEN")
t("... and /healthz needs no token (probes cannot send one)", hz == 200)

print(f"\n{'ALL PASSED' if not fails else str(fails) + ' FAILED'}")
sys.exit(1 if fails else 0)
