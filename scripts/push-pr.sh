#!/usr/bin/env bash
# Rebase the engine work onto the team's current main, run the tests, push to our own branch and open the PR.
# Run from inside the unzipped kobo-kobo folder. Needs: git, node 20+, and (for the PR step) the GitHub CLI `gh auth login`.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/daodudestiny56-netizen/kobo-kobo-.git}"   # confirm the exact repo name (with or without the trailing dash)
BRANCH="${BRANCH:-feat/engine-caleb}"                                              # our own branch, never main
SRC="docs/team-handoff"                                                            # the branch that holds all the work

cd "$(git rev-parse --show-toplevel)"
git remote get-url origin >/dev/null 2>&1 || git remote add origin "$REPO_URL"
git remote set-url origin "$REPO_URL"
git fetch origin
git checkout "$SRC"

# Replay our commits on top of the team's main (their root src/ and web/ do not clash with our server/).
git rebase --onto origin/main main "$SRC" || { echo "Rebase conflict: fix the files, 'git add' them, 'git rebase --continue', then run this script again."; exit 1; }

( cd server && npm ci && npm run typecheck && npm test )

git push -u origin "$SRC:$BRANCH"

TITLE="Engine: SQLite ledger, sweep state machine, withdrawals, USSD/SMS, API, demo seed"
BODY="Backend engine for Kobo Kobo (PRD v3). Everything lives under server/. Start with docs/TEAM.md.

- Sweep engine: persist-before-bank-call, requery on timeout, per-credit guard holds, reversals, 23:00/23:30 WAT scheduler
- Signed ledger with derived pots, emergency withdrawals (3-month vest, 2-month cooldown), demo clock
- USSD (6-item menu), two-way SMS, Smart Rate confirmation. English and Pidgin, no PIN
- HTTP API (/api/v1), ops and demo endpoints, reconciliation report, seven-persona demo seed
- 65 tests pass. Bank is behind BankPort (SimulatedBank for now); Abiodun's client plugs in at server/src/index.ts

Not verified against the real sandbox yet."
if command -v gh >/dev/null 2>&1; then
  gh pr create --repo "$(echo "$REPO_URL" | sed -E 's#https://github.com/(.*)\.git#\1#')" --base main --head "$BRANCH" --title "$TITLE" --body "$BODY"
else
  echo "gh not installed: open https://github.com/$(echo "$REPO_URL" | sed -E 's#https://github.com/(.*)\.git#\1#')/compare/main...$BRANCH?expand=1 and paste the description above."
fi
