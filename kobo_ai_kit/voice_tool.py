#!/usr/bin/env python3
"""
Kobo Kobo voice tool: the commands you run on YOUR PC with your 9jaLingo key.

    python voice_tool.py review            # offline: writes voice_review_sheet.md for native-speaker review
    python voice_tool.py warm              # wake the 9jaLingo engine (do this ~10 min before a demo)
    python voice_tool.py check             # real end-to-end test: engine, voices, one clip per language, QA, files to listen to
    python voice_tool.py pack              # pre-render everything the demo needs, so nothing is generated live
    python voice_tool.py say "Mo ti gbà" --lang yo      # hear any sentence (quick experiment)

Your key goes in a file named .env next to this script (copy .env.example). Never commit .env, never paste it in chat.
"""
import sys as _sys
from pathlib import Path as _Path

_HERE = str(_Path(__file__).resolve().parent)
if _HERE not in _sys.path:
    _sys.path.insert(0, _HERE)

import argparse
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import voice as vc

HERE = Path(__file__).resolve().parent

# DEMO DATA only. Real facts come from the ledger (Caleb) via POST /api/v1/ai/voice/prepare.
DEMO = {
    "m_0001": {"name": "Ngozi", "balance": {"total": 36800, "emergency": 18400, "retirement": 18400, "vesting_days": 0, "cooldown_days": 0},
               "receipt": {"takings": 38000, "sweep": 760, "emergency": 380, "retirement": 380}},
    "m_0002": {"name": "Musa", "balance": {"total": 12400, "emergency": 6200, "retirement": 6200, "vesting_days": 0, "cooldown_days": 0},
               "receipt": {"takings": 21000, "sweep": 420, "emergency": 210, "retirement": 210}},
    "m_0003": {"name": "Chidi", "balance": {"total": 0},
               "receipt": {"takings": 0, "sweep": 0}},
    "m_0004": {"name": "Bisi", "balance": {"total": 22000, "emergency": 11000, "retirement": 11000, "vesting_days": 12, "cooldown_days": 0},
               "receipt": {"takings": 0, "sweep": 0}},
    "m_0005": {"name": "Tunde", "balance": {"total": 54000, "emergency": 27000, "retirement": 27000, "vesting_days": 0, "cooldown_days": 0},
               "receipt": {"takings": 66950, "sweep": 1340, "emergency": 670, "retirement": 670, "held_amount": 10000000}},
}
DEMO_SUGGESTIONS = {
    "m_0001": {"direction": "INCREASE", "rate_cur": 2, "rate_new": 2.5, "monthly_change": 5700},
    "m_0002": {"direction": "DECREASE", "rate_cur": 2, "rate_new": 1.5, "monthly_change": -4500},
}
STATIC = ["ivr_welcome", "ivr_invalid", "ivr_goodbye", "ivr_unknown", "ivr_not_ready", "ivr_outbound_only"]
ALL_LANGS = ["en", "pidgin", "yoruba", "hausa", "igbo"]


GUIDE = """Kobo Kobo voice tool. Pick a command (type it in the terminal after 'python voice_tool.py'):

  voices                      list your voices and check your preferred ones
  audition "text" --lang yo   hear one sentence in many voices, then choose
  say "text" --lang pcm       hear one sentence (pcm = Pidgin/English, yo, ha, ig)
  warm                        wake the engine before a demo
  check                       full real test: one clip per language
  pack                        pre-render everything the demo needs
  export                      copy packed clips out as static files + manifest.json for the app
  review                      write voice_review_sheet.md for native speakers

Example:  python voice_tool.py voices
"""


def _studio(need_provider=True):
    st = vc.build_studio_from_env()
    if isinstance(st.provider, vc.NaijaLingoProvider):
        st.provider.max_wait = float(os.getenv("VOICE_TOOL_MAX_WAIT", "900"))     # a cold start can take minutes
        st.provider.on_wait = lambda s, state: print(f"   ...the engine is waking up ({s:.0f}s, status: {state}). Please wait, this is normal after a quiet period.", flush=True)
    if need_provider and st.provider.name == "none":
        print("No voice provider configured.\n"
              "  1. Copy .env.example to .env (same folder as this script)\n"
              "  2. Put your key on the line NAIJALINGO_API_KEY=...\n"
              "  3. Run this command again.")
        raise SystemExit(2)
    return st


def _save_formats(st, audio_id, base):
    saved = []
    for fmt in ("wav", "mp3", "ogg"):
        try:
            data, _ = st.get_audio(audio_id, fmt)
        except vc.TranscodeUnavailable:
            continue
        p = Path(f"{base}.{fmt}")
        p.write_bytes(data)
        saved.append(p.name)
    return saved


# ----------------------------------------------------------------------------- review (offline)
def cmd_review(a):
    st = vc.VoiceStudio(vc.NullProvider(), cache_dir=Path(a.cache), allow_draft=True)
    facts = {"total": 36800, "emergency": 18400, "retirement": 18400, "takings": 38000, "sweep": 760,
             "rate_cur": 2, "rate_new": 2.5, "monthly_change": 5700, "vesting_days": 12, "cooldown_days": 20,
             "held_amount": 10000000}
    lines = ["# Kobo Kobo voice scripts: native-speaker review sheet", "",
             f"Generated {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}. Sample amounts: balance 36,800; today's sales 38,000; saved 760.", "",
             "## How to review", "",
             "1. Read each **spoken text** aloud as a trader would hear it on the phone.",
             "2. Check: correct language, natural wording, correct spelling and tone marks / dots (Yoruba and Igbo).",
             "3. Amounts are spoken in **English number words** on purpose (Nigerians usually say money in English).",
             "   Tell us if a language should use its own number words instead.",
             "4. The words **yes** (and the on-screen **YES**) must stay English: the SMS handler reads YES.",
             "5. Write the corrected sentence in the last column. When a language is fully reviewed, change its `status` to",
             "   `approved` in `voice_templates.json` (only a native speaker should do that).", "",
             "Status now: " + ", ".join(f"**{k}** = {v['status']}" for k, v in st.book.languages.items()), ""]
    for intent, variants in st.book.intents.items():
        for variant in variants:
            lines += [f"## {intent} / {variant}", "", "| Language | Spoken text | Correction |", "|---|---|---|"]
            for lang in ALL_LANGS:
                try:
                    sc = st.script(intent, lang, {**facts, "direction": variant.upper()}, name="Ngozi" if intent != "ivr_welcome" else None,
                                   variant=variant, max_seconds=60)
                    text = sc.text.replace("|", "/")
                    lines.append(f"| {st.book.languages[lang]['name']} ({sc.status}) | {text} | |")
                except vc.VoiceError as e:
                    lines.append(f"| {lang} | ERROR: {e} | |")
            lines.append("")
    out = Path(a.out)
    out.write_text("\n".join(lines), encoding="utf-8")
    print(f"Wrote {out}  ({sum(1 for l in lines if l.startswith('| ') and 'Spoken text' not in l)} sentences to review)")
    return 0


# ----------------------------------------------------------------------------- warm
def cmd_warm(a):
    st = _studio()
    print("Waking the 9jaLingo engine. If it was asleep this can take several minutes. Please wait...")
    t0 = time.time()
    spk = st.speaker_candidates("pcm")[0]
    for attempt in range(1, a.tries + 1):
        try:
            st.provider.synthesize("Hello.", "pcm", spk)
            print(f"Engine is warm after {time.time() - t0:.0f}s. You can render clips now.")
            return 0
        except vc.VoiceError as e:
            print(f"  attempt {attempt}/{a.tries}: {e}")
            if not e.retryable:
                return 1
    print("The engine did not wake up. Check the 9jaLingo status/dashboard, or try again in a few minutes.")
    return 1


# ----------------------------------------------------------------------------- check
def cmd_check(a):
    st = _studio()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    bad = 0
    print("1) Is the engine up?")
    h = st.provider.health()
    print("  ", h)
    bad += not h.get("ok")
    print("\n2) Voices available")
    for tl in ("pcm", "yo", "ha", "ig"):
        sp = st.discover_speakers(tl)
        ids = {s["id"] for s in sp}
        want = [s for g in ("female", "male") for s in st.DEFAULT_SPEAKERS[tl][g]]
        missing = [w for w in want if sp and w not in ids]
        print(f"   {tl}: {len(sp)} voice(s)" + (f"   NOT FOUND (will fall back): {', '.join(missing)}" if missing else "   defaults present")
              + ("" if sp else "   (could not list voices)"))
    print("\n3) One real clip per language (this is the real test: listen to the files)")
    first = True
    for lang in ("pidgin", "yoruba", "hausa", "igbo", "en"):
        sc = st.script("balance", lang, DEMO["m_0001"]["balance"], name=a.name)
        t0 = time.time()
        try:
            r = st.render(sc, force=True)
        except vc.VoiceError as e:
            bad += 1
            print(f"   [{lang}] FAILED: {e}")
            first = False
            continue
        wall = time.time() - t0
        files = _save_formats(st, r.audio_id, out / f"{lang}_balance")
        print(f"   [{lang}] {sc.status.upper()} script, voice {r.speaker}, audio {r.seconds:.1f}s "
              f"(we expected ~{sc.est_seconds:.1f}s), took {wall:.0f}s, QA {'OK' if r.qa.get('ok') else 'ISSUES ' + str(r.qa.get('issues'))}")
        pref = st.preferred.get(sc.tts_lang)
        if pref and r.speaker != pref:
            print(f"        WARNING: your preferred voice ({pref[:8]}...) was not used; fell back to {r.speaker}. Run: python voice_tool.py voices")
        print(f"        says: {sc.text}")
        print(f"        saved: {', '.join(files) or 'wav only'} in {out}/")
        if first and wall > 45:
            print("        note: that first clip was slow = the engine was cold. Run 'warm' before demos.")
        first = False
        bad += not r.qa.get("ok")
    print("\n4) What it learned:", json.dumps(st.status()["calibration"]))
    print("\nNext: open the files in", out, "and LISTEN. Pronunciation of the English number words inside Yoruba/Hausa/Igbo")
    print("voices is the thing to check. If it sounds wrong, tell me and we switch those languages to native number words.")
    print("RESULT:", "ALL OK" if not bad else f"{bad} problem(s) above")
    return 1 if bad else 0


# ----------------------------------------------------------------------------- pack
def cmd_pack(a):
    st = _studio()
    jm = vc.JobManager(st)
    langs = a.languages or ALL_LANGS
    todo = []                                       # (label, script, register, gender)
    if a.only in ("all", "static"):
        for lang in langs:
            for intent in STATIC:
                todo.append((f"{intent} [{lang}]", st.script(intent, lang, {}), None))
    if a.only in ("all", "merchants"):
        seed = HERE / "seed" / "merchants.json"
        merchants = {m["id"]: m for m in json.loads(seed.read_text(encoding="utf-8"))} if seed.exists() else {}
        for mid, d in DEMO.items():
            lang = merchants.get(mid, {}).get("preferred_language", "pidgin")
            for intent, key in (("balance", "balance"), ("sweep_receipt", "receipt")):
                todo.append((f"{intent} {mid} [{lang}]", st.script(intent, lang, d[key], name=d["name"]), (mid, intent)))
        for mid, f in DEMO_SUGGESTIONS.items():
            lang = merchants.get(mid, {}).get("preferred_language", "pidgin")
            todo.append((f"rate_suggestion {mid} [{lang}]", st.script("rate_suggestion", lang, f, name=DEMO[mid]["name"]), None))
    print(f"Rendering {len(todo)} clips one at a time (about 12 s each when warm; the first may take minutes if the engine is asleep).")
    jobs = []
    for label, sc, reg in todo:
        jobs.append((label, sc, jm.submit(sc, register=reg)))
    t0 = time.time()
    done = set()
    while len(done) < len(jobs):
        for label, sc, j in jobs:
            if label in done:
                continue
            s = jm.status(j["audio_id"])
            if s["status"] in ("READY", "FAILED"):
                done.add(label)
                print(f"  [{len(done)}/{len(jobs)}] {s['status']:<6} {label}" + (f"   {s['error'][:90]}" if s.get("error") else ""))
        if len(done) < len(jobs):
            time.sleep(2)
    manifest = []
    failed = 0
    for label, sc, j in jobs:
        s = jm.status(j["audio_id"])
        meta = st.cache.meta(j["audio_id"]) or {}
        failed += s["status"] != "READY"
        manifest.append({"label": label, "audio_id": j["audio_id"], "status": s["status"], "error": s.get("error"),
                         "language": sc.language, "review_status": sc.status, "seconds": meta.get("seconds"), "text": sc.text})
    mp = Path(a.manifest)
    mp.write_text(json.dumps(manifest, indent=1, ensure_ascii=False), encoding="utf-8")
    print(f"\nDone in {time.time() - t0:.0f}s. {len(jobs) - failed}/{len(jobs)} ready. Manifest: {mp}")
    print("Audio is in", st.cache.root, "(keep this folder for the demo: the IVR plays from it, nothing is generated live).")
    return 1 if failed else 0


# ----------------------------------------------------------------------------- export (static clips for the app)
def cmd_export(a):
    """Copy the rendered demo clips out of the cache as plain audio files plus a manifest, so the Node app can serve them
    as STATIC assets (PRD v3 8.4: pre-recorded clips). No internet, no key and no service needed at demo time."""
    st = _studio(need_provider=False)
    mp = Path(a.manifest)
    if not mp.exists():
        print(f"{mp} not found. Run  python voice_tool.py pack  first.")
        return 2
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    clips, skipped = [], 0
    for m in json.loads(mp.read_text(encoding="utf-8")):
        if m.get("status") != "READY":
            skipped += 1
            continue
        slug = re.sub(r"[^a-z0-9]+", "-", m["label"].lower()).strip("-")
        files = {}
        for fmt in a.formats:
            try:
                data, _ = st.get_audio(m["audio_id"], fmt)
            except vc.VoiceError as e:
                print(f"  skip {slug}.{fmt}: {e}")
                continue
            (out / f"{slug}.{fmt}").write_bytes(data)
            files[fmt] = f"{slug}.{fmt}"
        if files:
            clips.append({"id": slug, "label": m["label"], "language": m["language"], "review_status": m["review_status"],
                          "seconds": m.get("seconds"), "text": m["text"], "files": files})
    (out / "manifest.json").write_text(json.dumps({"_demo_data": True, "clips": clips}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"Exported {len(clips)} clip(s) x {', '.join(a.formats)} to {out}/ (+ manifest.json). {skipped} skipped (not ready).")
    print("Serve the folder as static files. Play by id; if a clip is missing or a language is a draft, speak the manifest's `text` with the browser instead.")
    return 0 if clips else 1


# ----------------------------------------------------------------------------- say
def cmd_say(a):
    st = _studio()
    spk = a.speaker or st.speaker_candidates(a.lang, a.gender)[0]
    t0 = time.time()
    wav = st.provider.synthesize(a.text, a.lang, spk)
    qa = vc.analyse_wav(wav, st.calib.estimate(a.text, a.lang))
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    p = out / f"say_{a.lang}.wav"
    p.write_bytes(wav)
    print(f"voice {spk}, {qa.seconds:.1f}s of audio in {time.time() - t0:.0f}s, QA {'OK' if qa.ok else qa.issues}. Saved {p}")
    return 0 if qa.ok else 1


# ----------------------------------------------------------------------------- voices / audition
def cmd_voices(a):
    st = _studio()
    langs = [a.lang] if a.lang else ["pcm", "yo", "ha", "ig"]
    bad = 0
    for tl in langs:
        pref = st.preferred.get(tl)
        sp = st.discover_speakers(tl)
        print(f"\n{tl}: {len(sp)} voice(s) listed")
        for s in sp:
            print(f"   {s['id']}  {str(s.get('name') or '-'):<16} {str(s.get('gender') or '-'):<8}" + ("  <- your preferred voice" if s["id"] == pref else ""))
        if pref:
            try:
                info = st.provider.speaker(pref)
                print(f"   preferred voice {pref}: FOUND" + (f" ({info.get('name')})" if isinstance(info, dict) and info.get("name") else ""))
            except vc.VoiceError as e:
                bad += 1
                print(f"   preferred voice {pref}: NOT USABLE ({e}). The system will fall back to a default voice.")
        else:
            print("   no preferred voice set (edit voice_speakers.json)")
    print("\nHear them: python voice_tool.py audition --lang yo \"Báwo ni\"")
    return 1 if bad else 0


def cmd_audition(a):
    """Say the same sentence in several voices and save each, so you can choose by ear."""
    st = _studio()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    pref = st.preferred.get(a.lang)
    cands = ([{"id": pref, "name": "YOUR-PREFERRED", "gender": "-"}] if pref else [])
    cands += [s for s in st.discover_speakers(a.lang) if s["id"] != pref and (not a.gender or s.get("gender") == a.gender)]
    cands = cands[: a.max]
    if not cands:
        print("No voices found for", a.lang, "(check your key, or pass --max higher).")
        return 1
    est = st.calib.estimate(a.text, a.lang)
    print(f"Auditioning {len(cands)} voice(s) for [{a.lang}]: {a.text!r}   (about 12 s each when warm)")
    worked = 0
    for s in cands:
        label = re.sub(r"[^A-Za-z0-9_-]", "", str(s.get("name") or "voice"))[:20] or "voice"
        t0 = time.time()
        try:
            wav = st.provider.synthesize(a.text, a.lang, s["id"])
        except vc.VoiceError as e:
            print(f"   {label:<20} FAILED: {str(e)[:90]}")
            continue
        qa = vc.analyse_wav(wav, est)
        p = out / f"audition_{a.lang}_{label}_{str(s['id'])[:8]}.wav"
        p.write_bytes(wav)
        worked += 1
        print(f"   {label:<20} {str(s.get('gender') or '-'):<7} {qa.seconds:.1f}s in {time.time() - t0:.0f}s  QA {'OK' if qa.ok else qa.issues}  -> {p.name}")
    print(f"\nSaved {worked} file(s) in {out}/. Listen, then put your favourite's full ID in voice_speakers.json")
    print("(or set VOICE_SPEAKER_" + a.lang.upper() + " in .env). The ID is the long code in the file name's list above: run 'voices' to see it.")
    return 0 if worked else 1


def main(argv=None):
    ap = argparse.ArgumentParser(prog="voice_tool.py", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("review", help="offline: write the native-speaker review sheet")
    p.add_argument("--out", default="voice_review_sheet.md")
    p.add_argument("--cache", default=str(HERE / "voice_cache"))
    p.set_defaults(fn=cmd_review)
    p = sub.add_parser("warm", help="wake the 9jaLingo engine")
    p.add_argument("--tries", type=int, default=3)
    p.set_defaults(fn=cmd_warm)
    p = sub.add_parser("check", help="real end-to-end check with your key")
    p.add_argument("--out", default="voice_out")
    p.add_argument("--name", default="Ngozi")
    p.set_defaults(fn=cmd_check)
    p = sub.add_parser("pack", help="pre-render the demo pack")
    p.add_argument("--only", choices=["all", "static", "merchants"], default="all")
    p.add_argument("--languages", nargs="*", choices=ALL_LANGS)
    p.add_argument("--manifest", default="voice_pack_manifest.json")
    p.set_defaults(fn=cmd_pack)
    p = sub.add_parser("voices", help="list your voices and check your preferred ones")
    p.add_argument("--lang", choices=["pcm", "yo", "ha", "ig"])
    p.set_defaults(fn=cmd_voices)
    p = sub.add_parser("audition", help="hear one sentence in many voices and choose")
    p.add_argument("text")
    p.add_argument("--lang", required=True, choices=["pcm", "yo", "ha", "ig"])
    p.add_argument("--gender", choices=["female", "male"])
    p.add_argument("--max", type=int, default=6)
    p.add_argument("--out", default="voice_out")
    p.set_defaults(fn=cmd_audition)
    p = sub.add_parser("export", help="write the packed clips out as static files + manifest.json for the app")
    p.add_argument("--manifest", default="voice_pack_manifest.json")
    p.add_argument("--out", default="voice_clips")
    p.add_argument("--formats", nargs="+", default=["mp3"], choices=["mp3", "ogg", "wav"])
    p.set_defaults(fn=cmd_export)
    p = sub.add_parser("say", help="hear one sentence")
    p.add_argument("text")
    p.add_argument("--lang", default="pcm", choices=["pcm", "yo", "ha", "ig"])
    p.add_argument("--speaker")
    p.add_argument("--gender", default="female", choices=["female", "male"])
    p.add_argument("--out", default="voice_out")
    p.set_defaults(fn=cmd_say)
    argv = sys.argv[1:] if argv is None else argv
    if not argv:
        print(GUIDE)
        return 0
    a = ap.parse_args(argv)
    return a.fn(a)


if __name__ == "__main__":
    sys.exit(main())
