import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { resolvePath } from '../src/channels/ussd';
import { buildServer } from '../src/server';
import { executeSweepForMerchant } from '../src/sweeps/service';
import { addDaysToInstant, addMonthsToInstant } from '../src/time';
import { addInflow, DAY, DURING, makeDeps, makeTrader, NIGHT, resetDb, testPool } from './helpers';

const pool = testPool();
let deps: ReturnType<typeof makeDeps>;
let app: ReturnType<typeof buildServer>;
// Daytime on the 6th (15:00 WAT): the sweep for tonight has not run yet.
beforeEach(async () => {
  await resetDb(pool);
  deps = makeDeps(pool, { now: DURING });
  app = buildServer(deps);
});
afterAll(() => pool.end());

const vestedPension = { emergency: '184.00', retirement: '184.00', firstContributionAt: addMonthsToInstant(DURING, -4) };
const trader = (o: Parameters<typeof makeTrader>[1] = {}) => makeTrader(pool, { pin: '7391', pension: vestedPension, ...o });
const merchantRow = async (id: string) =>
  (await pool.query('SELECT sweep_percentage::text rate, is_paused, paused_until FROM merchants WHERE id=$1', [id])).rows[0];

const ussd = async (phone: string, text: string) => {
  const res = await app.inject({ method: 'POST', url: '/api/v1/ussd', payload: `sessionId=s1&serviceCode=*384*5050%23&phoneNumber=${encodeURIComponent(phone)}&text=${encodeURIComponent(text)}`, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toContain('text/plain');
  const body = res.body;
  expect(body).toMatch(/^(CON|END) /);
  expect(body.length - 4).toBeLessThanOrEqual(182); // one USSD screen
  return body;
};

describe('USSD navigation', () => {
  it('resolves back (0) and home (99) against the cumulative path', () => {
    expect(resolvePath('')).toEqual([]);
    expect(resolvePath('1*0')).toEqual([]);
    expect(resolvePath('5*1500*0')).toEqual(['5']);
    expect(resolvePath('5*1500*99')).toEqual([]);
    expect(resolvePath('3*0*2')).toEqual(['2']);
    expect(resolvePath('0')).toEqual([]);
  });

  it('shows the PRD main menu with the current rate, and handles back/home', async () => {
    const m = await trader({ rate: '2.50' });
    const menu = await ussd(m.phone_number, '');
    expect(menu).toBe(
      "CON Kobo Kobo\n1. Balance\n2. Today's Takings & Sweep\n3. Sweep Rate (Now: 2.5%)\n4. Pause / Resume Sweeps\n5. Emergency Withdrawal\n6. Spoken Balance (Call)\n7. Change PIN",
    );
    expect(await ussd(m.phone_number, '1*0')).toBe(menu);
    expect(await ussd(m.phone_number, '5*1500*99')).toBe(menu);
  });

  it('tells an unknown number to sign up and rejects bad choices', async () => {
    expect(await ussd('+2348099999999', '')).toMatch(/^END This number is not registered/);
    const m = await trader();
    expect(await ussd(m.phone_number, '9')).toMatch(/^END Invalid choice/);
  });

  it('accepts the local 080... number format', async () => {
    const m = await trader({ phone: '+2348031230000' });
    expect(await ussd('08031230000', '')).toMatch(/^CON Kobo Kobo\n1\./);
    void m;
  });
});

describe('USSD: balance and today', () => {
  it('1 shows both pots and the Emergency Pot status', async () => {
    const m = await trader();
    expect(await ussd(m.phone_number, '1')).toBe('CON Kobo Kobo Balance\nTotal: N368\nEmergency: N184 (Eligible)\nRetirement: N184 (Locked to 50)\n0. Back');
  });

  it('1 shows when a young account opens', async () => {
    const m = await trader({ pension: { emergency: '10.00', retirement: '10.00', firstContributionAt: addMonthsToInstant(DURING, -1) } });
    expect(await ussd(m.phone_number, '1')).toContain('Emergency: N10 (Opens 6 Jan 2027)');
  });

  it("2 shows today's takings and tonight's projected sweep, then the finished sweep", async () => {
    const m = await trader();
    await addInflow(pool, m.id, '28000.00', DURING);
    expect(await ussd(m.phone_number, '2')).toBe('END Takings so far: N28,000\nSweep tonight (2%): N560\nSweeps run at 11pm.');

    deps.executor.setBalance(m.access_nuban, 100_000_000n);
    deps.setNow(NIGHT);
    await executeSweepForMerchant(deps, m.id, DAY);
    expect(await ussd(m.phone_number, '2')).toMatch(/^END Tonight's sweep is done: N560 saved\.\nRef PEN-20261106-000001$/);
  });

  it('2 says nothing will be taken while paused', async () => {
    const m = await trader({ paused: true, pausedUntil: addDaysToInstant(DURING, 2) });
    expect(await ussd(m.phone_number, '2')).toContain('Sweeps are paused');
  });
});

describe('USSD: rate and pause write what the sweep reads', () => {
  it('3 changes the rate (accepts 2.5), rejects out-of-range values', async () => {
    const m = await trader();
    expect(await ussd(m.phone_number, '3')).toMatch(/^CON Enter your new sweep rate/);
    expect(await ussd(m.phone_number, '3*3')).toMatch(/^END Done! Your sweep rate is now 3%/);
    expect((await merchantRow(m.id)).rate).toBe('3.00');
    expect(await ussd(m.phone_number, '3*2.5')).toContain('2.5%');
    expect((await merchantRow(m.id)).rate).toBe('2.50');
    for (const bad of ['6', '2.555', 'abc', '10', '-1']) {
      expect(await ussd(m.phone_number, `3*${bad}`)).toMatch(/^END Invalid rate/);
    }
    expect((await merchantRow(m.id)).rate).toBe('2.50');
  });

  it('4 pauses for 48 hours, then offers resume', async () => {
    const m = await trader();
    expect(await ussd(m.phone_number, '4')).toMatch(/^CON Sweeps are on\.\n1\. Pause for 48 hours/);
    expect(await ussd(m.phone_number, '4*1')).toMatch(/^END Sweeps paused until 8 Nov 2026/);
    const row = await merchantRow(m.id);
    expect(row.is_paused).toBe(true);
    expect(row.paused_until).toEqual(addDaysToInstant(DURING, 2));

    deps.setNow(addDaysToInstant(DURING, 1));
    expect(await ussd(m.phone_number, '4')).toMatch(/^CON Sweeps are paused until 8 Nov 2026\.\n1\. Resume now/);
    expect(await ussd(m.phone_number, '4*1')).toMatch(/^END Sweeps resumed/);
    expect(await merchantRow(m.id)).toMatchObject({ is_paused: false, paused_until: null });
  });
});

describe('USSD: emergency withdrawal', () => {
  it('walks amount -> confirm -> paid, and the pot drops', async () => {
    const m = await trader();
    expect(await ussd(m.phone_number, '5')).toBe('CON Emergency Pot: N184\nEnter amount in naira to withdraw to your Access account:\n0. Back');
    expect(await ussd(m.phone_number, '5*100')).toBe(`CON Withdraw N100 to Access ****${m.access_nuban.slice(-4)}?\n1. Yes\n2. No`);
    expect(await ussd(m.phone_number, '5*100*1')).toBe('CON Enter your 4-digit PIN to confirm:');
    expect(await ussd(m.phone_number, '5*100*1*7391')).toBe(`END N100 is on its way to your Access account ****${m.access_nuban.slice(-4)}.`);
    expect(deps.executor.balances.get(m.access_nuban)).toBe(10_000n);
    expect((await pool.query('SELECT emergency_balance::text e FROM pension_accounts WHERE merchant_id=$1', [m.id])).rows[0].e).toBe('84.00');
  });

  it('declining moves no money; commas are tolerated; bad amounts are refused', async () => {
    const m = await trader({ pension: { emergency: '5000.00', retirement: '0.00', firstContributionAt: addMonthsToInstant(DURING, -4) } });
    expect(await ussd(m.phone_number, '5*1,500*2')).toBe('END Cancelled. No money was moved.');
    expect(deps.executor.calls.credit).toBe(0);
    expect(await ussd(m.phone_number, '5*1,500')).toMatch(/^CON Withdraw N1,500 /);
    expect(await ussd(m.phone_number, '5*abc')).toMatch(/^END Invalid amount/);
    expect(await ussd(m.phone_number, '5*0')).toMatch(/^CON Kobo Kobo\n1\./); // "0" is Back, so we land on the main menu
    expect(await ussd(m.phone_number, '5*-5')).toMatch(/^END Invalid amount/);
    expect(await ussd(m.phone_number, '5*5001')).toBe('END You only have N5,000 in your Emergency Pot.');
  });

  it('explains why a young account cannot cash out yet, and the cooldown after a payout', async () => {
    const young = await trader({ pension: { emergency: '100.00', retirement: '100.00', firstContributionAt: addMonthsToInstant(DURING, -1) } });
    expect(await ussd(young.phone_number, '5')).toMatch(/^END Emergency cashout unavailable: Opens 6 Jan 2027\./);

    const m = await trader();
    await ussd(m.phone_number, '5*50*1*7391');
    expect(await ussd(m.phone_number, '5')).toMatch(/^END Emergency cashout unavailable: Next payout 5 Jan 2027\./);
  });

  it('a bank refusal says the money is safe', async () => {
    const m = await trader();
    deps.executor.failNext('credit', 'ACCOUNT_BLOCKED');
    expect(await ussd(m.phone_number, '5*50*1*7391')).toBe('END The bank could not process this. Your money is safe in the Emergency Pot.');
    expect((await pool.query('SELECT emergency_balance::text e FROM pension_accounts WHERE merchant_id=$1', [m.id])).rows[0].e).toBe('184.00');
  });
});

describe('USSD: spoken balance', () => {
  it('queues one callback request per trader until it is handled', async () => {
    const m = await trader({ language: 'yoruba' });
    expect(await ussd(m.phone_number, '6')).toMatch(/^END You will get a call shortly/);
    await ussd(m.phone_number, '6');
    const { rows } = await pool.query('SELECT merchant_id, language, status FROM voice_callback_requests');
    expect(rows).toEqual([{ merchant_id: m.id, language: 'yoruba', status: 'PENDING' }]);
  });
});

describe('Nigerian Pidgin', () => {
  const pidginTrader = (o: Parameters<typeof makeTrader>[1] = {}) => trader({ language: 'pidgin', ...o });

  it('speaks Pidgin on every USSD screen and stays within one screen', async () => {
    const m = await pidginTrader();
    expect(await ussd(m.phone_number, '')).toBe(
      'CON Kobo Kobo\n1. Check Balance\n2. Today Sales & Sweep\n3. Change Sweep Rate (Now: 2%)\n4. Pause / Resume Sweep\n5. Emergency Money\n6. Hear Balance (Call me)\n7. Change PIN',
    );
    expect(await ussd(m.phone_number, '1')).toBe('CON Your Kobo Kobo Balance\nTotal: N368\nEmergency: N184 (You fit collect)\nRetirement: N184 (Lock till 50)\n0. Back');
    expect(await ussd(m.phone_number, '3')).toMatch(/^CON Put your new sweep rate/);
    expect(await ussd(m.phone_number, '3*9')).toMatch(/^END Rate no correct/);
    expect(await ussd(m.phone_number, '3*3')).toMatch(/^END Correct! Your sweep rate na 3% now/);
    expect(await ussd(m.phone_number, '4')).toMatch(/^CON Sweep dey run/);
    expect(await ussd(m.phone_number, '4*1')).toMatch(/^END We don pause your sweep till 8 Nov 2026/);
    expect(await ussd(m.phone_number, '4')).toMatch(/^CON Sweep dey pause till 8 Nov 2026/);
    expect(await ussd(m.phone_number, '4*1')).toMatch(/^END Sweep don continue/);
    expect(await ussd(m.phone_number, '8')).toMatch(/^END That choice no correct/);
    expect(await ussd(m.phone_number, '6')).toMatch(/^END We go call you soon/);
  });

  it('Pidgin withdrawal flow, refusals and closed pot', async () => {
    const m = await pidginTrader();
    expect(await ussd(m.phone_number, '5')).toMatch(/^CON Emergency Pot: N184\nPut the naira/);
    expect(await ussd(m.phone_number, '5*100')).toBe(`CON Collect N100 go Access ****${m.access_nuban.slice(-4)}?\n1. Yes\n2. No`);
    expect(await ussd(m.phone_number, '5*100*2')).toBe('END We don cancel am. No money comot.');
    expect(await ussd(m.phone_number, '5*500')).toBe('END Na only N184 dey your Emergency Pot.');
    expect(await ussd(m.phone_number, '5*abc')).toMatch(/^END Amount no correct/);
    const young = await pidginTrader({ pension: { emergency: '10.00', retirement: '10.00', firstContributionAt: addMonthsToInstant(DURING, -1) } });
    expect(await ussd(young.phone_number, '5')).toBe('END You no fit collect Emergency money now: E go open 6 Jan 2027.');
  });

  it("Pidgin today screen, and English remains the fallback for languages without copy", async () => {
    const m = await pidginTrader();
    await addInflow(pool, m.id, '28000.00', DURING);
    expect(await ussd(m.phone_number, '2')).toBe('END Sales so far: N28,000\nSweep tonight (2%): N560\nSweep dey run 11pm.');
    const yoruba = await trader({ language: 'yoruba' });
    expect(await ussd(yoruba.phone_number, '')).toMatch(/^CON Kobo Kobo\n1\. Balance/);
  });

  it('Pidgin SMS: balance status, unknown, help and pause texts', async () => {
    const m = await pidginTrader({ pension: { emergency: '10.00', retirement: '10.00', firstContributionAt: addMonthsToInstant(DURING, -1) } });
    const sms = async (text: string) => (await app.inject({ method: 'POST', url: '/api/v1/sms/inbound', payload: { from: m.phone_number, text } })).json().reply;
    expect(await sms('BAL')).toContain('Emergency Pot: N10 (E go open 6 Jan 2027)');
    expect(await sms('PAUSE')).toMatch(/We don pause your sweep till 8 Nov 2026/);
    expect(await sms('RESUME')).toBe('Kobo Kobo: Sweep don resume. Next one go run 11pm.');
    expect(await sms('RATE 9')).toMatch(/To change your rate, text RATE and number/);
  });
});

describe('two-way SMS', () => {
  const sms = (from: string, text: string, extra: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url: '/api/v1/sms/inbound', payload: { from, text, ...extra } });
  const outbox = async () => (await pool.query('SELECT to_phone, kind, body FROM sms_outbox ORDER BY created_at, body')).rows;

  it('BAL answers like the PRD sample and queues the same text to the trader', async () => {
    const m = await trader({ pension: { emergency: '18400.00', retirement: '18400.00', firstContributionAt: addMonthsToInstant(DURING, -4) } });
    const res = await sms(m.phone_number, 'BAL');
    expect(res.statusCode).toBe(200);
    expect(res.json().reply).toBe('Kobo Kobo: Total saved is N36,800. Emergency Pot: N18,400 (Eligible for payout). Retirement Pot: N18,400 (Locked till 50). Text PAUSE to stop tomorrow sweep.');
    expect(await outbox()).toEqual([{ to_phone: m.phone_number, kind: 'COMMAND_REPLY', body: res.json().reply }]);
  });

  it('PAUSE / STOP pause for 48h, RESUME / START undo it', async () => {
    const m = await trader();
    expect((await sms(m.phone_number, 'pause')).json().reply).toMatch(/paused until 8 Nov 2026/);
    expect(await merchantRow(m.id)).toMatchObject({ is_paused: true, paused_until: addDaysToInstant(DURING, 2) });
    expect((await sms(m.phone_number, 'RESUME')).json().reply).toMatch(/resumed/);
    expect(await merchantRow(m.id)).toMatchObject({ is_paused: false, paused_until: null });
    await sms(m.phone_number, '  Stop ');
    expect((await merchantRow(m.id)).is_paused).toBe(true);
    await sms(m.phone_number, 'START');
    expect((await merchantRow(m.id)).is_paused).toBe(false);
  });

  it('RATE n sets the rate (1-5, decimals ok) and rejects anything else', async () => {
    const m = await trader();
    expect((await sms(m.phone_number, 'RATE 3')).json().reply).toBe('Kobo Kobo: Sweep rate is now 3%. It applies from the next nightly sweep.');
    expect((await merchantRow(m.id)).rate).toBe('3.00');
    await sms(m.phone_number, 'rate 2.5');
    expect((await merchantRow(m.id)).rate).toBe('2.50');
    await sms(m.phone_number, 'RATE 3%');
    expect((await merchantRow(m.id)).rate).toBe('3.00');
    for (const bad of ['RATE', 'RATE 9', 'RATE 0', 'RATE abc', 'RATE 2.555', 'RATE -2']) {
      expect((await sms(m.phone_number, bad)).json().reply).toMatch(/^Kobo Kobo: To change your rate/);
    }
    expect((await merchantRow(m.id)).rate).toBe('3.00');
  });

  it('HELP and unknown text give the command list; replies come in the trader\'s language', async () => {
    const m = await trader({ language: 'pidgin' });
    expect((await sms(m.phone_number, 'HELP')).json().reply).toContain('RESUME = continue');
    expect((await sms(m.phone_number, 'wetin')).json().reply).toBe('Kobo Kobo: Sorry, we no understand that one. Text HELP to see the commands.');
    expect((await sms(m.phone_number, 'BAL')).json().reply).toContain('Your total savings na');
  });

  it('answers unknown senders in the response only, never spending SMS on them', async () => {
    const res = await sms('+2348099999999', 'BAL');
    expect(res.json().reply).toMatch(/not registered/);
    expect(await outbox()).toEqual([]);
  });

  it('accepts local number formats and the Africa\'s Talking form post, and de-duplicates redelivery', async () => {
    const m = await trader({ phone: '+2348031230000' });
    const form = 'from=08031230000&to=5050&text=BAL&date=2026-11-06&id=ATUid_1&linkId=abc';
    const post = () => app.inject({ method: 'POST', url: '/api/v1/sms/inbound', payload: form, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect((await post()).json().reply).toMatch(/Total saved/);
    await post(); // the telco delivers the same webhook again
    expect(await outbox()).toHaveLength(1);
    void m;
  });

  it('webhook token guards both telco endpoints but not the internal API', async () => {
    const guarded = buildServer(makeDeps(pool, { now: DURING, config: { webhookToken: 'tok', serviceToken: '' } }));
    const m = await trader();
    expect((await guarded.inject({ method: 'POST', url: '/api/v1/sms/inbound', payload: { from: m.phone_number, text: 'BAL' } })).statusCode).toBe(401);
    expect((await guarded.inject({ method: 'POST', url: '/api/v1/sms/inbound?token=tok', payload: { from: m.phone_number, text: 'BAL' } })).statusCode).toBe(200);
    expect((await guarded.inject({ method: 'POST', url: '/api/v1/ussd?token=nope', payload: { phoneNumber: m.phone_number, text: '' } })).statusCode).toBe(401);
    expect((await guarded.inject({ method: 'POST', url: '/api/v1/ussd?token=tok', payload: { phoneNumber: m.phone_number, text: '' } })).statusCode).toBe(200);
    await guarded.close();
  });
});

describe('channel changes drive the nightly sweep (what Rails reads before every sweep)', () => {
  const fund = async (m: { id: string; access_nuban: string }) => {
    await addInflow(pool, m.id, '45000.00', DURING);
    deps.executor.setBalance(m.access_nuban, 100_000_000n);
  };

  it('PAUSE by SMS means tonight\'s sweep is skipped; RESUME by USSD means the next night sweeps', async () => {
    const m = await trader();
    await fund(m);
    await app.inject({ method: 'POST', url: '/api/v1/sms/inbound', payload: { from: m.phone_number, text: 'PAUSE' } });
    deps.setNow(NIGHT);
    expect((await executeSweepForMerchant(deps, m.id, DAY)).status).toBe('SKIPPED_PAUSED');
    expect(deps.executor.calls.debit).toBe(0);

    await ussd(m.phone_number, '4*1'); // paused -> resume
    await addInflow(pool, m.id, '45000.00', new Date('2026-11-07T12:00:00Z'));
    deps.setNow(new Date('2026-11-07T22:30:00Z'));
    expect((await executeSweepForMerchant(deps, m.id, '2026-11-07')).status).toBe('EXECUTED');
  });

  it('a rate change by USSD or SMS is the rate the sweep uses', async () => {
    const m = await trader();
    await fund(m);
    await ussd(m.phone_number, '3*4'); // 4%
    deps.setNow(NIGHT);
    const rec = await executeSweepForMerchant(deps, m.id, DAY);
    expect(rec).toMatchObject({ status: 'EXECUTED', rateHundredths: 400n, sweepAmount: 180_000n }); // N45,000 x 4% = N1,800
    expect(await ussd(m.phone_number, '1')).toContain('Total: N2,168');
  });

  it('the sweep receipt SMS and the later BAL text agree on the balance', async () => {
    const m = await trader({ pension: { emergency: '0.00', retirement: '0.00' } });
    await fund(m);
    deps.setNow(NIGHT);
    await executeSweepForMerchant(deps, m.id, DAY);
    const reply = (await app.inject({ method: 'POST', url: '/api/v1/sms/inbound', payload: { from: m.phone_number, text: 'BAL' } })).json().reply;
    expect(reply).toContain('Total saved is N900.');
    expect(reply).toContain('Emergency Pot: N450 (Opens 6 Feb 2027)');
  });
});
