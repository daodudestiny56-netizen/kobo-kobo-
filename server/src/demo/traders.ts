import type { Language } from '../merchants/service';

/** The four sandbox individuals (Forge guide 5.4), the same list the web app's demo sign-in shows. Synthetic data. */
export interface DemoTrader {
  fullName: string;
  bankAccount: string;
  bvn: string;
  nin: string;
  tier: number;
  phone: string;
  language: Language;
}

export const DEMO_TRADERS: DemoTrader[] = [
  { fullName: 'Adaeze Chiamaka Okonkwo', bankAccount: '0123456789', bvn: '22200000001', nin: '70000000001', tier: 3, phone: '+2348000000001', language: 'pidgin' },
  { fullName: 'Babatunde Olumide Adeyemi', bankAccount: '0123456790', bvn: '22200000002', nin: '70000000002', tier: 3, phone: '+2348000000002', language: 'yoruba' },
  { fullName: 'Musa Ibrahim Abdullahi', bankAccount: '0123456791', bvn: '22200000003', nin: '70000000003', tier: 2, phone: '+2348000000003', language: 'hausa' },
  { fullName: 'Efosa Godwin Osagie', bankAccount: '0123456792', bvn: '22200000004', nin: '70000000004', tier: 1, phone: '+2348000000004', language: 'en' },
];

export const tierOf = (account: string): number => DEMO_TRADERS.find((t) => t.bankAccount === account)?.tier ?? 1;
