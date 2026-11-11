#!/usr/bin/env python3
"""
Kobo Kobo - AI service (Sweep Guard + name matching + Smart Rate + Voice). PRD v2.0.0.

Run:    uvicorn kobo_ai_service:app --port 8001
Docs:   http://localhost:8001/docs     <- live API contract (Swagger)

Env:
  GUARD_STUB=1                  always return CLEARED (lets teammates integrate before rules are tuned)
  SPIKE_POLICY=exclude_inflow   (default) hold only the flagged inflow, sweep the rest
  SPIKE_POLICY=hold_day         hold the whole day's sweep if any inflow is flagged
  SEED_DIR=./seed               folder produced by generate_seed.py (gives Guard its 30-day baseline)
"""
import sys as _sys
from pathlib import Path as _Path

_HERE = str(_Path(__file__).resolve().parent)       # lets sibling files (smart_rate.py ...) import from ANY folder
if _HERE not in _sys.path:
    _sys.path.insert(0, _HERE)
import hashlib
import json
import math
import os
import re
import unicodedata
from collections import Counter, defaultdict, deque
from decimal import Decimal
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Literal, Optional, Union

import numpy as np
from fastapi import FastAPI, Header, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from rapidfuzz.distance import JaroWinkler

import core_client
import smart_rate as sr
import voice as vc
import voice_ivr

STUB = os.getenv("GUARD_STUB", "0") == "1"
POLICY = os.getenv("SPIKE_POLICY", "exclude_inflow")
SWEEP_CUTOFF_HOUR = int(os.getenv("SWEEP_CUTOFF_HOUR", "23"))   # PRD v3 6.1: sweep window ends 23:00 WAT
# Default = the "seed" folder next to this file. You normally set NOTHING. If you do set SEED_DIR, quotes pasted by
# Windows "Copy as path" are stripped for you.
SEED_DIR = Path(os.getenv("SEED_DIR", str(Path(__file__).parent / "seed")).strip().strip('"').strip("'"))
MODEL_VERSION = "guard-rules-v1"

# ---- Sweep Guard tunables
WINDOW_DAYS = 30            # baseline window (WAT days before sweep_date)
MIN_HISTORY_INFLOWS = 30    # need this many inflows ...
MIN_HISTORY_DAYS = 7        # ... across this many days to trust the statistics (PRD v3 9.1: at least 7 days)
MIN_ABS_FLAG = 100_000.0    # never flag a single inflow below this (no nuisance flags on small traders)
Z_FLAG = 3.0                # robust z-score (log-amount) to flag
Z_HIGH = 5.0                # ... to call it HIGH
RATIO_HIGH = 50.0           # amount / typical amount to call it HIGH
MAD_FLOOR = 0.35            # floor on log-scale spread so very regular traders don't get hair-trigger flags
COLD_MEDIUM = 500_000.0     # cold start (thin history): absolute thresholds
COLD_HIGH = 1_000_000.0

# ---- Name matching tunables
MATCH_T = 0.90
REVIEW_T = 0.70

WAT = timezone(timedelta(hours=1))
SEV_RANK = {"NONE": 0, "LOW": 1, "MEDIUM": 2, "HIGH": 3}

app = FastAPI(title="Kobo Kobo AI service", version="2.0.0",
              description="Sweep Guard + identity name matching. Runs BEFORE the 23:00 WAT sweep.")


# =============================================================================== history store
HISTORY = defaultdict(list)   # merchant_id -> [(wat_date, amount)]
SEEN_DATE = {}                # bank_reference -> WAT date it was counted on (idempotent history + duplicate detection)


def _parse_ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def sweep_day(dt):
    """Which sweep a credit belongs to. PRD v3 6.1: the window is [previous 23:00 WAT, this 23:00 WAT), so a credit at
    23:30 WAT belongs to the NEXT sweep day and nothing is missed or counted twice."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return (dt.astimezone(WAT) + timedelta(hours=24 - SWEEP_CUTOFF_HOUR)).date()


def wat_date(dt):
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(WAT).date()


def _load_history():
    p = SEED_DIR / "inflows.json"
    if not p.exists():
        print(f"[kobo] WARNING: seed data not found at {p}\n"
              f"[kobo]   Sweep Guard will have no history and Smart Rate will answer 404.\n"
              f"[kobo]   Fix: keep the 'seed' folder (with inflows.json inside) next to kobo_ai_service.py, "
              f"or set SEED_DIR to that folder.")
        return
    for r in json.loads(p.read_text(encoding="utf-8")):
        HISTORY[r["merchant_id"]].append((sweep_day(_parse_ts(r["settled_at"])), float(r["amount"])))
        SEEN_DATE[r["bank_reference"]] = sweep_day(_parse_ts(r["settled_at"]))


_load_history()


def naira(x):
    return f"₦{x:,.0f}"


# =============================================================================== models
class Inflow(BaseModel):
    sender: Optional[str] = None
    narration: Optional[str] = None
    bank_reference: str
    amount: float = Field(gt=0, description="Naira")
    channel: str = "POS"
    settled_at: datetime
    trader_confirmed: bool = Field(
        False, description="True once the trader/Ops confirmed a previously held inflow is legit")


class CheckRequest(BaseModel):
    merchant_id: str
    sweep_date: date = Field(description="WAT calendar date being swept")
    inflows: list[Inflow] = Field(description="Credits settled 00:00:00-22:59:59 WAT that day")
    identity_status: Literal["VERIFIED", "REVIEW", "MISMATCH"] = "VERIFIED"
    prior_sweep_status: Optional[str] = Field(
        None, description="daily_sweeps.status already stored for (merchant, sweep_date), else null")
    proposed_rate: Optional[float] = Field(None, description="Sweep % e.g. 2.0. Only used to report avoided_sweep")


class Alert(BaseModel):
    alert_type: Literal["ANOMALOUS_INFLOW", "SUSPECTED_DUPLICATE", "NAME_MISMATCH"]
    severity: Literal["LOW", "MEDIUM", "HIGH"]
    action_taken: Literal["HELD", "ALLOWED", "QUARANTINED"]
    bank_reference: Optional[str] = Field(None, description="null = sweep-level alert")
    reason: str
    metrics: dict = Field(default_factory=dict)


class Bucket(BaseModel):
    bank_references: list[str]
    total: float


class CheckResponse(BaseModel):
    check_id: str
    sweep_key: str
    status: Literal["CLEARED", "PARTIAL", "HELD"]
    severity: Literal["NONE", "LOW", "MEDIUM", "HIGH"]
    reason: str
    sweepable: Bucket
    held: Bucket
    alerts: list[Alert]
    policy: str
    model_version: str


# =============================================================================== Sweep Guard
def _spike_alert(inflow, amts, days, rate):
    x = inflow.amount
    if x < MIN_ABS_FLAG:
        return None
    warm = len(amts) >= MIN_HISTORY_INFLOWS and days >= MIN_HISTORY_DAYS
    metrics = {"baseline_inflow_count": len(amts), "baseline_days": days}
    if warm:
        logs = np.log(np.array(amts))
        center = float(np.median(logs))
        scale = max(float(np.median(np.abs(logs - center))) * 1.4826, MAD_FLOOR)
        z = (math.log(x) - center) / scale
        typical = math.exp(center)
        ratio = x / typical
        if z < Z_FLAG:
            return None
        sev = "HIGH" if (z >= Z_HIGH or ratio >= RATIO_HIGH) else "MEDIUM"
        reason = (f"{naira(x)} is {ratio:,.0f}x this merchant's typical sale ({naira(typical)}). "
                  f"Held until the trader confirms.")
        metrics.update(method="robust_log_z", z_score=round(z, 1),
                       typical_amount=round(typical, 2), ratio=round(ratio, 1))
    else:
        if x >= COLD_HIGH:
            sev = "HIGH"
        elif x >= COLD_MEDIUM:
            sev = "MEDIUM"
        else:
            return None
        reason = (f"{naira(x)} is unusually large for a merchant with under {MIN_HISTORY_DAYS} days of history. "
                  f"Held until the trader confirms.")
        metrics.update(method="cold_start_absolute")
    if rate:
        metrics["avoided_sweep"] = round(x * rate / 100.0, 2)
    return Alert(alert_type="ANOMALOUS_INFLOW", severity=sev, action_taken="HELD",
                 bank_reference=inflow.bank_reference, reason=reason, metrics=metrics)


@app.post("/api/v1/ai/sweep-guard/check", response_model=CheckResponse, tags=["Sweep Guard"])
def sweep_guard_check(req: CheckRequest):
    """Call once per merchant, right before the 23:00 WAT sweep. Idempotent per identical payload."""
    sweep_key = f"{req.merchant_id}:{req.sweep_date.isoformat()}"
    check_id = "sgc_" + hashlib.sha1(req.model_dump_json().encode()).hexdigest()[:8]
    refs = [i.bank_reference for i in req.inflows]
    all_total = round(sum(i.amount for i in req.inflows), 2)

    if STUB:
        return CheckResponse(check_id=check_id, sweep_key=sweep_key, status="CLEARED", severity="NONE",
                             reason="STUB MODE: always cleared.",
                             sweepable=Bucket(bank_references=refs, total=all_total),
                             held=Bucket(bank_references=[], total=0.0),
                             alerts=[], policy="stub", model_version="stub")

    alerts = []
    sweep_hold = False

    # 1) sweep-level: duplicate
    if req.prior_sweep_status == "EXECUTED":
        alerts.append(Alert(alert_type="SUSPECTED_DUPLICATE", severity="MEDIUM", action_taken="HELD",
                            reason=f"A sweep for {sweep_key} was already EXECUTED. Blocking a second one.",
                            metrics={"prior_sweep_status": req.prior_sweep_status}))
        sweep_hold = True

    # 2) sweep-level: identity
    if req.identity_status != "VERIFIED":
        sev = "HIGH" if req.identity_status == "MISMATCH" else "MEDIUM"
        alerts.append(Alert(alert_type="NAME_MISMATCH", severity=sev, action_taken="HELD",
                            reason=f"Identity check is {req.identity_status}: BVN name and RSA/account name "
                                   f"do not match well enough. Ops must resolve before sweeping.",
                            metrics={"identity_status": req.identity_status}))
        sweep_hold = True

    # 2b) sweep-level: the same bank_reference twice in one batch, or one already counted on another day
    already = any(a.alert_type == "SUSPECTED_DUPLICATE" for a in alerts)
    dup_in_batch = sorted(r for r, n in Counter(refs).items() if n > 1)
    replayed = sorted({i.bank_reference for i in req.inflows if SEEN_DATE.get(i.bank_reference) not in (None, req.sweep_date)})
    if (dup_in_batch or replayed) and not already:
        alerts.append(Alert(alert_type="SUSPECTED_DUPLICATE", severity="MEDIUM", action_taken="HELD",
                            reason=("The same payment appears twice in this sweep, or was already counted on an earlier day. "
                                    "Holding so nobody is swept twice for one payment."),
                            metrics={"duplicate_in_batch": dup_in_batch[:5], "already_counted_on_other_day": replayed[:5]}))
        sweep_hold = True

    # 3) inflow-level: spikes
    lo = req.sweep_date - timedelta(days=WINDOW_DAYS)
    hist = [(d, a) for d, a in HISTORY[req.merchant_id] if lo <= d < req.sweep_date]
    amts = [a for _, a in hist]
    days = len({d for d, _ in hist})
    flagged = {}
    for inflow in req.inflows:
        if inflow.trader_confirmed or inflow.bank_reference in flagged:
            continue
        al = _spike_alert(inflow, amts, days, req.proposed_rate)
        if al:
            alerts.append(al)
            flagged[inflow.bank_reference] = inflow

    ok = [i for i in req.inflows if i.bank_reference not in flagged]
    ok_total = round(sum(i.amount for i in ok), 2)

    if sweep_hold or (flagged and POLICY == "hold_day"):
        status = "HELD"
        sweepable = Bucket(bank_references=[], total=0.0)
        held = Bucket(bank_references=refs, total=all_total)
    elif flagged:
        status = "PARTIAL"
        sweepable = Bucket(bank_references=[i.bank_reference for i in ok], total=ok_total)
        held = Bucket(bank_references=list(flagged), total=round(all_total - ok_total, 2))
    else:
        status = "CLEARED"
        sweepable = Bucket(bank_references=refs, total=all_total)
        held = Bucket(bank_references=[], total=0.0)

    severity = max((a.severity for a in alerts), key=lambda s: SEV_RANK[s], default="NONE")

    sweep_reasons = [a.reason for a in alerts if a.bank_reference is None]
    inflow_reasons = [a.reason for a in alerts if a.bank_reference]
    if status == "CLEARED":
        reason = f"All {len(refs)} inflow(s) look normal." if refs else "No inflows today: sweep is ₦0."
    elif status == "PARTIAL":
        reason = (f"{len(flagged)} inflow(s) held. Sweeping the other {len(ok)} ({naira(ok_total)}). "
                  + " ".join(inflow_reasons))
    else:
        reason = "Whole sweep held. " + " ".join(sweep_reasons + inflow_reasons)

    # keep the baseline fresh (idempotent per bank_reference; flagged inflows never poison it)
    for i in req.inflows:
        if i.bank_reference in flagged or i.bank_reference in SEEN_DATE:
            continue
        SEEN_DATE[i.bank_reference] = req.sweep_date
        HISTORY[req.merchant_id].append((req.sweep_date, i.amount))     # these credits ARE this sweep's window

    return CheckResponse(check_id=check_id, sweep_key=sweep_key, status=status, severity=severity,
                         reason=reason, sweepable=sweepable, held=held, alerts=alerts,
                         policy=POLICY, model_version=MODEL_VERSION)


# =============================================================================== name matching
TITLES = {"mr", "mrs", "miss", "ms", "dr", "prof", "chief", "alhaji", "alhaja", "engr",
          "pastor", "madam", "sir", "hon", "elder", "rev"}


def _tokens(name):
    s = unicodedata.normalize("NFKD", name)
    s = "".join(c for c in s if not unicodedata.combining(c)).lower()
    s = re.sub(r"[^a-z\s]", " ", s.replace("'", "").replace("-", " "))
    return [t for t in s.split() if t not in TITLES]


def _tok_sim(a, b):
    if a == b:
        return 1.0
    if len(a) == 1 or len(b) == 1:                      # initial: "I." vs "Ibrahim"
        return 0.90 if a[0] == b[0] else 0.0
    sim = JaroWinkler.normalized_similarity(a, b)
    short, long_ = sorted((a, b), key=len)
    if len(short) >= 4 and short in long_:              # shortened form: Seun / Oluwaseun
        sim = max(sim, 0.88)                            # deliberately below MATCH -> goes to review
    return sim


def name_similarity(a, b):
    ta, tb = _tokens(a), _tokens(b)
    if not ta or not tb:
        return 0.0, 0.0, 0, [], ta, tb
    short, long_ = (ta, tb) if len(ta) <= len(tb) else (tb, ta)
    pairs = sorted(((_tok_sim(s, l), i, j) for i, s in enumerate(short) for j, l in enumerate(long_)),
                   reverse=True)
    used_s, used_l, matched, sims = set(), set(), [], []
    for sim, i, j in pairs:
        if i in used_s or j in used_l:
            continue
        used_s.add(i)
        used_l.add(j)
        sims.append(sim)
        matched.append([short[i], long_[j], round(sim, 3)])
    mean, mn = sum(sims) / len(sims), min(sims)
    score = 0.6 * mean + 0.4 * mn - min(0.06, 0.02 * (len(long_) - len(short)))
    if len(short) < 2:
        score = min(score, 0.85)                        # one-word names never auto-match
    score = max(0.0, min(1.0, score))
    unmatched = [t for j, t in enumerate(long_) if j not in used_l]
    return score, mn, len(short), matched, unmatched, []


class NameMatchRequest(BaseModel):
    name_a: str = Field(description="e.g. BVN name")
    name_b: str = Field(description="e.g. Access RSA / account name")
    context: Optional[str] = Field(None, description="free text, e.g. BVN_VS_RSA. Never send BVN/NIN numbers.")


class NameMatchResponse(BaseModel):
    score: float
    decision: Literal["MATCH", "REVIEW", "MISMATCH"]
    thresholds: dict
    method: str
    detail: dict


@app.post("/api/v1/ai/name-match", response_model=NameMatchResponse, tags=["Identity"])
def name_match(req: NameMatchRequest):
    """Names only. Nothing is stored or logged."""
    score, mn, n_short, matched, unmatched, _ = name_similarity(req.name_a, req.name_b)
    if score >= MATCH_T and mn >= MATCH_T and n_short >= 2:
        decision = "MATCH"
    elif score >= REVIEW_T:
        decision = "REVIEW"
    else:
        decision = "MISMATCH"
    return NameMatchResponse(score=round(score, 3), decision=decision,
                             thresholds={"match": MATCH_T, "review": REVIEW_T},
                             method="token_align_jaro_winkler_v1",
                             detail={"matched_tokens": matched, "unmatched_tokens": unmatched})


@app.get("/healthz", tags=["Ops"])
def healthz():
    """Liveness/readiness for Kubernetes. Instant: never calls the network."""
    return {"ok": True}


@app.get("/health", tags=["Ops"])
def health():
    return {"ok": True, "stub": STUB, "policy": POLICY, "merchants_loaded": len(HISTORY),
            "model_version": MODEL_VERSION, "smart_rate_version": sr.MODEL_VERSION,
            "seed_dir": str(SEED_DIR), "seed_found": (SEED_DIR / "inflows.json").exists(),
            "voice_provider": STUDIO.provider.name, "guard_mode": os.getenv("GUARD_MODE", "whole")}


# =============================================================================== Smart Rate
# The engine only SUGGESTS. A rate changes only when the trader answers YES to an issued suggestion, and the
# caller (SMS/USSD handler) then writes `apply.value` to merchants.sweep_percentage. This service never writes it.
MERCHANTS = {}       # merchant_id -> seed metadata (language, current rate, start date)
SUGGESTIONS = {}     # suggestion_id -> record. In-memory for the hackathon; production = a rate_suggestions table.


def _load_merchants():
    p = SEED_DIR / "merchants.json"
    if not p.exists():
        return
    for m in json.loads(p.read_text(encoding="utf-8")):
        MERCHANTS[m["id"]] = {"start": date.fromisoformat(m["created_at"][:10]),
                              "preferred_language": m.get("preferred_language", "en"),
                              "phone_number": m.get("phone_number"),
                              "sweep_percentage": m.get("sweep_percentage", 2.0),
                              "is_paused": m.get("is_paused", False)}


_load_merchants()


def _now(dt=None):
    if dt is None:
        return datetime.now(timezone.utc)
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _iso(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") if dt else None


def _records(merchant_id):
    return [r for r in SUGGESTIONS.values() if r["merchant_id"] == merchant_id]


def _smart_rate_run(merchant_id, as_of, current_rate, language, is_paused, now):
    daily = defaultdict(float)
    for d, a in HISTORY.get(merchant_id, []):
        daily[d] += a
    if not daily:
        raise HTTPException(status_code=404, detail="No sales history for this merchant")
    m = MERCHANTS.get(merchant_id, {})
    return sr.recommend(
        merchant_id, daily, m.get("start") or min(daily), as_of or max(daily),
        current_rate if current_rate is not None else m.get("sweep_percentage", 2.0),
        language or m.get("preferred_language", "en"),
        m.get("is_paused", False) if is_paused is None else is_paused,
        _records(merchant_id), now, daily_cap=float(os.getenv("DAILY_CAP_NAIRA", "5000")))


@app.get("/api/v1/ai/smart-rate/{merchant_id}", tags=["Smart Rate"])
def smart_rate_preview(merchant_id: str, as_of: Optional[date] = None, current_rate: Optional[float] = None,
                       language: Optional[str] = None, is_paused: Optional[bool] = None,
                       now: Optional[datetime] = None):
    """Analysis only. No side effects. `as_of` = last COMPLETE WAT day (defaults to the latest day on file).
    `now` is for demos/tests (fake clock). Returns the full explanation: metrics, checks, rationale, messages."""
    return _smart_rate_run(merchant_id, as_of, current_rate, language, is_paused, _now(now))


class SmartRateIssue(BaseModel):
    as_of: Optional[date] = None
    current_rate: Optional[float] = None
    language: Optional[str] = None
    is_paused: Optional[bool] = None
    now: Optional[datetime] = None


@app.post("/api/v1/ai/smart-rate/{merchant_id}/issue", tags=["Smart Rate"])
def smart_rate_issue(merchant_id: str, body: SmartRateIssue = SmartRateIssue()):
    """Call when you are about to SEND the suggestion. Records it as PENDING (expires in 7 days).
    Safe to retry: while one is pending you get the same suggestion back. HOLD results are not recorded."""
    now = _now(body.now)
    for r in _records(merchant_id):
        if r["status"] == "PENDING" and now < r["expires_at"]:
            out = dict(r["result"])
            out["suggestion"] = dict(out["suggestion"], status="PENDING")
            return out
    res = _smart_rate_run(merchant_id, body.as_of, body.current_rate, body.language, body.is_paused, now)
    if res["action"] == "HOLD" or not res["suggestion"]:
        return res
    sid = res["suggestion"]["suggestion_id"]
    res["suggestion"]["status"] = "PENDING"
    SUGGESTIONS[sid] = {"id": sid, "merchant_id": merchant_id, "direction": res["action"],
                        "current_rate": res["current_rate"], "recommended_rate": res["recommended_rate"],
                        "language": res["suggestion"]["messages"]["language"], "status": "PENDING",
                        "created_at": now, "expires_at": now + timedelta(days=sr.EXPIRY_DAYS),
                        "responded_at": None, "result": res}
    return res


class SmartRateAnswer(BaseModel):
    suggestion_id: str
    response: str = Field(description="YES / Y / 1  or  NO / N / 2 (case-insensitive)")
    now: Optional[datetime] = None


@app.post("/api/v1/ai/smart-rate/respond", tags=["Smart Rate"])
def smart_rate_respond(body: SmartRateAnswer):
    """The trader's answer. ONLY an approved=true result may change the rate: write `apply.value` to
    merchants.sweep_percentage. Idempotent. A YES after expiry is refused (the data has moved on: re-run)."""
    now = _now(body.now)
    st = SUGGESTIONS.get(body.suggestion_id)
    if st is None:
        raise HTTPException(status_code=404, detail="Unknown suggestion_id")
    ans = body.response.strip().upper()
    if ans in ("YES", "Y", "1"):
        yes = True
    elif ans in ("NO", "N", "2"):
        yes = False
    else:
        raise HTTPException(status_code=422, detail="Reply YES or NO")
    cur, rec, lang = st["current_rate"], st["recommended_rate"], st["language"]

    def reply(approved, reason=None):
        out = {"suggestion_id": st["id"], "merchant_id": st["merchant_id"], "status": st["status"],
               "approved": approved, "reason": reason,
               "new_rate": rec if approved else None, "rate_stays_at": None if approved else cur,
               "apply": ({"table": "merchants", "column": "sweep_percentage", "merchant_id": st["merchant_id"],
                          "value": rec, "effective": "next nightly sweep"} if approved else None),
               "confirmation_sms": sr.confirmation_text("DONE" if approved else "KEPT", lang, cur, rec)}
        return out

    if st["status"] == "PENDING" and now >= st["expires_at"]:
        st["status"] = "EXPIRED"
    if st["status"] == "EXPIRED":
        return reply(False, "EXPIRED: this suggestion is older than 7 days. Ask for a fresh one.")
    if st["status"] == "PENDING":
        st["status"] = "ACCEPTED" if yes else "DECLINED"
        st["responded_at"] = now
        return reply(yes)
    if st["status"] == "ACCEPTED":
        if yes:
            return reply(True)                                   # idempotent
        raise HTTPException(status_code=409, detail="Already accepted and applied. Change the rate normally.")
    # DECLINED
    return reply(False, None if not yes else "ALREADY_DECLINED: ask for a fresh suggestion.")


# =============================================================================== Voice
# Audio is rendered AHEAD (after the nightly sweep) and served from a cache: the 9jaLingo server handles one request
# at a time and can take minutes to wake, and an Africa's Talking IVR callback must answer in 5 seconds.
from urllib.parse import parse_qs  # noqa: E402

STUDIO = vc.build_studio_from_env()
JOBS = vc.JobManager(STUDIO)
def _merchant_view():
    """Seed merchants merged field-by-field with what core has told us (phone, language, name)."""
    view = {k: dict(v) for k, v in MERCHANTS.items()}
    for mid, d in STUDIO.directory().items():
        view.setdefault(mid, {}).update(d)
    return view


IVR = voice_ivr.IvrFlow(STUDIO, _merchant_view)
STATIC_PROMPTS = ["ivr_welcome", "ivr_invalid", "ivr_goodbye", "ivr_unknown", "ivr_not_ready", "ivr_outbound_only"]


def set_voice_studio(studio, jobs=None):
    """Swap the voice engine (tests, or a custom provider)."""
    global STUDIO, JOBS, IVR
    STUDIO = studio
    JOBS = jobs or vc.JobManager(studio)
    IVR = voice_ivr.IvrFlow(studio, _merchant_view)


class VoiceScriptRequest(BaseModel):
    intent: str = Field(description="balance | sweep_receipt | rate_suggestion | ivr_welcome | ivr_goodbye | ...")
    language: Optional[str] = Field(None, description="en | pidgin | yoruba | hausa | igbo (default: the merchant's)")
    facts: dict = Field(default_factory=dict, description="naira amounts as numbers, e.g. {\"total\": 36800}")
    name: Optional[str] = Field(None, description="how to greet them, e.g. 'Ngozi'. Optional.")
    variant: Optional[str] = None
    max_seconds: float = Field(24.0, ge=3, le=60)
    merchant_id: Optional[str] = None


class VoiceRenderRequest(VoiceScriptRequest):
    gender: str = Field("female", pattern="^(female|male)$")
    speaker: Optional[str] = None
    register: bool = Field(False, description="remember as this merchant's latest clip for the IVR (needs merchant_id)")
    wait_seconds: float = Field(0.0, ge=0, le=60, description="wait this long for the audio before answering PENDING")
    formats: list[str] = Field(default_factory=lambda: ["mp3", "ogg"])


def _compose(req):
    lang = req.language or STUDIO.directory().get(req.merchant_id or "", {}).get("preferred_language") \
        or MERCHANTS.get(req.merchant_id or "", {}).get("preferred_language", "en")
    try:
        return STUDIO.script(req.intent, lang, req.facts, name=req.name, variant=req.variant, max_seconds=req.max_seconds)
    except (vc.VoiceError, ValueError) as e:
        raise HTTPException(status_code=422, detail=str(e))


def _voice_payload(script, job, formats=("mp3", "ogg")):
    key = job["audio_id"]
    ready = job["status"] == "READY"
    meta = STUDIO.cache.meta(key) or {} if ready else {}
    return {"audio_id": key, "status": job["status"], "error": job.get("error"), "error_kind": job.get("error_kind"),
            "script": script.to_dict() if script else None,
            "urls": {f: STUDIO.signer.url(key, f) for f in formats if f in vc.FORMATS} if ready else {},
            "seconds": meta.get("seconds"), "speaker": meta.get("speaker_used"), "qa": meta.get("qa"),
            "provider": meta.get("provider"), "poll": f"/api/v1/ai/voice/jobs/{key}" if not ready else None}


@app.post("/api/v1/ai/voice/script", tags=["Voice"])
def voice_script(req: VoiceScriptRequest):
    """Text only: what would be spoken, how long, which language was really used. No audio, no API key needed."""
    return _compose(req).to_dict()


@app.post("/api/v1/ai/voice/render", tags=["Voice"])
def voice_render(req: VoiceRenderRequest):
    """Queue (or find) the audio. READY returns signed URLs. PENDING: poll /voice/jobs/{audio_id}.
    Cached audio is instant; a fresh clip takes ~12 s, or minutes if the 9jaLingo engine is waking up."""
    script = _compose(req)
    reg = (req.merchant_id, req.intent) if (req.register and req.merchant_id) else None
    job = JOBS.submit(script, gender=req.gender, speaker=req.speaker, register=reg)
    if job["status"] in ("PENDING", "RUNNING") and req.wait_seconds:
        job = JOBS.wait(job["audio_id"], req.wait_seconds)
    return _voice_payload(script, job, req.formats)


_AUDIO_ID = re.compile(r"[0-9a-f]{20}")


@app.get("/api/v1/ai/voice/jobs/{audio_id}", tags=["Voice"])
def voice_job(audio_id: str, formats: str = "mp3,ogg"):
    if not _AUDIO_ID.fullmatch(audio_id):
        raise HTTPException(status_code=404, detail="Unknown audio_id")
    job = JOBS.status(audio_id)
    if job["status"] == "UNKNOWN":
        raise HTTPException(status_code=404, detail="Unknown audio_id")
    return _voice_payload(None, job, [f for f in formats.split(",") if f])


@app.get("/api/v1/ai/voice/audio/{name}", tags=["Voice"])
def voice_audio(name: str, exp: Optional[str] = None, sig: Optional[str] = None):
    """name = '<audio_id>.<mp3|ogg|wav|wav8k>'. mp3 = Africa's Talking <Play>. ogg (Opus) = WhatsApp voice note."""
    audio_id, _, fmt = name.rpartition(".")
    if not _AUDIO_ID.fullmatch(audio_id) or fmt not in vc.FORMATS:
        raise HTTPException(status_code=404, detail="Use /<audio_id>.<mp3|ogg|wav|wav8k>")
    if not STUDIO.signer.verify(audio_id, fmt, exp, sig):
        raise HTTPException(status_code=403, detail="Link expired or invalid")
    try:
        got = STUDIO.get_audio(audio_id, fmt)
    except vc.TranscodeUnavailable as e:
        raise HTTPException(status_code=503, detail=str(e))
    except vc.VoiceError as e:
        raise HTTPException(status_code=500, detail=str(e))
    if got is None:
        raise HTTPException(status_code=404, detail="Audio not found (not rendered yet?)")
    return Response(content=got[0], media_type=got[1], headers={"Cache-Control": "private, max-age=3600"})


class VoicePrepareRender(BaseModel):
    intent: str
    facts: dict = Field(default_factory=dict)


class VoicePrepareItem(BaseModel):
    merchant_id: str
    phone_number: Optional[str] = Field(None, description="so the IVR can recognise this merchant's call")
    name: Optional[str] = None
    language: Optional[str] = None
    gender: str = Field("female", pattern="^(female|male)$")
    renders: list[VoicePrepareRender]


class VoicePrepareRequest(BaseModel):
    items: list[VoicePrepareItem]


@app.post("/api/v1/ai/voice/prepare", tags=["Voice"])
def voice_prepare(req: VoicePrepareRequest):
    """For the nightly job: right AFTER the 23:00 sweep, send every merchant's facts (balance, receipt).
    Audio is queued one at a time and registered as that merchant's latest clip, so the IVR can play it instantly."""
    out = []
    for it in req.items:
        lang = it.language or STUDIO.directory().get(it.merchant_id, {}).get("preferred_language") \
            or MERCHANTS.get(it.merchant_id, {}).get("preferred_language", "en")
        STUDIO.register_merchant(it.merchant_id, it.phone_number, it.language, it.name)
        for r in it.renders:
            try:
                script = STUDIO.script(r.intent, lang, r.facts, name=it.name)
            except (vc.VoiceError, ValueError) as e:
                out.append({"merchant_id": it.merchant_id, "intent": r.intent, "status": "REJECTED", "error": str(e)})
                continue
            job = JOBS.submit(script, gender=it.gender, register=(it.merchant_id, r.intent))
            out.append({"merchant_id": it.merchant_id, "intent": r.intent, "audio_id": job["audio_id"],
                        "status": job["status"], "language_used": script.language})
    return {"queued": sum(1 for o in out if o["status"] in ("PENDING", "RUNNING")),
            "ready": sum(1 for o in out if o["status"] == "READY"),
            "rejected": sum(1 for o in out if o["status"] == "REJECTED"), "items": out}


class VoicePrewarm(BaseModel):
    languages: list[str] = Field(default_factory=lambda: ["en", "pidgin", "yoruba", "hausa", "igbo"])
    gender: str = Field("female", pattern="^(female|male)$")


@app.post("/api/v1/ai/voice/prewarm", tags=["Voice"])
def voice_prewarm(req: VoicePrewarm = VoicePrewarm()):
    """Render the fixed IVR prompts (welcome, goodbye, ...) in every language. Do this once before a demo or deploy."""
    ids = []
    for lang in req.languages:
        for intent in STATIC_PROMPTS:
            try:
                job = JOBS.submit(STUDIO.script(intent, lang, {}), gender=req.gender)
                ids.append({"intent": intent, "language": lang, "audio_id": job["audio_id"], "status": job["status"]})
            except (vc.VoiceError, ValueError) as e:
                ids.append({"intent": intent, "language": lang, "status": "REJECTED", "error": str(e)})
    return {"total": len(ids), "pending": JOBS.pending(), "items": ids}


@app.get("/api/v1/ai/voice/latest/{merchant_id}", tags=["Voice"])
def voice_latest(merchant_id: str):
    return STUDIO.latest_all().get(merchant_id, {})


@app.get("/api/v1/ai/voice/status", tags=["Voice"])
def voice_status(check: bool = False):
    """Engine status. ?check=true also pings 9jaLingo (needs internet; may wake the engine). Never shows the key."""
    out = STUDIO.status()
    out["queue_pending"] = JOBS.pending()
    out["public_base_url"] = os.getenv("PUBLIC_BASE_URL", "") or None
    if check:
        out["provider_health"] = STUDIO.provider.health()
    return out


@app.get("/api/v1/ai/voice/clip", tags=["Voice"])
def voice_clip(merchant_id: str, intent: str = "balance", format: str = "mp3", ttl: int = 900):
    """For core's voice callback: the merchant's latest clip (under 36 hours old) as a signed, expiring link.
    Core puts it in <Play url="..."/>; if ready is false core keeps speaking its own English <Say>.
    Correct for 'balance' and 'sweep_receipt' (they are re-rendered every night)."""
    if format not in vc.FORMATS or not 60 <= ttl <= 86400:
        raise HTTPException(status_code=422, detail="format must be mp3|ogg|wav|wav8k and ttl 60-86400")
    e = STUDIO.latest(merchant_id, intent)
    if not e:
        return JSONResponse({"ready": False, "reason": "no fresh clip for this merchant (not rendered tonight yet, or older than 36 hours)"}, status_code=404)
    meta = STUDIO.cache.meta(e["audio_id"]) or {}
    return {"ready": True, "audio_id": e["audio_id"], "url": STUDIO.signer.url(e["audio_id"], format, ttl=ttl), "format": format,
            "language": e["language"], "seconds": meta.get("seconds"), "review_status": meta.get("review_status"),
            "created_at": e["created_at"], "text": meta.get("text")}


def _webhook_ok(token):
    want = os.getenv("WEBHOOK_TOKEN", "")
    return (not want) or token == want


async def _form(request: Request):
    body = (await request.body()).decode("utf-8", "ignore")
    return {k: v[0] for k, v in parse_qs(body, keep_blank_values=True).items()}


@app.post("/api/v1/ai/voice/ivr/answer", tags=["Voice IVR"])
async def ivr_answer(request: Request, token: Optional[str] = None):
    """Africa's Talking voice callback URL (form-encoded POST). Returns XML. Point your AT voice number here
    (add ?token=... if WEBHOOK_TOKEN is set, as core does for its webhooks)."""
    if not _webhook_ok(token):
        return Response(content="", status_code=401)
    return Response(content=IVR.answer(await _form(request)), media_type="application/xml")


@app.post("/api/v1/ai/voice/ivr/menu", tags=["Voice IVR"])
async def ivr_menu(request: Request, token: Optional[str] = None):
    """GetDigits callback: the key the caller pressed."""
    if not _webhook_ok(token):
        return Response(content="", status_code=401)
    return Response(content=IVR.menu(await _form(request)), media_type="application/xml")


# =============================================================================== Core integration (AI_ML_HANDOFF.md)
# Core (Caleb) calls us before every sweep, and we propose Smart Rate changes to core. The AI only ADVISES.
@app.middleware("http")
async def _service_token(request: Request, call_next):
    """Optional shared secret for service-to-service calls: set AI_SERVICE_TOKEN and every /api/v1/ai/* call needs
    'Authorization: Bearer <token>'. Not applied to /evaluate (own GUARD_TOKEN), /health, signed audio links or the
    Africa's Talking IVR callbacks (those prove themselves by signature / call session)."""
    tok = os.getenv("AI_SERVICE_TOKEN", "")
    p = request.url.path
    if tok and p.startswith("/api/v1/ai/") and not p.startswith(("/api/v1/ai/voice/audio/", "/api/v1/ai/voice/ivr/")):
        if request.headers.get("authorization") != f"Bearer {tok}":
            return JSONResponse({"detail": "Missing or invalid service token"}, status_code=401)
    return await call_next(request)


_SEV = {"LOW": 1, "MEDIUM": 2, "HIGH": 3}


class EvalInflow(BaseModel):
    bank_reference: str
    amount: Optional[Union[str, float, int]] = Field(None, description='decimal naira string, e.g. "7000.00" (or send amount_kobo)')
    amount_kobo: Optional[int] = Field(None, description="integer kobo (PRD v3 stores money as kobo)")
    settled_at: datetime
    channel: Optional[str] = "POS"
    sender: Optional[str] = Field(None, description="optional: lets us spot look-alike duplicates")
    narration: Optional[str] = None


class EvalRequest(BaseModel):
    merchant_id: str
    sweep_date: date
    takings: Optional[Union[str, float, int]] = None
    takings_kobo: Optional[int] = None
    inflows: list[EvalInflow] = Field(default_factory=list)
    mode: Optional[Literal["whole", "partial"]] = Field(
        None, description="whole = HOLD blocks the entire sweep (core's original contract). partial = only the flagged "
                          "credits are excluded and the rest still sweeps (PRD v3 9.1). Default: env GUARD_MODE, else whole.")


def _guard_score(alert):
    z = alert.metrics.get("z_score")
    if z is not None:
        return round(min(0.99, 1 - math.exp(-max(float(z), 0.0) / 4)), 2)
    return {"HIGH": 0.9, "MEDIUM": 0.6, "LOW": 0.3}[alert.severity]


def _naira(i):
    return Decimal(i.amount_kobo) / 100 if i.amount_kobo is not None else Decimal(str(i.amount))


def _money(d):
    q = Decimal(d).quantize(Decimal("0.01"))
    return f"{q:.2f}", int(q * 100)


def _evaluate_whole(req):
    inflows = [Inflow(bank_reference=i.bank_reference, amount=float(_naira(i)), channel=i.channel or "POS", settled_at=i.settled_at)
               for i in req.inflows]
    res = sweep_guard_check(CheckRequest(merchant_id=req.merchant_id, sweep_date=req.sweep_date, inflows=inflows))
    if res.status == "CLEARED":
        return {"verdict": "CLEAR"}
    min_rank = _SEV.get(os.getenv("GUARD_HOLD_MIN_SEVERITY", "HIGH").upper(), 3)
    holdable = [a for a in res.alerts if a.alert_type != "ANOMALOUS_INFLOW" or _SEV[a.severity] >= min_rank]
    if not holdable:
        print(f"[kobo] /evaluate: {req.merchant_id} had only below-threshold anomalies, answering CLEAR")
        return {"verdict": "CLEAR"}
    top = max(holdable, key=lambda a: _SEV[a.severity])
    return {"verdict": "HOLD", "alert_type": top.alert_type,
            "details": {"score": _guard_score(top), "reason": top.reason, "severity": top.severity,
                        "bank_reference": top.bank_reference, "metrics": top.metrics}}


def _evaluate_partial(req):
    """PRD v3 9.1: only the flagged credit is excluded; the rest of the day still sweeps."""
    raw = [Inflow(bank_reference=i.bank_reference, amount=float(_naira(i)), channel=i.channel or "POS",
                  settled_at=i.settled_at, sender=i.sender, narration=i.narration) for i in req.inflows]
    # 1) exact duplicates are IGNORED, not alarmed: same reference twice, or already counted on another day
    seen, kept, ignored = set(), [], []
    for i in raw:
        if i.bank_reference in seen or SEEN_DATE.get(i.bank_reference) not in (None, req.sweep_date):
            ignored.append(i.bank_reference)
            continue
        seen.add(i.bank_reference)
        kept.append(i)
    # 2) look-alikes (same sender + amount + narration within 5 minutes) are FLAGGED and held out
    groups = defaultdict(list)
    for i in kept:
        if i.sender and i.narration:
            groups[(i.sender.strip().lower(), round(i.amount, 2), i.narration.strip().lower())].append(i)
    lookalike = {}
    for lst in groups.values():
        lst.sort(key=lambda x: x.settled_at)
        for a, b in zip(lst, lst[1:]):
            if (b.settled_at - a.settled_at).total_seconds() <= 300:
                lookalike[b.bank_reference] = b
    # 3) statistical anomalies on the rest
    res = sweep_guard_check(CheckRequest(merchant_id=req.merchant_id, sweep_date=req.sweep_date,
                                         inflows=[i for i in kept if i.bank_reference not in lookalike]))
    if res.status == "HELD":                                  # a sweep-level problem: nothing to salvage
        return _evaluate_whole(req)
    min_rank = _SEV.get(os.getenv("GUARD_HOLD_MIN_SEVERITY", "MEDIUM").upper(), 2)   # a partial hold is cheap: lower bar
    excluded = {a.bank_reference: a for a in res.alerts
                if a.bank_reference and (a.alert_type != "ANOMALOUS_INFLOW" or _SEV[a.severity] >= min_rank)}
    for ref_ in lookalike:
        excluded[ref_] = Alert(alert_type="SUSPECTED_DUPLICATE", severity="MEDIUM", action_taken="HELD", bank_reference=ref_,
                               reason="Same sender, amount and narration as another credit within 5 minutes. Held out of "
                                      "tonight's sweep until ops reviews it.", metrics={"window_seconds": 300})
    ok = [i for i in kept if i.bank_reference not in excluded]
    out_ = [i for i in kept if i.bank_reference in excluded]
    sw, ex = _money(sum(Decimal(str(i.amount)) for i in ok)), _money(sum(Decimal(str(i.amount)) for i in out_))
    details = {"mode": "partial", "sweepable_references": [i.bank_reference for i in ok], "sweepable_total": sw[0],
               "sweepable_total_kobo": sw[1], "excluded_references": [i.bank_reference for i in out_],
               "excluded_total": ex[0], "excluded_total_kobo": ex[1], "ignored_duplicates": ignored}
    if not excluded:
        return {"verdict": "CLEAR", "details": details} if ignored else {"verdict": "CLEAR"}
    top = max(excluded.values(), key=lambda a: _SEV[a.severity])
    return {"verdict": "HOLD", "alert_type": top.alert_type,
            "details": {**details, "score": _guard_score(top), "reason": top.reason, "severity": top.severity,
                        "bank_reference": top.bank_reference,
                        "alerts": [{"alert_type": a.alert_type, "severity": a.severity, "bank_reference": a.bank_reference,
                                    "reason": a.reason} for a in excluded.values()]}}


@app.post("/evaluate", tags=["Core integration"])
def evaluate(req: EvalRequest, authorization: Optional[str] = Header(None)):
    """Core calls this for every trader just before debiting (GUARD_URL=http://<this-host>/evaluate).
    Answers {"verdict":"CLEAR"} or {"verdict":"HOLD","alert_type":...,"details":{...}} within milliseconds.
    mode=whole (default, core's original contract): a HOLD blocks the WHOLE sweep, and a single-inflow anomaly holds only at
    HIGH severity (a false HOLD costs a night of savings) unless GUARD_HOLD_MIN_SEVERITY=MEDIUM.
    mode=partial (PRD v3): only the flagged credits are excluded; read details.excluded_references and details.sweepable_total
    (and *_kobo) and sweep the rest. Exact duplicate references are ignored; look-alike credits are flagged.
    Any internal problem answers CLEAR (core would fail open anyway) and prints the error."""
    tok = os.getenv("GUARD_TOKEN", "")
    if tok and authorization != f"Bearer {tok}":
        raise HTTPException(status_code=401, detail="Missing or invalid guard token")
    try:
        mode = req.mode or os.getenv("GUARD_MODE", "whole")
        return _evaluate_partial(req) if mode == "partial" else _evaluate_whole(req)
    except Exception as e:                                   # never block core
        print(f"[kobo] /evaluate error for {req.merchant_id}: {type(e).__name__}: {e}. Answering CLEAR.")
        return {"verdict": "CLEAR"}


class HistoryInflow(BaseModel):
    bank_reference: str
    amount: Optional[Union[str, float, int]] = None
    amount_kobo: Optional[int] = None
    settled_at: datetime


class HistoryRequest(BaseModel):
    merchant_id: str
    inflows: list[HistoryInflow]


@app.post("/api/v1/ai/history", tags=["Core integration"])
def backfill_history(req: HistoryRequest):
    """Teach us a merchant's past sales WITHOUT judging them (so Sweep Guard and Smart Rate have a baseline from day one).
    Send up to ~60 days of inflows once per merchant. Safe to repeat: known bank_references are skipped."""
    added = skipped = 0
    for i in req.inflows:
        try:
            amt = float(Decimal(i.amount_kobo) / 100 if i.amount_kobo is not None else Decimal(str(i.amount)))
        except Exception:
            skipped += 1
            continue
        if amt <= 0 or i.bank_reference in SEEN_DATE:
            skipped += 1
            continue
        d = sweep_day(i.settled_at)
        SEEN_DATE[i.bank_reference] = d
        HISTORY[req.merchant_id].append((d, amt))
        added += 1
    return {"merchant_id": req.merchant_id, "added": added, "skipped": skipped}


# ---- Smart Rate -> core
CORE = None
PROPOSALS = deque(maxlen=200)


def core():
    global CORE
    if CORE is None:
        CORE = core_client.CoreClient()
    return CORE


def set_core_client(c):
    global CORE
    CORE = c


class ProposeRequest(BaseModel):
    merchant_id: str
    current_rate: Optional[float] = Field(None, description="the merchant's rate today (percent). Needed for merchants not in the seed data")
    as_of: Optional[date] = Field(None, description="last COMPLETE WAT day (default: latest day on file)")
    language: Optional[str] = None
    dry_run: bool = Field(False, description="analyse and show what would be sent, but do not call core")
    now: Optional[datetime] = None


def _propose_one(req: ProposeRequest):
    if req.current_rate is None and req.merchant_id not in MERCHANTS:
        raise HTTPException(status_code=422, detail="current_rate is required for merchants outside the seed data")
    res = _smart_rate_run(req.merchant_id, req.as_of, req.current_rate, req.language, False, _now(req.now))
    summary = {"merchant_id": req.merchant_id, "current_rate": res["current_rate"], "recommended_rate": res["recommended_rate"],
               "action": res["action"], "regime": res["regime"], "confidence": res["confidence_score"],
               "hold_reason": res["hold_reason"], "rationale": res["rationale"]}
    if res["action"] == "HOLD":
        out = {**summary, "status": "NO_SUGGESTION"}
    else:
        reason = core_client.build_reason(res["rationale"], res["confidence_score"], res["model_version"])
        payload = {"merchant_id": req.merchant_id, "suggested_rate": core_client.format_rate(res["recommended_rate"]), "reason": reason}
        if req.dry_run:
            out = {**summary, "status": "DRY_RUN", "would_send": payload}
        else:
            open_s, _ = core().open_suggestion(req.merchant_id)
            if open_s:
                out = {**summary, "status": "SKIPPED_PENDING", "core": open_s}
            else:
                out = {**summary, **core().propose(req.merchant_id, res["recommended_rate"], reason)}
    PROPOSALS.append({"at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "merchant_id": req.merchant_id,
                      "status": out["status"], "rate": out.get("recommended_rate")})
    return out


@app.post("/api/v1/ai/smart-rate/propose", tags=["Core integration"])
def smart_rate_propose(req: ProposeRequest):
    """Analyse one merchant and, if a change is warranted, POST the suggestion to core. Core texts the trader and applies the
    rate only after YES. Core's answers (already pending, 14-day cooldown after a NO, unchanged, unknown merchant) are
    returned as a `status`, never as an error."""
    return _propose_one(req)


class ProposeBatch(BaseModel):
    items: list[ProposeRequest]


@app.post("/api/v1/ai/smart-rate/propose-batch", tags=["Core integration"])
def smart_rate_propose_batch(req: ProposeBatch):
    """The scheduled job: one call, many merchants. One bad merchant never stops the rest."""
    out = []
    for it in req.items:
        try:
            out.append(_propose_one(it))
        except HTTPException as e:
            out.append({"merchant_id": it.merchant_id, "status": "ERROR", "error": e.detail})
    counts = Counter(o["status"] for o in out)
    return {"counts": dict(counts), "items": out}


@app.get("/api/v1/ai/smart-rate-proposals", tags=["Core integration"])
def smart_rate_proposals(merchant_id: Optional[str] = None):
    """The last 200 proposals this service made (for debugging and audit)."""
    return [p for p in PROPOSALS if not merchant_id or p["merchant_id"] == merchant_id]
