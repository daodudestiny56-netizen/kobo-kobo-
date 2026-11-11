#!/usr/bin/env python3
"""
Kobo Kobo - Voice engine (PRD v2.0.0: multilingual IVR voice + audio generator).

What it does, in plain words
  Turns facts ("balance 36,800", "sweep 700") into short spoken messages in Pidgin, Yoruba, Hausa,
  Igbo or English, as audio files ready for an IVR call (MP3) or a WhatsApp voice note (OGG/Opus).

Why it is built this way (all from reading the 9jaLingo SDK and the Africa's Talking / WhatsApp docs)
  * The 9jaLingo server handles ONE request at a time (~12 s each) and can be scaled to zero, so a cold
    start can take minutes. An IVR callback must answer in 5 s. => Never synthesise during a call.
    Audio is rendered AHEAD (right after the nightly sweep), cached on disk, and served from the cache.
  * Africa's Talking <Say> only reads English, so local languages must be <Play url=...> audio files.
  * WhatsApp voice notes must be OGG with the Opus codec (mono). 9jaLingo returns WAV, so we convert
    locally with ffmpeg (pip install imageio-ffmpeg gives you one, no system install needed).
  * Amounts are spoken as English number words inside every language (how Nigerians usually say money),
    so no unreviewed Yoruba/Igbo/Hausa number grammar can corrupt a balance.

Quality gates
  * Every clip is checked (is it a real WAV, not silent, not truncated, plausible length for the text)
    and retried with another setting / speaker before it is accepted. Bad audio is never cached.
  * Languages marked "draft" in voice_templates.json are AI-written and need a native speaker.
  * Scripts that need a fact you did not supply raise an error. A wrong or blank amount is never spoken.
"""
import sys as _sys
from pathlib import Path as _Path

_HERE = str(_Path(__file__).resolve().parent)
if _HERE not in _sys.path:
    _sys.path.insert(0, _HERE)

import hashlib
import hmac
import io
import json
import math
import os
import queue
import re
import shutil
import string
import subprocess
import tempfile
import threading
import time
import wave
from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from pathlib import Path

import httpx
import numpy as np

HERE = Path(__file__).resolve().parent


def load_dotenv(path=None):
    """Tiny .env reader (KEY=VALUE per line). Never overrides variables that are already set."""
    p = Path(path) if path else HERE / ".env"
    if not p.exists():
        return
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


load_dotenv()

MODEL = "9jalingo-tts-1"
ALLOW_DRAFT_DEFAULT = os.getenv("VOICE_ALLOW_DRAFT", "1") == "1"


# =============================================================================== errors
class VoiceError(Exception):
    retryable = False


class MissingFact(VoiceError, ValueError):
    pass


class ProviderAuthError(VoiceError):
    pass


class ProviderBadRequest(VoiceError):
    def __init__(self, msg, kind="bad_request"):
        super().__init__(msg)
        self.kind = kind


class ProviderRateLimited(VoiceError):
    retryable = True

    def __init__(self, msg, retry_after=None):
        super().__init__(msg)
        self.retry_after = retry_after


class ProviderCapacity(VoiceError):
    retryable = True


class ProviderServerError(VoiceError):
    retryable = True


class ProviderUnavailable(VoiceError):
    retryable = True


class VoiceQualityError(VoiceError):
    pass


class TranscodeUnavailable(VoiceError):
    pass


# =============================================================================== saying numbers
_ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven",
         "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"]
_TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"]
_SCALES = ((10 ** 12, "trillion"), (10 ** 9, "billion"), (10 ** 6, "million"), (10 ** 3, "thousand"))


def int_to_words(n):
    """36800 -> 'thirty six thousand eight hundred' (British 'and', spaces not hyphens: friendlier to TTS)."""
    n = int(n)
    if n < 0:
        return "minus " + int_to_words(-n)
    if n < 20:
        return _ONES[n]
    if n < 100:
        t, o = divmod(n, 10)
        return _TENS[t] + (" " + _ONES[o] if o else "")
    if n < 1000:
        h, r = divmod(n, 100)
        return _ONES[h] + " hundred" + (" and " + int_to_words(r) if r else "")
    for scale, name in _SCALES:
        if n >= scale:
            q, r = divmod(n, scale)
            s = int_to_words(q) + " " + name
            if r:
                s += (" and " + int_to_words(r)) if r < 100 else (" " + int_to_words(r))
            return s
    raise ValueError(n)


def _dec(x):
    try:
        d = Decimal(str(x))
    except InvalidOperation:
        raise ValueError(f"not a number: {x!r}")
    if not d.is_finite():
        raise ValueError(f"not a finite number: {x!r}")
    return d


def speak_money(x):
    d = _dec(x)
    if d < 0 or d >= Decimal(10 ** 13):
        raise ValueError(f"amount out of range: {x!r}")
    n = int(d.quantize(Decimal("1"), rounding=ROUND_HALF_UP))
    return f"{int_to_words(n)} naira"


def speak_percent(x):
    d = _dec(x)
    if d < 0 or d > 100:
        raise ValueError(f"percent out of range: {x!r}")
    whole, _, frac = format(d.normalize(), "f").partition(".")
    words = int_to_words(int(whole))
    if frac:
        words += " point " + " ".join(_ONES[int(c)] for c in frac)
    return words + " percent"


def speak_days(x):
    n = int(_dec(x))
    if n < 0 or n > 3660:
        raise ValueError(f"days out of range: {x!r}")
    return f"{int_to_words(n)} day" + ("" if n == 1 else "s")


MONEY_SLOTS = {"total", "emergency", "retirement", "takings", "sweep", "held_amount", "monthly_change"}
PERCENT_SLOTS = {"rate_cur", "rate_new"}
DAY_SLOTS = {"vesting_days", "cooldown_days"}


NUMERIC_SLOTS = MONEY_SLOTS | PERCENT_SLOTS | DAY_SLOTS


def normalize_facts(facts):
    """Accept numbers OR decimal strings ("12000.00") in naira, OR integer kobo in a *_kobo key (total_kobo: 3680000).
    Anything numeric that is not a clean number raises ValueError, so junk can never be spoken or crash a comparison."""
    out = {}
    facts = dict(facts or {})
    for k in [k for k in facts if k.endswith("_kobo")]:
        base = k[:-5]
        v = facts.pop(k)
        if base not in MONEY_SLOTS:
            raise ValueError(f"{k}: only money amounts can be sent in kobo")
        if v is None:
            continue
        if facts.get(base) is not None:
            raise ValueError(f"send {base} OR {k}, not both")
        if isinstance(v, (bool, list, dict)):
            raise ValueError(f"{k} is not a number")
        d = _dec(v)
        if d != d.to_integral_value():
            raise ValueError(f"{k} must be a whole number of kobo")
        facts[base] = d / 100
    for k, v in facts.items():
        if k == "emergency_eligible" and v is not None:
            if isinstance(v, str) and v.strip().lower() in ("true", "false"):
                out[k] = v.strip().lower() == "true"
            elif isinstance(v, bool):
                out[k] = v
            else:
                raise ValueError("emergency_eligible must be true or false")
        elif k in NUMERIC_SLOTS and v is not None:
            if isinstance(v, (bool, list, dict)):
                raise ValueError(f"{k} is not a number")
            out[k] = _dec(v)
        else:
            out[k] = v
    return out


def clean_name(name):
    if not name:
        return ""
    s = re.sub(r"[^\w\s'’.-]", "", str(name), flags=re.UNICODE)
    return re.sub(r"\s+", " ", s).strip()[:30]


def spoken_slots(facts, name=None):
    out = {}
    for k, v in (facts or {}).items():
        if v is None:
            continue
        if k == "monthly_change":                      # a rate DECREASE is a negative change: spoken as a positive amount
            out[k] = speak_money(abs(_dec(v)))
        elif k in MONEY_SLOTS:                         # every other amount must be >= 0 (negative = a bug upstream)
            out[k] = speak_money(v)
        elif k in PERCENT_SLOTS:
            out[k] = speak_percent(v)
        elif k in DAY_SLOTS:
            out[k] = speak_days(v)
        else:
            out[k] = str(v)
    nm = clean_name(name)
    out["name_prefix"] = f"{nm}, " if nm else ""
    return out


# =============================================================================== pronunciation + timing
LEXICON = [
    (re.compile(r"\bYES\b"), "yes"),
    (re.compile(r"\bUSSD\b"), "U S S D"),
    (re.compile(r"\bBVN\b"), "B V N"),
    (re.compile(r"\bNIN\b"), "N I N"),
    (re.compile(r"\bPenCom\b", re.I), "Pen Com"),
]


def apply_lexicon(text):
    for rx, rep in LEXICON:
        text = rx.sub(rep, text)
    return text


def _words(text):
    return [w for w in re.split(r"\s+", text.strip()) if re.search(r"\w", w, flags=re.UNICODE)]


class Calibration:
    """Learns seconds-per-word for each voice language from real renders, so time estimates and QA bounds
    tighten as the system is used. Stored in calibration.json next to the audio cache."""
    DEFAULT_SPW = {"pcm": 0.40, "yo": 0.50, "ha": 0.46, "ig": 0.50}
    OVERHEAD_S = 0.6     # lead/trail silence: measured on real 9jaLingo clips ("Hello world" = 1.5 s)

    def __init__(self, path=None):
        self.path = Path(path) if path else None
        self.data = {}
        if self.path and self.path.exists():
            try:
                self.data = json.loads(self.path.read_text(encoding="utf-8"))
            except Exception:
                self.data = {}

    def spw(self, tts_lang):
        return float(self.data.get(tts_lang, {}).get("spw") or self.DEFAULT_SPW.get(tts_lang, 0.45))

    def calibrated(self, tts_lang):
        return int(self.data.get(tts_lang, {}).get("n", 0)) >= 5

    def estimate(self, text, tts_lang):
        return self.OVERHEAD_S + len(_words(text)) * self.spw(tts_lang)

    def update(self, tts_lang, words, seconds):
        if words < 3 or seconds <= 0:
            return
        m = min(max((seconds - self.OVERHEAD_S) / words, 0.15), 1.2)
        d = self.data.setdefault(tts_lang, {"spw": m, "n": 0})
        d["spw"] = m if d["n"] == 0 else round(0.8 * d["spw"] + 0.2 * m, 4)
        d["n"] += 1
        if self.path:
            _atomic_write(self.path, json.dumps(self.data, indent=1).encode("utf-8"))


def _atomic_write(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + f".{os.getpid()}.{threading.get_ident()}.tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)


# =============================================================================== templates -> script
LANG_ALIASES = {"en": "en", "english": "en", "pidgin": "pidgin", "pcm": "pidgin", "yoruba": "yoruba", "yo": "yoruba",
                "hausa": "hausa", "ha": "hausa", "igbo": "igbo", "ig": "igbo"}


def norm_lang(x):
    return LANG_ALIASES.get(str(x or "en").strip().lower())


class TemplateBook:
    def __init__(self, path=None):
        self.path = Path(path or os.getenv("VOICE_TEMPLATES") or HERE / "voice_templates.json")
        self.data = json.loads(self.path.read_text(encoding="utf-8"))

    @property
    def languages(self):
        return self.data["languages"]

    @property
    def intents(self):
        return self.data["intents"]

    def has(self, intent, variant, lang):
        return lang in self.intents.get(intent, {}).get(variant, {})

    def variants(self, intent):
        return list(self.intents[intent].keys())

    @staticmethod
    def parse_segment(s):
        if isinstance(s, str):
            return s, 100, None
        return s[0], (s[1] if len(s) > 1 else 100), (s[2] if len(s) > 2 else None)

    def segments(self, intent, variant, lang):
        return [self.parse_segment(s) for s in self.intents[intent][variant][lang]]


def _truthy(facts, key):
    v = facts.get(key)
    return v not in (None, "", 0, 0.0, False)


def _need(facts, *keys):
    """A missing amount is an ERROR. It must never be read as 'zero' ('you have not saved anything')."""
    gone = [k for k in keys if facts.get(k) is None]
    if gone:
        raise MissingFact(f"missing fact(s): {', '.join(gone)}")


def choose_variant(intent, facts):
    if intent == "balance":
        _need(facts, "total")
        if (facts.get("total") or 0) <= 0:
            return "empty"
        # PRD v3 6.5: no channel may ever say "available now" when it is not. So the caller must state the withdrawal
        # rule explicitly: either both day counts (0 when nothing blocks) or emergency_eligible. Silence is an error.
        vest, cool, flag = facts.get("vesting_days"), facts.get("cooldown_days"), facts.get("emergency_eligible")
        if flag is None and (vest is None or cool is None):
            raise MissingFact("balance needs the emergency-withdrawal rule: send vesting_days AND cooldown_days "
                              "(0 when nothing blocks), or emergency_eligible. We never guess 'available now'.")
        if (vest or 0) > 0:
            return "waiting"
        if (cool or 0) > 0:
            return "cooling"
        if flag is False:
            raise MissingFact("emergency_eligible is false: also send vesting_days or cooldown_days so we can say when")
        return "eligible"
    if intent == "sweep_receipt":
        _need(facts, "takings")
        if (facts.get("takings") or 0) <= 0:
            return "zero_sales"
        reason = str(facts.get("skip_reason") or "").upper()
        sweep = facts.get("sweep")
        if reason in ("LOW_BALANCE", "PAUSED") and (sweep is None or sweep <= 0):
            return reason.lower()
        _need(facts, "sweep")
        if (facts.get("sweep") or 0) <= 0:
            return "no_sweep"
        return "normal"
    if intent == "rate_suggestion":
        d = str(facts.get("direction", "")).upper()
        if d not in ("INCREASE", "DECREASE"):
            raise MissingFact("rate_suggestion needs facts.direction = INCREASE or DECREASE")
        return d.lower()
    return "default"


@dataclass
class Script:
    intent: str
    variant: str
    language_requested: str
    language: str
    tts_lang: str
    status: str
    text: str
    words: int
    est_seconds: float
    dropped: list = field(default_factory=list)
    fallback: dict = None
    over_budget: bool = False

    def to_dict(self):
        return {"intent": self.intent, "variant": self.variant, "language_requested": self.language_requested,
                "language_used": self.language, "tts_lang": self.tts_lang, "review_status": self.status,
                "text": self.text, "words": self.words, "est_seconds": round(self.est_seconds, 1),
                "dropped_optional_lines": self.dropped, "fallback": self.fallback, "over_budget": self.over_budget}


def resolve_language(book, intent, variant, requested, allow_draft):
    req = norm_lang(requested)
    chain = ([req] if req else []) + ["pidgin", "en"]
    for lang in chain:
        info = book.languages.get(lang)
        if not info or not book.has(intent, variant, lang):
            continue
        st = info.get("status", "draft")
        if st == "approved" or (st == "draft" and allow_draft):
            fb = None
            if lang != req:
                reason = ("unknown_language" if req is None else
                          "missing_template" if not book.has(intent, variant, req) else "not_approved_by_a_native_speaker")
                fb = {"requested": requested, "used": lang, "reason": reason}
            return lang, st, fb
    raise VoiceError(f"no usable template for {intent}/{variant}")


def compose_script(book, intent, language, facts, *, name=None, variant=None, max_seconds=24.0,
                   calib=None, allow_draft=ALLOW_DRAFT_DEFAULT):
    facts = normalize_facts(facts)
    if intent not in book.intents:
        raise VoiceError(f"unknown intent '{intent}'. Known: {', '.join(book.intents)}")
    variant = variant or choose_variant(intent, facts)
    if variant not in book.intents[intent]:
        raise VoiceError(f"unknown variant '{variant}' for {intent}. Known: {', '.join(book.variants(intent))}")
    lang, status, fb = resolve_language(book, intent, variant, language, allow_draft)
    tts_lang = book.languages[lang]["tts_lang"]
    calib = calib or Calibration()

    segs = [(t, w, wh) for (t, w, wh) in book.segments(intent, variant, lang)
            if wh is None or (wh.startswith("!") and not _truthy(facts, wh[1:])) or (not wh.startswith("!") and _truthy(facts, wh))]
    slots = spoken_slots(facts, name)
    fmt = string.Formatter()
    needed = {f for t, _, _ in segs for _, f, _, _ in fmt.parse(t) if f}
    missing = sorted(f for f in needed if f not in slots)
    if missing:
        raise MissingFact(f"missing fact(s) for {intent}/{variant}: {', '.join(missing)}")
    rendered = [(t.format_map(slots).strip(), w) for t, w, _ in segs]

    dropped = []
    keep = list(range(len(rendered)))

    def build(idx):
        return apply_lexicon(" ".join(rendered[i][0] for i in idx))

    text = build(keep)
    while calib.estimate(text, tts_lang) > max_seconds:
        optional = [i for i in keep if rendered[i][1] < 100]
        if not optional:
            break
        drop = min(optional, key=lambda i: (rendered[i][1], -i))
        keep.remove(drop)
        dropped.append(rendered[drop][0])
        text = build(keep)
    est = calib.estimate(text, tts_lang)
    return Script(intent, variant, language, lang, tts_lang, status, text, len(_words(text)), est,
                  dropped, fb, est > max_seconds)


# =============================================================================== quality gate
@dataclass
class QAReport:
    ok: bool
    seconds: float
    expected: float
    ratio: float
    rms: float
    silence_ratio: float
    sample_rate: int
    issues: list
    warnings: list
    verified: bool = True

    def to_dict(self):
        return {"ok": self.ok, "seconds": round(self.seconds, 2), "expected_seconds": round(self.expected, 2),
                "ratio": round(self.ratio, 2), "rms": round(self.rms, 4), "silence_ratio": round(self.silence_ratio, 2),
                "sample_rate": self.sample_rate, "issues": self.issues, "warnings": self.warnings,
                "verified": self.verified}


def analyse_wav(data, expected_s, calibrated=False):
    if len(data) < 44 or data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        return QAReport(False, 0.0, expected_s, 0.0, 0.0, 1.0, 0, ["not_a_wav_file"], [])
    try:
        with wave.open(io.BytesIO(data), "rb") as w:
            ch, sw, rate = w.getnchannels(), w.getsampwidth(), w.getframerate()
            frames = w.readframes(w.getnframes())
    except Exception as e:
        return QAReport(True, 0.0, expected_s, 0.0, 0.0, 0.0, 0, [], [f"could_not_parse_wav: {str(e)[:50]}"], False)
    if sw != 2 or ch < 1 or rate <= 0:
        return QAReport(True, 0.0, expected_s, 0.0, 0.0, 0.0, rate, [], ["unsupported_wav_layout"], False)
    x = np.frombuffer(frames[: len(frames) - (len(frames) % (2 * ch))], dtype="<i2").astype(np.float32) / 32768.0
    if ch > 1:
        x = x.reshape(-1, ch).mean(axis=1)
    seconds = len(x) / rate
    rms = float(np.sqrt(np.mean(x ** 2))) if len(x) else 0.0
    hop = max(int(rate * 0.02), 1)
    m = len(x) // hop
    silence = float(np.mean(np.sqrt(np.mean(x[: m * hop].reshape(m, hop) ** 2, axis=1)) < 0.01)) if m else 1.0
    clip = float(np.mean(np.abs(x) >= 0.999)) if len(x) else 0.0
    ratio = seconds / expected_s if expected_s > 0 else 1.0
    lo, hi = (0.65, 1.6) if calibrated else (0.45, 2.2)
    issues, warns = [], []
    if seconds < 0.4:
        issues.append("too_short")
    if rms < 0.003:
        issues.append("silent")
    elif silence > 0.85:
        issues.append("mostly_silence")
    if expected_s > 0 and ratio < lo:
        issues.append("shorter_than_the_text_needs")
    if expected_s > 0 and ratio > hi:
        issues.append("longer_than_the_text_needs")
    if clip > 0.02:
        warns.append("clipping")
    return QAReport(not issues, seconds, expected_s, ratio, rms, silence, rate, issues, warns)


# =============================================================================== providers
class TTSProvider:
    name = "base"
    on_wait = None          # optional callback(elapsed_seconds, state) so a UI can show "engine is waking up..."

    def speaker(self, speaker_id):
        return None

    def synthesize(self, text, tts_lang, speaker, *, temperature=None):
        raise NotImplementedError

    def speakers(self, tts_lang):
        return []

    def health(self):
        return {"ok": True}


class NullProvider(TTSProvider):
    """No key configured: only already-cached audio can be served."""
    name = "none"

    def synthesize(self, *a, **k):
        raise ProviderAuthError("No voice provider configured. Set NAIJALINGO_API_KEY (see .env.example).")

    def health(self):
        return {"ok": False, "detail": "no provider configured"}


class FakeProvider(TTSProvider):
    """Offline stand-in for tests: makes a tone whose length follows the text. NEVER use in front of an audience.
    mode: 'ok' | 'silent' | 'short' | 'long' | 'garbage' | 'error' | 'capacity' | a list consumed one per call."""
    name = "fake"

    def __init__(self, mode="ok", spw=0.42, sample_rate=22050, delay=0.0, voices=0):
        self.voices = voices
        self.mode = mode
        self.spw = spw
        self.sr = sample_rate
        self.delay = delay
        self.calls = []

    def speakers(self, tts_lang):
        return [{"id": f"fake-{tts_lang}-{i}", "name": f"Fake{i}", "language": tts_lang,
                 "gender": "female" if i % 2 == 0 else "male"} for i in range(self.voices)]

    def speaker(self, speaker_id):
        if self.voices and str(speaker_id).startswith("fake-"):
            return {"id": speaker_id}
        raise ProviderBadRequest(f"Speaker '{speaker_id}' not found", kind="speaker")

    def _next_mode(self):
        if isinstance(self.mode, list):
            return self.mode.pop(0) if len(self.mode) > 1 else self.mode[0]
        return self.mode

    def synthesize(self, text, tts_lang, speaker, *, temperature=None):
        self.calls.append({"text": text, "tts_lang": tts_lang, "speaker": speaker, "temperature": temperature})
        if self.delay:
            time.sleep(self.delay)
        mode = self._next_mode()
        if mode == "error":
            raise ProviderServerError("fake server error")
        if mode == "capacity":
            raise ProviderCapacity("fake: engine is starting")
        if mode == "badspeaker" and len(self.calls) == 1:
            raise ProviderBadRequest("speaker not found", kind="speaker")
        if mode == "garbage":
            return b"not audio at all" * 10
        secs = max(len(text.split()) * self.spw, 0.5)
        secs *= {"short": 0.1, "long": 4.0}.get(mode, 1.0)
        n = int(secs * self.sr)
        t = np.arange(n) / self.sr
        wave_ = 0.3 * np.sin(2 * math.pi * 220 * t) * (0.6 + 0.4 * np.sin(2 * math.pi * 3 * t))
        if mode == "silent":
            wave_ = wave_ * 0
        return _pcm16_wav(wave_, self.sr)


def _pcm16_wav(samples, rate):
    pcm = (np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes()
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)
    return buf.getvalue()


class NaijaLingoProvider(TTSProvider):
    """Thin client for https://api.9jalingo.org, written from the official SDK source (v2.2.0).
    Auth header X-API-Key. POST /v1/audio/speech {input, voice, lang, model, response_format}.
    If the engine is scaled to zero the server answers 202 + job_id; we poll /v1/jobs/{id} then GET .../audio.
    The server runs one inference at a time, so we also serialise calls with a lock."""
    name = "naijalingo"

    def __init__(self, api_key, base_url="https://api.9jalingo.org", model=MODEL, *, client=None,
                 sleep=time.sleep, clock=time.monotonic, max_wait=180.0, poll_cap=20.0, retries=2, timeout=120.0):
        self.api_key = api_key
        self.model = model
        self.sleep = sleep
        self.clock = clock
        self.max_wait = max_wait
        self.poll_cap = poll_cap
        self.retries = retries
        self._lock = threading.Lock()
        self._client = client or httpx.Client(base_url=base_url.rstrip("/"),
                                              timeout=httpx.Timeout(timeout, connect=10.0),
                                              headers={"User-Agent": "kobo-kobo-voice/1.0"})

    # ---- plumbing
    @staticmethod
    def _detail(r):
        try:
            d = r.json().get("detail", r.text)
        except Exception:
            d = r.text
        return str(d)[:200]

    def _map_error(self, r):
        c, d = r.status_code, self._detail(r)
        if c in (401, 403):
            return ProviderAuthError(f"9jaLingo rejected the API key ({c}): {d}")
        about_voice = any(w in d.lower() for w in ("speaker", "voice"))
        if c == 404:
            return ProviderBadRequest(f"not found: {d}", kind="speaker" if about_voice else "not_found")
        if c in (400, 413, 415, 422):
            return ProviderBadRequest(d, kind="speaker" if about_voice and any(w in d.lower() for w in ("not found", "unknown", "invalid", "does not exist", "no such")) else "bad_request")
        if c == 429:
            ra = r.headers.get("Retry-After")
            return ProviderRateLimited(d, float(ra) if ra and ra.replace(".", "", 1).isdigit() else None)
        if c == 503:
            return ProviderCapacity(d)
        if c >= 500:
            return ProviderServerError(f"{c}: {d}")
        return VoiceError(f"unexpected status {c}: {d}")

    def _request(self, method, path, **kw):
        headers = dict(kw.pop("headers", {}))
        headers["X-API-Key"] = self.api_key
        last = None
        for attempt in range(self.retries + 1):
            try:
                r = self._client.request(method, path, headers=headers, **kw)
            except (httpx.ConnectError, httpx.ConnectTimeout) as e:
                last = ProviderUnavailable(f"cannot reach 9jaLingo: {e}")
            except httpx.TimeoutException as e:
                raise ProviderCapacity(f"9jaLingo did not answer in time (the engine may be busy or waking): {e}")
            else:
                if r.is_success:
                    return r
                err = self._map_error(r)
                if not err.retryable or attempt >= self.retries:
                    raise err
                last = err
                if isinstance(err, ProviderRateLimited):
                    self.sleep(min(err.retry_after or 10.0, 60.0))
                    continue
            if attempt < self.retries:
                self.sleep(1.5 * (attempt + 1))
        raise last

    def _audio(self, r):
        if "json" in r.headers.get("content-type", "").lower():
            raise ProviderServerError(f"API returned JSON where audio was expected: {self._detail(r)}")
        if not r.content:
            raise ProviderServerError("API returned an empty audio response")
        if r.content[:4] != b"RIFF":
            raise ProviderServerError(f"API did not return WAV audio (starts with {r.content[:4]!r})")
        return r.content

    def _await_job(self, first):
        try:
            queued = first.json()
        except Exception:
            raise ProviderServerError("queued response was not JSON")
        job_id = str((queued or {}).get("job_id") or "").strip()
        if not job_id:
            raise ProviderServerError("queued response had no job_id")
        start = self.clock()
        deadline = start + self.max_wait
        status = queued
        while self.clock() < deadline:
            try:
                delay = float(status.get("retry_after", queued.get("retry_after", 5)))
            except (TypeError, ValueError):
                delay = 5.0
            self.sleep(max(2.0, min(delay, self.poll_cap)))
            status = self._request("GET", f"/v1/jobs/{job_id}").json()
            state = str(status.get("status") or "").lower()
            if self.on_wait:
                try:
                    self.on_wait(self.clock() - start, state)
                except Exception:
                    pass
            if state == "completed":
                return self._audio(self._request("GET", f"/v1/jobs/{job_id}/audio"))
            if state == "failed":
                raise ProviderServerError(str(status.get("error") or "queued job failed"))
            if state not in ("queued", "running", "processing"):
                raise ProviderServerError(f"unknown job status: {state or 'missing'}")
        raise ProviderCapacity(f"9jaLingo engine still starting after {self.max_wait:.0f}s (cold start). "
                               f"Run 'python voice_tool.py warm' a few minutes before you need audio.")

    # ---- API
    def synthesize(self, text, tts_lang, speaker, *, temperature=None):
        body = {"input": text, "voice": speaker, "lang": tts_lang, "model": self.model, "response_format": "wav"}
        if temperature is not None:
            body["temperature"] = temperature
        with self._lock:
            r = self._request("POST", "/v1/audio/speech", json=body,
                              headers={"Prefer": "respond-async-on-cold-start"})
            return self._await_job(r) if r.status_code == 202 else self._audio(r)

    def speaker(self, speaker_id):
        """Look one voice up (GET /v1/speakers/{id}). Raises ProviderBadRequest(kind='speaker') if the server does not know it."""
        return self._request("GET", f"/v1/speakers/{speaker_id}").json()

    def speakers(self, tts_lang):
        data = self._request("GET", "/v1/speakers", params={"language": tts_lang}).json()
        out = []
        for s in data.get("speakers", []):
            out.append({"id": s.get("id", s.get("speaker_id", "")), "name": s.get("name"),
                        "language": s.get("language"), "gender": s.get("gender")})
        return out

    def health(self):
        try:
            return {"ok": True, **self._request("GET", "/v1/health").json()}
        except VoiceError as e:
            return {"ok": False, "detail": str(e)}


# =============================================================================== cache, formats, signed URLs
class AudioCache:
    """Content-addressed WAV cache: key = hash(text, voice language, speaker). Writes are atomic."""

    def __init__(self, root):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def key(text, tts_lang, speaker, model=MODEL):
        raw = json.dumps([model, tts_lang, speaker, text], ensure_ascii=False)
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:20]

    def path(self, key, ext="wav"):
        return self.root / f"{key}.{ext}"

    def has(self, key):
        """True only for a plausible WAV. A truncated or corrupted file is treated as a miss and re-rendered."""
        p = self.path(key)
        try:
            if p.stat().st_size < 1000:
                return False
            with open(p, "rb") as f:
                head = f.read(12)
            return head[:4] == b"RIFF" and head[8:12] == b"WAVE"
        except OSError:
            return False

    def read(self, key, ext="wav"):
        p = self.path(key, ext)
        return p.read_bytes() if p.exists() else None

    def meta(self, key):
        p = self.path(key, "json")
        try:
            return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None
        except Exception:
            return None

    def put(self, key, wav, meta):
        _atomic_write(self.path(key), wav)
        _atomic_write(self.path(key, "json"), json.dumps(meta, ensure_ascii=False, indent=1).encode("utf-8"))

    def stats(self):
        files = list(self.root.glob("*.wav"))
        return {"clips": len(files), "megabytes": round(sum(f.stat().st_size for f in files) / 1e6, 2)}


FORMATS = {"wav": "audio/wav", "mp3": "audio/mpeg", "ogg": "audio/ogg", "wav8k": "audio/wav"}
_FF_ARGS = {
    "mp3": ["-ac", "1", "-ar", "22050", "-c:a", "libmp3lame", "-b:a", "48k"],          # Africa's Talking <Play>
    "ogg": ["-ac", "1", "-ar", "24000", "-c:a", "libopus", "-b:a", "24k", "-application", "voip"],  # WhatsApp voice note
    "wav8k": ["-ac", "1", "-ar", "8000", "-c:a", "pcm_s16le"],                         # telephone-grade fallback
}


def find_ffmpeg():
    env = os.getenv("FFMPEG_BIN")
    if env and Path(env).exists():
        return env
    found = shutil.which("ffmpeg")
    if found:
        return found
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


def transcode(wav, fmt):
    if fmt == "wav":
        return wav
    if fmt not in _FF_ARGS:
        raise VoiceError(f"unknown format '{fmt}'. Use: {', '.join(FORMATS)}")
    ff = find_ffmpeg()
    if not ff:
        raise TranscodeUnavailable("ffmpeg not found. Run: pip install imageio-ffmpeg (bundles ffmpeg, no install needed)")
    ext = "ogg" if fmt == "ogg" else ("mp3" if fmt == "mp3" else "wav")
    with tempfile.TemporaryDirectory() as td:
        src, dst = Path(td) / "in.wav", Path(td) / f"out.{ext}"
        src.write_bytes(wav)
        p = subprocess.run([ff, "-y", "-loglevel", "error", "-i", str(src), *_FF_ARGS[fmt], str(dst)],
                           capture_output=True, timeout=90)
        if p.returncode != 0 or not dst.exists():
            raise VoiceError(f"ffmpeg failed: {p.stderr.decode('utf-8', 'ignore')[-200:]}")
        return dst.read_bytes()


class UrlSigner:
    """Signed, expiring audio URLs (audio can contain balances). With no secret URLs are unsigned: demo only."""

    def __init__(self, secret="", base_url=""):
        self.secret = secret or ""
        self.base = (base_url or "").rstrip("/")

    @property
    def signed(self):
        return bool(self.secret)

    def _mac(self, text):
        return hmac.new(self.secret.encode(), text.encode(), hashlib.sha256).hexdigest()[:32]

    def sign(self, audio_id, fmt, exp):
        return self._mac(f"{audio_id}.{fmt}.{exp}")

    def url(self, audio_id, fmt, ttl=3600, now=None):
        path = f"{self.base}/api/v1/ai/voice/audio/{audio_id}.{fmt}"
        if not self.signed:
            return path
        exp = int((now or time.time()) + ttl)
        return f"{path}?exp={exp}&sig={self.sign(audio_id, fmt, exp)}"

    def verify(self, audio_id, fmt, exp, sig, now=None):
        if not self.signed:
            return True
        try:
            if int(exp) < (now or time.time()):
                return False
        except (TypeError, ValueError):
            return False
        return hmac.compare_digest(self.sign(audio_id, fmt, exp), str(sig or ""))

    def token(self, *parts):
        return self._mac("|".join(str(p) for p in parts)) if self.signed else ""

    def check_token(self, token, *parts):
        return (not self.signed) or hmac.compare_digest(self.token(*parts), str(token or ""))


# =============================================================================== the studio
@dataclass
class RenderResult:
    audio_id: str
    from_cache: bool
    seconds: float
    speaker: str
    tts_lang: str
    qa: dict
    attempts: list
    provider: str

    def to_dict(self):
        return self.__dict__.copy()


def load_preferred(path=None):
    """Preferred voice id per voice language: voice_speakers.json, overridden by VOICE_SPEAKER_PCM/_YO/_HA/_IG."""
    p = Path(path or os.getenv("VOICE_SPEAKERS_FILE") or HERE / "voice_speakers.json")
    out = {}
    try:
        if p.exists():
            out = {k: str(x).strip() for k, x in json.loads(p.read_text(encoding="utf-8")).get("preferred", {}).items() if str(x).strip()}
    except Exception:
        out = {}
    for lang in ("pcm", "yo", "ha", "ig"):
        env = os.getenv(f"VOICE_SPEAKER_{lang.upper()}", "").strip()
        if env:
            out[lang] = env
    return out


class VoiceStudio:
    DEFAULT_SPEAKERS = {   # from the 9jaLingo docs/SDK examples. Verified at runtime by `voice_tool.py check`.
        "pcm": {"female": ["ada_pcm", "blessing_pcm"], "male": ["daniel_pcm", "blessing_pcm"]},
        "yo": {"female": ["adeola_yo"], "male": ["adekunle_yo"]},
        "ha": {"female": ["aisha_ha"], "male": ["bello_ha"]},
        "ig": {"female": ["adaeze_ig"], "male": ["ifeanyi_ig"]},
    }

    def __init__(self, provider, cache_dir=None, templates=None, allow_draft=ALLOW_DRAFT_DEFAULT, signer=None, preferred=None):
        self.provider = provider
        self.preferred = load_preferred() if preferred is None else dict(preferred)
        root = Path(cache_dir or os.getenv("VOICE_CACHE_DIR") or HERE / "voice_cache")
        self.cache = AudioCache(root)
        self.book = templates or TemplateBook()
        self.calib = Calibration(root / "calibration.json")
        self.allow_draft = allow_draft
        self.signer = signer or UrlSigner()
        self._latest_path = root / "latest.json"
        self._latest_lock = threading.Lock()
        self._dir_path = root / "merchant_directory.json"      # phone numbers: keep this folder out of git
        self._dir_lock = threading.Lock()
        self._speaker_cache = {}

    # ---- scripts
    def script(self, intent, language, facts, *, name=None, variant=None, max_seconds=24.0):
        # Trimming uses a FIXED estimate on purpose: the same facts must always give the same text (and cache key).
        # The learned calibration (self.calib) is used only to judge the audio that comes back (render()).
        return compose_script(self.book, intent, language, facts, name=name, variant=variant,
                              max_seconds=max_seconds, calib=None, allow_draft=self.allow_draft)

    # ---- speakers
    def speaker_candidates(self, tts_lang, gender="female"):
        """Order tried: your preferred voice, then the built-in defaults, then any other voice the platform lists."""
        gender = gender if gender in ("female", "male") else "female"
        out = []
        pref = self.preferred.get(tts_lang)
        if pref:
            out.append(pref)
        for s in self.DEFAULT_SPEAKERS.get(tts_lang, {}).get(gender, []):
            if s not in out:
                out.append(s)
        for s in self._speaker_cache.get(tts_lang, []):
            if s.get("gender") == gender and s["id"] not in out:
                out.append(s["id"])
        return out or ["blessing_pcm"]

    def discover_speakers(self, tts_lang):
        try:
            self._speaker_cache[tts_lang] = self.provider.speakers(tts_lang)
        except VoiceError:
            self._speaker_cache.setdefault(tts_lang, [])
        return self._speaker_cache[tts_lang]

    def plan(self, script, gender="female", speaker=None):
        cands = [speaker] if speaker else self.speaker_candidates(script.tts_lang, gender)
        return self.cache.key(script.text, script.tts_lang, cands[0]), cands

    # ---- render (synchronous; the JobManager calls this from a worker)
    def render(self, script, *, gender="female", speaker=None, force=False):
        key, cands = self.plan(script, gender, speaker)
        if not force and self.cache.has(key):
            m = self.cache.meta(key) or {}
            return RenderResult(key, True, m.get("seconds", 0.0), m.get("speaker_used", cands[0]), script.tts_lang,
                                m.get("qa", {}), [], m.get("provider", "cache"))
        expected = self.calib.estimate(script.text, script.tts_lang)
        calibrated = self.calib.calibrated(script.tts_lang)
        plan = [(cands[0], None), (cands[0], 0.7)] + ([(cands[1], 0.7)] if len(cands) > 1 else [])
        attempts, skip = [], set()
        for spk, temp in plan:
            if spk in skip:
                continue
            try:
                wav = self.provider.synthesize(script.text, script.tts_lang, spk, temperature=temp)
            except ProviderBadRequest as e:
                attempts.append({"speaker": spk, "temperature": temp, "error": str(e)})
                if e.kind == "speaker":
                    skip.add(spk)
                    continue
                raise
            qa = analyse_wav(wav, expected, calibrated)
            attempts.append({"speaker": spk, "temperature": temp, "qa_ok": qa.ok, "issues": qa.issues})
            if qa.ok:
                meta = {"text": script.text, "intent": script.intent, "variant": script.variant,
                        "language": script.language, "review_status": script.status, "tts_lang": script.tts_lang,
                        "speaker_requested": cands[0], "speaker_used": spk, "seconds": round(qa.seconds, 2),
                        "words": script.words, "qa": qa.to_dict(), "attempts": attempts,
                        "provider": self.provider.name, "model": MODEL,
                        "created_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
                self.cache.put(key, wav, meta)
                if qa.verified:
                    self.calib.update(script.tts_lang, script.words, qa.seconds)
                return RenderResult(key, False, qa.seconds, spk, script.tts_lang, qa.to_dict(), attempts,
                                    self.provider.name)
        raise VoiceQualityError("no acceptable audio after %d attempt(s): %s" % (len(attempts), attempts))

    # ---- formats
    def get_audio(self, key, fmt="mp3"):
        wav = self.cache.read(key)
        if wav is None:
            return None
        if fmt == "wav":
            return wav, FORMATS["wav"]
        cached = self.cache.read(key, fmt)
        if cached is None:
            cached = transcode(wav, fmt)
            _atomic_write(self.cache.path(key, fmt), cached)
        return cached, FORMATS[fmt]

    # ---- who is who: core pushes phone + language with the nightly facts, the IVR needs them to recognise a call
    def directory(self):
        try:
            return json.loads(self._dir_path.read_text(encoding="utf-8")) if self._dir_path.exists() else {}
        except Exception:
            return {}

    def register_merchant(self, merchant_id, phone_number=None, language=None, name=None):
        with self._dir_lock:
            data = self.directory()
            e = data.setdefault(merchant_id, {})
            if phone_number:
                e["phone_number"] = str(phone_number)
            if language:
                e["preferred_language"] = language
            if name:
                e["name"] = clean_name(name)
            _atomic_write(self._dir_path, json.dumps(data, indent=1, ensure_ascii=False).encode("utf-8"))

    def preformat(self, key, formats=("mp3", "ogg")):
        """Convert ahead of time (best effort) so Africa's Talking / WhatsApp never wait for ffmpeg."""
        for f in formats:
            try:
                self.get_audio(key, f)
            except Exception:
                pass

    # ---- "latest audio for this merchant" index, used by the IVR (it cannot synthesise during a call)
    def register(self, merchant_id, intent, audio_id, language):
        with self._latest_lock:
            data = self.latest_all()
            data.setdefault(merchant_id, {})[intent] = {
                "audio_id": audio_id, "language": language,
                "created_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
            _atomic_write(self._latest_path, json.dumps(data, indent=1).encode("utf-8"))

    def latest_all(self):
        try:
            return json.loads(self._latest_path.read_text(encoding="utf-8")) if self._latest_path.exists() else {}
        except Exception:
            return {}

    def latest(self, merchant_id, intent, max_age_hours=36):
        e = self.latest_all().get(merchant_id, {}).get(intent)
        if not e or not self.cache.has(e["audio_id"]):
            return None
        age = (datetime.now(timezone.utc) - datetime.strptime(e["created_at"], "%Y-%m-%dT%H:%M:%SZ")
               .replace(tzinfo=timezone.utc)).total_seconds() / 3600
        return e if age <= max_age_hours else None

    def status(self):
        return {"provider": self.provider.name, "cache": self.cache.stats(), "ffmpeg": bool(find_ffmpeg()),
                "urls_signed": self.signer.signed, "allow_draft_languages": self.allow_draft,
                "preferred_voices": self.preferred,
                "calibration": {k: {"seconds_per_word": v["spw"], "samples": v["n"]} for k, v in self.calib.data.items()},
                "languages": {k: v["status"] for k, v in self.book.languages.items()}}


# =============================================================================== background jobs
class JobManager:
    """One worker thread = one request at a time, matching how the 9jaLingo server behaves.
    Retryable provider errors (engine waking up, 5xx, network) are retried with a delay; bad audio never is cached."""

    def __init__(self, studio, retry_delays=(30, 120), sleep=time.sleep):
        self.studio = studio
        self.retry_delays = retry_delays
        self.sleep = sleep
        self.q = queue.Queue()
        self.jobs = {}
        self._lock = threading.RLock()          # re-entrant: status() is called while the lock is held
        self._worker = None

    def _ensure_worker(self):
        with self._lock:
            if self._worker is None or not self._worker.is_alive():
                self._worker = threading.Thread(target=self._run, name="voice-worker", daemon=True)
                self._worker.start()

    def submit(self, script, *, gender="female", speaker=None, register=None):
        key, _ = self.studio.plan(script, gender, speaker)
        if self.studio.cache.has(key):
            if register:
                self.studio.register(register[0], register[1], key, script.language)
            with self._lock:
                self.jobs[key] = {"audio_id": key, "status": "READY", "from_cache": True, "error": None}
            return self.status(key)
        with self._lock:
            j = self.jobs.get(key)
            if j and j["status"] in ("PENDING", "RUNNING"):
                return self.status(key)
            self.jobs[key] = {"audio_id": key, "status": "PENDING", "error": None, "from_cache": False,
                              "event": threading.Event(), "queued_at": time.time()}
        self.q.put((key, script, gender, speaker, register))
        self._ensure_worker()
        return self.status(key)

    def status(self, key):
        with self._lock:
            j = self.jobs.get(key)
        if j is None:
            return {"audio_id": key, "status": "READY" if self.studio.cache.has(key) else "UNKNOWN", "error": None}
        return {k: v for k, v in j.items() if k != "event"}

    def wait(self, key, timeout):
        with self._lock:
            j = self.jobs.get(key)
        if j and j.get("event") is not None and j["status"] in ("PENDING", "RUNNING"):
            j["event"].wait(timeout)
        return self.status(key)

    def pending(self):
        with self._lock:
            return sum(1 for j in self.jobs.values() if j["status"] in ("PENDING", "RUNNING"))

    def _run(self):
        while True:
            key, script, gender, speaker, register = self.q.get()
            with self._lock:
                self.jobs[key]["status"] = "RUNNING"
            err, kind = None, None
            for attempt in range(len(self.retry_delays) + 1):
                try:
                    self.studio.render(script, gender=gender, speaker=speaker)
                    err = None
                    break
                except VoiceError as e:
                    err, kind = str(e), type(e).__name__
                    if not e.retryable or attempt >= len(self.retry_delays):
                        break
                    self.sleep(self.retry_delays[attempt])
                except Exception as e:                     # never let the worker die
                    err, kind = f"unexpected: {e}", type(e).__name__
                    break
            with self._lock:
                j = self.jobs[key]
                if err is None:
                    self.studio.preformat(key)
                    j.update(status="READY", error=None)
                    if register:
                        self.studio.register(register[0], register[1], key, script.language)
                else:
                    j.update(status="FAILED", error=err, error_kind=kind)
                j["event"].set()


# =============================================================================== wiring from environment
def build_studio_from_env():
    prov = os.getenv("VOICE_PROVIDER", "").strip().lower()
    key = os.getenv("NAIJALINGO_API_KEY", "").strip()
    if prov == "fake":
        provider = FakeProvider()
    elif prov in ("", "naijalingo") and key:
        provider = NaijaLingoProvider(key, base_url=os.getenv("NAIJALINGO_BASE_URL", "https://api.9jalingo.org"))
    else:
        provider = NullProvider()
    return VoiceStudio(provider, signer=UrlSigner(os.getenv("VOICE_URL_SECRET", ""), os.getenv("PUBLIC_BASE_URL", "")))
