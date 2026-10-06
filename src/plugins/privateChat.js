/**
 * Phase 2A — private 1:1 chat
 * - Live delivery to both participants
 * - Permanent history across meetings for logged-in user pairs
 * - Guest-aware: if one side is logged in, store under that user's DM with guest label
 * - On reconnect, replay in-memory private history for this meeting
 */

const db = require('../../db');

module.exports = {
  id: 'privateChat',
  register(ctx) {
    const { sendToParticipant } = ctx;

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
        fromUserId: actor.userId || null,
        toId: targetId,
        toName: target.name,
        toUserId: target.userId || null,
        text,
        at: Date.now(),
        peerIsGuest: !target.userId || !actor.userId,
      };
      meeting.privateChat.push(entry);
      if (meeting.privateChat.length > 500) meeting.privateChat.shift();

      const payload = { type: 'private-chat', message: entry };
      sendToParticipant(participantId, payload);
      sendToParticipant(targetId, payload);

      // Permanent DM storage
      Promise.resolve()
        .then(async () => {
          const aUser = actor.userId || null;
          const bUser = target.userId || null;

          if (aUser && bUser) {
            // Both logged in → cross-meeting thread
            const thread = await db.findOrCreateDmThread(aUser, bUser);
            await db.saveDmMessage({
              threadId: thread.id,
              senderUserId: aUser,
              senderParticipantId: participantId,
              senderName: actor.name,
              body: text,
              meetingCode,
            });
          } else if (aUser && !bUser) {
            // Actor logged in, target is guest
            const guestKey = 'guest:' + targetId;
            const thread = await db.findOrCreateGuestDmThread(aUser, guestKey, target.name);
            await db.saveDmMessage({
              threadId: thread.id,
              senderUserId: aUser,
              senderParticipantId: participantId,
              senderName: actor.name,
              body: text,
              meetingCode,
            });
          } else if (!aUser && bUser) {
            // Actor is guest, target logged in — store under target's thread
            const guestKey = 'guest:' + participantId;
            const thread = await db.findOrCreateGuestDmThread(bUser, guestKey, actor.name);
            await db.saveDmMessage({
              threadId: thread.id,
              senderUserId: null,
              senderParticipantId: participantId,
              senderName: actor.name,
              body: text,
              meetingCode,
            });
          }
          // guest ↔ guest: in-memory only for this meeting
        })
        .catch((e) => console.warn('[private-chat] persist', e.message));
    });

    // On (re)join: replay private messages involving this participant for this live meeting
    ctx.onRegister((ws, meeting, participantId) => {
      if (!meeting || !Array.isArray(meeting.privateChat) || !meeting.privateChat.length) return;
      try {
        const mine = meeting.privateChat.filter(
          (m) => m.fromId === participantId || m.toId === participantId
        );
        if (mine.length) {
          ws.send(JSON.stringify({ type: 'private-chat-history', messages: mine.slice(-100) }));
        }
      } catch (_) {}
    });
  },
};
