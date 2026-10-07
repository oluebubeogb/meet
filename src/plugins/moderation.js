/**
 * Phase 1 moderation: roles, waiting room, raised hands, lock, remove, ask-unmute
 */
const { can, isModerator, normalizeRole } = require('../lib/permissions');
const {
  getParticipantsList,
  getWaitingList,
  getRaisedHands,
  getSecurityState,
  broadcast,
  broadcastToModerators,
  sendToParticipant,
  blockParticipant,
  serializeParticipant,
} = require('../rooms/store');

function emitRoster(meetingCode, meeting) {
  broadcast(meetingCode, {
    type: 'participants',
    participants: getParticipantsList(meeting),
    waiting: getWaitingList(meeting),
    raisedHands: getRaisedHands(meeting),
  });
}

function emitSecurity(meetingCode, meeting) {
  broadcast(meetingCode, {
    type: 'security-updated',
    security: getSecurityState(meeting),
  });
}

module.exports = {
  id: 'moderation',
  register(ctx) {
    // ----- Raise / lower hand -----
    ctx.onWs('raise-hand', ({ participantId, meeting, meetingCode }) => {
      const p = meeting.participants.get(participantId);
      if (!p || p.status !== 'ACTIVE') return;
      if (!can(meeting, p, 'raiseHand')) return;
      p.handRaisedAt = Date.now();
      emitRoster(meetingCode, meeting);
      broadcast(meetingCode, {
        type: 'hand-raised',
        participantId,
        name: p.name,
        raisedHands: getRaisedHands(meeting),
      });
    });

    ctx.onWs('lower-hand', ({ msg, participantId, meeting, meetingCode }) => {
      const targetId = msg.targetId || participantId;
      const actor = meeting.participants.get(participantId);
      const target = meeting.participants.get(targetId);
      if (!actor || !target) return;
      if (targetId !== participantId && !can(meeting, actor, 'lowerHands')) return;
      target.handRaisedAt = null;
      emitRoster(meetingCode, meeting);
      broadcast(meetingCode, {
        type: 'hand-lowered',
        participantId: targetId,
        by: participantId,
        raisedHands: getRaisedHands(meeting),
      });
    });

    ctx.onWs('lower-all-hands', ({ participantId, meeting, meetingCode }) => {
      const actor = meeting.participants.get(participantId);
      if (!actor || !can(meeting, actor, 'lowerHands')) return;
      for (const p of meeting.participants.values()) {
        p.handRaisedAt = null;
      }
      emitRoster(meetingCode, meeting);
      broadcast(meetingCode, {
        type: 'hands-cleared',
        by: participantId,
        raisedHands: [],
      });
    });

    // ----- Ask to unmute -----
    ctx.onWs('ask-unmute', ({ msg, participantId, meeting, meetingCode }) => {
      const actor = meeting.participants.get(participantId);
      if (!actor || !can(meeting, actor, 'askUnmute')) return;
      const targetId = msg.targetId;
      const target = meeting.participants.get(targetId);
      if (!target || target.status !== 'ACTIVE') return;
      sendToParticipant(targetId, {
        type: 'ask-unmute',
        by: participantId,
        byName: actor.name,
      });
    });

    // ----- Role changes -----
    ctx.onWs('set-role', async ({ msg, participantId, meeting, meetingCode }) => {
      const actor = meeting.participants.get(participantId);
      if (!actor || !can(meeting, actor, 'manageRoles')) return;
      const targetId = msg.targetId;
      const newRole = normalizeRole(msg.role);
      if (newRole === 'host') return; // use transfer-host
      const target = meeting.participants.get(targetId);
      if (!target || target.role === 'host') return;
      if (newRole !== 'cohost' && newRole !== 'participant' && newRole !== 'guest') return;
      target.role = newRole;
      target.isHost = false;
      try {
        if (ctx.db) {
          await ctx.db.upsertMembership({
            code: meetingCode,
            userId: target.userId,
            participantId: targetId,
            displayName: target.name,
            role: newRole,
            status: 'ACTIVE',
          });
        }
      } catch (_) {}
      emitRoster(meetingCode, meeting);
      broadcast(meetingCode, {
        type: 'role-changed',
        participantId: targetId,
        role: newRole,
        by: participantId,
        participants: getParticipantsList(meeting),
      });
    });

    ctx.onWs('transfer-host', ({ msg, participantId, meeting, meetingCode }) => {
      const actor = meeting.participants.get(participantId);
      if (!actor || actor.role !== 'host') return;
      const targetId = msg.targetId;
      const target = meeting.participants.get(targetId);
      if (!target || target.status !== 'ACTIVE') return;
      actor.role = 'cohost';
      actor.isHost = false;
      target.role = 'host';
      target.isHost = true;
      meeting.hostId = targetId;
      emitRoster(meetingCode, meeting);
      broadcast(meetingCode, {
        type: 'host-transferred',
        from: participantId,
        to: targetId,
        participants: getParticipantsList(meeting),
      });
    });

    // ----- Remove -----
    ctx.onWs('remove-participant', async ({ msg, participantId, meeting, meetingCode }) => {
      const actor = meeting.participants.get(participantId);
      if (!actor || !can(meeting, actor, 'removePeople')) return;
      const targetId = msg.targetId;
      if (targetId === participantId) return;
      const target = meeting.participants.get(targetId);
      if (!target || target.role === 'host') return;
      // cohost cannot remove host or other cohosts unless host
      if (actor.role === 'cohost' && (target.role === 'host' || target.role === 'cohost')) return;

      const preventRejoin = !!msg.preventRejoin;
      blockParticipant(meeting, target, { preventRejoin });
      try {
        if (ctx.db) {
          await ctx.db.setMembershipStatus(meetingCode, {
            userId: target.userId,
            participantId: targetId,
            status: preventRejoin ? 'BLOCKED' : 'REMOVED',
          });
        }
      } catch (_) {}

      sendToParticipant(targetId, {
        type: 'removed',
        by: participantId,
        byName: actor.name,
        preventRejoin,
      });

      const tws = ctx.getClient(targetId);
      if (tws) {
        try { tws.close(); } catch (_) {}
        ctx.deleteClient(targetId);
      }

      emitRoster(meetingCode, meeting);
      broadcast(meetingCode, {
        type: 'participant-removed',
        participantId: targetId,
        participants: getParticipantsList(meeting),
        waiting: getWaitingList(meeting),
      });
    });

    // ----- Waiting room admit / decline -----
    ctx.onWs('admit-participant', ({ msg, participantId, meeting, meetingCode }) => {
      const actor = meeting.participants.get(participantId);
      if (!actor || !can(meeting, actor, 'manageWaiting')) return;
      const targetId = msg.targetId;
      const target = meeting.participants.get(targetId);
      if (!target || target.status !== 'WAITING') return;
      target.status = 'ACTIVE';
      target.approvedAt = Date.now();
      sendToParticipant(targetId, {
        type: 'admitted',
        meeting: {
          code: meetingCode,
          name: meeting.name,
          participantId: targetId,
        },
        participants: getParticipantsList(meeting),
      });
      emitRoster(meetingCode, meeting);
      broadcast(meetingCode, {
        type: 'participant-joined',
        participantId: targetId,
        participants: getParticipantsList(meeting),
        waiting: getWaitingList(meeting),
      });
    });

    ctx.onWs('decline-participant', ({ msg, participantId, meeting, meetingCode }) => {
      const actor = meeting.participants.get(participantId);
      if (!actor || !can(meeting, actor, 'manageWaiting')) return;
      const targetId = msg.targetId;
      const target = meeting.participants.get(targetId);
      if (!target || target.status !== 'WAITING') return;
      target.status = 'REMOVED';
      sendToParticipant(targetId, {
        type: 'declined',
        by: participantId,
      });
      const tws = ctx.getClient(targetId);
      if (tws) {
        try { tws.close(); } catch (_) {}
        ctx.deleteClient(targetId);
      }
      meeting.participants.delete(targetId);
      emitRoster(meetingCode, meeting);
      broadcastToModerators(meetingCode, {
        type: 'waiting-updated',
        waiting: getWaitingList(meeting),
      });
    });

    ctx.onWs('admit-all', ({ participantId, meeting, meetingCode }) => {
      const actor = meeting.participants.get(participantId);
      if (!actor || !can(meeting, actor, 'manageWaiting')) return;
      const waiting = [...meeting.participants.values()].filter((p) => p.status === 'WAITING');
      for (const target of waiting) {
        target.status = 'ACTIVE';
        target.approvedAt = Date.now();
        sendToParticipant(target.id, {
          type: 'admitted',
          meeting: { code: meetingCode, name: meeting.name, participantId: target.id },
          participants: getParticipantsList(meeting),
        });
      }
      emitRoster(meetingCode, meeting);
      broadcast(meetingCode, {
        type: 'participants',
        participants: getParticipantsList(meeting),
        waiting: [],
      });
    });

    ctx.onWs('decline-all', ({ participantId, meeting, meetingCode }) => {
      const actor = meeting.participants.get(participantId);
      if (!actor || !can(meeting, actor, 'manageWaiting')) return;
      const waiting = [...meeting.participants.values()].filter((p) => p.status === 'WAITING');
      for (const target of waiting) {
        sendToParticipant(target.id, { type: 'declined', by: participantId });
        const tws = ctx.getClient(target.id);
        if (tws) {
          try { tws.close(); } catch (_) {}
          ctx.deleteClient(target.id);
        }
        meeting.participants.delete(target.id);
      }
      emitRoster(meetingCode, meeting);
      broadcastToModerators(meetingCode, {
        type: 'waiting-updated',
        waiting: [],
      });
    });

    // ----- Security / lock -----
    ctx.onWs('update-security', ({ msg, participantId, meeting, meetingCode }) => {
      const actor = meeting.participants.get(participantId);
      if (!actor || !can(meeting, actor, 'manageSecurity')) return;
      if (!meeting.settings) return;
      const s = meeting.settings;
      const patch = msg.settings || {};
      const keys = [
        'waitingRoom', 'guestAccess', 'locked',
        'participantScreenShare', 'participantMicrophone', 'participantCamera',
        'chat', 'reactions', 'raiseHand',
        'participantsCanInvite', 'guestsCanInvite',
      ];
      const prevShare = s.participantScreenShare !== false;
      for (const k of keys) {
        if (typeof patch[k] === 'boolean') s[k] = patch[k];
      }
      const shareAllowed = s.participantScreenShare !== false;
      // Push resolved permissions to every active non-host so UI updates without reload
      for (const [pid, p] of meeting.participants) {
        if (!p || p.status !== 'ACTIVE') continue;
        const perms = require('../lib/permissions').resolvePermissions(meeting, p);
        sendToParticipant(pid, {
          type: 'permissions-updated',
          permissions: perms,
        });
        // If screen share was turned off for non-moderators, force-stop their share
        if (prevShare && !shareAllowed && !isModerator(p) && p.sharing) {
          p.sharing = false;
          sendToParticipant(pid, {
            type: 'force-stop-share',
            byName: actor.name || 'Host',
          });
          broadcast(meetingCode, {
            type: 'share-stopped',
            participantId: pid,
          });
        }
      }
      emitSecurity(meetingCode, meeting);
      emitRoster(meetingCode, meeting);
    });

    ctx.onWs('lock-meeting', ({ participantId, meeting, meetingCode }) => {
      const actor = meeting.participants.get(participantId);
      if (!actor || !can(meeting, actor, 'lockMeeting')) return;
      meeting.settings.locked = true;
      emitSecurity(meetingCode, meeting);
      broadcast(meetingCode, { type: 'meeting-locked', locked: true });
    });

    ctx.onWs('unlock-meeting', ({ participantId, meeting, meetingCode }) => {
      const actor = meeting.participants.get(participantId);
      if (!actor || !can(meeting, actor, 'lockMeeting')) return;
      meeting.settings.locked = false;
      emitSecurity(meetingCode, meeting);
      broadcast(meetingCode, { type: 'meeting-locked', locked: false });
    });

    // Per-user permission overrides (Phase 2)
    ctx.onWs('set-participant-permissions', ({ msg, participantId, meeting, meetingCode }) => {
      const actor = meeting.participants.get(participantId);
      if (!actor || !can(meeting, actor, 'manageRoles')) return;
      const targetId = msg.targetId;
      const target = meeting.participants.get(targetId);
      if (!target || target.role === 'host') return;
      const patch = msg.permissions || {};
      target.permissionOverrides = target.permissionOverrides || {};
      ['microphone', 'camera', 'screenShare', 'chat', 'reactions', 'raiseHand'].forEach((k) => {
        if (typeof patch[k] === 'boolean') target.permissionOverrides[k] = patch[k];
      });
      emitRoster(meetingCode, meeting);
      sendToParticipant(targetId, {
        type: 'permissions-updated',
        permissions: require('../lib/permissions').resolvePermissions(meeting, target),
      });
      broadcast(meetingCode, {
        type: 'participants',
        participants: getParticipantsList(meeting),
      });
    });

    // Enhanced mute — require permission
    ctx.onWs('mute-participant', ({ msg, participantId, meeting, meetingCode }) => {
      const actor = meeting.participants.get(participantId);
      if (!actor || !can(meeting, actor, 'muteOthers')) return;
      const targetId = msg.targetId;
      const target = meeting.participants.get(targetId);
      if (!target) return;
      target.mutedByHost = true;
      sendToParticipant(targetId, {
        type: 'force-mute',
        by: participantId,
        byName: actor.name,
      });
      emitRoster(meetingCode, meeting);
    });

    ctx.onWs('set-max-participants', ({ msg, participantId, meeting, meetingCode }) => {
      const actor = meeting.participants.get(participantId);
      if (!actor || actor.role !== 'host') return;
      const max = Math.min(100, Math.max(2, parseInt(msg.max || 20, 10)));
      if (!meeting.settings) meeting.settings = {};
      meeting.settings.maxParticipants = max;
      meeting.maxParticipants = max;
      broadcast(meetingCode, { type: 'toast', message: 'Participant limit set to ' + max });
      broadcast(meetingCode, { type: 'security-state', security: { maxParticipants: max } });
    });


    ctx.onWs('mute-all', ({ participantId, meeting, meetingCode }) => {
      const actor = meeting.participants.get(participantId);
      if (!actor || (actor.role !== 'host' && actor.role !== 'cohost')) return;
      const { broadcast, sendToParticipant } = ctx;
      for (const [pid, p] of meeting.participants) {
        if (pid === participantId) continue;
        if (p.status !== 'ACTIVE') continue;
        if (p.role === 'host') continue;
        p.mutedByHost = true;
        sendToParticipant(pid, {
          type: 'force-mute',
          byName: actor.name,
          byId: participantId,
        });
      }
      broadcast(meetingCode, { type: 'toast', message: 'Everyone muted by ' + (actor.name || 'host') });
      if (ctx.logActivity) {
        try { ctx.logActivity(meeting, 'mute_all', actor); } catch (_) {}
      }
    });

    // Attention ring — plays a tone on the recipient's client (works in background)
    ctx.onWs('ring-all', ({ participantId, meeting, meetingCode }) => {
      const actor = meeting.participants.get(participantId);
      if (!actor || (actor.role !== 'host' && actor.role !== 'cohost')) return;
      const { broadcast } = ctx;
      broadcast(meetingCode, {
        type: 'ring-all',
        fromId: participantId,
        fromName: actor.name,
        isAll: true,
        at: Date.now(),
      });
      if (ctx.logActivity) {
        try { ctx.logActivity(meeting, 'ring_all', actor); } catch (_) {}
      }
    });

    ctx.onWs('ring-participant', ({ msg, participantId, meeting }) => {
      const actor = meeting.participants.get(participantId);
      if (!actor || (actor.role !== 'host' && actor.role !== 'cohost')) return;
      const targetId = String(msg.targetId || '');
      if (!targetId) return;
      const target = meeting.participants.get(targetId);
      if (!target || target.status !== 'ACTIVE') return;
      const { sendToParticipant } = ctx;
      sendToParticipant(targetId, {
        type: 'ring-participant',
        targetId,
        fromId: participantId,
        fromName: actor.name,
        at: Date.now(),
      });
      if (ctx.logActivity) {
        try { ctx.logActivity(meeting, 'ring_participant', actor, { targetId, targetName: target.name }); } catch (_) {}
      }
    });

  },
};
