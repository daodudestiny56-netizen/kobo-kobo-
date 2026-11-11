import { core } from "./0001_core.js";
import { engine } from "./0002_engine.js";
import { inflowMeta } from "./0010_inflow_meta.js";
import { engineRuntime } from "./0011_engine_runtime.js";

export const migrations: { id: string; sql: string }[] = [
  { id: "0001_core", sql: core },
  { id: "0002_engine", sql: engine },
  { id: "0010_inflow_meta", sql: inflowMeta },
  { id: "0011_engine_runtime", sql: engineRuntime },
];