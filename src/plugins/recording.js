/**
 * Phase 2 — recording signaling (LiveKit egress / client capture can attach later)
 */
const { can } = require('../lib/permissions');

module.exports = {
  id: 'recording',
  register(ctx) {
    const { db, broadcast, sendToParticipant } = ctx;

    function emitState(meeting, meetingCode) {
      broadcast(meetingCode, {
        type: 'recording-state',
        recording: meeting.recording || null,
      });
    }

    ctx.onWs('start-recording', async ({ msg, participantId, meeting, meetingCode }) => {
      const actor = meeting.participants.get(participantId);
      if (!actor || actor.role !== 'host') return;
      if (meeting.recording && meeting.recording.status === 'recording') return;

      const options = {
        audio: msg.audio !== false,
        video: msg.video !== false,
        screenShare: msg.screenShare !== false,
        chat: msg.chat !== false,
      };

      let row = null;
      try {
        row = await db.startRecording({
          meetingHistoryId: meeting.historyId || null,
          code: meetingCode,
          startedByUserId: actor.userId || null,
          startedByName: actor.name,
          options,
        });
      } catch (e) {
        console.error('[recording] start', e.message);
      }

      meeting.recording = {
        id: row?.id || null,
        status: 'recording',
        startedAt: Date.now(),
        startedBy: actor.name,
        options,
      };

      if (ctx.logActivity) {
        ctx.logActivity(meeting, 'recording_started', actor, options);
      }

      emitState(meeting, meetingCode);
      broadcast(meetingCode, {
        type: 'toast',
        message: 'Recording started',
      });
    });

    ctx.onWs('stop-recording', async ({ participantId, meeting, meetingCode }) => {
      const actor = meeting.participants.get(participantId);
      if (!actor || actor.role !== 'host') return;
      if (!meeting.recording || meeting.recording.status !== 'recording') return;

      try {
        if (meeting.recording.id) await db.stopRecording(meeting.recording.id);
      } catch (e) {
        console.error('[recording] stop', e.message);
      }

      meeting.recording.status = 'stopped';
      meeting.recording.endedAt = Date.now();

      if (ctx.logActivity) {
        ctx.logActivity(meeting, 'recording_stopped', actor);
      }

      emitState(meeting, meetingCode);
      broadcast(meetingCode, {
        type: 'toast',
        message: 'Recording stopped',
      });
    });
  },
};
