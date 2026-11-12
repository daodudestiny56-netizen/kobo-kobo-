# Demo run order

About 5 minutes. Open the app at `https://team07.xtradot.co` (or `kubectl port-forward svc/app 8080:80` and `http://localhost:8080`).

## Before you start

1. `k8s/app.yaml` sets two demo-only variables: `DEMO_OPEN=1` (the Operations and Demo tools screens need no key) and `DEMO_UNENROLLED_ACCOUNTS=0123456792` (Efosa is left free, so you can sign up live). Remove both after the demo and re-apply.
2. Open `/sign-in?demo=1` once in the browser. This shows Demo tools, Button phone and Operations.
3. Press **Demo tools, Reset all demo data**. The app signs you out. Three traders stay seeded (Adaeze, Babatunde, Musa); Efosa is free.

## The run

| # | Show | Do | Say |
|---|---|---|---|
| 1 | The gap | Landing page | 91.4% of personal pension accounts have never received a naira. Fixed debits fail on slow days. |
| 2 | Sign up | Go to Start a pension. First try BVN `22299999999` with any account to show the refusal. Then sign up as Efosa: BVN `22200000004`, account `0123456792`, any phone. Read the consent, agree | The BVN is checked, the name must match the account, consent is recorded. We show the new pension number at the end. |
| 3 | A day of trading | Demo tools, press the `₦28,000` payment | Customers pay as usual. All of it lands in the trader's own account. |
| 4 | A mistake | Demo tools, press `₦3,000,000 (a mistake)` | A credit far outside this trader's pattern. |
| 5 | The sweep | Demo tools, Run the nightly saving now. Close the sheet and look at Savings | 2% of the ₦28,000 is ₦560, split ₦280 and ₦280 into the two pots. The receipt has a reference. |
| 6 | Safety | Operations, Alerts. Press `It is a mistake, exclude it` | SweepGuard held only the ₦3,000,000. The rest of the day still swept. |
| 7 | Button phone | `/demo/phone`, pick the trader. Try `BAL`, then `CASHOUT 5000`, then `RATE 6` | The cash-out is refused with the honest reason, in the trader's language. The share must be 1% to 5%. |
| 8 | Close | | What is simulated, who benefits, who pays, the approvals still needed. |

### Optional: the bank times out (30 seconds)

Press **Reset all demo data**, then in Operations choose `Bank times out` and press Run nightly saving. The sweeps show as unknown. Press **Requery bank** on a sweep. About 30 seconds later the sandbox bank reverses the transfer and the sweep ends as failed. At the bank there is exactly one debit and one reversal: we asked again, we never sent again. Reconciliation still says everything is accounted for. (Efosa is free again after a reset, so sign up again if you need him.)

## Rehearsing without spoiling the demo

- **Reset does not reset the bank.** The bank keeps its history, so payments from an earlier rehearsal for the same account can reappear in the next run's takings. If today's numbers look doubled, that is why.
- **The mistaken payment is paid from the demo payer account (`0123456793`).** Each `₦3,000,000` press spends ₦3,000,000 of it. When it runs short the button answers "The bank could not take that payment". Rehearse the mistake once at most before the real run, or skip steps 4 and 6.
- **The sandbox allows 60 bank calls a minute for the whole team.** If screens are slow or fail, wait a minute.

## What is simulated

The bank is the Forge sandbox. Customer payments are transfers between team accounts. The pension account and RSA PIN, USSD and SMS are simulated. SweepGuard and SmartRate are real statistics and rules (`server/src/intel`), calibrated on synthetic traders.

## If something breaks

- Sign-in says the account is unknown: press Reset all demo data, then sign in again.
- Operations asks for a demo key: the server is not running with `DEMO_OPEN=1`. Set it, or enter the `DEMO_SECRET`.
- Efosa's sign-up says "already enrolled": press Reset all demo data first, and check `DEMO_UNENROLLED_ACCOUNTS` is set.
- Fall back to the mock: build the web app without `NEXT_PUBLIC_API_MODE=live` (`cd web && npm run dev`). It has the same screens on a seeded demo bank.
