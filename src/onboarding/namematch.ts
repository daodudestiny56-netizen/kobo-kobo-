export type MatchBand = "matched" | "needs_review" | "mismatch";
export type MatchResult = { band: MatchBand; score: number; matched: number };

const TITLES = new Set(["MR", "MRS", "MISS", "MS", "DR", "CHIEF", "ALHAJI", "ALHAJA", "ENGR", "PROF", "MALLAM"]);

const tokens = (s: string): string[] =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z]+/g, " ")
    .split(" ")
    .filter((t) => t && !TITLES.has(t));

function lev(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

type Kind = "exact" | "fuzzy" | "initial";
function tokenMatch(a: string, b: string): Kind | null {
  if (a === b) return "exact";
  if (a.length === 1 || b.length === 1) return a[0] === b[0] ? "initial" : null;
  if (Math.min(a.length, b.length) >= 5 && lev(a, b) <= 1) return "fuzzy";
  return null;
}

/**
 * matched      every token of the shorter name is in the longer one (order and middle names ignored)
 * needs_review same, but via an initial or a one-letter typo; or two or more shared tokens that are not all of the shorter name
 * mismatch     everything else, including "same surname, different first name"
 */
export function matchNames(a: string, b: string): MatchResult {
  const ta = tokens(a), tb = tokens(b);
  const [short, long] = ta.length <= tb.length ? [ta, [...tb]] : [tb, [...ta]];
  if (short.length === 0) return { band: "mismatch", score: 0, matched: 0 };

  let matched = 0, soft = false;
  for (const t of short) {
    // prefer exact, then fuzzy, then initial
    let idx = long.findIndex((x) => x === t), kind: Kind | null = idx >= 0 ? "exact" : null;
    if (idx < 0) {
      for (const want of ["fuzzy", "initial"] as Kind[]) {
        idx = long.findIndex((x) => tokenMatch(t, x) === want);
        if (idx >= 0) { kind = want; break; }
      }
    }
    if (idx >= 0 && kind) {
      matched++;
      if (kind !== "exact") soft = true;
      long.splice(idx, 1); // one-to-one
    }
  }

  const score = matched / short.length;
  let band: MatchBand = "mismatch";
  if (short.length >= 2 && matched === short.length) band = soft ? "needs_review" : "matched";
  else if (matched >= 2) band = "needs_review";
  else if (short.length === 1 && matched === 1) band = "needs_review";
  return { band, score, matched };
}