/**
 * Phase 2A — private 1:1 chat
 * - Live delivery when both online
 * - Messages always persisted (even if peer is away / left)
 * - On rejoin: replay in-memory + DB history for logged-in users
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
      if (!targetId) return;

      let attachment = null;
      if (msg.attachment && typeof msg.attachment === 'object') {
        let kind = 'file';
        if (msg.attachment.kind === 'image') kind = 'image';
        else if (msg.attachment.kind === 'voice') kind = 'voice';
        const name = String(msg.attachment.name || (kind === 'voice' ? 'voice.webm' : 'file')).slice(0, 120);
        const mime = String(msg.attachment.mime || (kind === 'voice' ? 'audio/webm' : 'application/octet-stream')).slice(0, 120);
        const dataUrl = String(msg.attachment.dataUrl || '');
        const maxChars = kind === 'image' ? 900_000 : 7_000_000;
        if (dataUrl.startsWith('data:') && dataUrl.length <= maxChars) {
          attachment = {
            kind,
            name,
            mime,
            size: Number(msg.attachment.size) || dataUrl.length,
            dataUrl,
          };
        }
      }
      if (!text && !attachment) return;

      // Target may have left — still allow send & persist
      let target = meeting.participants.get(targetId);
      const targetName = (target && target.name) || msg.targetName || 'Participant';
      const targetUserId = (target && target.userId) || msg.targetUserId || null;
      const targetActive = !!(target && target.status === 'ACTIVE');

      if (!Array.isArray(meeting.privateChat)) meeting.privateChat = [];
      const entry = {
        id: 'pc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9),
        fromId: participantId,
        fromName: actor.name,
        fromUserId: actor.userId || null,
        toId: targetId,
        toName: targetName,
        toUserId: targetUserId,
        text,
        attachment,
        at: Date.now(),
        peerIsGuest: !targetUserId || !actor.userId,
      };
      meeting.privateChat.push(entry);
      if (meeting.privateChat.length > 800) meeting.privateChat = meeting.privateChat.slice(-500);

      const payload = { type: 'private-chat', message: entry };
      // Always echo to sender
      sendToParticipant(participantId, payload);
      // Deliver to target only if still connected & active
      if (targetActive) {
        sendToParticipant(targetId, payload);
      }

      // Permanent storage (independent of meeting presence)
      // body stores text; attachment JSON is appended in body marker for DMs without schema change
      const bodyForDb = attachment
        ? (text || '') + '\n__attach__' + JSON.stringify({
            kind: attachment.kind,
            name: attachment.name,
            mime: attachment.mime,
            size: attachment.size,
            dataUrl: attachment.dataUrl,
          })
        : text;

      Promise.resolve()
        .then(async () => {
          const aUser = actor.userId || null;
          const bUser = targetUserId || null;

          if (aUser && bUser) {
            const thread = await db.findOrCreateDmThread(aUser, bUser);
            await db.saveDmMessage({
              threadId: thread.id,
              senderUserId: aUser,
              senderParticipantId: participantId,
              senderName: actor.name,
              body: bodyForDb,
              meetingCode,
            });
          } else if (aUser && !bUser) {
            const guestKey = 'guest:' + targetId;
            const thread = await db.findOrCreateGuestDmThread(aUser, guestKey, targetName);
            await db.saveDmMessage({
              threadId: thread.id,
              senderUserId: aUser,
              senderParticipantId: participantId,
              senderName: actor.name,
              body: bodyForDb,
              meetingCode,
            });
          } else if (!aUser && bUser) {
            const guestKey = 'guest:' + participantId;
            const thread = await db.findOrCreateGuestDmThread(bUser, guestKey, actor.name);
            await db.saveDmMessage({
              threadId: thread.id,
              senderUserId: null,
              senderParticipantId: participantId,
              senderName: actor.name,
              body: bodyForDb,
              meetingCode,
            });
          }
        })
        .catch((e) => console.warn('[private-chat] persist', e.message));
    });

    // On (re)join: replay private messages for this meeting + DB history for logged-in users
    ctx.onRegister((ws, meeting, participantId) => {
      if (!meeting) return;
      const p = meeting.participants.get(participantId);
      if (!p) return;

      try {
        // 1) In-memory meeting private chat involving this participant
        if (Array.isArray(meeting.privateChat) && meeting.privateChat.length) {
          const mine = meeting.privateChat.filter(
            (m) => m.fromId === participantId || m.toId === participantId
          );
          // Also match by userId when participantId changed after rejoin
          const byUser =
            p.userId
              ? meeting.privateChat.filter(
                  (m) =>
                    m.fromUserId === p.userId ||
                    m.toUserId === p.userId
                )
              : [];
          const seen = new Set();
          const merged = [];
          [...mine, ...byUser].forEach((m) => {
            if (m.id && seen.has(m.id)) return;
            if (m.id) seen.add(m.id);
            merged.push(m);
          });
          merged.sort((a, b) => (a.at || 0) - (b.at || 0));
          if (merged.length) {
            ws.send(JSON.stringify({ type: 'private-chat-history', messages: merged.slice(-150) }));
          }
        }
      } catch (e) {
        console.warn('[private-chat] in-memory history', e.message);
      }

      // 2) Cross-meeting DB history for logged-in users
      if (p.userId) {
        Promise.resolve()
          .then(async () => {
            const threads = await db.listDmThreadsForUser(p.userId, 30);
            for (const t of threads) {
              const msgs = await db.getDmMessages(t.id, 80);
              if (!msgs.length) continue;
              const peerIsGuest = !!(t.peer_is_guest === true || t.peer_is_guest === 1);
              let peerUserId = null;
              let peerName = t.guest_display_name || 'Guest';
              if (!peerIsGuest) {
                peerUserId = t.user_a_id === p.userId ? t.user_b_id : t.user_a_id;
              }
              // Map to private-chat-history shape (participant ids may be unknown)
              const mapped = msgs.map((m) => ({
                id: 'db_' + m.id,
                fromId: m.sender_user_id === p.userId ? participantId : ('user:' + (m.sender_user_id || 'peer')),
                fromName: m.sender_name,
                fromUserId: m.sender_user_id,
                toId: m.sender_user_id === p.userId ? ('user:' + (peerUserId || 'peer')) : participantId,
                toName: m.sender_user_id === p.userId ? peerName : p.name,
                toUserId: m.sender_user_id === p.userId ? peerUserId : p.userId,
                text: m.body,
                at: m.created_at ? new Date(m.created_at).getTime() : Date.now(),
                peerIsGuest,
                _peerUserId: peerUserId,
                _peerName: peerName,
                _fromDb: true,
              }));
              ws.send(
                JSON.stringify({
                  type: 'private-chat-history',
                  messages: mapped,
                  peerUserId,
                  peerName,
                  peerIsGuest,
                })
              );
            }
          })
          .catch((e) => console.warn('[private-chat] db history', e.message));
      }
    });
  },
};
