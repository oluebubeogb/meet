/**
 * Phase 2B — breakout rooms (assignment + signaling; media rooms via LiveKit room names)
 */
module.exports = {
  id: 'breakout',
  register(ctx) {
    const { broadcast, sendToParticipant, getParticipantsList } = ctx;

    function emitBreakouts(meeting, meetingCode) {
      broadcast(meetingCode, {
        type: 'breakout-state',
        breakouts: meeting.breakouts || null,
      });
    }

    ctx.onWs('breakout-create', ({ msg, participantId, meeting, meetingCode }) => {
      const actor = meeting.participants.get(participantId);
      if (!actor || actor.role !== 'host') return;
      const count = Math.min(10, Math.max(2, parseInt(msg.count || 2, 10)));
      const active = [...meeting.participants.values()].filter(
        (p) => p.status === 'ACTIVE' && p.role !== 'host'
      );
      const rooms = [];
      for (let i = 0; i < count; i++) {
        rooms.push({
          id: 'bo_' + (i + 1),
          name: 'Room ' + (i + 1),
          participantIds: [],
          livekitRoom: meetingCode + '-bo-' + (i + 1),
        });
      }
      active.forEach((p, idx) => {
        rooms[idx % count].participantIds.push(p.id);
      });
      meeting.breakouts = {
        open: true,
        rooms,
        createdAt: Date.now(),
        createdBy: participantId,
      };
      emitBreakouts(meeting, meetingCode);
      broadcast(meetingCode, { type: 'toast', message: count + ' breakout rooms opened' });
      // Notify each participant of their room
      rooms.forEach((room) => {
        room.participantIds.forEach((pid) => {
          sendToParticipant(pid, {
            type: 'breakout-assign',
            room,
          });
        });
      });
    });

    ctx.onWs('breakout-close', ({ participantId, meeting, meetingCode }) => {
      const actor = meeting.participants.get(participantId);
      if (!actor || actor.role !== 'host') return;
      meeting.breakouts = { open: false, rooms: [], closedAt: Date.now() };
      emitBreakouts(meeting, meetingCode);
      broadcast(meetingCode, { type: 'toast', message: 'Breakout rooms closed — return to main' });
      broadcast(meetingCode, { type: 'breakout-return' });
    });

    ctx.onWs('breakout-move', ({ msg, participantId, meeting, meetingCode }) => {
      const actor = meeting.participants.get(participantId);
      if (!actor || actor.role !== 'host') return;
      if (!meeting.breakouts?.open) return;
      const { targetId, roomId } = msg;
      meeting.breakouts.rooms.forEach((r) => {
        r.participantIds = r.participantIds.filter((id) => id !== targetId);
      });
      const room = meeting.breakouts.rooms.find((r) => r.id === roomId);
      if (room) {
        room.participantIds.push(targetId);
        sendToParticipant(targetId, { type: 'breakout-assign', room });
      }
      emitBreakouts(meeting, meetingCode);
    });
  },
};
