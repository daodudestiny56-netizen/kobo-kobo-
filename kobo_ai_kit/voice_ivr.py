#!/usr/bin/env python3
"""
Kobo Kobo - IVR call flow for Africa's Talking Voice.

How Africa's Talking voice works (from its SDK docs): when a call connects, AT POSTs to your callback URL
and you must answer within 5 seconds with XML such as <Response><GetDigits ...><Play url="..."/></GetDigits>
</Response>. <Say> speaks ENGLISH only; <Play url> plays an audio file from a public URL. So every Nigerian
language clip must already exist as audio BEFORE the call: this module only ever points at cached audio.
If a clip is missing it degrades to an English <Say> instead of going silent.

Safety choices
  * The welcome message never contains an amount (anyone may pick up the phone).
  * Balances are read only on OUTBOUND calls (we call the registered number). Inbound calls are refused
    unless IVR_ALLOW_INBOUND=1, because caller-ID can be spoofed.
  * The call is tied to the AT sessionId; the menu step refuses unknown or expired sessions.
  * Read-only: the IVR never changes anything. Rate changes and pauses stay on SMS/USSD with YES/NO consent.
NOT yet tested against a live Africa's Talking number: field names (callerNumber, destinationNumber, direction,
isActive, sessionId, dtmfDigits, clientRequestId) follow AT's documentation; verify in the AT sandbox.
"""
import sys as _sys
from pathlib import Path as _Path

_HERE = str(_Path(__file__).resolve().parent)
if _HERE not in _sys.path:
    _sys.path.insert(0, _HERE)

import os
import re
import threading
import time
from urllib.parse import quote
from xml.sax.saxutils import escape, quoteattr

from voice import VoiceError, find_ffmpeg

MENU_PATH = "/api/v1/ai/voice/ivr/menu"
SESSION_TTL = 30 * 60


def xml_response(body):
    return '<?xml version="1.0" encoding="UTF-8"?><Response>' + body + "</Response>"


def play(url):
    return f"<Play url={quoteattr(url)}></Play>"


def say(text):                       # Africa's Talking reads <Say> in English only
    return f"<Say>{escape(text)}</Say>"


def get_digits(inner, callback_url, timeout=10, num_digits=1):
    return (f'<GetDigits timeout="{int(timeout)}" numDigits="{int(num_digits)}" callbackUrl={quoteattr(callback_url)}>'
            f"{inner}</GetDigits>")


def _last10(number):
    return re.sub(r"\D", "", str(number or ""))[-10:]


class IvrFlow:
    def __init__(self, studio, merchants, base_url="", allow_inbound=None, now=time.time):
        self.studio = studio
        self._merchants = merchants              # dict, or a function returning one: merchant_id -> {phone_number, preferred_language}
        self.base = (base_url or os.getenv("PUBLIC_BASE_URL", "")).rstrip("/")
        self.allow_inbound = (os.getenv("IVR_ALLOW_INBOUND", "0") == "1") if allow_inbound is None else allow_inbound
        self.now = now
        self.sessions = {}                        # AT sessionId -> {merchant_id, lang, at}
        self._lock = threading.Lock()
        self.fmt = "mp3" if find_ffmpeg() else "wav"

    # ---- helpers
    @property
    def merchants(self):
        return self._merchants() if callable(self._merchants) else self._merchants

    def _phones(self):
        return {_last10(m.get("phone_number")): mid for mid, m in self.merchants.items() if m.get("phone_number")}

    def find_merchant(self, form):
        cid = form.get("clientRequestId")
        if cid in self.merchants:
            return cid
        phones = self._phones()
        for k in ("destinationNumber", "callerNumber"):
            mid = phones.get(_last10(form.get(k)))
            if mid:
                return mid
        return None

    def menu_url(self):
        tok = os.getenv("WEBHOOK_TOKEN", "")          # core's convention: Africa's Talking webhooks carry ?token=
        return f"{self.base}{MENU_PATH}" + (f"?token={quote(tok)}" if tok else "")

    def clip_url(self, audio_id):
        return self.studio.signer.url(audio_id, self.fmt, ttl=900)

    def prompt(self, intent, lang):
        """Play the pre-rendered static prompt, or speak English if it was never rendered."""
        try:
            script = self.studio.script(intent, lang, {})
            key, _ = self.studio.plan(script)
            if self.studio.cache.has(key):
                return play(self.clip_url(key))
            if lang != "en":                      # try the English clip before falling back to <Say>
                en = self.studio.script(intent, "en", {})
                k2, _ = self.studio.plan(en)
                if self.studio.cache.has(k2):
                    return play(self.clip_url(k2))
            return say(self.studio.script(intent, "en", {}).text)
        except VoiceError:
            return say("Sorry, something went wrong. Goodbye.")

    def _goodbye(self, lang):
        return self.prompt("ivr_goodbye", lang)

    def _menu(self, lang, extra_before=""):
        return xml_response(get_digits(extra_before + self.prompt("ivr_welcome", lang), self.menu_url())
                            + self._goodbye(lang))

    def _gc(self):
        cutoff = self.now() - SESSION_TTL
        for sid in [s for s, v in self.sessions.items() if v["at"] < cutoff]:
            self.sessions.pop(sid, None)

    # ---- AT callbacks
    def answer(self, form):
        """First callback when the call connects."""
        if str(form.get("isActive", "1")) == "0":     # call-ended notification
            return ""
        mid = self.find_merchant(form)
        if mid is None:
            return xml_response(self.prompt("ivr_unknown", "en"))
        lang = self.merchants[mid].get("preferred_language", "en")
        if str(form.get("direction", "")).lower() == "inbound" and not self.allow_inbound:
            return xml_response(self.prompt("ivr_outbound_only", lang))
        sid = form.get("sessionId")
        if not sid:
            return xml_response(self.prompt("ivr_unknown", "en"))
        with self._lock:
            self._gc()
            self.sessions[sid] = {"merchant_id": mid, "lang": lang, "at": self.now()}
        return self._menu(lang)

    def menu(self, form):
        """Callback after the caller presses a key (AT sends dtmfDigits)."""
        if str(form.get("isActive", "1")) == "0":
            return ""
        with self._lock:
            self._gc()
            sess = self.sessions.get(form.get("sessionId"))
        if not sess:
            return xml_response(self.prompt("ivr_unknown", "en"))
        mid, lang = sess["merchant_id"], sess["lang"]
        digit = str(form.get("dtmfDigits", "")).strip()
        if digit in ("1", "2"):
            intent = "balance" if digit == "1" else "sweep_receipt"
            entry = self.studio.latest(mid, intent)
            if not entry:
                return xml_response(self.prompt("ivr_not_ready", lang))
            return xml_response(get_digits(play(self.clip_url(entry["audio_id"])), self.menu_url())
                                + self._goodbye(lang))
        if digit == "9":
            return self._menu(lang)
        return self._menu(lang, extra_before=self.prompt("ivr_invalid", lang))
