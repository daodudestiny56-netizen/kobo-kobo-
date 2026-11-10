import type { Metadata } from 'next';
import { DocPage } from '@/components/DocPage';

export const metadata: Metadata = { title: 'Privacy' };

export default function PrivacyPage() {
  return (
    <DocPage
      title="Privacy"
      updated="10 November 2026"
      notice="Draft for the Access Youth Tech Forge 2026 demo. It describes how the prototype is designed to handle data, using synthetic data only. It is not legal advice and has not been reviewed by a lawyer or a data protection officer."
      sections={[
        { id: 'collect', title: 'What we collect', body: (<><ul><li>Your name and mobile number.</li><li>Your bank account number.</li><li>Your BVN and NIN, used to check who you are. We keep a scrambled copy of your BVN, not the number itself.</li><li>Your chosen share, language and settings.</li><li>The amounts of your daily sales, so we can work out each saving.</li></ul></>) },
        { id: 'why', title: 'Why we use it', body: (<><p>To check your identity, move your chosen share into your pension, send you receipts, protect you from mistaken transfers, and show you your balances.</p></>) },
        { id: 'share', title: 'Who sees it', body: (<><p>Your bank sees your account and transfers. Your pension fund manager sees your pension contributions. We do not sell your data. Messages written by an AI model contain wording only, not your personal details.</p></>) },
        { id: 'law', title: 'Your rights', body: (<><p>Under the Nigeria Data Protection Act 2023 you can ask what we hold about you, ask us to correct it, object to how we use it, and withdraw your consent. Withdrawing consent is as easy as giving it: you can stop saving at any time.</p></>) },
        { id: 'keep', title: 'How long we keep it', body: (<><p>The retention period will be decided and published before any real launch. In this demo, all data is synthetic and can be reset at any time.</p></>) },
        { id: 'demo', title: 'About this demo', body: (<><p>This prototype uses only synthetic names, accounts, BVNs and NINs from the Forge sandbox. No real personal data is collected or stored.</p></>) },
      ]}
    />
  );
}
