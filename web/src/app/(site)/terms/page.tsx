import type { Metadata } from 'next';
import { DocPage } from '@/components/DocPage';

export const metadata: Metadata = { title: 'Terms of use' };

export default function TermsPage() {
  return (
    <DocPage
      title="Terms of use"
      updated="10 November 2026"
      notice="Draft for the Access Youth Tech Forge 2026 demo. It describes how the prototype is designed to work. It is not legal advice and has not been reviewed by a lawyer, PenCom, Access Bank or Access ARM."
      sections={[
        { id: 'what', title: 'What Kobo Kobo does', body: (<><p>Kobo Kobo moves a share of your daily sales from your own bank account into your own pension, automatically, each night. It does not hold your money.</p></>) },
        { id: 'sales', title: 'Your sales and your account', body: (<><p>All your sales are paid into your own bank account. Kobo Kobo never takes money from a payment on its way to you. Each night, your chosen share is moved from your account, after your sales have been received.</p></>) },
        { id: 'saving', title: 'The nightly saving', body: (<><ul><li>It runs every night at 11:00 pm.</li><li>It counts the sales received since the last saving.</li><li>Your share is between 1% and 5%. If you make no sales, nothing is taken.</li><li>We leave a safety minimum in your account and limit how much can be taken in one night.</li></ul></>) },
        { id: 'pots', title: 'Your two pots', body: (<><p>Each saving is split in half. The emergency pot opens 3 months after your first saving, and you can then withdraw once every 2 months to your own account. The retirement pot is locked until you are 50. These follow the PenCom Personal Pension Plan Guidelines (2025).</p></>) },
        { id: 'control', title: 'Pausing, changing and stopping', body: (<><p>You can pause, change your share or stop at any time, in the app, by USSD or by text message. Stopping does not remove what you have already saved.</p></>) },
        { id: 'fees', title: 'Fees', body: (<><p>Kobo Kobo charges no fee in this demo. In a real service, a pension agent can charge ₦20 per contribution and ₦100 per withdrawal under PenCom rules, and your fund manager charges a yearly fee on your fund. Any fee will be shown before you agree to it.</p></>) },
        { id: 'wrong', title: 'When something goes wrong', body: (<><p>If a transfer fails, nothing is taken. If the bank has not confirmed a transfer, we check it and do not send it again. If a very large payment arrives, we hold that payment back until it is checked. Every saving gets a receipt with a reference number.</p></>) },
        { id: 'returns', title: 'Returns are not guaranteed', body: (<><p>Pension funds can go down as well as up, and returns can be lower than inflation. Kobo Kobo does not promise any return.</p></>) },
        { id: 'demo', title: 'About this demo', body: (<><p>This prototype runs on the Access Youth Tech Forge sandbox. Bank accounts and transfers use synthetic data. The pension account, USSD, SMS and voice are simulated. No real money moves.</p></>) },
      ]}
    />
  );
}
