import type { Config } from './config';
import type { Db } from './db';

export type Clock = () => Date;

export interface Deps {
  db: Db;
  config: Config;
  clock: Clock;
}
