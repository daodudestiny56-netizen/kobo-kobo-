import type { BankPort } from './bank/port';
import type { Config } from './config';
import type { Db } from './db';
import type { SweepGuard } from './guard/port';

export type Clock = () => Date;

export interface Deps {
  db: Db;
  config: Config;
  clock: Clock;
  bank: BankPort;
  guard: SweepGuard;
}
