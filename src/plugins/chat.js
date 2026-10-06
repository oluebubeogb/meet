/** Plugin: in-meeting chat — text, mentions, images (webp), file attachments
 *  Permanent: messages are written to chat_messages and linked to meeting history / artifact.
 */

const db = require('../../db');

const MAX_TEXT = 2000;
const MAX_IMAGE_DATA_CHARS = 900_000;
const MAX_FILE_DATA_CHARS = 2_800_000;
const MAX_HISTORY = 150;

module.exports = {
  id: 'chat',
  register(ctx) {
    const { broadcast } = ctx;

    ctx.onWs('chat', ({ msg, participantId, meeting, meetingCode }) => {
      const p = meeting.participants.get(participantId);
      if (!p) return;

      const text = String(msg.text || '').trim().slice(0, MAX_TEXT);
      const mentions = Array.isArray(msg.mentions)
        ? msg.mentions
            .slice(0, 20)
            .map((m) => ({
              id: String(m.id || '').slice(0, 80),
              name: String(m.name || '').slice(0, 40),
            }))
            .filter((m) => m.id || m.name)
        : [];

      let attachment = null;
      if (msg.attachment && typeof msg.attachment === 'object') {
        let kind = 'file';
        if (msg.attachment.kind === 'image') kind = 'image';
        else if (msg.attachment.kind === 'voice') kind = 'voice';
        const name = String(msg.attachment.name || (kind === 'voice' ? 'voice.webm' : 'file')).slice(0, 120);
        const mime = String(msg.attachment.mime || (kind === 'voice' ? 'audio/webm' : 'application/octet-stream')).slice(0, 120);
        const dataUrl = String(msg.attachment.dataUrl || '');
        const maxChars = kind === 'image' ? MAX_IMAGE_DATA_CHARS : MAX_FILE_DATA_CHARS;
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

      const chatMsg = {
        type: 'chat',
        id: Date.now() + '-' + Math.random().toString(36).slice(2, 7),
        participantId,
        name: p.name,
        text,
        mentions,
        attachment,
        at: Date.now(),
      };

      if (!Array.isArray(meeting.chatHistory)) meeting.chatHistory = [];
      meeting.chatHistory.push(chatMsg);
      if (meeting.chatHistory.length > MAX_HISTORY * 1.3) {
        meeting.chatHistory = meeting.chatHistory.slice(-MAX_HISTORY);
      }
      broadcast(meetingCode, chatMsg);

      const attachForDb = attachment
        ? {
            kind: attachment.kind,
            name: attachment.name,
            mime: attachment.mime,
            size: attachment.size,
            dataUrl:
              attachment.dataUrl && attachment.dataUrl.length < 200_000
                ? attachment.dataUrl
                : null,
            omitted: !!(attachment.dataUrl && attachment.dataUrl.length >= 200_000),
          }
        : null;

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
            senderName: p.name,
            senderUserId: p.userId || null,
            body: text || null,
            attachments: attachForDb,
            groupId: null,
          });
        })
        .catch((e) => console.warn('[chat] persist', e.message));
    });

    ctx.onRegister((ws, meeting) => {
      if (!meeting || !Array.isArray(meeting.chatHistory) || !meeting.chatHistory.length) return;
      try {
        const messages = meeting.chatHistory.slice(-80).map((m) => {
          if (!m.attachment || !m.attachment.dataUrl) return m;
          if (m.attachment.dataUrl.length > 400_000) {
            return {
              ...m,
              attachment: {
                ...m.attachment,
                dataUrl: null,
                omitted: true,
              },
            };
          }
          return m;
        });
        ws.send(JSON.stringify({ type: 'chat-history', messages }));
      } catch (_) {}
    });
  },
};
