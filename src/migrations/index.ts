import { core } from "./0001_core.js";
import { engine } from "./0002_engine.js";
import { inflowMeta } from "./0010_inflow_meta.js";

export const migrations: { id: string; sql: string }[] = [
  { id: "0001_core", sql: core },
  { id: "0002_engine", sql: engine },
  // Tomiwa adds { id: "0003_guard", sql: guard } for guard_alerts, messages
  { id: "0010_inflow_meta", sql: inflowMeta },
];