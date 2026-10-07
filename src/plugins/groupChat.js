/**
 * Phase 2 — in-meeting sub-group chats
 * Host/cohost can create groups, add/remove members.
 * Messages persisted to chat_messages with group_id.
 * Live updates so members see groups without page reload.
 */

const db = require('../../db');

module.exports = {
  id: 'groupChat',
  register(ctx) {
    const { sendToParticipant } = ctx;

    function isModerator(actor) {
      return actor && (actor.role === 'host' || actor.role === 'cohost');
    }

    function memberIds(meeting, groupId) {
      const g = (meeting.chatGroups || {})[groupId];
      return g ? (g.members || []) : [];
    }

    function memberPayload(meeting, groupId) {
      const g = meeting.chatGroups[groupId];
      if (!g) return [];
      return g.members.map((id) => {
        const p = meeting.participants.get(id);
        return {
          id,
          name: p ? p.name : (g.memberNames && g.memberNames[id]) || id,
          role: p ? p.role : 'participant',
          userId: p ? p.userId || null : null,
        };
      });
    }

    function sendToGroup(meeting, groupId, payload) {
      const members = memberIds(meeting, groupId);
      for (const mid of members) {
        sendToParticipant(mid, payload);
      }
    }

    function emitGroupState(meeting, groupId) {
      const g = meeting.chatGroups[groupId];
      if (!g) return;
      const state = {
        type: 'group-state',
        group: {
          id: groupId,
          title: g.title,
          members: memberPayload(meeting, groupId),
        },
      };
      sendToGroup(meeting, groupId, state);
    }

    ctx.onWs('group-create', ({ msg, participantId, meeting, meetingCode }) => {
      const actor = meeting.participants.get(participantId);
      if (!isModerator(actor)) return;
      const groupId = String(msg.groupId || 'grp_' + Date.now()).slice(0, 80);
      const title = String(msg.title || msg.name || 'Group').trim().slice(0, 40) || 'Group';
      let members = Array.isArray(msg.members) ? msg.members.map(String).slice(0, 50) : [];
      if (!members.includes(participantId)) members.unshift(participantId);
      members = [...new Set(members)];

      if (!meeting.chatGroups) meeting.chatGroups = {};
      const memberNames = {};
      members.forEach((id) => {
        const p = meeting.participants.get(id);
        memberNames[id] = p ? p.name : id;
      });
      meeting.chatGroups[groupId] = {
        id: groupId,
        title,
        members,
        memberNames,
        createdBy: participantId,
        messages: [],
      };

      emitGroupState(meeting, groupId);

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
          for (const mid of members) {
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
      if (!groupId) return;
      if (!meeting.chatGroups || !meeting.chatGroups[groupId]) return;
      const g = meeting.chatGroups[groupId];
      if (!g.members.includes(participantId)) return;

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

      const entry = {
        id: 'gc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9),
        groupId,
        fromId: participantId,
        fromName: actor.name,
        fromUserId: actor.userId || null,
        text,
        attachment,
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
            body: text || null,
            attachments: attachment
              ? { kind: attachment.kind, name: attachment.name, mime: attachment.mime, size: attachment.size, dataUrl: attachment.dataUrl }
              : null,
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
      if (!target) return;
      const g = meeting.chatGroups[groupId];
      if (!g.members.includes(targetId)) g.members.push(targetId);
      if (!g.memberNames) g.memberNames = {};
      g.memberNames[targetId] = target.name;

      emitGroupState(meeting, groupId);
      // Explicit notify for the newly added member (in case emit missed)
      sendToParticipant(targetId, {
        type: 'group-state',
        group: { id: groupId, title: g.title, members: memberPayload(meeting, groupId) },
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

      const memberPayloadMsg = {
        type: 'group-members',
        groupId,
        members: memberPayload(meeting, groupId),
      };
      sendToGroup(meeting, groupId, memberPayloadMsg);
      sendToParticipant(targetId, { type: 'group-removed', groupId });

      db.removeChatGroupMember(groupId, targetId).catch(() => {});
    });

    // Replay groups this participant belongs to (and backfill title/messages)
    ctx.onRegister((ws, meeting, participantId) => {
      if (!meeting || !meeting.chatGroups) return;
      try {
        for (const gid of Object.keys(meeting.chatGroups)) {
          const g = meeting.chatGroups[gid];
          if (!g.members.includes(participantId)) continue;
          ws.send(
            JSON.stringify({
              type: 'group-state',
              group: { id: gid, title: g.title, members: memberPayload(meeting, gid) },
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
