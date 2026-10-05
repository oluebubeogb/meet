/**
 * Phase 2B — collaborative whiteboard stroke relay
 */
module.exports = {
  id: 'whiteboard',
  register(ctx) {
    const { broadcast, sendToParticipant } = ctx;

    ctx.onWs('wb-stroke', ({ msg, participantId, meeting, meetingCode }) => {
      const actor = meeting.participants.get(participantId);
      if (!actor || actor.status !== 'ACTIVE') return;
      if (!Array.isArray(meeting.wbStrokes)) meeting.wbStrokes = [];
      const stroke = {
        id: msg.id || 's_' + Date.now(),
        from: participantId,
        fromName: actor.name,
        points: msg.points || [],
        color: msg.color || '#111',
        width: msg.width || 3,
        erase: !!msg.erase,
        at: Date.now(),
      };
      meeting.wbStrokes.push(stroke);
      if (meeting.wbStrokes.length > 2000) meeting.wbStrokes = meeting.wbStrokes.slice(-1500);
      broadcast(meetingCode, { type: 'wb-stroke', stroke }, participantId);
    });

    ctx.onWs('wb-clear', ({ participantId, meeting, meetingCode }) => {
      const actor = meeting.participants.get(participantId);
      if (!actor || (actor.role !== 'host' && actor.role !== 'cohost')) return;
      meeting.wbStrokes = [];
      broadcast(meetingCode, { type: 'wb-clear', by: participantId });
    });

    ctx.onWs('wb-sync', ({ participantId, meeting }) => {
      sendToParticipant(participantId, {
        type: 'wb-sync',
        strokes: meeting.wbStrokes || [],
      });
    });
  },
};
