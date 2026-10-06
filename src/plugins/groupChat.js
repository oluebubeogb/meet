/**
 * Phase 2 — in-meeting sub-group chats
 * Host/cohost can create groups, add/remove members.
 * Messages persisted to chat_messages with group_id.
 */

const db = require('../../db');

module.exports = {
  id: 'groupChat',
  register(ctx) {
    const { sendToParticipant, broadcast } = ctx;

    function isModerator(actor) {
      return actor && (actor.role === 'host' || actor.role === 'cohost');
    }

    function memberIds(meeting, groupId) {
      const g = (meeting.chatGroups || {})[groupId];
      return g ? (g.members || []) : [];
    }

    function sendToGroup(meeting, groupId, payload, exceptId) {
      const members = memberIds(meeting, groupId);
      for (const mid of members) {
        if (exceptId && mid === exceptId) continue;
        sendToParticipant(mid, payload);
      }
    }

    ctx.onWs('group-create', ({ msg, participantId, meeting, meetingCode }) => {
      const actor = meeting.participants.get(participantId);
      if (!isModerator(actor)) return;
      const groupId = String(msg.groupId || 'grp_' + Date.now()).slice(0, 80);
      const title = String(msg.title || 'Group').trim().slice(0, 40) || 'Group';
      let members = Array.isArray(msg.members) ? msg.members.map(String).slice(0, 50) : [];
      if (!members.includes(participantId)) members.unshift(participantId);

      if (!meeting.chatGroups) meeting.chatGroups = {};
      meeting.chatGroups[groupId] = {
        id: groupId,
        title,
        members: [...new Set(members)],
        createdBy: participantId,
        messages: [],
      };

      const state = {
        type: 'group-state',
        group: {
          id: groupId,
          title,
          members: meeting.chatGroups[groupId].members.map((id) => {
            const p = meeting.participants.get(id);
            return {
              id,
              name: p ? p.name : id,
              role: p ? p.role : 'participant',
              userId: p ? p.userId || null : null,
            };
          }),
        },
      };
      sendToGroup(meeting, groupId, state);

      Promise.resolve()
        .then(async () => {
          await db.createChatGroup({
            id: groupId,
            meetingCode,
            meetingHistoryId: meeting.historyId || null,
            title,
            createdByParticipantId: participantId,
            createdByUserId: actor.userId || null,
          });
          for (const mid of meeting.chatGroups[groupId].members) {
            const p = meeting.participants.get(mid);
            await db.addChatGroupMember({
              groupId,
              participantId: mid,
              userId: p ? p.userId || null : null,
              displayName: p ? p.name : mid,
            });
          }
        })
        .catch((e) => console.warn('[group-create]', e.message));
    });

    ctx.onWs('group-chat', ({ msg, participantId, meeting, meetingCode }) => {
      const actor = meeting.participants.get(participantId);
      if (!actor || actor.status !== 'ACTIVE') return;
      const groupId = String(msg.groupId || '');
      const text = String(msg.text || '').trim().slice(0, 2000);
      if (!groupId || !text) return;
      if (!meeting.chatGroups || !meeting.chatGroups[groupId]) return;
      const g = meeting.chatGroups[groupId];
      if (!g.members.includes(participantId)) return;

      const entry = {
        id: 'gc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
        groupId,
        fromId: participantId,
        fromName: actor.name,
        fromUserId: actor.userId || null,
        text,
        at: Date.now(),
      };
      if (!Array.isArray(g.messages)) g.messages = [];
      g.messages.push(entry);
      if (g.messages.length > 300) g.messages = g.messages.slice(-200);

      const payload = { type: 'group-chat', message: entry };
      sendToGroup(meeting, groupId, payload);

      Promise.resolve()
        .then(async () => {
          let artifactId = meeting.artifactId || null;
          if (!artifactId && meeting.historyId) {
            try {
              const art = await db.ensureArtifactForHistory(meeting.historyId, meetingCode);
              if (art) {
                meeting.artifactId = art.id;
                artifactId = art.id;
              }
            } catch (_) {}
          }
          await db.saveChatMessage({
            meetingHistoryId: meeting.historyId || null,
            artifactId,
            sessionId: meetingCode,
            senderId: participantId,
            senderName: actor.name,
            senderUserId: actor.userId || null,
            body: text,
            attachments: null,
            groupId,
          });
        })
        .catch((e) => console.warn('[group-chat] persist', e.message));
    });

    ctx.onWs('group-add-member', ({ msg, participantId, meeting }) => {
      const actor = meeting.participants.get(participantId);
      if (!isModerator(actor)) return;
      const groupId = String(msg.groupId || '');
      const targetId = String(msg.targetId || '');
      if (!groupId || !targetId || !meeting.chatGroups || !meeting.chatGroups[groupId]) return;
      const target = meeting.participants.get(targetId);
      if (!target || target.status !== 'ACTIVE') return;
      const g = meeting.chatGroups[groupId];
      if (!g.members.includes(targetId)) g.members.push(targetId);

      const memberPayload = {
        type: 'group-members',
        groupId,
        members: g.members.map((id) => {
          const p = meeting.participants.get(id);
          return {
            id,
            name: p ? p.name : id,
            role: p ? p.role : 'participant',
            userId: p ? p.userId || null : null,
          };
        }),
      };
      sendToGroup(meeting, groupId, memberPayload);
      sendToParticipant(targetId, {
        type: 'group-state',
        group: { id: groupId, title: g.title, members: memberPayload.members },
      });

      db.addChatGroupMember({
        groupId,
        participantId: targetId,
        userId: target.userId || null,
        displayName: target.name,
      }).catch(() => {});
    });

    ctx.onWs('group-remove-member', ({ msg, participantId, meeting }) => {
      const actor = meeting.participants.get(participantId);
      if (!isModerator(actor)) return;
      const groupId = String(msg.groupId || '');
      const targetId = String(msg.targetId || '');
      if (!groupId || !targetId || !meeting.chatGroups || !meeting.chatGroups[groupId]) return;
      const g = meeting.chatGroups[groupId];
      g.members = g.members.filter((id) => id !== targetId);

      const memberPayload = {
        type: 'group-members',
        groupId,
        members: g.members.map((id) => {
          const p = meeting.participants.get(id);
          return {
            id,
            name: p ? p.name : id,
            role: p ? p.role : 'participant',
            userId: p ? p.userId || null : null,
          };
        }),
      };
      sendToGroup(meeting, groupId, memberPayload);
      sendToParticipant(targetId, { type: 'group-removed', groupId });

      db.removeChatGroupMember(groupId, targetId).catch(() => {});
    });

    // Replay groups this participant belongs to
    ctx.onRegister((ws, meeting, participantId) => {
      if (!meeting || !meeting.chatGroups) return;
      try {
        for (const gid of Object.keys(meeting.chatGroups)) {
          const g = meeting.chatGroups[gid];
          if (!g.members.includes(participantId)) continue;
          const members = g.members.map((id) => {
            const p = meeting.participants.get(id);
            return {
              id,
              name: p ? p.name : id,
              role: p ? p.role : 'participant',
              userId: p ? p.userId || null : null,
            };
          });
          ws.send(
            JSON.stringify({
              type: 'group-state',
              group: { id: gid, title: g.title, members },
            })
          );
          const msgs = (g.messages || []).slice(-80);
          if (msgs.length) {
            ws.send(JSON.stringify({ type: 'group-chat-history', groupId: gid, messages: msgs }));
          }
        }
      } catch (_) {}
    });
  },
};
