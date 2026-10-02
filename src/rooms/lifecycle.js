const db = require('../../db');
const config = require('../config');
const {
  getMeeting,
  deleteMeeting,
  allMeetings,
  getClient,
  deleteClient,
  touchMeeting,
} = require('./store');

function endMeeting(code, reason = 'ended') {
  const meeting = getMeeting(code);
  if (!meeting) return;
  if (meeting.historyId) {
    try {
      db.endMeetingHistory(meeting.historyId);
    } catch (_) {}
  }
  if (meeting.scheduledId) {
    try {
      db.updateScheduledStatus(meeting.scheduledId, 'ended', {
        endedAt: new Date().toISOString(),
      });
      try {
        const { schedulePayoutForMeeting } = require('../lib/payouts');
        schedulePayoutForMeeting(meeting.scheduledId);
      } catch (e) {
        console.warn('[payout schedule]', e.message);
      }
    } catch (_) {}
  }
  for (const [pid] of meeting.participants) {
    const ws = getClient(pid);
    if (ws) {
      try {
        ws.send(JSON.stringify({ type: 'meeting-ended', reason }));
        ws.close();
      } catch (_) {}
      deleteClient(pid);
    }
  }
  deleteMeeting(code);
  console.log(`[meeting] ended ${code} (${reason})`);
}

function cleanupInactiveMeetings() {
  const now = Date.now();
  for (const [code, meeting] of allMeetings()) {
    const last = meeting.lastActivity || meeting.createdAt || 0;
    if (now - last >= config.MEETING_INACTIVITY_MS) {
      endMeeting(code, 'inactivity');
    }
  }
}

module.exports = {
  endMeeting,
  cleanupInactiveMeetings,
  touchMeeting,
};
