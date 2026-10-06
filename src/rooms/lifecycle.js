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

async function endMeeting(code, reason = 'ended') {
  const meeting = getMeeting(code);
  if (!meeting) return;
  if (meeting.historyId) {
    try {
      await db.endMeetingHistory(meeting.historyId);
    } catch (_) {}
    try {
      // Phase 1: permanent Artifact for ended meetings
      await db.ensureArtifactForHistory(meeting.historyId, code);
    } catch (e) {
      console.warn('[artifact] create on end', e.message);
    }
  }
  if (meeting.scheduledId) {
    try {
      await db.updateScheduledStatus(meeting.scheduledId, 'ended', {
        endedAt: new Date().toISOString(),
      });
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
      Promise.resolve(endMeeting(code, 'inactivity')).catch(() => {});
    }
  }
}

module.exports = {
  endMeeting,
  cleanupInactiveMeetings,
  touchMeeting,
};
