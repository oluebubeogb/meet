/**
 * Auto-transfer ticket proceeds to host after meeting ends + PAYOUT_DELAY_DAYS.
 */
const db = require('../../db');
const config = require('../config');
const paystack = require('./paystack');

function schedulePayoutForMeeting(scheduledId) {
  const meeting = db.getScheduledById(scheduledId);
  if (!meeting) return null;
  if (!meeting.is_paid) return null;
  if (meeting.verification_status !== 'paid') {
    console.warn(`[payout] skip meeting ${scheduledId}: verification not paid`);
    return null;
  }
  const existing = db.getPayoutForMeeting(scheduledId);
  if (existing && existing.status !== 'failed') return existing;

  const income = db.getMeetingIncome(scheduledId);
  const gross = income.grossKobo || 0;
  if (gross <= 0) {
    console.log(`[payout] meeting ${scheduledId}: no ticket revenue`);
    return null;
  }
  const fee = Math.round((gross * (config.PLATFORM_FEE_PERCENT || 0)) / 100);
  const net = Math.max(0, gross - fee);
  const endedAt = meeting.ended_at || new Date().toISOString();
  const eligible = new Date(endedAt);
  eligible.setDate(eligible.getDate() + (config.PAYOUT_DELAY_DAYS || 0));

  return db.createMeetingPayout({
    scheduledMeetingId: scheduledId,
    hostUserId: meeting.host_user_id,
    payoutAccountId: meeting.payout_account_id,
    grossKobo: gross,
    feeKobo: fee,
    netKobo: net,
    eligibleAt: eligible.toISOString(),
  });
}

async function processEligiblePayouts() {
  if (!paystack.isConfigured()) return;
  const now = new Date().toISOString();
  const rows = db.listEligiblePayouts(now);
  for (const row of rows) {
    try {
      const account = row.payout_account_id ? db.getPayoutAccountById(row.payout_account_id) : null;
      if (!account || !account.paystack_recipient_code) {
        db.updateMeetingPayout(row.id, {
          status: 'failed',
          errorMessage: 'No verified payout account / recipient',
        });
        continue;
      }
      if (row.net_kobo < 10000) {
        // Paystack minimum transfer is often ₦100
        db.updateMeetingPayout(row.id, {
          status: 'failed',
          errorMessage: 'Net amount below minimum transfer',
        });
        continue;
      }
      db.updateMeetingPayout(row.id, { status: 'processing' });
      const reference = paystack.newReference('payout');
      const result = await paystack.initiateTransfer({
        amountKobo: row.net_kobo,
        recipientCode: account.paystack_recipient_code,
        reference,
        reason: `Meet ticket proceeds #${row.scheduled_meeting_id}`,
      });
      db.updateMeetingPayout(row.id, {
        status: 'success',
        paystackTransferCode: result.transfer_code || result.id || null,
        paystackReference: reference,
        transferredAt: new Date().toISOString(),
      });
      console.log(`[payout] transferred ${row.net_kobo} kobo for meeting ${row.scheduled_meeting_id}`);
    } catch (e) {
      console.error('[payout] failed', row.id, e.message);
      db.updateMeetingPayout(row.id, {
        status: 'failed',
        errorMessage: e.message || 'Transfer failed',
      });
    }
  }
}

function startPayoutWorker() {
  setInterval(() => {
    processEligiblePayouts().catch((e) => console.error('[payout worker]', e));
  }, config.PAYOUT_POLL_INTERVAL_MS || 5 * 60 * 1000);
  // first run after short delay
  setTimeout(() => {
    processEligiblePayouts().catch(() => {});
  }, 15000);
}

module.exports = {
  schedulePayoutForMeeting,
  processEligiblePayouts,
  startPayoutWorker,
};
