import { kv } from '@vercel/kv';

// All group-moderation logic lives here, separate from the private-chat AI
// conversation flow in telegram.js. Groups stay quiet by default — she
// moderates silently and only replies when a command is used or she's
// directly mentioned/replied to. That's the whole point of a moderation
// bot: acting without constant chatter.

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const QSTASH_TOKEN = process.env.QSTASH_TOKEN;
const REMINDER_SECRET = process.env.REMINDER_SECRET || 'pxr-8k2m9qzt4v-default';

async function tg(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return r.json();
}

function settingsKey(chatId) { return `group:${chatId}:settings`; }
function commandsKey(chatId) { return `group:${chatId}:commands`; }
function warningsKey(chatId, userId) { return `group:${chatId}:warnings:${userId}`; }
function pendingKey(chatId, userId) { return `group:${chatId}:pending:${userId}`; }
function floodKey(chatId, userId) { return `group:${chatId}:flood:${userId}`; }
function statsKey(chatId) { return `group:${chatId}:stats`; }

const DEFAULT_SETTINGS = {
  bannedWords: [],
  welcomeMessage: 'Welcome! Please read the group rules and be respectful.',
  verificationEnabled: true,
  linksBlocked: false,
  floodLimit: 5,     // messages
  floodWindow: 6     // seconds
};

async function getSettings(chatId) {
  const stored = await kv.get(settingsKey(chatId));
  return { ...DEFAULT_SETTINGS, ...(stored || {}) };
}

async function saveSettings(chatId, settings) {
  await kv.set(settingsKey(chatId), settings);
}

async function bumpStat(chatId, field) {
  try { await kv.hincrby(statsKey(chatId), field, 1); } catch (e) { /* stats are a bonus */ }
}

async function isAdmin(chatId, userId) {
  try {
    const r = await tg('getChatMember', { chat_id: chatId, user_id: userId });
    const status = r.result?.status;
    return status === 'administrator' || status === 'creator';
  } catch (e) {
    return false;
  }
}

// --- New member join: verification + welcome ---
export async function handleNewMembers(update, res, host) {
  const chatId = update.message.chat.id;
  const newMembers = update.message.new_chat_members;
  const settings = await getSettings(chatId);

  for (const member of newMembers) {
    if (member.is_bot) continue; // don't gate other bots
    await bumpStat(chatId, 'joins');

    if (!settings.verificationEnabled) {
      await tg('sendMessage', { chat_id: chatId, text: `${settings.welcomeMessage}` });
      continue;
    }

    // Restrict until verified
    await tg('restrictChatMember', {
      chat_id: chatId,
      user_id: member.id,
      permissions: { can_send_messages: false }
    });

    const promptRes = await tg('sendMessage', {
      chat_id: chatId,
      text: `Welcome ${member.first_name}! Tap the button below within 5 minutes to verify you're human and unlock chatting.`,
      reply_markup: {
        inline_keyboard: [[{ text: "I'm not a robot ✅", callback_data: `verify_${member.id}` }]]
      }
    });

    const promptMessageId = promptRes.result?.message_id;
    await kv.set(pendingKey(chatId, member.id), { promptMessageId, joinedAt: Date.now() });
    await kv.expire(pendingKey(chatId, member.id), 600);

    // Schedule an automatic kick if they don't verify in time — reuses the
    // same one-off delayed-webhook mechanism as personal reminders.
    if (QSTASH_TOKEN) {
      try {
        const base = `https://${host}`;
        const destination = `${base}/api/group-verify-timeout?secret=${REMINDER_SECRET}`;
        await fetch(`https://qstash.upstash.io/v2/publish/${destination}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${QSTASH_TOKEN}`,
            'Content-Type': 'application/json',
            'Upstash-Delay': '300s'
          },
          body: JSON.stringify({ chatId, userId: member.id, promptMessageId })
        });
      } catch (e) { /* timeout kick is a bonus safeguard, don't block on it */ }
    }
  }

  return res.status(200).send('OK');
}

// --- Verification button click ---
export async function handleCallbackQuery(update, res) {
  const query = update.callback_query;
  const data = query.data;
  const chatId = query.message.chat.id;
  const clickerId = query.from.id;

  if (data?.startsWith('verify_')) {
    const targetUserId = parseInt(data.split('_')[1], 10);
    if (clickerId !== targetUserId) {
      await tg('answerCallbackQuery', { callback_query_id: query.id, text: "This verification isn't for you.", show_alert: true });
      return res.status(200).send('OK');
    }

    await tg('restrictChatMember', {
      chat_id: chatId,
      user_id: targetUserId,
      permissions: {
        can_send_messages: true, can_send_audios: true, can_send_documents: true,
        can_send_photos: true, can_send_videos: true, can_send_other_messages: true,
        can_add_web_page_previews: true
      }
    });

    await kv.del(pendingKey(chatId, targetUserId));
    await tg('answerCallbackQuery', { callback_query_id: query.id, text: 'Verified! Welcome in.' });
    await tg('deleteMessage', { chat_id: chatId, message_id: query.message.message_id });

    const settings = await getSettings(chatId);
    await tg('sendMessage', { chat_id: chatId, text: settings.welcomeMessage });
  }

  return res.status(200).send('OK');
}

// --- Regular group message: moderation + commands ---
export async function handleGroupMessage(update, res) {
  const message = update.message;
  const chatId = message.chat.id;
  const userId = message.from.id;
  const text = message.text || '';
  await bumpStat(chatId, 'messages');

  const userIsAdmin = await isAdmin(chatId, userId);

  // --- Admin config commands ---
  if (text.startsWith('/') && userIsAdmin) {
    const handled = await handleAdminCommand(chatId, message, text);
    if (handled) return res.status(200).send('OK');
  }

  // --- Moderation commands (reply to a user's message, admin-only) ---
  if (userIsAdmin && message.reply_to_message && text.startsWith('/')) {
    const handled = await handleModerationCommand(chatId, message, text);
    if (handled) return res.status(200).send('OK');
  }

  // --- Custom commands ---
  if (text.startsWith('/')) {
    const trigger = text.split(' ')[0].slice(1).toLowerCase();
    const customResponse = await kv.hget(commandsKey(chatId), trigger);
    if (customResponse) {
      await tg('sendMessage', { chat_id: chatId, text: customResponse });
      return res.status(200).send('OK');
    }
  }

  // Non-admins skip moderation checks entirely for the group owner/admins
  if (!userIsAdmin) {
    const settings = await getSettings(chatId);

    // Flood/rapid-fire protection
    const floodCount = await kv.incr(floodKey(chatId, userId));
    if (floodCount === 1) await kv.expire(floodKey(chatId, userId), settings.floodWindow);
    if (floodCount > settings.floodLimit) {
      await tg('deleteMessage', { chat_id: chatId, message_id: message.message_id }).catch(() => {});
      await bumpStat(chatId, 'deleted');
      // Temporary mute for 2 minutes on flood
      await tg('restrictChatMember', {
        chat_id: chatId, user_id: userId,
        permissions: { can_send_messages: false },
        until_date: Math.floor(Date.now() / 1000) + 120
      }).catch(() => {});
      return res.status(200).send('OK');
    }

    // Banned words
    const lowerText = text.toLowerCase();
    if (settings.bannedWords.some(w => lowerText.includes(w.toLowerCase()))) {
      await tg('deleteMessage', { chat_id: chatId, message_id: message.message_id }).catch(() => {});
      await bumpStat(chatId, 'deleted');
      return res.status(200).send('OK');
    }

    // Link blocking
    if (settings.linksBlocked && /https?:\/\/|t\.me\//i.test(text)) {
      await tg('deleteMessage', { chat_id: chatId, message_id: message.message_id }).catch(() => {});
      await bumpStat(chatId, 'deleted');
      return res.status(200).send('OK');
    }
  }

  return res.status(200).send('OK');
}

async function handleAdminCommand(chatId, message, text) {
  const [cmd, ...rest] = text.split(' ');
  const arg = rest.join(' ');

  if (cmd === '/addbannedword' && arg) {
    const settings = await getSettings(chatId);
    settings.bannedWords.push(arg.trim());
    await saveSettings(chatId, settings);
    await tg('sendMessage', { chat_id: chatId, text: `Added banned word: "${arg.trim()}"` });
    return true;
  }
  if (cmd === '/removebannedword' && arg) {
    const settings = await getSettings(chatId);
    settings.bannedWords = settings.bannedWords.filter(w => w.toLowerCase() !== arg.trim().toLowerCase());
    await saveSettings(chatId, settings);
    await tg('sendMessage', { chat_id: chatId, text: `Removed banned word: "${arg.trim()}"` });
    return true;
  }
  if (cmd === '/setwelcome' && arg) {
    const settings = await getSettings(chatId);
    settings.welcomeMessage = arg;
    await saveSettings(chatId, settings);
    await tg('sendMessage', { chat_id: chatId, text: 'Welcome message updated.' });
    return true;
  }
  if (cmd === '/togglelinks') {
    const settings = await getSettings(chatId);
    settings.linksBlocked = !settings.linksBlocked;
    await saveSettings(chatId, settings);
    await tg('sendMessage', { chat_id: chatId, text: `Link blocking for non-admins is now ${settings.linksBlocked ? 'ON' : 'OFF'}.` });
    return true;
  }
  if (cmd === '/toggleverification') {
    const settings = await getSettings(chatId);
    settings.verificationEnabled = !settings.verificationEnabled;
    await saveSettings(chatId, settings);
    await tg('sendMessage', { chat_id: chatId, text: `New member verification is now ${settings.verificationEnabled ? 'ON' : 'OFF'}.` });
    return true;
  }
  if (cmd === '/setcommand') {
    const [trigger, ...respParts] = rest;
    const response = respParts.join(' ');
    if (!trigger || !response) {
      await tg('sendMessage', { chat_id: chatId, text: 'Usage: /setcommand rules Your response text here' });
      return true;
    }
    await kv.hset(commandsKey(chatId), { [trigger.toLowerCase()]: response });
    await tg('sendMessage', { chat_id: chatId, text: `Custom command /${trigger.toLowerCase()} saved.` });
    return true;
  }
  if (cmd === '/removecommand' && arg) {
    await kv.hdel(commandsKey(chatId), arg.trim().toLowerCase());
    await tg('sendMessage', { chat_id: chatId, text: `Removed command /${arg.trim().toLowerCase()}.` });
    return true;
  }
  if (cmd === '/stats') {
    const stats = await kv.hgetall(statsKey(chatId)) || {};
    await tg('sendMessage', {
      chat_id: chatId,
      text: `Group stats:\nMessages seen: ${stats.messages || 0}\nDeleted: ${stats.deleted || 0}\nJoins: ${stats.joins || 0}\nBans: ${stats.bans || 0}`
    });
    return true;
  }
  if (cmd === '/modhelp') {
    await tg('sendMessage', {
      chat_id: chatId,
      text: `Admin commands:\n/addbannedword [word]\n/removebannedword [word]\n/setwelcome [text]\n/togglelinks\n/toggleverification\n/setcommand [trigger] [response]\n/removecommand [trigger]\n/stats\n\nReply to a user's message with:\n/warn\n/unwarn\n/mute [minutes]\n/unmute\n/kick\n/ban`
    });
    return true;
  }
  return false;
}

async function handleModerationCommand(chatId, message, text) {
  const cmd = text.split(' ')[0];
  const targetUserId = message.reply_to_message.from.id;
  const targetName = message.reply_to_message.from.first_name;

  if (cmd === '/warn') {
    const count = await kv.incr(warningsKey(chatId, targetUserId));
    if (count >= 3) {
      await tg('restrictChatMember', {
        chat_id: chatId, user_id: targetUserId,
        permissions: { can_send_messages: false },
        until_date: Math.floor(Date.now() / 1000) + 3600
      });
      await kv.del(warningsKey(chatId, targetUserId));
      await tg('sendMessage', { chat_id: chatId, text: `${targetName} hit 3 warnings — muted for 1 hour.` });
    } else {
      await tg('sendMessage', { chat_id: chatId, text: `${targetName} warned (${count}/3).` });
    }
    return true;
  }
  if (cmd === '/unwarn') {
    await kv.decr(warningsKey(chatId, targetUserId));
    await tg('sendMessage', { chat_id: chatId, text: `Removed one warning from ${targetName}.` });
    return true;
  }
  if (cmd === '/mute') {
    const minutes = parseInt(text.split(' ')[1], 10) || 60;
    await tg('restrictChatMember', {
      chat_id: chatId, user_id: targetUserId,
      permissions: { can_send_messages: false },
      until_date: Math.floor(Date.now() / 1000) + minutes * 60
    });
    await tg('sendMessage', { chat_id: chatId, text: `${targetName} muted for ${minutes} minute(s).` });
    return true;
  }
  if (cmd === '/unmute') {
    await tg('restrictChatMember', {
      chat_id: chatId, user_id: targetUserId,
      permissions: {
        can_send_messages: true, can_send_audios: true, can_send_documents: true,
        can_send_photos: true, can_send_videos: true, can_send_other_messages: true,
        can_add_web_page_previews: true
      }
    });
    await tg('sendMessage', { chat_id: chatId, text: `${targetName} unmuted.` });
    return true;
  }
  if (cmd === '/kick') {
    await tg('banChatMember', { chat_id: chatId, user_id: targetUserId });
    await tg('unbanChatMember', { chat_id: chatId, user_id: targetUserId });
    await tg('sendMessage', { chat_id: chatId, text: `${targetName} kicked.` });
    return true;
  }
  if (cmd === '/ban') {
    await tg('banChatMember', { chat_id: chatId, user_id: targetUserId });
    await bumpStat(chatId, 'bans');
    await tg('sendMessage', { chat_id: chatId, text: `${targetName} banned.` });
    return true;
  }
  return false;
}
