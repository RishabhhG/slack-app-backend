/**
 * slack.service.js
 * Encapsulates all Slack API calls: mentions, DMs, self-DMs, threads, reactions.
 * Keeps server.js clean and makes the service independently testable.
 */
import { WebClient } from '@slack/web-api';

// ─── In-process name caches (cleared on server restart — acceptable for MVP) ──
const userCache = {};
const channelCache = {};

async function resolveUserName(slack, uid) {
  if (!uid) return 'Unknown';
  if (userCache[uid]) return userCache[uid];
  try {
    const info = await slack.users.info({ user: uid });
    const name =
      info.user?.profile?.display_name ||
      info.user?.real_name ||
      info.user?.name ||
      uid;
    userCache[uid] = name;
    return name;
  } catch {
    return uid;
  }
}

async function resolveChannelName(slack, cid) {
  if (!cid) return 'unknown';
  if (channelCache[cid]) return channelCache[cid];
  try {
    const info = await slack.conversations.info({ channel: cid });
    const name = info.channel?.name || cid;
    channelCache[cid] = name;
    return name;
  } catch {
    return cid;
  }
}

/**
 * Replace all <@UID> / <@UID|name> / <#CID|name> / URLs in message text
 * with human-readable strings.
 */
async function resolveTextMentions(slack, text) {
  if (!text) return '';
  let result = text;

  // Fast-path: piped display names <@UID|name>
  result = result.replace(/<@([A-Z0-9]+)\|([^>]+)>/g, '@$2');

  // Slow-path: plain <@UID> → API lookup
  const uids = [
    ...new Set([...result.matchAll(/<@([A-Z0-9]+)>/g)].map((m) => m[1])),
  ];
  for (const uid of uids) {
    const name = await resolveUserName(slack, uid);
    result = result.replace(new RegExp(`<@${uid}>`, 'g'), `@${name}`);
  }

  result = result.replace(/<#[A-Z0-9]+\|([^>]+)>/g, '#$1');
  result = result.replace(/<(https?[^|>]+)\|?[^>]*>/g, '$1');
  return result;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch direct @mentions for the authenticated user.
 * Uses search.messages so we only get messages where the user is actually tagged.
 *
 * @param {string} token  Slack user token (xoxp-…)
 * @param {string} myUid  Slack user ID of the authenticated user
 * @returns {Promise<Array>} Normalised feed items
 */
async function fetchMentions(token, myUid) {
  const slack = new WebClient(token);
  const items = [];

  // ── Direct @mentions ────────────────────────────────────────────────────────
  if (myUid) {
    const mentionToken = `<@${myUid}>`;
    console.log(`[Slack] Searching mentions for ${mentionToken}`);

    const results = await slack.search.messages({
      query: `"${mentionToken}"`,
      count: 30,
      sort: 'timestamp',
      sort_dir: 'desc',
    });

    const msgs = results?.messages?.matches || [];
    console.log(`[Slack] Found ${msgs.length} mention messages`);

    for (const msg of msgs) {
      // Hard verify the mention is really in the text
      if (!msg.text?.includes(`<@${myUid}`)) continue;

      const channelName =
        msg.channel?.name ||
        (msg.channel?.id
          ? await resolveChannelName(slack, msg.channel.id)
          : 'unknown');

      const senderName =
        msg.username && !/^[A-Z0-9]{9,}$/.test(msg.username)
          ? msg.username
          : await resolveUserName(slack, msg.user);

      const cleanText = await resolveTextMentions(slack, msg.text);
      const ts = parseFloat(msg.ts) * 1000;
      const isDm =
        msg.channel?.is_im || msg.channel?.name?.startsWith('D') || false;

      items.push({
        id: `slack_mention_${msg.ts}`,
        source: 'slack',
        type: 'Mention',
        title: cleanText.slice(0, 120) + (cleanText.length > 120 ? '…' : ''),
        meta: `${senderName} · ${isDm ? `DM from ${senderName}` : `#${channelName}`}`,
        raisedBy: senderName,
        channel: channelName,
        channelId: msg.channel?.id || null,
        senderId: msg.user || null,
        time: new Date(ts).toLocaleString(),
        priority: 'high',
        url: msg.permalink || 'https://slack.com',
        rawTime: ts,
        slackTs: msg.ts,
        isDm: !!isDm,
        threadTs: msg.thread_ts || null,
        isThread: !!(msg.thread_ts && msg.thread_ts !== msg.ts),
      });
    }
  } else {
    // No UID configured — fall back to channel scan (less precise)
    console.warn('[Slack] No myUserId set, falling back to channel scan');
    const channelList = await slack.conversations.list({
      types: 'public_channel,private_channel',
      limit: 50,
    });
    const channels = (channelList.channels || []).filter((c) => c.is_member);

    for (const channel of channels.slice(0, 10)) {
      try {
        const history = await slack.conversations.history({
          channel: channel.id,
          limit: 30,
        });
        for (const msg of history.messages || []) {
          if (msg.subtype) continue;
          const text = msg.text || '';
          if (!text.toLowerCase().includes('?') && !text.includes('@'))
            continue;
          const ts = parseFloat(msg.ts) * 1000;
          if (Date.now() - ts > 7 * 24 * 3600 * 1000) continue;

          const senderName = await resolveUserName(slack, msg.user);
          const cleanText = await resolveTextMentions(slack, text);

          items.push({
            id: `slack_${msg.ts}`,
            source: 'slack',
            type: text.includes('@') ? 'Mention' : 'Question',
            title: cleanText.slice(0, 120) + (cleanText.length > 120 ? '…' : ''),
            meta: `${senderName} · #${channel.name}`,
            raisedBy: senderName,
            channel: channel.name,
            channelId: channel.id,
            time: new Date(ts).toLocaleString(),
            priority: 'medium',
            url: 'https://slack.com',
            rawTime: ts,
            slackTs: msg.ts,
            isDm: false,
            isThread: false,
          });
        }
      } catch {}
    }
  }

  // ── Unread DMs ──────────────────────────────────────────────────────────────
  if (myUid) {
    try {
      const imList = await slack.conversations.list({ types: 'im', limit: 20 });
      for (const im of (imList.channels || [])
        .filter((c) => c.unread_count > 0)
        .slice(0, 10)) {
        try {
          const history = await slack.conversations.history({
            channel: im.id,
            limit: 5,
          });
          const latestMsg = (history.messages || []).find(
            (m) => !m.subtype && m.user !== myUid
          );
          if (!latestMsg) continue;

          const senderName = await resolveUserName(
            slack,
            latestMsg.user || im.user
          );
          const cleanText = await resolveTextMentions(slack, latestMsg.text);
          const ts = parseFloat(latestMsg.ts) * 1000;

          // Skip if already captured as a mention
          if (items.find((i) => i.slackTs === latestMsg.ts)) continue;

          items.push({
            id: `slack_dm_${latestMsg.ts}`,
            source: 'slack',
            type: 'Direct Message',
            title:
              cleanText.slice(0, 120) + (cleanText.length > 120 ? '…' : ''),
            meta: `DM from ${senderName}`,
            raisedBy: senderName,
            channel: 'DM',
            channelId: im.id,
            time: new Date(ts).toLocaleString(),
            priority: 'high',
            url: 'https://slack.com',
            rawTime: ts,
            slackTs: latestMsg.ts,
            isDm: true,
            isThread: false,
          });
        } catch {}
      }
    } catch (e) {
      console.error('[Slack] DM fetch error:', e.message);
    }

    // ── Self DM (personal notepad) ────────────────────────────────────────────
    try {
      const imList = await slack.conversations.list({ types: 'im', limit: 50 });
      const selfIM = (imList.channels || []).find((c) => c.user === myUid);

      if (selfIM) {
        const history = await slack.conversations.history({
          channel: selfIM.id,
          limit: 20,
        });

        for (const msg of history.messages || []) {
          if (msg.subtype) continue;
          if (items.find((i) => i.slackTs === msg.ts)) continue;

          const cleanText = await resolveTextMentions(slack, msg.text);
          const ts = parseFloat(msg.ts) * 1000;
          if (Date.now() - ts > 7 * 24 * 3600 * 1000) continue;

          items.push({
            id: `slack_selfnote_${msg.ts}`,
            source: 'slack',
            type: 'Self Note',
            title:
              cleanText.slice(0, 120) + (cleanText.length > 120 ? '…' : ''),
            meta: 'Your Slack notepad',
            raisedBy: 'You',
            channel: 'Self DM',
            channelId: selfIM.id,
            time: new Date(ts).toLocaleString(),
            priority: msg.text?.includes(`<@${myUid}>`) ? 'high' : 'low',
            url: 'https://slack.com',
            rawTime: ts,
            slackTs: msg.ts,
            isDm: true,
            isThread: false,
          });
        }
      }
    } catch (e) {
      console.error('[Slack] Self-DM error:', e.message);
    }
  }

  // Deduplicate by id
  const seen = new Set();
  return items.filter((i) => {
    if (seen.has(i.id)) return false;
    seen.add(i.id);
    return true;
  });
}

/**
 * Fetch replies for a specific Slack thread.
 */
async function fetchThreadReplies(token, myUid, channel, threadTs) {
  const slack = new WebClient(token);
  const result = await slack.conversations.replies({
    channel,
    ts: threadTs,
    limit: 20,
  });

  const replies = [];
  for (const msg of result.messages || []) {
    if (msg.subtype) continue;
    const name = await resolveUserName(slack, msg.user);
    const text = await resolveTextMentions(slack, msg.text);
    replies.push({
      ts: msg.ts,
      user: msg.user,
      name,
      text,
      isMe: msg.user === myUid,
      time: new Date(parseFloat(msg.ts) * 1000).toLocaleString(),
      reactions: (msg.reactions || []).map((r) => ({
        emoji: r.name,
        count: r.count,
      })),
    });
  }
  return replies;
}

/**
 * Post a reply to a Slack thread (or channel if no threadTs).
 */
async function postReply(token, channel, text, threadTs) {
  const slack = new WebClient(token);
  await slack.chat.postMessage({
    channel,
    text,
    ...(threadTs ? { thread_ts: threadTs } : {}),
  });
}

/**
 * Add an emoji reaction to a Slack message.
 */
async function addReaction(token, channel, timestamp, emoji) {
  const slack = new WebClient(token);
  await slack.reactions.add({ channel, timestamp, name: emoji });
}

/**
 * Fetch per-channel message activity (for the heatmap panel).
 */
async function fetchChannelActivity(token, myUid) {
  const slack = new WebClient(token);
  const channelList = await slack.conversations.list({
    types: 'public_channel,private_channel',
    limit: 30,
  });
  const channels = (channelList.channels || [])
    .filter((c) => c.is_member)
    .slice(0, 8);

  const result = [];
  for (const ch of channels) {
    try {
      const history = await slack.conversations.history({
        channel: ch.id,
        limit: 50,
      });
      const msgs = (history.messages || []).filter((m) => !m.subtype);
      const myMentions = msgs.filter((m) => m.text?.includes(myUid)).length;
      result.push({
        id: ch.id,
        name: ch.name,
        total: msgs.length,
        myMentions,
        latest: msgs[0]
          ? new Date(parseFloat(msgs[0].ts) * 1000).toLocaleString()
          : null,
      });
    } catch {}
  }

  return result.sort((a, b) => b.myMentions - a.myMentions);
}

async function fetchChannels(token) {
  const slack = new WebClient(token);

  const result = await slack.conversations.list({
    types: 'public_channel,private_channel',
    limit: 100,
    exclude_archived: true
  });

  return (result.channels || [])
    .map(c => ({
      id: c.id,
      name: c.name,
      isPrivate: c.is_private,
      isMember: c.is_member
    }));
}

export default { fetchMentions, fetchThreadReplies, postReply, addReaction, fetchChannelActivity, fetchChannels, resolveTextMentions, resolveUserName };
