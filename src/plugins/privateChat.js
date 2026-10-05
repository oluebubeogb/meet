/**
 * Phase 2A — private 1:1 chat during a live meeting
 */
module.exports = {
  id: 'privateChat',
  register(ctx) {
    const { sendToParticipant, broadcast } = ctx;

    ctx.onWs('private-chat', ({ msg, participantId, meeting, meetingCode }) => {
      const actor = meeting.participants.get(participantId);
      if (!actor || actor.status !== 'ACTIVE') return;
      const targetId = msg.targetId;
      const text = String(msg.text || '').trim().slice(0, 2000);
      if (!targetId || !text) return;
      const target = meeting.participants.get(targetId);
      if (!target || target.status !== 'ACTIVE') return;

      if (!Array.isArray(meeting.privateChat)) meeting.privateChat = [];
      const entry = {
        id: 'pc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
        fromId: participantId,
        fromName: actor.name,
        toId: targetId,
        toName: target.name,
        text,
        at: Date.now(),
      };
      meeting.privateChat.push(entry);
      if (meeting.privateChat.length > 500) meeting.privateChat.shift();

      const payload = { type: 'private-chat', message: entry };
      sendToParticipant(participantId, payload);
      sendToParticipant(targetId, payload);
    });
  },
};
