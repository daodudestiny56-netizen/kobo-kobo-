#!/usr/bin/env python3
"""
Kobo Kobo - client for the CORE backend (Caleb's service), from AI_ML_HANDOFF.md.

Smart Rate: the AI only ADVISES. We POST a suggestion to core; core texts the trader (Pidgin or English) and changes
the rate only when the trader replies YES. Core owns consent, the one-open-suggestion rule, the 14-day cooldown after
a NO, and the 72-hour expiry. So we never change a rate ourselves and we treat core's answers as the truth.

    POST {CORE_URL}/api/v1/smart-rate/suggestions   {"merchant_id", "suggested_rate": "2.5", "reason": "..."}
    GET  {CORE_URL}/api/v1/merchants/{id}/smart-rate      -> the open suggestion, or null

Env: CORE_URL (default http://localhost:3000), SERVICE_TOKEN (sent as 'Authorization: Bearer ...' when set).

NOTE: written from the handoff text only (docs/openapi.yaml was not available). Error bodies are parsed leniently:
the machine codes (SUGGESTION_PENDING, SUGGESTION_COOLDOWN, RATE_UNCHANGED) are searched for anywhere in the body.
"""
import sys as _sys
from pathlib import Path as _Path

_HERE = str(_Path(__file__).resolve().parent)
if _HERE not in _sys.path:
    _sys.path.insert(0, _HERE)

import json
import os

import httpx

CODES = ("SUGGESTION_PENDING", "SUGGESTION_COOLDOWN", "RATE_UNCHANGED")
REASON_MAX = 500


def _find(obj, key):
    """First value for `key` anywhere in a nested JSON object."""
    if isinstance(obj, dict):
        if key in obj:
            return obj[key]
        for v in obj.values():
            r = _find(v, key)
            if r is not None:
                return r
    elif isinstance(obj, list):
        for v in obj:
            r = _find(v, key)
            if r is not None:
                return r
    return None


def _code(body):
    text = body if isinstance(body, str) else json.dumps(body, ensure_ascii=False)
    return next((c for c in CODES if c in text), None)


def format_rate(rate):
    """Core wants percent 1-5, up to 2 decimals, as a string: 2.5 -> '2.5', 3.0 -> '3'."""
    r = round(float(rate), 2)
    if not (1.0 <= r <= 5.0):
        raise ValueError(f"suggested rate {rate} is outside core's 1-5 range")
    return f"{r:g}"


def build_reason(rationale, confidence=None, model=None):
    bits = [rationale.strip()]
    tail = []
    if confidence is not None:
        tail.append(f"confidence {confidence:.0%}")
    if model:
        tail.append(model)
    if tail:
        bits.append("(" + ", ".join(tail) + ")")
    text = " ".join(bits)
    return text if len(text) <= REASON_MAX else text[: REASON_MAX - 1].rstrip() + "…"


class CoreClient:
    def __init__(self, base_url=None, token=None, client=None, timeout=5.0):
        self.base = (base_url or os.getenv("CORE_URL", "http://localhost:3000")).rstrip("/")
        self.token = os.getenv("SERVICE_TOKEN", "") if token is None else token
        self._c = client or httpx.Client(base_url=self.base, timeout=timeout)

    def _headers(self):
        return {"Authorization": f"Bearer {self.token}"} if self.token else {}

    def open_suggestion(self, merchant_id):
        """Returns (suggestion_or_None, error_or_None). Never raises: a failed pre-check just means 'try anyway'."""
        try:
            r = self._c.get(f"/api/v1/merchants/{merchant_id}/smart-rate", headers=self._headers())
            if r.status_code == 200:
                return (r.json() or None), None
            return None, f"core answered {r.status_code}"
        except (httpx.HTTPError, ValueError) as e:
            return None, str(e)

    def propose(self, merchant_id, rate, reason):
        """POST one suggestion. Always returns a dict with a `status`:
        SENT | SKIPPED_PENDING | SKIPPED_COOLDOWN | SKIPPED_UNCHANGED | ERROR_UNKNOWN_MERCHANT | ERROR_AUTH |
        ERROR_REJECTED | ERROR_UNREACHABLE (retryable)."""
        try:
            body = {"merchant_id": merchant_id, "suggested_rate": format_rate(rate), "reason": reason[:REASON_MAX]}
        except ValueError as e:
            return {"status": "ERROR_REJECTED", "error": str(e), "retryable": False}
        try:
            r = self._c.post("/api/v1/smart-rate/suggestions", json=body, headers=self._headers())
        except httpx.HTTPError as e:
            return {"status": "ERROR_UNREACHABLE", "error": f"cannot reach core: {e}", "retryable": True, "sent": body}
        try:
            data = r.json()
        except ValueError:
            data = {"raw": r.text[:300]}
        c = r.status_code
        out = {"http_status": c, "core": data, "sent": body}
        if c == 201:
            return {**out, "status": "SENT"}
        if c == 409:
            code = _code(data)
            if code == "SUGGESTION_COOLDOWN":
                return {**out, "status": "SKIPPED_COOLDOWN", "retry_after": _find(data, "retry_after")}
            return {**out, "status": "SKIPPED_PENDING"}
        if c == 422 and _code(data) == "RATE_UNCHANGED":
            return {**out, "status": "SKIPPED_UNCHANGED"}
        if c == 404:
            return {**out, "status": "ERROR_UNKNOWN_MERCHANT"}
        if c in (401, 403):
            return {**out, "status": "ERROR_AUTH", "error": "core rejected SERVICE_TOKEN"}
        if c >= 500:
            return {**out, "status": "ERROR_UNREACHABLE", "retryable": True, "error": f"core error {c}"}
        return {**out, "status": "ERROR_REJECTED", "error": f"core answered {c}", "retryable": False}
