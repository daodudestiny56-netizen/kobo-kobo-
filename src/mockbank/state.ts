export type Status = "active" | "dormant" | "frozen" | "pnd";

export type Account = {
  number: string;
  name: string;
  type: string;
  kyc: number | null;
  kobo: number;
  status: Status;
  team: boolean;
  bank: string;
  nip: string;
  cbn?: string;
};

export type Tx = {
  reference: string;
  account: string;
  type: string;
  direction: "credit" | "debit";
  kobo: number;
  feeKobo: number;
  vatKobo: number;
  stampKobo: number;
  balanceAfterKobo: number;
  counterparty: string | null;
  channel: string | null;
  status: string;
  at: string;
};

// ISO 8601 UTC without milliseconds, like the real sandbox: 2026-11-09T20:17:01Z
export const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

export const accounts = new Map<string, Account>();
export const transactions: Tx[] = [];

const resetHooks: Array<() => void> = [];
export const onReset = (fn: () => void) => { resetHooks.push(fn); };

export const BVNS: Record<string, string> = {
  "0123456789": "22200000001",
  "0123456790": "22200000002",
  "0123456791": "22200000003",
  "0123456792": "22200000004",
};

const x = (number: string, name: string, type: string, kyc: number | null, naira: number): Account => ({
  number, name, type, kyc, kobo: naira * 100, status: "active", team: true,
  bank: "Xtradot Bank", nip: "000014", cbn: "044",
});

const b = (number: string, name: string, bank: string, nip: string, status: Status = "active"): Account => ({
  number, name, type: "savings", kyc: null, kobo: 0, status, team: false, bank, nip,
  ...(nip === "000014" ? { cbn: "044" } : {}),
});

// Order matters: opening rows are inserted in this order and listed newest-first.
const TEAM: Account[] = [
  x("0123456789", "ADAEZE CHIAMAKA OKONKWO", "savings", 3, 1_500_000),
  x("0123456790", "BABATUNDE OLUMIDE ADEYEMI", "current", 3, 5_000_000),
  x("0123456791", "MUSA IBRAHIM ABDULLAHI", "savings", 2, 250_000),
  x("0123456792", "EFOSA GODWIN OSAGIE", "savings", 1, 40_000),
  x("0123456793", "MAMA NKECHI PROVISIONS LTD", "corporate", null, 12_000_000),
];

const BENEFICIARIES: Account[] = [
  b("0987654321", "NGOZI ADAOBI EZE", "Xtradot Bank", "000014"),
  b("0987654322", "AISHA HAUWA BELLO", "Xtradot Bank", "000014"),
  b("0987654399", "OBINNA KELECHI OKAFOR", "Xtradot Bank", "000014", "dormant"),
  b("0123987001", "CHUKWUEMEKA IFEANYI NWOSU", "GTBank", "000013"),
  b("0123987099", "GARBA SANI DANJUMA", "GTBank", "000013", "pnd"),
  b("0123987002", "FUNMILAYO ABIOLA OGUNLEYE", "Zenith", "000015"),
  b("0123987003", "ZAINAB HALIMA YUSUF", "First Bank", "000016"),
  b("0123987004", "TAMUNOTONYE BRIGGS", "UBA", "000004"),
  b("0123987098", "BLESSING OGHENEKARO EDEH", "Wema", "000017", "frozen"),
  b("8031234506", "IFEOLUWA GRACE ADEBAYO", "OPay", "100004"),
  b("8051234507", "IYA BISI FOODS ENTERPRISES", "Moniepoint", "090405"),
  b("0123987005", "AREWA SOLAR CO-OPERATIVE SOCIETY", "Zenith", "000015"),
  b("0123987006", "OGOJA COMMUNITY FOREST TRUST", "First Bank", "000016"),
];

export function reset(): void {
  accounts.clear();
  transactions.length = 0;
  const at = `${new Date().toISOString().slice(0, 10)}T07:00:00Z`;
  for (const a of TEAM) {
    accounts.set(a.number, { ...a });
    transactions.push({
      reference: "OPENING-BAL", account: a.number, type: "opening_balance", direction: "credit",
      kobo: a.kobo, feeKobo: 0, vatKobo: 0, stampKobo: 0, balanceAfterKobo: a.kobo,
      counterparty: null, channel: null, status: "successful", at,
    });
  }
  for (const a of BENEFICIARIES) accounts.set(a.number, { ...a });
  for (const fn of resetHooks) fn();
}

reset();