import { core } from "./0001_core.js";
import { inflowMeta } from "./0010_inflow_meta.js";

export const migrations: { id: string; sql: string }[] = [
  { id: "0001_core", sql: core },
  // Caleb adds { id: "0002_engine", sql: engine } for pension_accounts, withdrawals, sweeps, ledger_entries
  // Tomiwa adds { id: "0003_guard", sql: guard } for guard_alerts, messages
  { id: "0010_inflow_meta", sql: inflowMeta },
];