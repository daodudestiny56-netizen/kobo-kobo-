# Demo run order

About 5 minutes. Open the app at `https://team07.xtradot.co` (or `kubectl port-forward svc/app 8080:80` and `http://localhost:8080`).

Before you start: open `/sign-in?demo=1` once in the browser (this shows Demo tools, Button phone and Operations), then **Settings, Demo tools, Reset demo**. Sign back in with a demo account.

The ops and demo controls are open while `DEMO_OPEN=1` is set in `k8s/app.yaml`. Remove it after the demo and re-apply.

| # | Show | Do | Say |
|---|---|---|---|
| 1 | The gap | Landing page | 91.4% of personal pension accounts have never received a naira. Fixed debits fail on slow days. |
| 2 | Sign up | Sign up with the Adaeze demo details: account `0123456789`, BVN `22200000001`. Read the consent, agree | The BVN is checked, the name must match the account, consent is recorded. Try BVN `22299999999` to show a refusal. |
| 3 | A day of trading | Demo tools, simulate a customer payment (a few times) | Customers pay as usual. All of it lands in the trader's own account. |
| 4 | The sweep | Operations, Run tonight's saving now | One transfer to the pension account. The pots split 50/50, a receipt with its reference appears. |
| 5 | A bad day | Run again for a trader with no sales | No sales, no sweep. Nothing bounces. |
| 6 | Safety | Operations, run with a forced timeout | The bank did not answer, so we requery, never resend. |
| 7 | Button phone | `/demo/phone`: `BAL`, `PAUSE`, then `CASHOUT 5000` | The early cash-out is refused with the honest reason. |
| 8 | Close | | What is simulated, who benefits, who pays, the approvals still needed. |

## What is simulated

The bank is the Forge sandbox. Customer payments are transfers between team accounts. The pension account and RSA PIN, USSD and SMS are simulated. SweepGuard and SmartRate are real statistics and rules (`server/src/intel`), calibrated on synthetic traders. Try a credit of 3,000,000 naira to see SweepGuard hold it while the rest of the day still sweeps.

## If something breaks

- Sign-in fails with "unknown merchant": press Reset demo, sign in again.
- Ops pages ask for a demo key: the server is not running with `DEMO_OPEN=1`; either set it or enter the `DEMO_SECRET`.
- Bank calls are slow or fail: the sandbox allows 60 requests a minute for the whole team. Wait a minute.
- Fall back to the mock: build the web app without `NEXT_PUBLIC_API_MODE=live` (`cd web && npm run dev`), which has the same screens on a seeded demo bank.
