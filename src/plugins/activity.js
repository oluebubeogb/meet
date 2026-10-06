/**
 * Phase 2 — meeting activity / audit trail
 */
module.exports = {
  id: 'activity',
  register(ctx) {
    const { db, broadcast, getParticipantsList } = ctx;

    async function log(meeting, eventType, actor, detail) {
      if (!meeting) return;
      try {
        await db.logActivity({
          meetingHistoryId: meeting.historyId || null,
          code: meeting.code || '',
          actorId: actor?.id || null,
          actorName: actor?.name || null,
          eventType,
          detail,
        });
      } catch (e) {
        console.warn('[activity]', e.message);
      }
      // Keep a short in-memory ring buffer for live viewers
      if (!Array.isArray(meeting.activityLive)) meeting.activityLive = [];
      const entry = {
        at: Date.now(),
        eventType,
        actorId: actor?.id || null,
        actorName: actor?.name || null,
        detail: detail || null,
      };
      meeting.activityLive.push(entry);
      if (meeting.activityLive.length > 200) meeting.activityLive.shift();
      broadcast(meeting.code || '', {
        type: 'activity',
        entry,
      });
    }

    ctx.logActivity = log;

    // Hook common moderation events via thin wrappers if not already logged elsewhere
    ctx.onWs('raise-hand', ({ participantId, meeting }) => {
      const p = meeting.participants.get(participantId);
      log(meeting, 'hand_raised', p);
    });
    ctx.onWs('lower-hand', ({ msg, participantId, meeting }) => {
      const actor = meeting.participants.get(participantId);
      const target = meeting.participants.get(msg.targetId || participantId);
      log(meeting, 'hand_lowered', actor, { targetId: target?.id, targetName: target?.name });
    });
    ctx.onWs('set-role', ({ msg, participantId, meeting }) => {
      const actor = meeting.participants.get(participantId);
      const target = meeting.participants.get(msg.targetId);
      log(meeting, 'role_changed', actor, { targetId: msg.targetId, targetName: target?.name, role: msg.role });
    });
    ctx.onWs('transfer-host', ({ msg, participantId, meeting }) => {
      const actor = meeting.participants.get(participantId);
      const target = meeting.participants.get(msg.targetId);
      log(meeting, 'host_transferred', actor, { to: msg.targetId, toName: target?.name });
    });
    ctx.onWs('remove-participant', ({ msg, participantId, meeting }) => {
      const actor = meeting.participants.get(participantId);
      log(meeting, 'participant_removed', actor, { targetId: msg.targetId, preventRejoin: !!msg.preventRejoin });
    });
    ctx.onWs('mute-participant', ({ msg, participantId, meeting }) => {
      const actor = meeting.participants.get(participantId);
      const target = meeting.participants.get(msg.targetId);
      log(meeting, 'muted', actor, { targetId: msg.targetId, targetName: target?.name });
    });
    ctx.onWs('lock-meeting', ({ participantId, meeting }) => {
      log(meeting, 'locked', meeting.participants.get(participantId));
    });
    ctx.onWs('unlock-meeting', ({ participantId, meeting }) => {
      log(meeting, 'unlocked', meeting.participants.get(participantId));
    });
    ctx.onWs('start-share', ({ participantId, meeting }) => {
      log(meeting, 'share_started', meeting.participants.get(participantId));
    });
    ctx.onWs('stop-share', ({ participantId, meeting }) => {
      log(meeting, 'share_stopped', meeting.participants.get(participantId));
    });
  },
};
