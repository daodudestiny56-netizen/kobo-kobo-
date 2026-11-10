import { describe, expect, it } from 'vitest';
import { handleUssd, resolvePath } from '../src/channels/ussd';
import { handleInboundSms } from '../src/channels/sms';
import { parseRateBps } from '../src/channels/actions';
import { ussdCopy } from '../src/channels/copy';
import { createSuggestion, getOpenSuggestion } from '../src/smart-rate/service';
import { setOffsetDays } from '../src/demo/clock';
import { getMerchant } from '../src/merchants/service';
import { listMessages } from '../src/messages/service';
import { pots } from '../src/ledger/ledger';
import { runSweepForMerchant } from '../src/sweeps/engine';
import { withdrawalRefusal } from '../src/messages/templates';
import { merchantSummary } from '../src/merchants/summary';
import { addInflow, AFTER_CUTOFF, DATE, fundedMerchant, makeDeps } from './helpers';

const N = (n: number) => BigInt(n) * 100n;
const SCREEN = 182;

async function saver(language: 'en' | 'pidgin' = 'en') {
  const deps = makeDeps({ now: AFTER_CUTOFF });
  const m = fundedMerchant(deps, { dailyCap: N(100_000), language });
  addInflow(deps.db, m.id, N(100_000), new Date('2026-11-13T11:00:00Z'));
  await runSweepForMerchant(deps, m.id, DATE);
  return { deps, m };
}
const dial = (deps: any, m: any, text: string) => handleUssd(deps, { phoneNumber: m.phone, text });

describe('USSD', () => {
  it('resolves back (0) and main menu (99)', () => {
    expect(resolvePath('')).toEqual([]);
    expect(resolvePath('3*0')).toEqual([]);
    expect(resolvePath('5*1500*99*1')).toEqual(['1']);
  });

  it('every screen fits 182 characters in English and Pidgin, and the menu has no PIN or voice call', async () => {
    for (const lang of ['en', 'pidgin'] as const) {
      const { deps, m } = await saver(lang);
      for (const text of ['', '1', '2', '3', '3*2.5', '3*9', '4', '4*1', '5', '6', '7', '3*0*1']) {
        const out = await dial(deps, m, text);
        expect(out).toMatch(/^(CON|END) /);
        expect(out.length, `${lang} "${text}": ${out}`).toBeLessThanOrEqual(SCREEN);
      }
      expect(await dial(deps, m, '')).not.toMatch(/PIN|call/i);
    }
    const c = ussdCopy('en');
    expect(c.menu('2').join('\n').length).toBeLessThanOrEqual(SCREEN);
  });

  it('unregistered numbers get END', async () => {
    const deps = makeDeps();
    expect(await handleUssd(deps, { phoneNumber: '+2348099999999', text: '' })).toMatch(/^END .*not registered/);
  });

  it('balance shows the pots; rate and pause write the same fields as the app', async () => {
    const { deps, m } = await saver();
    expect(await dial(deps, m, '1')).toMatch(/Total: N2,000/);
    expect(await dial(deps, m, '3*2.5')).toMatch(/^END .*2\.5%/);
    expect(getMerchant(deps.db, m.id).rateBps).toBe(250);
    expect(await dial(deps, m, '3*9')).toMatch(/^END Invalid rate/);
    expect(getMerchant(deps.db, m.id).rateBps).toBe(250);
    expect(await dial(deps, m, '4*1')).toMatch(/^END Sweeps paused until/);
    expect(merchantSummary(deps, m.id).paused).toBe(true);
    expect(await dial(deps, m, '4')).toMatch(/Resume now/);
    expect(await dial(deps, m, '4*1')).toMatch(/resumed/);
    expect(merchantSummary(deps, m.id).paused).toBe(false);
  });

  it('cashout refusal is the same sentence on USSD, SMS and the app', async () => {
    const { deps, m } = await saver();
    const s = merchantSummary(deps, m.id);
    const expected = withdrawalRefusal('en', s.eligibility);
    expect(await dial(deps, m, '5')).toBe(`END ${expected}`);
    expect((await handleInboundSms(deps, { from: m.phone, text: 'CASHOUT 500' })).reply).toBe(expected);
  });

  it('cashout: amount, confirm, pay (no PIN); No moves nothing; too much is refused', async () => {
    const { deps, m } = await saver();
    setOffsetDays(deps.db, 100);
    expect(await dial(deps, m, '5')).toMatch(/^CON Emergency Pot: N1,000/);
    expect(await dial(deps, m, '5*5000')).toMatch(/^END .*1,000/);
    expect(await dial(deps, m, '5*abc')).toMatch(/^END Invalid amount/);
    expect(await dial(deps, m, '5*500')).toMatch(/^CON Withdraw N500 to Access \*\*\*\*\d{4}\?/);
    expect(await dial(deps, m, '5*500*2')).toMatch(/^END Cancelled/);
    expect(pots(deps.db, m.id).emergency).toBe(N(1000));
    expect(await dial(deps, m, '5*500*1')).toMatch(/^END .*on its way/);
    expect(pots(deps.db, m.id).emergency).toBe(N(500));
  });

  it('spoken balance returns text and a cancelled trader is told so', async () => {
    const { deps, m } = await saver('pidgin');
    expect(await dial(deps, m, '6')).toMatch(/^END Your total savings na N2,000/);
    await handleInboundSms(deps, { from: m.phone, text: 'STOP' });
    expect(await dial(deps, m, '')).toMatch(/^END .*cancel/);
  });
});

describe('SMS', () => {
  it('parses rates', () => {
    expect(parseRateBps('2')).toBe(200);
    expect(parseRateBps('2.5%')).toBe(250);
    for (const bad of ['0', '6', 'abc', '', '2.555', '1,5']) expect(parseRateBps(bad), bad).toBeNull();
  });

  it('BAL, RATE, PAUSE, RESUME, HELP and unknown; inbound and replies are stored', async () => {
    const { deps, m } = await saver();
    const r = (text: string) => handleInboundSms(deps, { from: m.phone, text }).then((x) => x.reply);
    expect(await r('bal')).toMatch(/2,000/);
    expect(await r('RATE 3')).toMatch(/3%/);
    expect(getMerchant(deps.db, m.id).rateBps).toBe(300);
    expect(await r('RATE 12')).toMatch(/RATE/);
    expect(getMerchant(deps.db, m.id).rateBps).toBe(300);
    await r('PAUSE');
    expect(merchantSummary(deps, m.id).paused).toBe(true);
    await r('RESUME');
    expect(merchantSummary(deps, m.id).paused).toBe(false);
    expect(await r('HELP')).toBeTruthy();
    expect(await r('gibberish')).toBeTruthy();
    const msgs = listMessages(deps.db, m.id, 100);
    expect(msgs.filter((x) => x.direction === 'IN').length).toBe(7);
  });

  it('unknown senders get a reply and nothing is stored', async () => {
    const deps = makeDeps();
    const r = await handleInboundSms(deps, { from: '+2348099999998', text: 'BAL' });
    expect(r.reply).toBeTruthy();
  });

  it('a repeated provider message id is stored once', async () => {
    const { deps, m } = await saver();
    await handleInboundSms(deps, { from: m.phone, text: 'BAL', messageId: 'X1' });
    await handleInboundSms(deps, { from: m.phone, text: 'BAL', messageId: 'X1' });
    expect(listMessages(deps.db, m.id, 100).filter((x) => x.direction === 'IN').length).toBe(1);
  });
});

describe('Smart Rate confirmation', () => {
  it('changes the rate only on YES; NO keeps it and starts a cooldown', async () => {
    const { deps, m } = await saver();
    createSuggestion(deps, { merchantId: m.id, suggestedBps: 300 });
    expect(getMerchant(deps.db, m.id).rateBps).toBe(200);
    expect((await handleInboundSms(deps, { from: m.phone, text: 'YES' })).reply).toMatch(/3%/);
    expect(getMerchant(deps.db, m.id).rateBps).toBe(300);

    createSuggestion(deps, { merchantId: m.id, suggestedBps: 400 });
    await handleInboundSms(deps, { from: m.phone, text: 'NO' });
    expect(getMerchant(deps.db, m.id).rateBps).toBe(300);
    expect(() => createSuggestion(deps, { merchantId: m.id, suggestedBps: 400 })).toThrow(/recently said no/);
  });

  it('one open suggestion per trader; a manual RATE supersedes it; expiry closes it', async () => {
    const { deps, m } = await saver();
    createSuggestion(deps, { merchantId: m.id, suggestedBps: 300 });
    expect(() => createSuggestion(deps, { merchantId: m.id, suggestedBps: 400 })).toThrow(/already waiting/);
    await handleInboundSms(deps, { from: m.phone, text: 'RATE 4' });
    expect(getOpenSuggestion(deps, m.id)).toBeNull();
    expect((await handleInboundSms(deps, { from: m.phone, text: 'YES' })).reply).toBeTruthy();
    expect(getMerchant(deps.db, m.id).rateBps).toBe(400);

    createSuggestion(deps, { merchantId: m.id, suggestedBps: 250 });
    deps.advance(73 * 3_600_000);
    expect(getOpenSuggestion(deps, m.id)).toBeNull();
  });
});
