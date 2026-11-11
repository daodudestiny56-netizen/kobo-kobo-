# Kobo Kobo AI Kit: Sweep Guard, Smart Rate, Voice

Owner: Tomiwa (AI/ML) | aligned to PRD v3.0.0 (Forge sandbox) and Caleb's `AI_ML_HANDOFF.md` / `openapi.yaml` | one Python service, port 8080 (8001 when run by hand)

The AI only **advises**. The app decides and moves the money. Nothing here debits an account or changes a rate by itself.

## Read this first: the team decision, and what this kit is now

**Status: the TypeScript port is done** (`server/src/intel/sweepguard.ts`, `smartrate.ts`, wired in by `server/src/guard/statistical.ts` and `server/src/smart-rate/analyze.ts`, tests in `server/tests/intel-*.test.ts`). This kit stays as the reference implementation.

**Decision (team lead):** no second service. SweepGuard and SmartRate are ported to **TypeScript as pure functions inside the Node app** (`src/intel/sweepguard.ts`, `src/intel/smartrate.ts`, plain arrays like `{amountKobo, at}`), in-process only, no remote mode, no public `/ai/*`, model calls only from Node.

| In this kit | Role now |
|---|---|
| `smart_rate.py`, the Sweep Guard rules in `kobo_ai_service.py`, `core_client.py`, `test_*.py` (400 checks) | **Reference implementation.** The behaviour the TypeScript port must match. The FastAPI service is a test harness, not deployed |
| `ts/src/intel/types.ts` | The TypeScript **signatures** (compile under `tsc --strict`). **The port itself is NOT written yet.** Reply to the lead: signatures are ready now |
| `generate_demo_history.py` -> `demo_history.json` | Synthetic **kobo** history for the 4 sandbox traders (Adaeze, Babatunde, Musa, Efosa), flagged `_demo_data`, for the team's seed script |
| `voice_tool.py pack` then `export` -> `voice_clips/*.mp3` + `manifest.json` | Pre-recorded demo clips as **static files** (PRD v3 8.4). No key, internet or service needed at demo time |
| `fallback/` (Dockerfile, ai-service.yaml) | **Only if the TypeScript port cannot be finished** (limits: 100m CPU / 192Mi, no shared DB, 2 s timeout, static fallback) |

**Porting note:** the Smart Rate confidence comes from a seeded bootstrap (numpy). A TypeScript port cannot reproduce numpy's random stream, so parity tests should compare **decisions and metrics** (action, rate, regime, hold reason, averages, trend) and allow about +-0.03 on `confidence`; or first switch both sides to one shared PRNG (not done).

## 0. Status at a glance

| Part | Built | Tested here (offline) | NOT verified (needs you / the team) |
|---|---|---|---|
| Sweep Guard `POST /evaluate` (whole-sweep and PRD v3 partial mode) | yes | 25 rule checks + 47 contract checks | live calls from the app |
| Name match (BVN name vs account name) | yes | 17 labelled pairs | real names |
| Smart Rate (analysis + proposal to core) | yes | 55 + 28 checks, 8-archetype backtest | real merchants (calibrated on synthetic data) |
| Voice: scripts, 9jaLingo client, cache, quality gate, MP3/OGG | yes | 238 checks | **sound quality of your chosen voices, per language** |
| Africa's Talking IVR | yes (optional: AT is not in the Forge sandbox) | simulated callbacks | a live AT number |
| Docker + Kubernetes template | yes, now **fallback only** (`fallback/`) | exact container command run, memory measured | not needed under the in-process plan |
| TypeScript port (`src/intel/*.ts`) | **signatures only** | signatures compile | **the port itself** |
| Demo history for the 4 sandbox traders | yes (`generate_demo_history.py`) | verified: 3 of 4 get the expected suggestion | the team's seed script loading it |
| Yoruba / Hausa / Igbo / Pidgin wording | AI drafts | structure only | **native-speaker review** |

**400 automated checks pass** (`test_contract` 25, `test_smart_rate` 55, `test_integration` 82, `test_voice` 238). None needs the internet or a key. Running service: about 63 MB at start, 76 MB after voice renders and a Smart Rate run.

## 1. Run it

```
pip install -r requirements.txt
python -m uvicorn kobo_ai_service:app --port 8001        # Swagger: http://localhost:8001/docs
```
`http://localhost:8001/healthz` is instant (`{"ok":true}`); `/health` also shows `seed_found`, `voice_provider`, `guard_mode`.
Tests: `python test_contract.py`, `python test_smart_rate.py`, `python test_integration.py`, `python test_voice.py`. Backtest: `python smart_rate_sim.py`.

Your key: copy `.env.example` to `.env` and fill `NAIJALINGO_API_KEY=`. `.env` is git-ignored. **Never commit it or paste it anywhere.** Keep `.env.example` itself committed (it holds no secret): remove `.env.example` from your `.gitignore` if you added it.

## 2. What PRD v3 changed for the AI part, and what we did

| PRD v3 says | We did |
|---|---|
| 9.1: only the flagged credit is excluded, the rest still sweeps | `POST /evaluate` has `mode: "partial"` (env `GUARD_MODE=partial`). Core's original contract (whole-sweep HOLD) stays the default |
| 9.1: exact duplicate `event_id`/`bank_reference` is ignored; same sender + amount + narration within a short window is flagged | partial mode ignores exact duplicates (counted once) and flags look-alikes within 5 minutes (send optional `sender`, `narration`) |
| 9.1: at least 7 days of history, absolute floor, bootstrap from the seeded October statements | minimum is now 7 days, floor N100,000, and `POST /api/v1/ai/history` loads past statements (section 3.3) |
| 6.1: rolling window ending 23:00 WAT, nothing missed or counted twice | credits are bucketed by sweep day: 22:59 WAT belongs to today's sweep, 23:00 and later to the next |
| Money is integer kobo everywhere | `amount_kobo`, `takings_kobo`, and `*_kobo` voice facts (`total_kobo`) alongside naira decimal strings |
| 6.2: daily cap (N5,000 default) | Smart Rate no longer offers a higher rate when the cap already binds (`DAILY_CAP_REACHED`) and the "adds about N..." figure respects the cap |
| 6.5: no channel may say "available now" when it is not | a balance with savings **must** carry the withdrawal rule (`vesting_days` AND `cooldown_days`, or `emergency_eligible`). Missing = error, never a guess |
| 6.2 / 6.3: low balance is reduced or skipped, nothing is carried forward; paused | new receipt wording for `skip_reason: LOW_BALANCE` and `PAUSED`; no "we will try again tomorrow" |
| 8.4: voice = generated text played by the browser, or pre-recorded clips; Yoruba/Hausa/Igbo flagged machine-generated | we do both: `/voice/script` returns the text for browser speech, `/voice/clip` returns real 9jaLingo audio. Draft languages carry `review_status: "draft"` |
| 5: one container, `/healthz`, port 8080, amd64, no secrets in the image, tags v1/v2 | `fallback/Dockerfile`, `fallback/ai-service.yaml`, `/healthz` (section 7, fallback only) |
| 4: Africa's Talking / telco not available; voice is not a phone call | the IVR code stays (optional, for a real telco later); the Forge demo uses `/voice/clip` in the browser |

**The PRD paste stopped in section 9.2 (SmartRate).** Anything after that (the rest of SmartRate, 9.3, business model, demo script, task split) has not been checked against this kit. Paste the rest.

## 3. How it plugs in

Money may be a decimal-naira string (`"12000.00"`), a number, or integer kobo in a `*_kobo` field. Merchant ids are opaque (UUIDs work). Dates are WAT sweep days.

### 3.1 Sweep Guard: `POST /evaluate` (called before every sweep)
```
{merchant_id, sweep_date, inflows:[{bank_reference, amount | amount_kobo, settled_at, sender?, narration?}], mode?}
-> {"verdict":"CLEAR"}
-> {"verdict":"HOLD","alert_type":"ANOMALOUS_INFLOW"|"SUSPECTED_DUPLICATE","details":{...}}
```
Top-level keys never change (`verdict`, `alert_type`, `details`).
- **whole** (default, core's contract): HOLD blocks the whole sweep; a single-inflow anomaly holds only at HIGH severity (a false HOLD costs a night of savings; `GUARD_HOLD_MIN_SEVERITY=MEDIUM` is stricter).
- **partial** (PRD v3): read `details.excluded_references`, `details.sweepable_total` / `sweepable_total_kobo` and sweep the rest. Real answer for a N10,000,000 accident:
```json
{"verdict":"HOLD","alert_type":"ANOMALOUS_INFLOW","details":{"mode":"partial","score":0.95,"severity":"HIGH",
 "sweepable_references":["NIP-A1","NIP-A3"],"sweepable_total":"66950.00","sweepable_total_kobo":6695000,
 "excluded_references":["NIP-A2"],"excluded_total":"10000000.00","excluded_total_kobo":1000000000,
 "ignored_duplicates":[],"reason":"₦10,000,000 is 1,250x this merchant's typical sale (₦8,000). Held until the trader confirms.",
 "bank_reference":"NIP-A2","alerts":[{"alert_type":"ANOMALOUS_INFLOW","severity":"HIGH","bank_reference":"NIP-A2","reason":"..."}]}}
```
Partial mode also flags MEDIUM anomalies, because holding one credit is cheap. Any internal error answers `CLEAR` and prints the cause. Auth: `GUARD_TOKEN` (Bearer), open when unset. The richer `POST /api/v1/ai/sweep-guard/check` (CLEARED / PARTIAL / HELD) is unchanged.

### 3.2 Smart Rate: we propose to core (confirmed against `openapi.yaml`)
```
POST /api/v1/ai/smart-rate/propose        {merchant_id, current_rate, as_of?, dry_run?}
POST /api/v1/ai/smart-rate/propose-batch  {items:[...]}           <- the scheduled job
```
If a change is warranted we `POST {CORE_URL}/api/v1/smart-rate/suggestions {merchant_id, suggested_rate:"2.5", reason}` (Bearer `SERVICE_TOKEN`). Core texts the trader and changes the rate only after YES, and owns the one-open-suggestion rule, the 14-day cooldown and the 72-hour expiry. Core's answers come back as a `status`: `SENT`, `SKIPPED_PENDING`, `SKIPPED_COOLDOWN` (with `retry_after`), `SKIPPED_UNCHANGED`, `ERROR_UNKNOWN_MERCHANT`, `ERROR_AUTH`, `ERROR_UNREACHABLE` (retryable), and ours: `NO_SUGGESTION`, `DRY_RUN`. `current_rate` is required for merchants not in the seed data. `/issue` and `/respond` are the standalone consent flow (no core): with core use `/propose` only.

### 3.3 Teaching us a merchant's past (bootstrap)
`POST /api/v1/ai/history {merchant_id, inflows:[{bank_reference, amount | amount_kobo, settled_at}]}` records past sales without judging them. At onboarding, send the sandbox's seeded October statement (`GET /transactions`, **only counted credits**: not loans, own transfers, withdrawals or reversals). Safe to repeat. Every `/evaluate` call also teaches us, so the baseline keeps growing.

### 3.4 Voice
After the nightly cutoff, the app sends facts; one clip is rendered at a time (~12 s each):
```
POST /api/v1/ai/voice/prepare
{"items":[{"merchant_id":"<uuid>","phone_number":"+234...","language":"pidgin","name":"Ada","renders":[
  {"intent":"balance","facts":{"total_kobo":3680000,"emergency_kobo":1840000,"retirement_kobo":1840000,"vesting_days":0,"cooldown_days":0}},
  {"intent":"sweep_receipt","facts":{"takings":"38000.00","sweep":"760.00","emergency":"380.00","retirement":"380.00"}}]}]}
```
Then the PWA/USSD simulator asks for the clip: `GET /api/v1/ai/voice/clip?merchant_id=<uuid>&intent=balance` -> `{ready:true, url:<signed, expiring mp3>, language, review_status, seconds, text}`, or 404 `{ready:false}` and the app falls back to browser speech of `POST /voice/script` (text only). Receipt facts: `skip_reason: "LOW_BALANCE"|"PAUSED"` when nothing was swept, `held_amount` to announce a held payment. A `name` is optional (BVN names are often surname-first, so use a preferred name).

### 3.5 Environment variables
| Variable | Used for | Default |
|---|---|---|
| `NAIJALINGO_API_KEY` | voice provider | none (voice serves cached audio only) |
| `VOICE_SPEAKER_PCM/_YO/_HA/_IG` | override a preferred voice id | from `voice_speakers.json` |
| `PUBLIC_BASE_URL` | address clients use for audio links | relative URLs |
| `VOICE_URL_SECRET` | signs audio links (required in production) | unsigned |
| `GUARD_MODE` | `whole` or `partial` | whole |
| `GUARD_TOKEN`, `AI_SERVICE_TOKEN`, `WEBHOOK_TOKEN` | Bearer for `/evaluate`; Bearer for other `/api/v1/ai/*`; `?token=` on IVR callbacks | open |
| `GUARD_HOLD_MIN_SEVERITY` | `HIGH` (whole) / `MEDIUM` (partial) by default | by mode |
| `CORE_URL`, `SERVICE_TOKEN` | calling the app | `http://localhost:3000`, none |
| `DAILY_CAP_NAIRA`, `SWEEP_CUTOFF_HOUR` | PRD v3 6.2 / 6.1 | 5000, 23 |
| `VOICE_ALLOW_DRAFT` | 1 = use AI-drafted languages, 0 = approved only (others fall back to English) | 1 |
| `VOICE_CACHE_DIR`, `SEED_DIR`, `FFMPEG_BIN`, `IVR_ALLOW_INBOUND`, `VOICE_PROVIDER` (`fake` = test tones only) | paths / switches | next to the code |

### 3.6 Open questions for Caleb / the team
1. Who calls `/evaluate` in v3 (the Node app, or do you port the statistics to TypeScript)? The PRD diagram puts SweepGuard/SmartRate inside the app; this kit works as a separate internal pod (section 7).
2. Which `mode` does the Node app want? (partial matches PRD 9.1.)
3. Audio links must reach the browser: the app must proxy `/ai/*` to this service (only one public service exists).
4. The held credit's later release (ops dismiss/confirm) is the app's side.

## 4. Sweep Guard rules and name match
- **Anomalous inflow:** robust z-score on log(amount) against the last 30 sweep days (median + MAD), flagged at z >= 3 and at least N100,000; HIGH at z >= 5 or 50x the typical sale. Below 7 days of history: absolute thresholds (N500k MEDIUM, N1M HIGH). Plain mean + 3 sigma is badly skewed by sale-size distributions; if judges ask: "3 sigma on robust statistics".
- **Name match** `POST /api/v1/ai/name-match {name_a, name_b}`: `>= 0.90` MATCH, `0.70-0.89` REVIEW, `< 0.70` MISMATCH. Token-aware Jaro-Winkler (word-order swaps, missing middle names, initials, titles, typos). Names only. No embeddings: for names they add risk without benefit.

## 5. Smart Rate
One step at a time (+0.5, or down at most 1.0) between 1% and 3.5%, from 30 days of takings.
- Learns each trader's weekly rhythm; ignores regular days off and finished breaks; caps freak days.
- Tells a short bad patch (3-10 days) from a real decline (bigger than the trader's own noise, permutation test); a volatile trader is never labelled "declining". Raises only with 80%+ support, lowers with 60%+; never talks a stable trader down. Affordability cap 3.5%, daily cap respected, December treated as a festive peak (assumption).
- `confidence_score` = share of 500 re-samples that still agree (max 0.99); every answer carries `checks[]`, `rationale`, `insights`.

| archetype | want | INCREASE | HOLD | DECREASE | wrong direction | flicker |
|---|---|---|---|---|---|---|
| steady_high | INCREASE | 100% | 0% | 0% | 0.0% | 0.5% |
| weekly_rhythm | INCREASE | 100% | 0% | 0% | 0.0% | 0.0% |
| closed_on_sundays | INCREASE | 98% | 2% | 0% | 0.0% | 1.5% |
| steady_low | HOLD | 0% | 100% | 0% | 0.0% | 0.0% |
| volatile | DECREASE | 0% | 2% | 98% | 0.0% | 1.4% |
| short_illness | INCREASE | 84% | 16% | 0% | 0.0% | 7.4% |
| persistent_decline | DECREASE | 0% | 45% | 55% | 0.0% | 10.2% |
| freak_big_days | INCREASE | 95% | 5% | 0% | 0.0% | 3.3% |

**Honest limit:** the archetypes are ours, so this proves the engine behaves as designed, not that it matches real traders. It is statistics plus rules, not a trained model (a model trained on our own synthetic data would only learn our generator). Every threshold is a named constant at the top of `smart_rate.py`; recalibrate on real data.

## 6. Voice

### 6.1 Why it is built this way
- The 9jaLingo server handles **one request at a time (~12 s)** and can scale to zero, so a **cold start can take minutes**. Nothing is synthesised on a page load or during a call: audio is **rendered ahead**, cached, and served from the cache. For a live demo: `python voice_tool.py warm`, then `pack`.
- WhatsApp voice notes need **OGG/Opus**; 9jaLingo returns WAV, so we convert with ffmpeg (`pip install imageio-ffmpeg` bundles one).
- Amounts are spoken as **English number words** inside every language (how Nigerians usually say money), so no unreviewed number grammar can corrupt a balance. A missing or negative amount is an **error**, never "zero". The same facts always give the same script (stable cache keys).
- Every clip passes a quality gate (real WAV, not silent, not truncated, plausible length), is retried at a calmer setting, then with a second voice; bad audio is never cached; a corrupt cache file is re-rendered. The time model (`0.6 s + words x seconds-per-word`) was corrected from your real clips and calibrates itself.

### 6.2 Your voices
Your four voice IDs are in **`voice_speakers.json`** (Pidgin/English, Yoruba, Hausa, Igbo); override with `VOICE_SPEAKER_*` in `.env`. They are tried first. If the server rejects one, the clip is still made with a built-in default voice and the metadata and `check` tell you. Choosing by ear:
```
python voice_tool.py voices                          # list voices, mark yours, confirm each exists
python voice_tool.py audition "Báwo ni" --lang yo    # the same sentence in many voices -> voice_out/*.wav, pick one
python voice_tool.py say "E kaaro" --lang yo         # one sentence
python voice_tool.py warm | check | pack | review    # wake engine | full real test | pre-render the demo | review sheet
python voice_tool.py export                          # packed clips -> voice_clips/*.mp3 + manifest.json (static files for the Node app)
```
Run with no command (or the VS Code Run button) and it prints this guide. Waiting on a cold start now shows progress.

### 6.3 Languages and review (important)
English is approved; **Pidgin, Yoruba, Hausa and Igbo are AI drafts** (`status: "draft"` in `voice_templates.json`). Send `voice_review_sheet.md` (85 sentences, Correction column) to native speakers; when a language is fully reviewed, set it to `approved`. With `VOICE_ALLOW_DRAFT=0` only approved languages are used, others fall back to English, flagged in the response. Do not put drafts in front of real traders. The keywords YES and RESUME stay English (the SMS handler matches them).
Check by ear: how each voice pronounces the English number words (and `yes`) inside Yoruba/Hausa/Igbo sentences. If wrong, those languages switch to native number words.

### 6.4 IVR (optional)
For a real telco later: welcome (no amounts) -> 1 balance, 2 receipt, 9 repeat. Balances are read only on **outbound** calls; inbound is refused unless `IVR_ALLOW_INBOUND=1`; calls are tied to the session; stale clips (over 36 h) are never played; missing clips degrade to English audio then Africa's Talking's English `<Say>`. Callbacks: `POST /api/v1/ai/voice/ivr/answer` and `/menu` (+ `?token=` if `WEBHOOK_TOKEN`). Not tested against a live number. Core's own `POST /api/v1/voice/callback` can instead `<Play>` the URL from `/voice/clip`.

### 6.5 Limits
About 5 clips a minute (the server's limit): fine for the demo's 4-10 merchants. Speech-to-text and the WhatsApp bot are not built. `voice_cache/` holds balances and `merchant_directory.json` holds phone numbers: keep out of git (it is in `.gitignore`).

## 7. Deployment: FALLBACK ONLY (the team chose the in-process TypeScript port)
- From the kit's root: `docker build --platform linux/amd64 -f fallback/Dockerfile -t <registry>/kobo-ai:v1 .` (tag v1, v2; never `latest`). Listens on `0.0.0.0:8080`, `GET /healthz`, runs as a non-root user, no secrets in the image.
- `fallback/ai-service.yaml` is a **template, not applied or tested**: an **internal** ClusterIP service (`http://ai.team07.svc.cluster.local`), probes on `/healthz`, requests 50m CPU / 128Mi, limits 200m / 256Mi (measured: ~76 MB), secrets from a `kobo-ai-secrets` Secret (create it with `kubectl`, never commit values), a volume at `/data` for the audio cache (a PVC keeps pre-rendered demo clips across restarts).
- Only one public service (`app`) exists, so the app should proxy `/ai/*` to this service so the browser can fetch signed audio links. Set `PUBLIC_BASE_URL=https://team07.xtradot.co/ai`.
- Services outside the cluster are unreachable from the sandbox: calls to 9jaLingo (`api.9jalingo.org`) need outbound internet from the pod. **Check this early**; if blocked, run `voice_tool.py pack` on a laptop and ship `voice_cache/` on the volume (clips then play offline).
- Synthetic data only, including logs and seeds.

## 8. Seed data (`seed/`)
5 merchants (steady, volatile, new trader with 9 days, sick week, spike demo; Igbo, Hausa, Pidgin, Yoruba, Pidgin), 3,681 inflows, `daily_totals.json`, `scenarios.json` (8 Sweep Guard cases), `kyc_name_pairs.json`. Regenerate: `python generate_seed.py` (deterministic). Demo merchant ids are `m_0001`...; the sandbox's four traders have UUID-style ids, which work the same.

## 9. Files
`smart_rate.py` | `kobo_ai_service.py` | `core_client.py` | `voice.py` | `voice_ivr.py` | `voice_templates.json` | `voice_speakers.json` | `voice_tool.py` | `generate_demo_history.py` | `generate_seed.py` | `smart_rate_sim.py` | `test_*.py` | `voice_review_sheet.md` | `ts/src/intel/types.ts` | `fallback/` | `.dockerignore` | `.env.example` | `.gitignore` | `requirements.txt` | `seed/`

## 10. Troubleshooting
- **`ModuleNotFoundError: smart_rate` / `voice`**: exact filenames (underscore, no spaces); all `.py` files and `seed/` in one folder; the files add their own folder to the import path.
- **`No module named numpy/fastapi/...`**: `pip install -r requirements.txt` with the Python you run the service with.
- **Seed folder:** normally set nothing; `SEED_DIR` must be the folder containing `inflows.json`. `/health` shows `seed_found`.
- **Voice "No voice provider configured"**: no key in `.env`. **"engine still starting"**: cold start, run `voice_tool.py warm`. **"ffmpeg not found"**: `pip install imageio-ffmpeg`. **Voice `check` warns "preferred voice was not used"**: run `voice_tool.py voices`.
- **Core shows `ERROR_AUTH`**: `SERVICE_TOKEN` must equal the app's. **`ERROR_UNREACHABLE`**: check `CORE_URL`; retryable.

## 11. Before you push
One branch per feature (`feature/ai-sweep-guard`, `feature/ai-smart-rate`, `feature/ai-voice`, `feature/ai-deploy`), PR, teammates review and merge. Check the hackathon rules on pre-written code. `git status` must not show `.env`, `voice_cache/` or `voice_out/`. Your voice IDs are not secrets; your API key is.

## 12. What remains
1. **TypeScript port** of SweepGuard and SmartRate against `ts/src/intel/types.ts`, with fixtures from the Python reference. This is the one big item; the lead asked what time the signatures are needed: they are ready now, so tell him when you can commit the port.
2. **You:** `voice_tool.py audition` per language to pick voices; `warm`, `pack`, `export` before the demo (clips as static files); send `voice_review_sheet.md` to native speakers (all non-English text is an AI draft).
3. **Team:** load `demo_history.json` in the seed script; decide how the PWA gets suggestions (inside the merchant summary, per the lead); outbound internet is not needed for the clips plan.
4. **Me, once you paste the rest of PRD v3 (it stopped in section 9.2):** check SmartRate, the demo script and the task split against this kit.
5. Not built: the TypeScript port, speech-to-text, a WhatsApp bot, a model trained on real merchant data.
