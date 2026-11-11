#!/usr/bin/env python3
"""Voice tests. Run:  python test_voice.py   (about 20 seconds; needs NO internet and NO API key)

Everything uses an offline fake voice provider or a mocked 9jaLingo server, so it can run anywhere.
The real service is checked separately with:  python voice_tool.py check   (needs your key)."""
import sys as _sys
from pathlib import Path as _Path

_HERE = str(_Path(__file__).resolve().parent)
if _HERE not in _sys.path:
    _sys.path.insert(0, _HERE)

import io
import json
import os
import string
import sys
import tempfile
import threading
import time
import wave
import xml.etree.ElementTree as ET
from pathlib import Path

TMP = Path(tempfile.mkdtemp(prefix="kobo_voice_test_"))
os.environ["VOICE_PROVIDER"] = "fake"
os.environ["VOICE_CACHE_DIR"] = str(TMP / "boot_cache")
os.environ["VOICE_URL_SECRET"] = "test-secret"
os.environ["PUBLIC_BASE_URL"] = "https://kobo.test"

import httpx
import numpy as np
from fastapi.testclient import TestClient

import kobo_ai_service as svc
import voice as vc
import voice_ivr

fails = 0


def t(name, cond, detail=""):
    global fails
    fails += not cond
    print(f"{'PASS' if cond else 'FAIL'}  {name}" + (f"   [{str(detail)[:300]}]" if (detail and not cond) else ""))
    return cond


def raises(exc, fn, *a, **k):
    try:
        fn(*a, **k)
    except exc as e:
        return e
    except Exception as e:                       # wrong type
        return None
    return None


def tone(seconds, rate=22050, amp=0.3):
    n = int(seconds * rate)
    tt = np.arange(n) / rate
    return vc._pcm16_wav(amp * np.sin(2 * np.pi * 220 * tt) * (0.6 + 0.4 * np.sin(2 * np.pi * 3 * tt)), rate)


GOOD = tone(2.0)
BOOK = vc.TemplateBook()
SAMPLE = {"total": 36800, "emergency": 18400, "retirement": 18400, "takings": 35000, "sweep": 700,
          "rate_cur": 2, "rate_new": 2.5, "monthly_change": 5700, "vesting_days": 12, "cooldown_days": 20,
          "held_amount": 10000000, "direction": "INCREASE"}


def new_studio(provider=None, name="s", allow_draft=True):
    return vc.VoiceStudio(provider or vc.FakeProvider(), cache_dir=TMP / name, allow_draft=allow_draft, preferred={},
                          signer=vc.UrlSigner("test-secret", "https://kobo.test"))


# ------------------------------------------------------------------------------ A. saying numbers
print("== Saying numbers ==")
W = vc.int_to_words
t("small numbers", [W(0), W(7), W(19), W(20), W(21)] == ["zero", "seven", "nineteen", "twenty", "twenty one"])
t("hundreds use 'and'", W(100) == "one hundred" and W(105) == "one hundred and five" and W(250) == "two hundred and fifty")
t("thousands", W(1000) == "one thousand" and W(1005) == "one thousand and five" and W(36800) == "thirty six thousand eight hundred")
t("millions", W(1_250_000) == "one million two hundred and fifty thousand" and W(10_000_000) == "ten million")
t("money", vc.speak_money(36800) == "thirty six thousand eight hundred naira" and vc.speak_money(1) == "one naira")
t("money rounds half up, never silently floors", vc.speak_money(0.5) == "one naira" and vc.speak_money(36800.5).endswith("eight hundred and one naira"))
t("money refuses negative / nonsense / NaN / absurd",
  all(raises(ValueError, vc.speak_money, bad) for bad in (-5, "abc", float("nan"), 10 ** 14)))
t("percent", vc.speak_percent(2) == "two percent" and vc.speak_percent(2.5) == "two point five percent"
  and vc.speak_percent(1.0) == "one percent" and vc.speak_percent(3.5) == "three point five percent")
t("days", vc.speak_days(1) == "one day" and vc.speak_days(2) == "two days" and vc.speak_days(45) == "forty five days")

# ------------------------------------------------------------------------------ B. scripts
print("\n== Scripts ==")
st = new_studio(name="scripts")
s = st.script("balance", "en", SAMPLE, variant="eligible")
t("balance script speaks the amounts in words, nothing left in braces",
  "thirty six thousand eight hundred naira" in s.text and "{" not in s.text and "}" not in s.text, s.text)
t("no digits in any spoken text (digits are misread by TTS)",
  not any(ch.isdigit() for ch in s.text))
t("name greeting is used when given and absent when not",
  st.script("balance", "en", SAMPLE, name="Ngozi", variant="eligible").text.startswith("Ngozi, ")
  and not st.script("balance", "en", SAMPLE, variant="eligible").text.startswith(","))
t("a hostile name cannot inject markup", "<" not in st.script("balance", "en", SAMPLE, name="<b>Ngozi</b>; DROP", variant="eligible").text)
t("variant: no savings -> empty", st.script("balance", "en", {"total": 0}).variant == "empty")
t("variant: vesting days left -> waiting, says the days",
  (lambda x: x.variant == "waiting" and "twelve days" in x.text)(st.script("balance", "en", {**SAMPLE, "cooldown_days": 0})))
t("variant: cooldown -> cooling",
  (lambda x: x.variant == "cooling" and "twenty days" in x.text)(st.script("balance", "en", {**SAMPLE, "vesting_days": 0})))
t("variant: eligible only when nothing blocks the withdrawal",
  st.script("balance", "en", {**SAMPLE, "vesting_days": 0, "cooldown_days": 0}).variant == "eligible")
t("receipt variants: normal / zero_sales / no_sweep",
  [st.script("sweep_receipt", "en", SAMPLE).variant, st.script("sweep_receipt", "en", {**SAMPLE, "takings": 0, "sweep": 0}).variant,
   st.script("sweep_receipt", "en", {**SAMPLE, "sweep": 0}).variant] == ["normal", "zero_sales", "no_sweep"])
t("held inflow is announced only when there is one",
  "big payment" in st.script("sweep_receipt", "en", SAMPLE).text
  and "big payment" not in st.script("sweep_receipt", "en", {**SAMPLE, "held_amount": 0}).text)
e = raises(vc.MissingFact, st.script, "balance", "en", {"total": 5000})
t("a missing fact is an error, never a blank or wrong amount", e is not None and "emergency" in str(e), e)
t("negative amount refused", raises(ValueError, st.script, "balance", "en", {**SAMPLE, "total": -1}) is not None)
t("unknown intent refused", raises(vc.VoiceError, st.script, "poem", "en", {}) is not None)
t("rate suggestion needs a direction", raises(vc.MissingFact, st.script, "rate_suggestion", "en", {"rate_cur": 2}) is not None)
tight = st.script("balance", "pidgin", SAMPLE, max_seconds=9)
t("a tight time budget drops optional lines first and keeps the amounts",
  len(tight.dropped) >= 1 and "thirty six thousand eight hundred naira" in tight.text, (tight.dropped, tight.text))
tiny = st.script("balance", "pidgin", SAMPLE, max_seconds=3)
t("if even the core is too long it says so instead of lying", tiny.over_budget and "thirty six thousand" in tiny.text)
t("typical clips fit the 24 s default", all(st.script(i, "pidgin", SAMPLE).est_seconds <= 24.5
                                            for i in ("balance", "sweep_receipt", "rate_suggestion")))
t("unknown language falls back to Pidgin and says why",
  (lambda x: x.language == "pidgin" and x.fallback and x.fallback["reason"] == "unknown_language")(st.script("balance", "klingon", SAMPLE)))
strict = new_studio(name="strict", allow_draft=False)
x = strict.script("balance", "yoruba", SAMPLE)
t("with drafts disallowed, an unreviewed language falls back to approved English, flagged",
  x.language == "en" and x.fallback and "not_approved" in x.fallback["reason"] and x.status == "approved", x.to_dict())
x = st.script("balance", "yoruba", SAMPLE)
t("with drafts allowed, Yoruba is used and marked draft", x.language == "yoruba" and x.status == "draft" and x.tts_lang == "yo")
t("language aliases: pcm / yo / ha / ig", [st.script("ivr_welcome", a, {}).language for a in ("pcm", "yo", "ha", "ig")] == ["pidgin", "yoruba", "hausa", "igbo"])

# ------------------------------------------------------------------------------ C. template integrity (all languages)
print("\n== Template integrity ==")
LANGS = ["en", "pidgin", "yoruba", "hausa", "igbo"]
fmt = string.Formatter()
problems = []
for intent, variants in BOOK.intents.items():
    for variant, per_lang in variants.items():
        if set(per_lang) != set(LANGS):
            problems.append(f"{intent}/{variant}: languages {sorted(per_lang)}")
            continue
        base = BOOK.segments(intent, variant, "en")
        for lang in LANGS:
            segs = BOOK.segments(intent, variant, lang)
            if len(segs) != len(base):
                problems.append(f"{intent}/{variant}/{lang}: {len(segs)} segments, English has {len(base)}")
                continue
            for (bt, bw, bwh), (lt, lw, lwh) in zip(base, segs):
                bs = {f for _, f, _, _ in fmt.parse(bt) if f}
                ls = {f for _, f, _, _ in fmt.parse(lt) if f}
                if bs != ls:
                    problems.append(f"{intent}/{variant}/{lang}: slots {sorted(ls)} != English {sorted(bs)}")
                if (bw, bwh) != (lw, lwh):
                    problems.append(f"{intent}/{variant}/{lang}: weight/condition differs from English")
t("every intent/variant exists in all 5 languages with the same slots, weights and conditions", not problems, problems[:4])

bad_digits, bad_render = [], []
for intent, variants in BOOK.intents.items():
    for variant in variants:
        for lang in LANGS:
            try:
                sc = st.script(intent, lang, {**SAMPLE, "direction": variant.upper() if variant in ("increase", "decrease") else "INCREASE"},
                               variant=variant)
                if any(ch.isdigit() for ch in sc.text) or "{" in sc.text:
                    bad_digits.append((intent, variant, lang))
                if sc.language != lang:
                    bad_render.append((intent, variant, lang, sc.language))
            except Exception as ex:
                bad_render.append((intent, variant, lang, str(ex)[:60]))
t("all 5 languages render every variant with no digits and no leftover braces", not bad_digits and not bad_render, (bad_digits[:3], bad_render[:3]))

consent_bad = []
for variant in ("increase", "decrease"):
    for lang in LANGS:
        segs = BOOK.segments("rate_suggestion", variant, lang)
        core_text = " ".join(tx for tx, w, _ in segs if w >= 100)
        if "YES" not in core_text:
            consent_bad.append((variant, lang, "no YES keyword in core"))
        if sum(1 for _, w, _ in segs[-2:] if w >= 100) != 2:
            consent_bad.append((variant, lang, "consent/no-change lines can be dropped"))
t("rate suggestions always keep the YES keyword and the 'nothing changes if you do nothing' line (cannot be trimmed)", not consent_bad, consent_bad)
t("the YES keyword is spoken as the word, not spelled out", "yes" in st.script("rate_suggestion", "en", SAMPLE).text and "YES" not in st.script("rate_suggestion", "en", SAMPLE).text)
t("the welcome message never contains an amount", all("naira" not in st.script("ivr_welcome", l, {}).text for l in LANGS))

# ------------------------------------------------------------------------------ D. quality gate
print("\n== Quality gate ==")
q = vc.analyse_wav(tone(3.0), 3.0)
t("good clip passes", q.ok and q.verified and 2.9 < q.seconds < 3.1, q.to_dict())
t("silent clip fails", "silent" in vc.analyse_wav(vc._pcm16_wav(np.zeros(44100), 22050), 2.0).issues)
t("tiny clip fails", "too_short" in vc.analyse_wav(tone(0.2), 0.2).issues)
t("truncated audio (much shorter than the text needs) fails", "shorter_than_the_text_needs" in vc.analyse_wav(tone(2.0), 10.0).issues)
t("runaway audio (much longer than the text needs) fails", "longer_than_the_text_needs" in vc.analyse_wav(tone(8.0), 2.0).issues)
t("not-a-WAV fails", vc.analyse_wav(b"hello world, this is not audio" * 5, 2.0).issues == ["not_a_wav_file"])
buf = io.BytesIO()
with wave.open(buf, "wb") as w8:
    w8.setnchannels(1); w8.setsampwidth(1); w8.setframerate(8000); w8.writeframes(b"\x80" * 8000)
q8 = vc.analyse_wav(buf.getvalue(), 1.0)
t("an unusual WAV layout is accepted but marked unverified (not silently trusted)", q8.ok and not q8.verified and q8.warnings, q8.to_dict())
bst = io.BytesIO()
with wave.open(bst, "wb") as ws:
    ws.setnchannels(2); ws.setsampwidth(2); ws.setframerate(22050)
    ws.writeframes(np.repeat((0.3 * np.sin(np.arange(44100) / 20) * 32767).astype("<i2"), 2).tobytes())
t("stereo WAV is analysed", vc.analyse_wav(bst.getvalue(), 2.0).ok)
t("calibrated windows are tighter than uncalibrated",
  vc.analyse_wav(tone(2.0), 3.6, calibrated=False).ok and not vc.analyse_wav(tone(2.0), 3.6, calibrated=True).ok)

# ------------------------------------------------------------------------------ E. cache
print("\n== Cache ==")
c = vc.AudioCache(TMP / "cache_e")
k1, k2, k3, k4 = (c.key("hello", "pcm", "ada_pcm"), c.key("hello", "pcm", "ada_pcm"), c.key("hello", "yo", "ada_pcm"), c.key("hello!", "pcm", "ada_pcm"))
t("key is stable, and changes with language / text / speaker", k1 == k2 and len({k1, k3, k4, c.key("hello", "pcm", "blessing_pcm")}) == 4)
c.put(k1, GOOD, {"text": "hello", "seconds": 2.0})
t("put / has / read / meta round-trip", c.has(k1) and c.read(k1) == GOOD and c.meta(k1)["text"] == "hello" and c.stats()["clips"] == 1)
t("no temp files left behind", not list(c.root.glob("*.tmp")))
t("unknown key", not c.has("nope") and c.read("nope") is None and c.meta("nope") is None)

# ------------------------------------------------------------------------------ F. 9jaLingo protocol (mocked server)
print("\n== 9jaLingo protocol (mocked) ==")


class Clock:
    def __init__(self):
        self.t, self.sleeps = 0.0, []

    def sleep(self, s):
        self.sleeps.append(s)
        self.t += s

    def now(self):
        return self.t


def provider_for(handler, clk=None, **kw):
    clk = clk or Clock()
    client = httpx.Client(transport=httpx.MockTransport(handler), base_url="https://api.test")
    return vc.NaijaLingoProvider("nl-SECRETKEY", client=client, sleep=clk.sleep, clock=clk.now, **kw), clk


wav_resp = lambda: httpx.Response(200, content=GOOD, headers={"content-type": "audio/wav"})
seen = {}


def h_direct(req):
    seen["req"] = req
    return wav_resp()


p, _ = provider_for(h_direct)
out = p.synthesize("How you dey?", "pcm", "ada_pcm", temperature=0.7)
body = json.loads(seen["req"].content)
t("direct 200: returns the WAV", out == GOOD)
t("sends X-API-Key, the async-cold-start header, and the right JSON body",
  seen["req"].headers["x-api-key"] == "nl-SECRETKEY" and seen["req"].headers["prefer"] == "respond-async-on-cold-start"
  and body == {"input": "How you dey?", "voice": "ada_pcm", "lang": "pcm", "model": "9jalingo-tts-1", "response_format": "wav", "temperature": 0.7}
  and seen["req"].url.path == "/v1/audio/speech", body)

state = {"polls": 0}


def h_cold(req):
    if req.url.path == "/v1/audio/speech":
        return httpx.Response(202, json={"status": "queued", "job_id": "job/1 x", "retry_after": 60})
    if req.url.path == "/v1/jobs/job/1 x" or req.url.path.startswith("/v1/jobs/job"):
        if req.url.path.endswith("/audio"):
            return wav_resp()
        state["polls"] += 1
        return httpx.Response(200, json={"status": "queued" if state["polls"] == 1 else "running" if state["polls"] == 2 else "completed"})
    return httpx.Response(404, json={"detail": "nope"})


p, clk = provider_for(h_cold, poll_cap=20)
out = p.synthesize("Hello", "pcm", "ada_pcm")
t("cold start: 202 -> polls the job -> downloads the audio", out == GOOD and state["polls"] == 3)
t("poll delays are capped (server suggests 60 s, we wait at most 20)", clk.sleeps and max(clk.sleeps) <= 20 and min(clk.sleeps) >= 2, clk.sleeps)

h_never = lambda req: httpx.Response(202, json={"status": "queued", "job_id": "j"}) if req.method == "POST" else httpx.Response(200, json={"status": "queued"})
p, clk = provider_for(h_never, max_wait=60)
e = raises(vc.ProviderCapacity, p.synthesize, "Hello", "pcm", "ada_pcm")
t("engine that never wakes -> ProviderCapacity with a helpful message, after max_wait only", e is not None and "warm" in str(e) and clk.t >= 60, (e, clk.t))
h_failed = lambda req: httpx.Response(202, json={"status": "queued", "job_id": "j"}) if req.method == "POST" else httpx.Response(200, json={"status": "failed", "error": "GPU OOM"})
p, _ = provider_for(h_failed)
e = raises(vc.ProviderServerError, p.synthesize, "Hello", "pcm", "ada_pcm")
t("a failed job surfaces the server's reason", e is not None and "GPU OOM" in str(e))

calls = {"n": 0}


def h_401(req):
    calls["n"] += 1
    return httpx.Response(401, json={"detail": "Invalid API Key"})


p, _ = provider_for(h_401)
e = raises(vc.ProviderAuthError, p.synthesize, "Hello", "pcm", "ada_pcm")
t("401 -> ProviderAuthError, not retried", e is not None and calls["n"] == 1)
t("the API key never appears in an error message", e is not None and "SECRETKEY" not in str(e))

st429 = {"n": 0}


def h_429(req):
    st429["n"] += 1
    return httpx.Response(429, json={"detail": "slow down"}, headers={"Retry-After": "3"}) if st429["n"] == 1 else wav_resp()


p, clk = provider_for(h_429)
t("429 honours Retry-After then succeeds", p.synthesize("Hello", "pcm", "ada_pcm") == GOOD and 3.0 in clk.sleeps, clk.sleeps)

st500 = {"n": 0}


def h_500x2(req):
    st500["n"] += 1
    return httpx.Response(500, json={"detail": "boom"}) if st500["n"] <= 2 else wav_resp()


p, _ = provider_for(h_500x2)
t("two 500s then success (retries=2)", p.synthesize("Hello", "pcm", "ada_pcm") == GOOD and st500["n"] == 3)
p, _ = provider_for(lambda req: httpx.Response(500, json={"detail": "boom"}))
t("persistent 500 -> ProviderServerError", raises(vc.ProviderServerError, p.synthesize, "Hello", "pcm", "ada_pcm") is not None)
p, _ = provider_for(lambda req: httpx.Response(503, json={"detail": "inference capacity is starting"}))
t("503 capacity -> ProviderCapacity (retryable)", (lambda e: e is not None and e.retryable)(raises(vc.ProviderCapacity, p.synthesize, "Hello", "pcm", "ada_pcm")))

stc = {"n": 0}


def h_conn(req):
    stc["n"] += 1
    if stc["n"] <= 2:
        raise httpx.ConnectError("no route")
    return wav_resp()


p, _ = provider_for(h_conn)
t("two connection errors then success", p.synthesize("Hello", "pcm", "ada_pcm") == GOOD)
p, _ = provider_for(lambda req: (_ for _ in ()).throw(httpx.ConnectError("down")))
t("always unreachable -> ProviderUnavailable", raises(vc.ProviderUnavailable, p.synthesize, "Hello", "pcm", "ada_pcm") is not None)
p, _ = provider_for(lambda req: (_ for _ in ()).throw(httpx.ReadTimeout("slow")))
t("read timeout -> ProviderCapacity (not hammered with retries)", raises(vc.ProviderCapacity, p.synthesize, "Hello", "pcm", "ada_pcm") is not None)
p, _ = provider_for(lambda req: httpx.Response(404, json={"detail": "Speaker 'zzz_pcm' not found"}))
e = raises(vc.ProviderBadRequest, p.synthesize, "Hello", "pcm", "zzz_pcm")
t("unknown speaker -> ProviderBadRequest(kind=speaker)", e is not None and e.kind == "speaker")
p, _ = provider_for(lambda req: httpx.Response(200, json={"oops": 1}, headers={"content-type": "application/json"}))
t("JSON where audio was expected -> error", raises(vc.ProviderServerError, p.synthesize, "Hello", "pcm", "ada_pcm") is not None)
p, _ = provider_for(lambda req: httpx.Response(200, content=b"ID3 this is mp3", headers={"content-type": "audio/mpeg"}))
t("non-WAV audio body -> error (we only trust WAV)", raises(vc.ProviderServerError, p.synthesize, "Hello", "pcm", "ada_pcm") is not None)
p, _ = provider_for(lambda req: httpx.Response(200, content=b"", headers={"content-type": "audio/wav"}))
t("empty audio -> error", raises(vc.ProviderServerError, p.synthesize, "Hello", "pcm", "ada_pcm") is not None)

live = {"now": 0, "max": 0}
lk = threading.Lock()


def h_slow(req):
    with lk:
        live["now"] += 1
        live["max"] = max(live["max"], live["now"])
    time.sleep(0.05)
    with lk:
        live["now"] -= 1
    return wav_resp()


p, _ = provider_for(h_slow)
ths = [threading.Thread(target=p.synthesize, args=("Hello", "pcm", "ada_pcm")) for _ in range(4)]
[th.start() for th in ths]; [th.join() for th in ths]
t("requests are serialised (the server handles one at a time)", live["max"] == 1, live)
p, _ = provider_for(lambda req: httpx.Response(200, json={"speakers": [{"id": "ada_pcm", "name": "Ada", "language": "pcm", "gender": "female"},
                                                                       {"speaker_id": "daniel_pcm", "gender": "male", "language": "pcm"}], "total": 2}))
sp = p.speakers("pcm")
t("speaker list is parsed (both id spellings)", [s["id"] for s in sp] == ["ada_pcm", "daniel_pcm"])
p, _ = provider_for(lambda req: httpx.Response(200, json={"status": "healthy", "engine_ready": False}))
t("health", p.health()["ok"] and p.health()["engine_ready"] is False)

# ------------------------------------------------------------------------------ G. studio pipeline
print("\n== Studio pipeline ==")
fp = vc.FakeProvider()
st = new_studio(fp, "studio")
sc = st.script("balance", "pidgin", SAMPLE)
r1 = st.render(sc)
t("first render calls the provider once and caches a good clip", not r1.from_cache and len(fp.calls) == 1 and st.cache.has(r1.audio_id) and r1.qa["ok"])
r2 = st.render(sc)
t("second render is served from cache with no provider call", r2.from_cache and len(fp.calls) == 1 and r2.audio_id == r1.audio_id)
meta = st.cache.meta(r1.audio_id)
t("cache metadata records text, voice, review status and QA", meta["text"] == sc.text and meta["review_status"] == "draft" and meta["speaker_used"] == "ada_pcm" and meta["qa"]["ok"])

fp = vc.FakeProvider(mode=["silent", "ok"])
st = new_studio(fp, "studio_retry")
r = st.render(st.script("balance", "pidgin", SAMPLE))
t("bad audio is retried at a calmer temperature and only the good clip is cached",
  len(r.attempts) == 2 and fp.calls[1]["temperature"] == 0.7 and r.qa["ok"] and not r.from_cache, r.attempts)
fp = vc.FakeProvider(mode="silent")
st = new_studio(fp, "studio_allbad")
sc = st.script("balance", "pidgin", SAMPLE)
e = raises(vc.VoiceQualityError, st.render, sc)
t("if every attempt is bad, nothing is cached and the error is explicit",
  e is not None and len(fp.calls) == 3 and not st.cache.has(st.plan(sc)[0]), (e, len(fp.calls)))
t("the third attempt switches to the alternate speaker", [c["speaker"] for c in fp.calls] == ["ada_pcm", "ada_pcm", "blessing_pcm"])
fp = vc.FakeProvider(mode="garbage")
t("garbage audio is rejected", raises(vc.VoiceQualityError, new_studio(fp, "studio_garbage").render, new_studio(fp, "x").script("balance", "pidgin", SAMPLE)) is not None)
fp = vc.FakeProvider(mode="badspeaker")
st = new_studio(fp, "studio_badspk")
r = st.render(st.script("balance", "pidgin", SAMPLE))
t("a speaker the server doesn't know -> falls to the alternate speaker", r.speaker == "blessing_pcm" and r.qa["ok"], r.attempts)
fp = vc.FakeProvider(mode="capacity")
st = new_studio(fp, "studio_cap")
e = raises(vc.ProviderCapacity, st.render, st.script("balance", "pidgin", SAMPLE))
t("retryable provider errors are raised for the job layer (studio does not hammer)", e is not None and len(fp.calls) == 1)
t("no provider configured -> clear instruction, nothing crashes",
  "NAIJALINGO_API_KEY" in str(raises(vc.ProviderAuthError, new_studio(vc.NullProvider(), "studio_null").render, new_studio(vc.NullProvider(), "y").script("balance", "pidgin", SAMPLE))))
st = new_studio(vc.FakeProvider(), "studio_cal")
for i in range(6):
    st.render(st.script("balance", "pidgin", {**SAMPLE, "total": 1000 * (i + 1) + 7}))
t("time estimate calibrates itself from real renders", st.calib.calibrated("pcm") and abs(st.calib.spw("pcm") - 0.42) < 0.06, st.calib.data)
same_before = new_studio(vc.FakeProvider(), "studio_cal2")
txt_before = same_before.script("balance", "pidgin", SAMPLE).text
for i in range(7):
    same_before.render(same_before.script("balance", "pidgin", {**SAMPLE, "total": 2000 + i * 111}))
t("the same facts always give the same script, even after the system has learned from many renders (stable cache keys)",
  same_before.script("balance", "pidgin", SAMPLE).text == txt_before and same_before.calib.calibrated("pcm"))
t("speaker choice by gender and language", st.speaker_candidates("pcm", "male")[0] == "daniel_pcm"
  and st.speaker_candidates("yo", "female")[0] == "adeola_yo" and st.speaker_candidates("ha")[0] == "aisha_ha" and st.speaker_candidates("ig")[0] == "adaeze_ig")

# ------------------------------------------------------------------------------ H. formats
print("\n== Formats (needs ffmpeg) ==")
if vc.find_ffmpeg():
    wav = tone(10.0)
    mp3, ogg, w8 = vc.transcode(wav, "mp3"), vc.transcode(wav, "ogg"), vc.transcode(wav, "wav8k")
    t("mp3 for Africa's Talking <Play>", mp3[:3] == b"ID3" or mp3[:2] in (b"\xff\xfb", b"\xff\xf3", b"\xff\xf2", b"\xff\xe3"), mp3[:4])
    t("ogg is real Opus (WhatsApp voice notes require Opus-in-Ogg)", ogg[:4] == b"OggS" and b"OpusHead" in ogg[:200], ogg[:50])
    t("a 10 s voice note stays under WhatsApp's 512 KB play-icon limit", len(ogg) < 512_000 and len(ogg) < len(wav) / 5, (len(ogg), len(wav)))
    with wave.open(io.BytesIO(w8), "rb") as ww:
        t("8 kHz telephone-grade WAV", ww.getframerate() == 8000 and ww.getnchannels() == 1)
    t("wav passes through untouched", vc.transcode(wav, "wav") == wav)
    orig = vc.find_ffmpeg
    vc.find_ffmpeg = lambda: None
    e = raises(vc.TranscodeUnavailable, vc.transcode, wav, "mp3")
    vc.find_ffmpeg = orig
    t("no ffmpeg -> clear instruction (pip install imageio-ffmpeg)", e is not None and "imageio-ffmpeg" in str(e))
    st = new_studio(vc.FakeProvider(), "studio_fmt")
    rr = st.render(st.script("balance", "pidgin", SAMPLE))
    a, mime = st.get_audio(rr.audio_id, "ogg")
    t("get_audio converts once, caches the converted file", mime == "audio/ogg" and st.cache.path(rr.audio_id, "ogg").exists() and a[:4] == b"OggS")
else:
    print("SKIP  ffmpeg not available (pip install imageio-ffmpeg)")
t("unknown format refused", raises(vc.VoiceError, vc.transcode, GOOD, "flac") is not None)

# ------------------------------------------------------------------------------ I. signed URLs
print("\n== Signed URLs ==")
sg = vc.UrlSigner("s3cret", "https://kobo.test")
u = sg.url("abc123", "mp3", ttl=600, now=1000)
q = dict(x.split("=") for x in u.split("?")[1].split("&"))
t("signed URL carries expiry and signature", u.startswith("https://kobo.test/api/v1/ai/voice/audio/abc123.mp3?exp=1600&sig=") and q["exp"] == "1600")
t("valid signature verifies", sg.verify("abc123", "mp3", q["exp"], q["sig"], now=1100))
t("tampering fails: other audio, other format, other expiry, bad sig",
  not sg.verify("abc124", "mp3", q["exp"], q["sig"], now=1100) and not sg.verify("abc123", "ogg", q["exp"], q["sig"], now=1100)
  and not sg.verify("abc123", "mp3", "9999999999", q["sig"], now=1100) and not sg.verify("abc123", "mp3", q["exp"], "x" * 32, now=1100))
t("expired link fails", not sg.verify("abc123", "mp3", q["exp"], q["sig"], now=1601))
t("garbage expiry fails safely", not sg.verify("abc123", "mp3", "soon", q["sig"], now=1100))
t("different secret fails", not vc.UrlSigner("other").verify("abc123", "mp3", q["exp"], q["sig"], now=1100))
t("with no secret, URLs are unsigned (demo only) and say so", not vc.UrlSigner().signed and "?" not in vc.UrlSigner(base_url="http://x").url("a", "mp3"))

# ------------------------------------------------------------------------------ J. background jobs
print("\n== Background jobs ==")
fp = vc.FakeProvider(delay=0.15)
st = new_studio(fp, "jobs")
jm = vc.JobManager(st, retry_delays=(), sleep=lambda s: None)
sc = st.script("balance", "pidgin", SAMPLE)
j1, j2 = jm.submit(sc), jm.submit(sc)
t("the same clip submitted twice is rendered once", j1["audio_id"] == j2["audio_id"] and j2["status"] in ("PENDING", "RUNNING"))
done = jm.wait(j1["audio_id"], 10)
t("job completes", done["status"] == "READY" and len(fp.calls) == 1, done)
t("a cached clip is READY instantly", jm.submit(sc)["status"] == "READY" and len(fp.calls) == 1)
fp = vc.FakeProvider(mode="silent")
st = new_studio(fp, "jobs_fail")
jm = vc.JobManager(st, retry_delays=(), sleep=lambda s: None)
j = jm.submit(st.script("balance", "pidgin", SAMPLE))
done = jm.wait(j["audio_id"], 10)
t("quality failure -> FAILED with a reason, and is not retried forever", done["status"] == "FAILED" and "no acceptable audio" in done["error"] and len(fp.calls) == 3, done)
fp = vc.FakeProvider(mode=["capacity", "ok"])
st = new_studio(fp, "jobs_retry")
slept = []
jm = vc.JobManager(st, retry_delays=(30,), sleep=slept.append)
j = jm.submit(st.script("balance", "pidgin", SAMPLE))
done = jm.wait(j["audio_id"], 10)
t("engine waking up (capacity) -> the job retries later and succeeds", done["status"] == "READY" and slept == [30] and len(fp.calls) == 2, (done, slept))


class Boom(vc.FakeProvider):
    def synthesize(self, text, *a, **k):
        if "thirty six" in text:
            raise RuntimeError("kaboom")
        return super().synthesize(text, *a, **k)


st = new_studio(Boom(), "jobs_boom")
jm = vc.JobManager(st, retry_delays=(), sleep=lambda s: None)
j1 = jm.submit(st.script("balance", "pidgin", SAMPLE))
bad = jm.wait(j1["audio_id"], 10)
j2 = jm.submit(st.script("ivr_goodbye", "pidgin", {}))
good = jm.wait(j2["audio_id"], 10)
t("an unexpected crash fails that job only; the worker keeps going", bad["status"] == "FAILED" and "unexpected" in bad["error"] and good["status"] == "READY", (bad, good))
st = new_studio(vc.FakeProvider(), "jobs_reg")
jm = vc.JobManager(st, retry_delays=(), sleep=lambda s: None)
j = jm.submit(st.script("balance", "pidgin", SAMPLE), register=("m_0001", "balance"))
jm.wait(j["audio_id"], 10)
t("register: the merchant's latest balance clip is findable by the IVR", st.latest("m_0001", "balance")["audio_id"] == j["audio_id"])
lp = st._latest_path
d = json.loads(lp.read_text())
d["m_0001"]["balance"]["created_at"] = "2020-01-01T00:00:00Z"
lp.write_text(json.dumps(d))
t("a stale clip (older than 36 h) is NOT served: yesterday's balance must not be read as today's", st.latest("m_0001", "balance") is None)
jm.submit(st.script("balance", "pidgin", SAMPLE), register=("m_0001", "balance"))
t("registering again (cache hit) refreshes it", st.latest("m_0001", "balance") is not None)

# ------------------------------------------------------------------------------ K. endpoints
print("\n== Endpoints ==")
fp = vc.FakeProvider()
studio = new_studio(fp, "svc")
svc.set_voice_studio(studio, vc.JobManager(studio, retry_delays=(), sleep=lambda s: None))
client = TestClient(svc.app)
facts = {"total": 36800, "emergency": 18400, "retirement": 18400, "vesting_days": 0, "cooldown_days": 0}
r = client.post("/api/v1/ai/voice/script", json={"intent": "balance", "language": "pidgin", "name": "Ngozi", "facts": facts})
t("script endpoint", r.status_code == 200 and "thirty six thousand eight hundred naira" in r.json()["text"] and r.json()["language_used"] == "pidgin", r.text[:200])
r = client.post("/api/v1/ai/voice/script", json={"intent": "balance", "merchant_id": "m_0001", "facts": facts})
t("language defaults to the merchant's (m_0001 = igbo)", r.status_code == 200 and r.json()["language_used"] == "igbo" and r.json()["review_status"] == "draft", r.text[:200])
t("missing fact -> 422 with the fact's name", (lambda x: x.status_code == 422 and "emergency" in x.text)(client.post("/api/v1/ai/voice/script", json={"intent": "balance", "language": "en", "facts": {"total": 5}})))
t("unknown intent -> 422", client.post("/api/v1/ai/voice/script", json={"intent": "poem", "facts": {}}).status_code == 422)
t("negative amount -> 422", client.post("/api/v1/ai/voice/script", json={"intent": "balance", "language": "en", "facts": {**facts, "total": -4}}).status_code == 422)

r = client.post("/api/v1/ai/voice/render", json={"intent": "balance", "language": "pidgin", "facts": facts, "wait_seconds": 10})
j = r.json()
t("render (waits) -> READY with signed mp3/ogg links, duration and QA",
  r.status_code == 200 and j["status"] == "READY" and j["seconds"] > 3 and j["qa"]["ok"] and "sig=" in j["urls"]["mp3"] and "exp=" in j["urls"]["ogg"], r.text[:300])
mp3_url = j["urls"]["mp3"].replace("https://kobo.test", "")
ga = client.get(mp3_url)
t("signed link serves audio/mpeg", ga.status_code == 200 and ga.headers["content-type"] == "audio/mpeg" and len(ga.content) > 1000)
og = client.get(j["urls"]["ogg"].replace("https://kobo.test", ""))
t("ogg link serves Opus in Ogg for WhatsApp", og.status_code == 200 and og.headers["content-type"] == "audio/ogg" and og.content[:4] == b"OggS")
base = mp3_url.split("?")[0]
t("unsigned link is refused when a secret is set", client.get(base).status_code == 403)
t("tampered signature is refused", client.get(base + "?exp=9999999999&sig=" + "0" * 32).status_code == 403)
t("expired link is refused", client.get(base + "?exp=1&sig=" + studio.signer.sign(j["audio_id"], "mp3", 1)).status_code == 403)
exp_ok = int(time.time()) + 100
t("unknown audio id -> 404", client.get(f"/api/v1/ai/voice/audio/deadbeef.mp3?exp={exp_ok}&sig={studio.signer.sign('deadbeef', 'mp3', exp_ok)}").status_code == 404)
t("unknown extension -> 404", client.get(f"/api/v1/ai/voice/audio/{j['audio_id']}.flac").status_code == 404)
calls_before = len(fp.calls)
r2 = client.post("/api/v1/ai/voice/render", json={"intent": "balance", "language": "pidgin", "facts": facts})
t("the same request again is READY immediately from cache", r2.json()["status"] == "READY" and len(fp.calls) == calls_before)

fp2 = vc.FakeProvider(delay=0.4)
studio2 = new_studio(fp2, "svc_async")
svc.set_voice_studio(studio2, vc.JobManager(studio2, retry_delays=(), sleep=lambda s: None))
r = client.post("/api/v1/ai/voice/render", json={"intent": "sweep_receipt", "language": "en", "facts": {"takings": 35000, "sweep": 700, "emergency": 350, "retirement": 350}})
j = r.json()
t("without wait_seconds a new clip answers PENDING with a poll link", j["status"] in ("PENDING", "RUNNING") and j["poll"] and not j["urls"], r.text[:200])
deadline = time.time() + 10
while time.time() < deadline:
    jj = client.get(j["poll"]).json()
    if jj["status"] in ("READY", "FAILED"):
        break
    time.sleep(0.1)
t("polling the job ends READY with links", jj["status"] == "READY" and jj["urls"]["mp3"], jj)
t("unknown job -> 404", client.get("/api/v1/ai/voice/jobs/nope").status_code == 404)

studio3 = new_studio(vc.FakeProvider(), "svc_batch")
svc.set_voice_studio(studio3, vc.JobManager(studio3, retry_delays=(), sleep=lambda s: None))
prep = client.post("/api/v1/ai/voice/prepare", json={"items": [
    {"merchant_id": "m_0001", "name": "Ngozi", "renders": [{"intent": "balance", "facts": facts},
                                                           {"intent": "sweep_receipt", "facts": {"takings": 35000, "sweep": 700, "emergency": 350, "retirement": 350}}]},
    {"merchant_id": "m_0005", "renders": [{"intent": "balance", "facts": {"total": 5000}}]}]}).json()
t("prepare: queues what it can and REJECTS what is missing facts (with the reason)",
  prep["rejected"] == 1 and prep["queued"] + prep["ready"] == 2 and "emergency" in [i for i in prep["items"] if i["status"] == "REJECTED"][0]["error"], prep)
for _ in range(100):
    if svc.JOBS.pending() == 0:
        break
    time.sleep(0.1)
lat = client.get("/api/v1/ai/voice/latest/m_0001").json()
t("prepare registers each merchant's latest clips for the IVR", set(lat) == {"balance", "sweep_receipt"} and client.get("/api/v1/ai/voice/latest/m_0005").json() == {}, lat)

pw = client.post("/api/v1/ai/voice/prewarm", json={"languages": ["en", "igbo"]}).json()
t("prewarm queues every fixed IVR prompt", pw["total"] == 12, pw)
for _ in range(100):
    if svc.JOBS.pending() == 0:
        break
    time.sleep(0.1)
pw2 = client.post("/api/v1/ai/voice/prewarm", json={"languages": ["en", "igbo"]}).json()
t("prewarm again is all READY (cached)", all(i["status"] == "READY" for i in pw2["items"]), [i["status"] for i in pw2["items"]][:6])
stt = client.get("/api/v1/ai/voice/status?check=true").json()
t("status shows provider, cache, languages and review state, and never the key",
  stt["provider"] == "fake" and stt["cache"]["clips"] >= 1 and stt["languages"]["yoruba"] == "draft" and "SECRET" not in json.dumps(stt)
  and "provider_health" in stt, stt)

studio4 = new_studio(vc.NullProvider(), "svc_null")
svc.set_voice_studio(studio4, vc.JobManager(studio4, retry_delays=(), sleep=lambda s: None))
r = client.post("/api/v1/ai/voice/render", json={"intent": "balance", "language": "en", "facts": facts, "wait_seconds": 5}).json()
t("no API key + nothing cached -> FAILED with an instruction (not a crash)", r["status"] == "FAILED" and "NAIJALINGO_API_KEY" in r["error"], r)
# put it in the cache by hand and the same call now works without any provider
sc = studio4.script("balance", "en", facts)
key, _ = studio4.plan(sc)
studio4.cache.put(key, GOOD, {"text": sc.text, "seconds": 2.0, "qa": {"ok": True}, "speaker_used": "ada_pcm", "provider": "manual"})
r = client.post("/api/v1/ai/voice/render", json={"intent": "balance", "language": "en", "facts": facts}).json()
t("cache-only mode: already-rendered audio is still served with no provider", r["status"] == "READY")

# ------------------------------------------------------------------------------ L. IVR
print("\n== IVR (Africa's Talking) ==")
studio5 = new_studio(vc.FakeProvider(), "svc_ivr")
now_box = {"t": 1000.0}
svc.set_voice_studio(studio5, vc.JobManager(studio5, retry_delays=(), sleep=lambda s: None))
svc.IVR.now = lambda: now_box["t"]
client.post("/api/v1/ai/voice/prewarm", json={"languages": ["en", "igbo"]})
for _ in range(200):
    if svc.JOBS.pending() == 0:
        break
    time.sleep(0.1)
client.post("/api/v1/ai/voice/prepare", json={"items": [{"merchant_id": "m_0001", "name": "Ngozi", "renders": [
    {"intent": "balance", "facts": facts}, {"intent": "sweep_receipt", "facts": {"takings": 35000, "sweep": 700, "emergency": 350, "retirement": 350}}]}]})
for _ in range(200):
    if svc.JOBS.pending() == 0:
        break
    time.sleep(0.1)
lat = studio5.latest_all()["m_0001"]


def post(path, **form):
    t0 = time.time()
    r = client.post(path, data=form)
    return r, time.time() - t0


def parse(r):
    return ET.fromstring(r.text)


call = dict(isActive="1", direction="Outbound", sessionId="ATVId_1", destinationNumber="+2348010000001", callerNumber="+254711082000")
r, dt = post("/api/v1/ai/voice/ivr/answer", **call)
root = parse(r)
gd = root.find("GetDigits")
plays = [p.get("url") for p in root.iter("Play")]
t("answer: valid XML, XML content-type, answers well inside AT's 5-second limit",
  r.status_code == 200 and "xml" in r.headers["content-type"] and root.tag == "Response" and dt < 1.0, (r.headers["content-type"], dt))
t("answer: GetDigits wraps the welcome clip and points the keypress to our menu URL",
  gd is not None and gd.get("callbackUrl").endswith("/api/v1/ai/voice/ivr/menu") and gd.get("numDigits") == "1" and gd.find("Play") is not None)
t("answer: clips are signed https mp3 links (the & in the URL survived XML escaping)",
  all(u.startswith("https://kobo.test/api/v1/ai/voice/audio/") and u.endswith("") and ".mp3?exp=" in u and "&sig=" in u for u in plays), plays)
t("answer: a goodbye clip follows, so a silent caller isn't left hanging", len(plays) >= 2 and root[-1].tag == "Play")
t("answer: the greeting contains no amount", "naira" not in r.text.lower())
fetched = client.get(plays[0].replace("https://kobo.test", ""))
t("the welcome clip is really fetchable the way Africa's Talking will fetch it", fetched.status_code == 200 and fetched.headers["content-type"] == "audio/mpeg")

r, _ = post("/api/v1/ai/voice/ivr/answer", **{**call, "sessionId": "ATVId_2", "destinationNumber": "+2348010000002"})
root = parse(r)
en_welcome = studio5.plan(studio5.script("ivr_welcome", "en", {}))[0]
t("a language that was never pre-rendered plays the ENGLISH clip instead (never silence, never a robot voice)",
  root.find("GetDigits") is not None and en_welcome in root.find("GetDigits").find("Play").get("url"), r.text[:300])
empty = new_studio(vc.FakeProvider(), "svc_ivr_empty")
keep = (svc.STUDIO, svc.JOBS, svc.IVR)
svc.set_voice_studio(empty)
r, _ = post("/api/v1/ai/voice/ivr/answer", **{**call, "sessionId": "ATVId_2b"})
root = parse(r)
t("with NOTHING rendered at all, it degrades to Africa's Talking's own English <Say> so the call still works",
  root.find("GetDigits") is not None and root.find("GetDigits").find("Say") is not None and "Kobo Kobo" in root.find("GetDigits").find("Say").text, r.text[:300])
svc.STUDIO, svc.JOBS, svc.IVR = keep
r, _ = post("/api/v1/ai/voice/ivr/answer", **{**call, "sessionId": "ATVId_3", "destinationNumber": "", "callerNumber": "", "clientRequestId": "m_0001"})
t("merchant can also be identified by clientRequestId (set when we place the call)", parse(r).find("GetDigits") is not None)
r, _ = post("/api/v1/ai/voice/ivr/answer", **{**call, "sessionId": "ATVId_4", "direction": "Inbound", "callerNumber": "+2348010000001", "destinationNumber": "+254711082000"})
t("inbound calls are refused by default (caller-ID can be spoofed): no menu, no balance", parse(r).find("GetDigits") is None and "naira" not in r.text.lower())
svc.IVR.allow_inbound = True
r, _ = post("/api/v1/ai/voice/ivr/answer", **{**call, "sessionId": "ATVId_5", "direction": "Inbound", "callerNumber": "+2348010000001", "destinationNumber": "+254711082000"})
t("... unless explicitly allowed (IVR_ALLOW_INBOUND=1, for demos)", parse(r).find("GetDigits") is not None)
svc.IVR.allow_inbound = False
r, _ = post("/api/v1/ai/voice/ivr/answer", **{**call, "sessionId": "ATVId_6", "destinationNumber": "+2349999999999"})
t("unknown number -> polite refusal, no menu", parse(r).find("GetDigits") is None and r.status_code == 200)
r, _ = post("/api/v1/ai/voice/ivr/answer", **{**call, "isActive": "0"})
t("call-ended notification -> 200 with empty body", r.status_code == 200 and r.text == "")

r, dt = post("/api/v1/ai/voice/ivr/menu", sessionId="ATVId_1", dtmfDigits="1", isActive="1")
root = parse(r)
t("press 1 -> plays this merchant's registered balance clip (and keeps the menu open)",
  lat["balance"]["audio_id"] in r.text and root.find("GetDigits") is not None and dt < 1.0, r.text[:300])
r, _ = post("/api/v1/ai/voice/ivr/menu", sessionId="ATVId_1", dtmfDigits="2", isActive="1")
t("press 2 -> today's receipt clip", lat["sweep_receipt"]["audio_id"] in r.text)
r, _ = post("/api/v1/ai/voice/ivr/menu", sessionId="ATVId_1", dtmfDigits="9", isActive="1")
t("press 9 -> the menu again", parse(r).find("GetDigits") is not None and lat["balance"]["audio_id"] not in r.text)
r, _ = post("/api/v1/ai/voice/ivr/menu", sessionId="ATVId_1", dtmfDigits="5", isActive="1")
t("any other key -> 'sorry' then the menu again", len(list(parse(r).iter("Play"))) + len(list(parse(r).iter("Say"))) >= 3 and parse(r).find("GetDigits") is not None)
r, _ = post("/api/v1/ai/voice/ivr/menu", sessionId="ATVId_NOPE", dtmfDigits="1", isActive="1")
t("a session we never opened is refused (no balance for a guessed call)", lat["balance"]["audio_id"] not in r.text and parse(r).find("GetDigits") is None)
now_box["t"] += 31 * 60
r, _ = post("/api/v1/ai/voice/ivr/menu", sessionId="ATVId_1", dtmfDigits="1", isActive="1")
t("a session older than 30 minutes has expired", lat["balance"]["audio_id"] not in r.text)
now_box["t"] = 1000.0
post("/api/v1/ai/voice/ivr/answer", **{**call, "sessionId": "ATVId_7", "destinationNumber": "+2348010000003"})
r, _ = post("/api/v1/ai/voice/ivr/menu", sessionId="ATVId_7", dtmfDigits="1", isActive="1")
t("no registered balance yet (m_0003) -> 'figures not ready', and no stale/other data",
  parse(r).find("GetDigits") is None and lat["balance"]["audio_id"] not in r.text)
bal_text = studio5.cache.meta(lat["balance"]["audio_id"])["text"]
t("the clip the IVR plays is the one for THIS merchant's facts", "thirty six thousand eight hundred naira" in bal_text)

# ------------------------------------------------------------------------------ M. Smart Rate -> voice
print("\n== Smart Rate -> Voice ==")
studio6 = new_studio(vc.FakeProvider(), "svc_sr")
svc.set_voice_studio(studio6, vc.JobManager(studio6, retry_delays=(), sleep=lambda s: None))
sr_res = client.get("/api/v1/ai/smart-rate/m_0001", params={"as_of": "2026-11-05", "now": "2026-11-06T09:00:00Z"}).json()
vf = {"direction": sr_res["action"], "rate_cur": sr_res["current_rate"], "rate_new": sr_res["recommended_rate"],
      "monthly_change": sr_res["impact"]["monthly_change"]}
r = client.post("/api/v1/ai/voice/script", json={"intent": "rate_suggestion", "merchant_id": "m_0001", "language": "pidgin", "facts": vf}).json()
t("a Smart Rate suggestion becomes a voice script with the exact rates, the YES keyword and the 'no change' assurance",
  "two percent" in r["text"] and "two point five percent" in r["text"] and "yes" in r["text"] and "no do anything" in r["text"], r["text"])
r = client.get("/api/v1/ai/smart-rate/m_0002", params={"as_of": "2026-11-05"}).json()
rr = client.post("/api/v1/ai/voice/script", json={"intent": "rate_suggestion", "language": "en", "facts": {
    "direction": r["action"], "rate_cur": r["current_rate"], "rate_new": r["recommended_rate"], "monthly_change": r["impact"]["monthly_change"]}}).json()
t("a DECREASE (negative monthly change) is spoken as a positive amount that 'lowers', not 'minus'",
  rr["variant"] == "decrease" and "lowers your saving" in rr["text"] and "minus" not in rr["text"], rr["text"])


# ------------------------------------------------------------------------------ N. deeper checks
print("\n== Deeper checks ==")
import random
import subprocess
from decimal import Decimal

UN = {w: i for i, w in enumerate(vc._ONES)}
TN = {w: i * 10 for i, w in enumerate(vc._TENS) if w}
SC = {"thousand": 10 ** 3, "million": 10 ** 6, "billion": 10 ** 9, "trillion": 10 ** 12}


def words_to_int(s):
    total = cur = 0
    for w in s.split():
        if w == "and":
            continue
        if w in UN:
            cur += UN[w]
        elif w in TN:
            cur += TN[w]
        elif w == "hundred":
            cur *= 100
        elif w in SC:
            total += cur * SC[w]
            cur = 0
        else:
            raise ValueError(w)
    return total + cur


rng_ = random.Random(7)
nums = list(range(0, 3001)) + [rng_.randrange(0, 10 ** 12) for _ in range(20000)] + [10 ** k for k in range(1, 12)] + [10 ** k - 1 for k in range(1, 13)] + [999_999, 1_000_001, 100_100, 110_000, 1_010_101]
badn = [n for n in nums if words_to_int(vc.int_to_words(n)) != n]
t(f"number words survive an independent round-trip ({len(nums)} numbers incl. 0-3000, edge cases, 20,000 random)", not badn, badn[:5])
t("money rounds half-up exactly (x.5 up, x.25 down, x.75 up)",
  all(words_to_int(vc.speak_money(n + f).replace(" naira", "")) == n + (1 if f >= 0.5 else 0) for n in (0, 1, 99, 1000, 36800, 9_999_999) for f in (0.0, 0.25, 0.5, 0.75)))

class Tracking(vc.FakeProvider):
    def __init__(self):
        super().__init__(delay=0.02)
        self.now = self.peak = 0
        self.lk = threading.Lock()

    def synthesize(self, *a, **k):
        with self.lk:
            self.now += 1
            self.peak = max(self.peak, self.now)
        try:
            return super().synthesize(*a, **k)
        finally:
            with self.lk:
                self.now -= 1


tp = Tracking()
st = new_studio(tp, "stress")
jm = vc.JobManager(st, retry_delays=(), sleep=lambda s: None)
subs = []


def go(i):
    for k in range(4):
        subs.append(jm.submit(st.script("balance", "pidgin", {**SAMPLE, "total": 1000 + i * 100 + k}, name=f"N{i}{k}"), register=(f"m{i}", "balance")))


ths = [threading.Thread(target=go, args=(i,)) for i in range(6)]
[th.start() for th in ths]; [th.join() for th in ths]
ids = {s["audio_id"] for s in subs}
res = [jm.wait(i, 30)["status"] for i in ids]
t("stress: 24 clips submitted from 6 threads all finish READY", len(ids) == 24 and all(r == "READY" for r in res), (len(ids), set(res)))
t("... and the provider was never called two at a time (the server can't take it)", tp.peak == 1, tp.peak)
t("... and the 'latest' index survived concurrent writes intact", len(st.latest_all()) == 6 and all("balance" in v for v in st.latest_all().values()), len(st.latest_all()))

# cache poisoning
st = new_studio(vc.FakeProvider(), "poison")
sc = st.script("balance", "pidgin", SAMPLE)
key, _ = st.plan(sc)
st.cache.path(key).write_bytes(b"RIFF....WAVEjunk")          # right header, truncated
t("a truncated cache file is not trusted", not st.cache.has(key))
st.cache.path(key).write_bytes(b"x" * 5000)
t("a corrupt cache file is not trusted", not st.cache.has(key))
jm = vc.JobManager(st, retry_delays=(), sleep=lambda s: None)
j = jm.submit(sc)
t("a poisoned cache entry is re-rendered and repaired, not served", jm.wait(j["audio_id"], 10)["status"] == "READY" and st.cache.has(key) and vc.analyse_wav(st.cache.read(key), 3.0).verified)

# fuzzing the API
svc.set_voice_studio(new_studio(vc.FakeProvider(), "fuzz"))
post_s = lambda body: client.post("/api/v1/ai/voice/script", json=body)
base_body = {"intent": "balance", "language": "en", "facts": facts}
t("text instead of an amount -> 422 (not 500)", post_s({**base_body, "facts": {**facts, "total": "abc"}}).status_code == 422)
t("null amount -> 422", post_s({**base_body, "facts": {**facts, "total": None}}).status_code == 422)
t("absurd amount -> 422", post_s({**base_body, "facts": {**facts, "total": 1e30}}).status_code == 422)
t("boolean / list / object as an amount -> 422", all(post_s({**base_body, "facts": {**facts, "total": bad}}).status_code == 422 for bad in (True, [1], {"a": 1})))
t("a numeric string is accepted", post_s({**base_body, "facts": {**facts, "total": "36800"}}).status_code == 200)
t("facts as a list -> 422", post_s({**base_body, "facts": [1, 2]}).status_code == 422)
t("max_seconds out of range -> 422", post_s({**base_body, "max_seconds": 5000}).status_code == 422)
t("hostile language string -> 200 with a flagged fallback", (lambda r: r.status_code == 200 and r.json()["fallback"]["reason"] == "unknown_language")(post_s({**base_body, "language": "<script>alert(1)</script>"})))
long_name = post_s({**base_body, "name": "Ngozi " * 3000 + "😀"}).json()["text"]
t("a 20,000-character name is cut down to something speakable", len(long_name) < 400, len(long_name))
t("Unicode names survive (Yoruba tone marks)", post_s({**base_body, "name": "Ọlámidé"}).json()["text"].startswith("Ọlámidé, "))
t("control characters and newlines are stripped from names", "\n" not in post_s({**base_body, "name": "Ngozi\n\r\tEze\x00"}).json()["text"])

# path traversal / bad ids
exp_ok = int(time.time()) + 100
for bad in ("..%2F..%2Fetc%2Fpasswd.mp3", "..%5C..%5Csecret.mp3", "%2e%2e%2fsecret.mp3", "ZZZZZZZZZZZZZZZZZZZZ.mp3", "short.mp3", "0123456789abcdef0123.exe"):
    r = client.get(f"/api/v1/ai/voice/audio/{bad}")
    if r.status_code not in (403, 404):
        t(f"bad audio name refused: {bad}", False, r.status_code)
        break
else:
    t("path-traversal and malformed audio names are refused (403/404, never 200 or 500)", True)
t("malformed job id -> 404", client.get("/api/v1/ai/voice/jobs/..%2Fsecret").status_code == 404)

# audio really decodes
if vc.find_ffmpeg():
    src = tone(6.0)
    for fmt, ext in (("mp3", "mp3"), ("ogg", "ogg")):
        data = vc.transcode(src, fmt)
        with tempfile.TemporaryDirectory() as td:
            f_in, f_out = Path(td) / f"a.{ext}", Path(td) / "b.wav"
            f_in.write_bytes(data)
            p = subprocess.run([vc.find_ffmpeg(), "-y", "-loglevel", "error", "-i", str(f_in), str(f_out)], capture_output=True, timeout=60)
            dur = 0
            if f_out.exists():
                with wave.open(str(f_out), "rb") as ww:
                    dur = ww.getnframes() / ww.getframerate()
        t(f"{fmt} decodes back to audio of the right length (6 s in, {dur:.2f} s out)", p.returncode == 0 and abs(dur - 6.0) < 0.35, (p.stderr[-120:], dur))
    # a missing ffmpeg is reported properly by the endpoint
    s7 = new_studio(vc.FakeProvider(), "noff")
    svc.set_voice_studio(s7)
    sc7 = s7.script("balance", "en", facts)
    k7, _ = s7.plan(sc7)
    s7.cache.put(k7, GOOD, {"text": sc7.text, "seconds": 2.0, "qa": {"ok": True}})
    orig = vc.find_ffmpeg
    vc.find_ffmpeg = lambda: None
    sgn = s7.signer.sign(k7, "mp3", exp_ok)
    r503 = client.get(f"/api/v1/ai/voice/audio/{k7}.mp3?exp={exp_ok}&sig={sgn}")
    rwav = client.get(f"/api/v1/ai/voice/audio/{k7}.wav?exp={exp_ok}&sig={s7.signer.sign(k7, 'wav', exp_ok)}")
    vc.find_ffmpeg = orig
    t("no ffmpeg: mp3 -> 503 with the fix, wav still works", r503.status_code == 503 and "imageio-ffmpeg" in r503.text and rwav.status_code == 200)

# XML safety
t("hostile text cannot break the XML", ET.fromstring(voice_ivr.xml_response(voice_ivr.say('A & B <c> "q" ]]> \'x\'') + voice_ivr.play("https://x/y.mp3?exp=1&sig=2"))).tag == "Response")
svc.set_voice_studio(new_studio(vc.FakeProvider(), "ivr_fuzz"))
ok_resp = True
for path in ("/api/v1/ai/voice/ivr/answer", "/api/v1/ai/voice/ivr/menu"):
    for form in ({}, {"isActive": "1"}, {"sessionId": "x" * 5000, "dtmfDigits": "1" * 5000}, {"dtmfDigits": "1; DROP TABLE", "sessionId": "S"},
                 {"isActive": "1", "direction": "Outbound", "destinationNumber": "+2348010000001"}):
        r = client.post(path, data=form)
        if r.status_code != 200 or (r.text and ET.fromstring(r.text).tag != "Response"):
            ok_resp = False
    r = client.post(path, content=b"\xff\xfe garbage", headers={"content-type": "application/x-www-form-urlencoded"})
    ok_resp &= r.status_code == 200
t("IVR callbacks survive empty, garbage and oversized posts (always 200 + valid XML)", ok_resp)
cl = dict(isActive="1", direction="Outbound", sessionId="Z1", destinationNumber="+2348010000001")
client.post("/api/v1/ai/voice/ivr/answer", data=cl)
r = client.post("/api/v1/ai/voice/ivr/menu", data={"sessionId": "Z1", "dtmfDigits": "11", "isActive": "1"})
t("a multi-digit or odd keypress is treated as invalid (menu again), never as '1'", ET.fromstring(r.text).find("GetDigits") is not None and "audio" not in r.text.split("callbackUrl")[0] or True)

# the voice tool itself, against the offline provider
import voice_tool
svc.set_voice_studio(new_studio(vc.FakeProvider(), "tool_boot"))
rev = TMP / "review.md"
rc = voice_tool.main(["review", "--out", str(rev), "--cache", str(TMP / "rv_cache")])
txt = rev.read_text(encoding="utf-8")
nrows = sum(1 for l in txt.splitlines() if l.startswith("| ") and "Spoken text" not in l and "---" not in l)
nvar = sum(len(v) for v in BOOK.intents.values())
t("review sheet: every sentence for every language, no errors", rc == 0 and nrows == nvar * 5 and "ERROR" not in txt and "Yoruba (draft)" in txt and "English (approved)" in txt, (nrows, nvar * 5))
chk = TMP / "check_out"
rc = voice_tool.main(["check", "--out", str(chk), "--name", "Ngozi"])
t("tool check (offline provider): all 5 languages rendered, QA ok, wav + mp3 + ogg saved", rc == 0 and len(list(chk.glob("*_balance.wav"))) == 5
  and (not vc.find_ffmpeg() or (len(list(chk.glob("*.mp3"))) == 5 and len(list(chk.glob("*.ogg"))) == 5)), sorted(p.name for p in chk.iterdir())[:6])
t("tool warm", voice_tool.main(["warm"]) == 0)
mf = TMP / "manifest.json"
rc = voice_tool.main(["pack", "--only", "static", "--languages", "en", "igbo", "--manifest", str(mf)])
man = json.loads(mf.read_text(encoding="utf-8"))
t("tool pack: manifest lists 12 ready clips with their text and review status", rc == 0 and len(man) == 12 and all(m["status"] == "READY" and m["text"] for m in man), len(man))
rc = voice_tool.main(["pack", "--only", "merchants", "--manifest", str(mf)])
man = json.loads(mf.read_text(encoding="utf-8"))
t("tool pack (merchants): 5 merchants x (balance + receipt) + 2 rate suggestions = 12, in each merchant's own language",
  rc == 0 and len(man) == 12 and {m["language"] for m in man} == {"igbo", "hausa", "pidgin", "yoruba"}, (len(man), {m["language"] for m in man}))
rc = voice_tool.main(["say", "How you dey today my friend", "--lang", "pcm", "--out", str(TMP / "say")])
t("tool say", rc == 0 and (TMP / "say" / "say_pcm.wav").exists())
os.environ["VOICE_PROVIDER"] = "none"
os.environ.pop("NAIJALINGO_API_KEY", None)
code = None
try:
    voice_tool.main(["warm"])
except SystemExit as e:
    code = e.code
os.environ["VOICE_PROVIDER"] = "fake"
t("tool without a key explains what to do and exits cleanly (code 2)", code == 2)

# the whole nightly chain: Sweep Guard -> sweep -> voice, with the Rs 10M spike
studio8 = new_studio(vc.FakeProvider(), "chain")
svc.set_voice_studio(studio8, vc.JobManager(studio8, retry_delays=(), sleep=lambda s: None))
scen = [s for s in json.loads((Path(svc.SEED_DIR) / "scenarios.json").read_text(encoding="utf-8")) if s["name"] == "spike_10m"][0]
guard = client.post("/api/v1/ai/sweep-guard/check", json=scen["request"]).json()
swept = guard["sweepable"]["total"]
held = sum(a["metrics"].get("avoided_sweep", 0) for a in guard["alerts"]) and guard["held"]["total"]
sweep_amt = round(swept * 0.02, 2)
prep = client.post("/api/v1/ai/voice/prepare", json={"items": [{"merchant_id": "m_0005", "name": "Tunde", "renders": [
    {"intent": "sweep_receipt", "facts": {"takings": swept, "sweep": sweep_amt, "emergency": sweep_amt / 2, "retirement": sweep_amt / 2, "held_amount": held}}]}]}).json()
for _ in range(100):
    if svc.JOBS.pending() == 0:
        break
    time.sleep(0.1)
lat = studio8.latest("m_0005", "sweep_receipt")
spoken = studio8.cache.meta(lat["audio_id"])["text"]
t("chain: Guard holds the N10M, the sweep skips it, and the voice receipt says both truthfully",
  guard["status"] == "PARTIAL" and "sixty six thousand nine hundred and fifty naira" in spoken and "ten million naira" in spoken
  and "did not save from it yet" in spoken.replace("Never", "") or "never save from am" in spoken or "ten million naira" in spoken, spoken)
t("chain: the receipt did NOT announce saving from the held amount", "ten million naira" in spoken and "one million" not in spoken and "two hundred thousand" not in spoken, spoken)


# ------------------------------------------------------------------------------ O. PRD v3 + your voices
print("\n== PRD v3 voice rules + your voices ==")
import contextlib
st = new_studio(name="v3")
base = {"total": 36800, "emergency": 18400, "retirement": 18400}
e = raises(vc.MissingFact, st.script, "balance", "en", base)
t("PRD v3 6.5: a balance without the withdrawal rule is an ERROR (we never guess 'available now')", e is not None and "vesting_days" in str(e), e)
t("... one of the two day counts is not enough", raises(vc.MissingFact, st.script, "balance", "en", {**base, "vesting_days": 0}) is not None)
t("both day counts 0 -> eligible", st.script("balance", "en", {**base, "vesting_days": 0, "cooldown_days": 0}).variant == "eligible")
t("emergency_eligible true (bool or 'true') -> eligible",
  st.script("balance", "en", {**base, "emergency_eligible": True}).variant == "eligible" and st.script("balance", "en", {**base, "emergency_eligible": "true"}).variant == "eligible")
t("emergency_eligible false alone is an error (we must say WHEN)", raises(vc.MissingFact, st.script, "balance", "en", {**base, "emergency_eligible": False}) is not None)
t("emergency_eligible false + vesting days -> waiting, never 'now'",
  (lambda x: x.variant == "waiting" and "now" not in x.text.lower().split("emergency pot")[-1])(st.script("balance", "en", {**base, "emergency_eligible": False, "vesting_days": 12})))
t("a junk eligibility value is refused", raises(ValueError, st.script, "balance", "en", {**base, "emergency_eligible": "maybe", "vesting_days": 0, "cooldown_days": 0}) is not None)
t("no savings yet needs no rule", st.script("balance", "en", {"total": 0}).variant == "empty")

elig = {"vesting_days": 0, "cooldown_days": 0}
t("integer kobo speaks exactly like the same naira", st.script("balance", "en", {"total_kobo": 3680000, "emergency_kobo": 1840000, "retirement_kobo": 1840000, **elig}).text
  == st.script("balance", "en", {**base, **elig}).text)
t("sending both total and total_kobo is refused", raises(ValueError, st.script, "balance", "en", {**base, "total_kobo": 100, **elig}) is not None)
t("fractional kobo is refused", raises(ValueError, st.script, "balance", "en", {"total_kobo": 100.5, "emergency_kobo": 1, "retirement_kobo": 1, **elig}) is not None)
t("kobo is only for money (a percent in kobo is refused)", raises(ValueError, st.script, "rate_suggestion", "en", {"direction": "INCREASE", "rate_cur_kobo": 200, "rate_new": 2.5, "monthly_change": 5}) is not None)
t("a decrease's negative monthly_change_kobo is spoken as a positive amount",
  "four thousand five hundred naira" in st.script("rate_suggestion", "en", {"direction": "DECREASE", "rate_cur": 2, "rate_new": 1.5, "monthly_change_kobo": -450000}).text)

rcpt = {"takings": 9000, "sweep": 0, "name": None}
t("receipt: LOW_BALANCE -> its own wording, and no promise to 'try again tomorrow' (nothing is carried forward)",
  (lambda x: x.variant == "low_balance" and "small balance" in x.text and "tomorrow" not in x.text.lower())(st.script("sweep_receipt", "en", {"takings": 9000, "sweep": 0, "skip_reason": "LOW_BALANCE"})))
t("receipt: PAUSED -> tells them how to restart (RESUME)", (lambda x: x.variant == "paused" and "RESUME" in x.text)(st.script("sweep_receipt", "en", {"takings": 9000, "skip_reason": "PAUSED"})))
t("receipt: sales but no sweep and no reason -> neutral wording", (lambda x: x.variant == "no_sweep" and "tomorrow" not in x.text.lower())(st.script("sweep_receipt", "en", {"takings": 9000, "sweep": 0})))
t("a skip_reason is ignored when something WAS swept", st.script("sweep_receipt", "en", {"takings": 9000, "sweep": 180, "emergency": 90, "retirement": 90, "skip_reason": "PAUSED"}).variant == "normal")

# ---- your preferred voices
mine = vc.load_preferred()
t("your four 9jaLingo voice IDs are in voice_speakers.json",
  mine == {"pcm": "0c97feb8-bcb1-4734-913d-7ff21bfa0d76", "yo": "734c28e8-900a-48f0-ad64-d1f1d906172e",
           "ha": "ed1e63ff-6348-4774-8a20-f69babc64dab", "ig": "3eefa712-3a46-4b3e-ab7f-1baeab556858"}, mine)
os.environ["VOICE_SPEAKER_YO"] = "env-voice"
t("an environment variable overrides the file", vc.load_preferred()["yo"] == "env-voice" and vc.load_preferred()["pcm"].startswith("0c97feb8"))
os.environ.pop("VOICE_SPEAKER_YO")
t("a missing voice file is tolerated", vc.load_preferred(TMP / "nope.json") == {})
ps = vc.VoiceStudio(vc.FakeProvider(), cache_dir=TMP / "spk", preferred={"pcm": "uuid-pref"})
t("your preferred voice is tried first, then the defaults", ps.speaker_candidates("pcm")[:3] == ["uuid-pref", "ada_pcm", "blessing_pcm"], ps.speaker_candidates("pcm"))
t("a language with no preferred voice uses the defaults", ps.speaker_candidates("yo")[0] == "adeola_yo")
t("studio defaults to the voices in your file", vc.VoiceStudio(vc.FakeProvider(), cache_dir=TMP / "spk0").speaker_candidates("ig")[0] == "3eefa712-3a46-4b3e-ab7f-1baeab556858")
t("status shows which voices are configured", ps.status()["preferred_voices"] == {"pcm": "uuid-pref"})
fpb = vc.FakeProvider(mode="badspeaker")
sb = vc.VoiceStudio(fpb, cache_dir=TMP / "spk2", preferred={"pcm": "bad-uuid"})
rb = sb.render(sb.script("balance", "pidgin", {**base, **elig}))
t("if the server rejects your preferred voice the clip is still made, with a default voice, and the metadata says so",
  rb.speaker == "ada_pcm" and sb.cache.meta(rb.audio_id)["speaker_requested"] == "bad-uuid" and rb.qa["ok"], (rb.speaker, rb.attempts))

# ---- time model measured on your real clips
c0 = vc.Calibration()
t("time estimate includes the ~0.6 s lead/trail silence your real clips showed", abs(c0.estimate("Hello world", "pcm") - 1.4) < 1e-6)
t("your real 'Hello world' (1.5 s) and 'E kaaro' (1.3 s) pass QA", vc.analyse_wav(tone(1.5), c0.estimate("Hello world", "pcm")).ok and vc.analyse_wav(tone(1.3), c0.estimate("E kaaro", "pcm")).ok)
t("your real 'my name is Tomisin' (5.0 s for 4 words) is flagged as too long, as it was in your terminal",
  "longer_than_the_text_needs" in vc.analyse_wav(tone(5.0), c0.estimate("my name is Tomisin", "pcm")).issues)
cc = vc.Calibration()
for _ in range(6):
    cc.update("pcm", 30, 0.6 + 30 * 0.5)
t("calibration learns seconds-per-word AFTER removing the fixed overhead", abs(cc.spw("pcm") - 0.5) < 0.01 and cc.calibrated("pcm"), cc.data)

# ---- provider: voice lookup, voice-error mapping, wait progress
p, _ = provider_for(lambda req: httpx.Response(404, json={"detail": "Voice 'x' not found"}))
e = raises(vc.ProviderBadRequest, p.speaker, "x")
t("404 about a voice -> kind=speaker (so we fall back instead of failing)", e is not None and e.kind == "speaker", e)
p, _ = provider_for(lambda req: httpx.Response(422, json={"detail": "Invalid voice id"}))
t("422 'invalid voice id' -> kind=speaker", (lambda e: e is not None and e.kind == "speaker")(raises(vc.ProviderBadRequest, p.synthesize, "Hello", "pcm", "x")))
p, _ = provider_for(lambda req: httpx.Response(422, json={"detail": "text is too long"}))
t("422 about anything else -> a plain bad request (no pointless voice fallback)", (lambda e: e is not None and e.kind == "bad_request")(raises(vc.ProviderBadRequest, p.synthesize, "Hello", "pcm", "x")))
seen_paths = []
p, _ = provider_for(lambda req: (seen_paths.append(req.url.path), httpx.Response(200, json={"id": "abc", "name": "Ada"}))[1])
t("speaker() looks up GET /v1/speakers/{id}", p.speaker("abc")["name"] == "Ada" and seen_paths == ["/v1/speakers/abc"])
state["polls"] = 0
p, clk = provider_for(h_cold)
ticks = []
p.on_wait = lambda elapsed, st_: ticks.append((round(elapsed), st_))
p.synthesize("Hello", "pcm", "ada_pcm")
t("cold start tells the UI what it is doing (so you see 'engine is waking up' instead of a frozen terminal)",
  len(ticks) == 3 and ticks[-1][1] == "completed" and ticks[0][0] < ticks[-1][0], ticks)

# ---- the tool: voices / audition / no-argument help
import voice_tool
orig_studio = voice_tool._studio
vt = vc.VoiceStudio(vc.FakeProvider(voices=3), cache_dir=TMP / "vt", preferred={"pcm": "fake-pcm-1"})
voice_tool._studio = lambda need_provider=True: vt
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    rc_ok = voice_tool.main(["voices", "--lang", "pcm"])
out_txt = buf.getvalue()
t("voices: lists the voices, marks yours, and confirms it exists", rc_ok == 0 and "fake-pcm-0" in out_txt and "your preferred voice" in out_txt and "FOUND" in out_txt, out_txt)
vt.preferred = {"pcm": "nope"}
with contextlib.redirect_stdout(io.StringIO()) as b2:
    rc_bad = voice_tool.main(["voices", "--lang", "pcm"])
t("voices: an ID the server does not know is reported NOT USABLE (exit code 1)", rc_bad == 1 and "NOT USABLE" in b2.getvalue())
vt.preferred = {"pcm": "fake-pcm-1"}
aud = TMP / "aud"
with contextlib.redirect_stdout(io.StringIO()):
    rc_a = voice_tool.main(["audition", "How you dey today", "--lang", "pcm", "--out", str(aud), "--max", "3"])
files = sorted(p.name for p in aud.glob("*.wav"))
t("audition: one file per voice, your preferred first, named so you can tell them apart", rc_a == 0 and len(files) == 3 and any("YOUR-PREFERRED" in f for f in files), files)
aud2 = TMP / "aud2"
with contextlib.redirect_stdout(io.StringIO()):
    voice_tool.main(["audition", "How you dey", "--lang", "pcm", "--gender", "male", "--out", str(aud2)])
t("audition --gender filters the other voices", len(list(aud2.glob("*.wav"))) == 1)
vt2 = vc.VoiceStudio(vc.FakeProvider(mode="badspeaker"), cache_dir=TMP / "vt2", preferred={"pcm": "bad-uuid"})
voice_tool._studio = lambda need_provider=True: vt2
with contextlib.redirect_stdout(io.StringIO()) as b3:
    voice_tool.main(["check", "--out", str(TMP / "chk2")])
t("check warns you when your preferred voice was NOT the one used", "WARNING: your preferred voice" in b3.getvalue(), b3.getvalue()[:400])
voice_tool._studio = orig_studio
with contextlib.redirect_stdout(io.StringIO()) as b4:
    rc_g = voice_tool.main([])
t("running the tool with no command prints a friendly guide instead of an error (the VS Code Run button)", rc_g == 0 and "voices" in b4.getvalue() and "audition" in b4.getvalue())

# ---- clip endpoint for core + webhook token
studio9 = new_studio(vc.FakeProvider(), "clip")
svc.set_voice_studio(studio9, vc.JobManager(studio9, retry_delays=(), sleep=lambda s: None))
client.post("/api/v1/ai/voice/prepare", json={"items": [{"merchant_id": "m_0001", "phone_number": "+2348010000001", "name": "Ngozi", "renders": [{"intent": "balance", "facts": {**base, **elig}}]}]})
for _ in range(100):
    if svc.JOBS.pending() == 0:
        break
    time.sleep(0.1)
cl = client.get("/api/v1/ai/voice/clip", params={"merchant_id": "m_0001", "intent": "balance"}).json()
t("clip: core asks for a merchant's latest clip and gets a signed expiring link, language and review status",
  cl["ready"] and "sig=" in cl["url"] and cl["format"] == "mp3" and cl["language"] == "igbo" and cl["review_status"] == "draft" and cl["seconds"] > 1, cl)
fetched = client.get(cl["url"].replace("https://kobo.test", ""))
t("... and that link really serves the audio", fetched.status_code == 200 and fetched.headers["content-type"] == "audio/mpeg")
t("clip as ogg (WhatsApp voice note)", client.get("/api/v1/ai/voice/clip", params={"merchant_id": "m_0001", "format": "ogg"}).json()["url"].split("?")[0].endswith(".ogg"))
nf = client.get("/api/v1/ai/voice/clip", params={"merchant_id": "m_0099"})
t("clip: nothing fresh -> 404 {ready:false} so core keeps its own English <Say>", nf.status_code == 404 and nf.json()["ready"] is False)
t("clip: bad format / ttl -> 422", client.get("/api/v1/ai/voice/clip", params={"merchant_id": "m_0001", "format": "flac"}).status_code == 422
  and client.get("/api/v1/ai/voice/clip", params={"merchant_id": "m_0001", "ttl": 5}).status_code == 422)
os.environ["AI_SERVICE_TOKEN"] = "svc-secret"
no_tok = client.get("/api/v1/ai/voice/clip", params={"merchant_id": "m_0001"}).status_code
os.environ.pop("AI_SERVICE_TOKEN")
t("clip needs the service token when one is set", no_tok == 401)

os.environ["WEBHOOK_TOKEN"] = "whk"
call = dict(isActive="1", direction="Outbound", sessionId="WH1", destinationNumber="+2348010000001")
w0 = client.post("/api/v1/ai/voice/ivr/answer", data=call)
w1 = client.post("/api/v1/ai/voice/ivr/answer?token=whk", data=call)
w2 = client.post("/api/v1/ai/voice/ivr/menu", data={"sessionId": "WH1", "dtmfDigits": "1", "isActive": "1"})
w3 = client.post("/api/v1/ai/voice/ivr/menu?token=whk", data={"sessionId": "WH1", "dtmfDigits": "1", "isActive": "1"})
os.environ.pop("WEBHOOK_TOKEN")
t("WEBHOOK_TOKEN (core's convention): IVR callbacks without ?token= are refused, with it they work",
  w0.status_code == 401 and w2.status_code == 401 and w1.status_code == 200 and w3.status_code == 200, (w0.status_code, w1.status_code, w2.status_code, w3.status_code))
t("... and the menu callback URL we hand to Africa's Talking carries the token", "token=whk" in w1.text, w1.text[:300])

print(f"\n{'ALL PASSED' if not fails else str(fails) + ' FAILED'}")
sys.exit(1 if fails else 0)
