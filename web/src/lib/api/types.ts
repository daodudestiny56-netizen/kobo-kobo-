export type Lang = 'en' | 'pidgin' | 'yoruba' | 'hausa' | 'igbo';

// PRD 6.3 sweep state machine.
export type SweepStatus =
  | 'SKIPPED_ZERO_SALES'
  | 'SKIPPED_PAUSED'
  | 'SKIPPED_LOW_BALANCE'
  | 'HELD_GUARD'
  | 'SETTLED'
  | 'FAILED'
  | 'UNKNOWN'
  | 'REVERSED';

export type ForceOutcome = 'none' | 'failed' | 'timeout' | 'reversed';

export interface DemoTrader {
  fullName: string;
  bankAccount: string;
  bvn: string;
  nin: string;
  tier: number;
  phone: string;
  language: Lang;
}

export interface Merchant {
  id: string;
  fullName: string;
  phone: string;
  bankAccount: string;
  virtualAccount: string;
  rsaPin: string;
  language: Lang;
  rateBps: number;
  pausedUntil: number | null;
  status: 'ACTIVE' | 'CANCELLED';
}

export interface SweepRecord {
  id: string;
  merchantId: string;
  merchantName: string;
  sweepDate: string;
  takingsKobo: number;
  rateBps: number;
  sweepKobo: number;
  emergencyKobo: number;
  retirementKobo: number;
  status: SweepStatus;
  pensionReference: string | null; // null for skipped sweeps (PRD 14)
  bankReference: string;
  executedAt?: number;
  note?: string;
}

export interface WithdrawalEligibility {
  eligible: boolean;
  reason?: string;
  availableFrom?: number;
  maxKobo: number;
}

export interface SmartRate {
  suggestedBps: number;
  reason: string;
}

export interface DayPoint {
  date: string;
  takingsKobo: number;
  savedKobo: number;
}

export interface BalancePoint {
  date: string;
  totalKobo: number;
}

export interface Stats {
  savedThisMonthKobo: number;
  savedAllTimeKobo: number;
  nightsSaved30: number;
  avgSales30Kobo: number;
  bestDay: { date: string; takingsKobo: number } | null;
  memberSince: number | null;
}

export interface BankAccount {
  bankName: string;
  number: string;
  balanceKobo: number;
  tier: number;
}

export type FeedKind = 'sale' | 'saving' | 'withdrawal' | 'skipped' | 'attention';

// One line in the account feed. amountKobo is signed from the trader's point of view: money in is positive.
export interface FeedItem {
  id: string;
  kind: FeedKind;
  at: number;
  title: string;
  subtitle: string;
  amountKobo: number;
  reference: string;
  status: 'completed' | 'pending' | 'failed' | 'reversed';
  sweepId?: string;
}

export interface Summary {
  merchant: Merchant;
  bankBalanceKobo: number;
  todayTakingsKobo: number;
  heldKobo: number;
  expectedSweepKobo: number;
  emergencyKobo: number;
  retirementKobo: number;
  withdrawal: WithdrawalEligibility;
  smartRate: SmartRate | null;
  recent: SweepRecord[];
  clockOffsetDays: number;
  account: BankAccount;
  stats: Stats;
  series: DayPoint[];
  balanceSeries: BalancePoint[];
}

export interface GuardAlert {
  id: string;
  merchantId: string;
  merchantName: string;
  amountKobo: number;
  type: 'ANOMALY' | 'DUPLICATE' | 'NAME_MISMATCH';
  status: 'PENDING_REVIEW' | 'DISMISSED' | 'CONFIRMED';
  detail: string;
}

export interface OpsOverview {
  sweeps: SweepRecord[];
  alerts: GuardAlert[];
  totals: { merchants: number; aumKobo: number; sweptTodayKobo: number };
  reconciliation: { ledgerKobo: number; armKobo: number; diffKobo: number };
  clockOffsetDays: number;
}

// POST /api/v1/merchants/onboard (src/onboarding/service.ts). BVN only, no NIN. The share of sales starts at 2%.
export interface OnboardRequest {
  phone: string;
  bankAccount: string;
  bvn: string;
  language: Lang;
  consentAccepted: boolean;
  consentVersion: string;
}

export interface OnboardResult {
  merchantId: string;
  fullName: string;
  language: Lang;
  rateBps: number;
  /** Present when the server returns the whole trader (it does once the engine is mounted). */
  rsaPin?: string;
}

// GET /api/v1/consent: the exact text the person agrees to, and its version.
export interface Consent {
  version: string;
  text: string;
}

export interface SettingsPatch {
  rateBps?: number;
  language?: Lang;
  pauseHours?: number; // 0 resumes
  cancel?: boolean;
  reactivate?: boolean;
}

export interface Api {
  listDemoTraders(): Promise<DemoTrader[]>;
  listMerchants(): Promise<Merchant[]>;
  consent(): Promise<Consent>;
  onboard(req: OnboardRequest): Promise<OnboardResult>;
  summary(id: string): Promise<Summary>;
  activity(id: string): Promise<SweepRecord[]>;
  feed(id: string): Promise<FeedItem[]>;
  verifyOtp(phone: string, code: string): Promise<{ merchantId: string | null }>;
  demoSignIn(account: string): Promise<{ merchantId: string }>;
  updateSettings(id: string, patch: SettingsPatch): Promise<Summary>;
  withdraw(id: string, amountKobo: number): Promise<{ ok: boolean; message: string }>;
  ussd(phone: string, sessionId: string, text: string): Promise<{ type: 'CON' | 'END'; body: string }>;
  sms(phone: string, text: string): Promise<{ reply: string }>;
  demoInflow(id: string, amountKobo: number): Promise<void>;
  demoClock(days: number): Promise<void>;
  demoReset(): Promise<void>;
  opsOverview(): Promise<OpsOverview>;
  opsRunSweep(force: ForceOutcome): Promise<OpsOverview>;
  opsRequery(sweepId: string): Promise<OpsOverview>;
  opsResolveAlert(id: string, decision: 'DISMISSED' | 'CONFIRMED'): Promise<OpsOverview>;
}
