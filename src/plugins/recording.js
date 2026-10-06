/**
 * Phase 1/2 — recording signaling + pause/stop + client file metadata
 */
module.exports = {
  id: 'recording',
  register(ctx) {
    const { db, broadcast } = ctx;

    function emitState(meeting, meetingCode) {
      broadcast(meetingCode, {
        type: 'recording-state',
        recording: meeting.recording || null,
      });
    }

    ctx.onWs('start-recording', async ({ msg, participantId, meeting, meetingCode }) => {
      const actor = meeting.participants.get(participantId);
      if (!actor || actor.role !== 'host') return;
      if (meeting.recording && (meeting.recording.status === 'recording' || meeting.recording.status === 'paused')) {
        return;
      }

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
        id: row && row.id ? row.id : null,
        status: 'recording',
        startedAt: Date.now(),
        pausedAt: null,
        pausedTotalMs: 0,
        startedBy: actor.name,
        options,
        fileUrl: null,
      };

      if (ctx.logActivity) {
        try { ctx.logActivity(meeting, 'recording_started', actor, options); } catch (_) {}
      }

      emitState(meeting, meetingCode);
      broadcast(meetingCode, { type: 'toast', message: 'Recording started' });
      broadcast(meetingCode, {
        type: 'recording-capture',
        action: 'start',
        recordingId: meeting.recording.id,
        options,
      });
    });

    ctx.onWs('pause-recording', async ({ participantId, meeting, meetingCode }) => {
      const actor = meeting.participants.get(participantId);
      if (!actor || actor.role !== 'host') return;
      if (!meeting.recording || meeting.recording.status !== 'recording') return;

      meeting.recording.status = 'paused';
      meeting.recording.pausedAt = Date.now();

      if (ctx.logActivity) {
        try { ctx.logActivity(meeting, 'recording_paused', actor); } catch (_) {}
      }
      emitState(meeting, meetingCode);
      broadcast(meetingCode, { type: 'toast', message: 'Recording paused' });
      broadcast(meetingCode, { type: 'recording-capture', action: 'pause', recordingId: meeting.recording.id });
    });

    ctx.onWs('resume-recording', async ({ participantId, meeting, meetingCode }) => {
      const actor = meeting.participants.get(participantId);
      if (!actor || actor.role !== 'host') return;
      if (!meeting.recording || meeting.recording.status !== 'paused') return;

      if (meeting.recording.pausedAt) {
        meeting.recording.pausedTotalMs =
          (meeting.recording.pausedTotalMs || 0) + (Date.now() - meeting.recording.pausedAt);
      }
      meeting.recording.pausedAt = null;
      meeting.recording.status = 'recording';

      if (ctx.logActivity) {
        try { ctx.logActivity(meeting, 'recording_resumed', actor); } catch (_) {}
      }
      emitState(meeting, meetingCode);
      broadcast(meetingCode, { type: 'toast', message: 'Recording resumed' });
      broadcast(meetingCode, { type: 'recording-capture', action: 'resume', recordingId: meeting.recording.id });
    });

    ctx.onWs('stop-recording', async ({ msg, participantId, meeting, meetingCode }) => {
      const actor = meeting.participants.get(participantId);
      if (!actor || actor.role !== 'host') return;
      if (!meeting.recording || !['recording', 'paused'].includes(meeting.recording.status)) return;

      const fileUrl = (msg && msg.fileUrl) || null;
      const filePath = (msg && msg.filePath) || null;

      try {
        if (meeting.recording.id) {
          await db.stopRecording(meeting.recording.id, { fileUrl, filePath });
        }
      } catch (e) {
        console.error('[recording] stop', e.message);
      }

      meeting.recording.status = 'stopped';
      meeting.recording.endedAt = Date.now();
      meeting.recording.fileUrl = fileUrl;

      if (ctx.logActivity) {
        try { ctx.logActivity(meeting, 'recording_stopped', actor, { fileUrl: !!fileUrl }); } catch (_) {}
      }

      emitState(meeting, meetingCode);
      broadcast(meetingCode, {
        type: 'toast',
        message: fileUrl ? 'Recording saved to Artifacts' : 'Recording stopped — saved to history',
      });
      broadcast(meetingCode, {
        type: 'recording-capture',
        action: 'stop',
        recordingId: meeting.recording.id,
      });
    });
  },
};
