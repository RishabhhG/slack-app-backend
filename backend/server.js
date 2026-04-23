/**
 * server.js — Reply Queue backend
 *
 * Features implemented end-to-end:
 *   1. Slack @mentions + DM feed  (slack.service.js)
 *   2. Done button — marks item complete + logs action to MongoDB
 *
 * Config & action logs are stored in MongoDB (no JSON files).
 */

import "./env.js";

import express from "express";
import cors from "cors";
import mongoose from "mongoose";

import { Config, FeedItem, ActionLog } from "./models.js";
import slackSvc from "./slack.service.js";
import gmailSvc from "./gmail.service.js";
import pipelineSvc from "./pipeline.service.js";
import {
  getCalendarEvents,
  createCalendarEvent
} from "./calendar.service.js";

const app = express();
app.use(cors({ origin: process.env.FRONTEND_URL || "http://localhost:3000" }));
app.use(express.json());
// ─── DB connection ────────────────────────────────────────────────────────────
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => console.error("❌ MongoDB connection error:", err.message));

// ─── Helper: get (or create) the singleton config doc ─────────────────────────
async function getConfig(userId = "default") {
  let cfg = await Config.findOne({ userId });
  if (!cfg) cfg = await Config.create({ userId });
  return cfg;
}

// ─── Config status ────────────────────────────────────────────────────────────
app.get("/api/config-status", async (req, res) => {
  try {
    const cfg = await getConfig();
    res.json({
      hasSlack: !!cfg.slackToken,
      hasGmail: !!cfg.googleTokens,
      yourName: cfg.yourName || "You",
      slackUserId: cfg.slackUserId || "",
      ngrokUrl: cfg.ngrokUrl || "",
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Setup / save credentials ─────────────────────────────────────────────────
app.post("/api/setup", async (req, res) => {
  try {
    const cfg = await getConfig();
    const { slackToken, slackUserId, yourName, ngrokUrl } = req.body;

    if (slackToken) cfg.slackToken = slackToken;
    if (slackUserId) cfg.slackUserId = slackUserId;
    if (yourName) cfg.yourName = yourName;
    if (ngrokUrl !== undefined) cfg.ngrokUrl = ngrokUrl.replace(/\/$/, "");

    await cfg.save();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Slack OAuth ───────────────────────────────────────────────────────────────
app.get("/auth/slack", async (req, res) => {
  const cfg = await getConfig();
  const baseUrl = (cfg.ngrokUrl || process.env.BASE_URL || "").replace(
    /\/$/,
    "",
  );
  const redirectUri = `${baseUrl}/auth/slack/callback`;
  const scopes =
    "channels:history,channels:read,groups:history,groups:read,im:history,im:read,mpim:history,mpim:read,users:read,search:read,chat:write,reactions:write";
  const clientId = process.env.SLACK_CLIENT_ID;
  const url = `https://slack.com/oauth/v2/authorize?client_id=${clientId}&user_scope=${scopes}&redirect_uri=${encodeURIComponent(redirectUri)}`;
  res.redirect(url);
});

app.get("/auth/slack/callback", async (req, res) => {
  const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
  if (req.query.error)
    return res.redirect(`${frontendUrl}?error=slack_oauth_denied`);

  try {
    const cfg = await getConfig();
    const baseUrl = (cfg.ngrokUrl || process.env.BASE_URL || "").replace(
      /\/$/,
      "",
    );
    const redirectUri = `${baseUrl}/auth/slack/callback`;

    const resp = await fetch(
      `https://slack.com/api/oauth.v2.access?client_id=${process.env.SLACK_CLIENT_ID}&client_secret=${process.env.SLACK_CLIENT_SECRET}&code=${req.query.code}&redirect_uri=${encodeURIComponent(redirectUri)}`,
      { method: "POST" },
    );
    const data = await resp.json();

    if (data.ok) {
      cfg.slackToken = data.authed_user?.access_token || data.access_token;
      cfg.slackUserId = data.authed_user?.id || cfg.slackUserId;
      cfg.slackTeamId = data.team?.id;
      cfg.slackTeamName = data.team?.name;
      await cfg.save();
      console.log("✅ Slack connected, user:", cfg.slackUserId);
      return res.redirect(`${frontendUrl}?connected=slack`);
    } else {
      console.error("[Slack OAuth]", data.error);
      return res.redirect(`${frontendUrl}?error=slack_oauth_failed`);
    }
  } catch (e) {
    console.error("[Slack callback]", e.message);
    return res.redirect(`${frontendUrl}?error=slack_callback_error`);
  }
});

// ─── Google OAuth ─────────────────────────────────────────────────────────────
app.get("/auth/google", (req, res) => {
  res.redirect(gmailSvc.getAuthUrl());
});

app.get("/auth/google/callback", async (req, res) => {
  const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
  try {
    const tokens = await gmailSvc.exchangeCode(req.query.code);
    const cfg = await getConfig();
    cfg.googleTokens = tokens;
    await cfg.save();
    res.redirect(`${frontendUrl}?connected=gmail`);
  } catch (e) {
    console.error("[Google callback]", e.message);
    res.redirect(`${frontendUrl}?error=google_callback_error`);
  }
});

// ─── Main inbox ───────────────────────────────────────────────────────────────
app.get("/api/inbox", async (req, res) => {
  try {
    // Log app open event
    await ActionLog.create({ event: "app_open" });

    const cfg = await getConfig();

    // Fetch from live sources in parallel
    const [gmailItems, slackItems] = await Promise.all([
      gmailSvc.fetchGmail(cfg),
      cfg.slackToken
        ? slackSvc.fetchMentions(cfg.slackToken, cfg.slackUserId || "")
        : Promise.resolve([]),
    ]);

    // Fetch persisted direct requests (not yet done)
    // AFTER — fetches all pipeline-saved items from DB (slack + direct)
    const dbItems = await FeedItem.find({
      source: { $in: ["direct", "slack"] },
      done: false,
    })
      .sort({ rawTime: -1 })
      .lean();

    const normalisedDirect = dbItems.map((d) => ({
      id: d._id.toString(),
      source: d.source,
      type: d.type,
      title: d.title,
      meta: d.meta,
      raisedBy: d.raisedBy,
      time: new Date(d.rawTime).toLocaleString(),
      priority: d.priority,
      url: d.url,
      rawTime: d.rawTime,
      // Slack-specific
      channelId: d.channelId || null,
      channelName: d.channelName || null,
      slackTs: d.slackTs || null,
      isDm: d.isDm || false,
      isThread: d.isThread || false,
      threadTs: d.threadTs || null,
      // Pipeline fields
      confidence: d.confidence || "high",
      has_deadline: d.has_deadline || false,
      has_question_mark: d.has_question_mark || false,
      mention_count: d.mention_count || 1,
      layer: d.layer ?? null,
      llmLabel: d.llmLabel || null,
      timeline: d.timeline || [],
    }));

    const all = [...gmailItems, ...normalisedDirect].sort((a, b) => {
      const p = { high: 0, medium: 1, low: 2 };
      const pd = (p[a.priority] ?? 1) - (p[b.priority] ?? 1);
      return pd !== 0 ? pd : (b.rawTime || 0) - (a.rawTime || 0);
    });
    res.json(all);
  } catch (e) {
    console.error("[inbox]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Mark item done ───────────────────────────────────────────────────────────
/**
 * POST /api/item/:id/done
 * Marks a direct-request item as done and logs the action.
 * For Slack/Gmail items (which are not persisted), we just log the action.
 */
app.post("/api/item/:id/done", async (req, res) => {
  try {
    const { id } = req.params;
    const { source } = req.body; // optional hint

    // If it's a persisted FeedItem (direct request), update it
    if (!id.startsWith("slack_") && !id.startsWith("gmail_")) {
      await FeedItem.findByIdAndUpdate(id, {
        done: true,
        doneAt: new Date(),
      });
    }

    // Always log the Done event for analytics
    await ActionLog.create({
      event: "item_done",
      itemId: id,
      itemSource:
        source ||
        (id.startsWith("slack_")
          ? "slack"
          : id.startsWith("gmail_")
            ? "gmail"
            : "direct"),
    });

    res.json({ ok: true });
  } catch (e) {
    console.error("[done]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Add direct request ───────────────────────────────────────────────────────
app.post("/api/request", async (req, res) => {
  try {
    const { title, raisedBy, type, priority, note } = req.body;
    if (!title || !raisedBy)
      return res.status(400).json({ error: "title and raisedBy are required" });

    await FeedItem.create({
      source: "direct",
      type: type || "Request",
      title,
      meta: `${raisedBy}${note ? " · " + note : ""}`,
      raisedBy,
      priority: priority || "medium",
      rawTime: Date.now(),
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Slack thread replies ─────────────────────────────────────────────────────
app.get("/api/slack/thread", async (req, res) => {
  try {
    const cfg = await getConfig();
    if (!cfg.slackToken) return res.json({ replies: [] });
    const { channel, thread_ts } = req.query;
    if (!channel || !thread_ts) return res.json({ replies: [] });

    const replies = await slackSvc.fetchThreadReplies(
      cfg.slackToken,
      cfg.slackUserId || "",
      channel,
      thread_ts,
    );
    res.json({ replies });
  } catch (e) {
    console.error("[thread]", e.message);
    res.json({ replies: [] });
  }
});

// ─── Slack quick reply ────────────────────────────────────────────────────────
app.post("/api/slack/reply", async (req, res) => {
  try {
    const cfg = await getConfig();
    if (!cfg.slackToken) return res.json({ ok: false, error: "no token" });
    const { channel, thread_ts, text } = req.body;
    if (!channel || !text)
      return res.status(400).json({ ok: false, error: "missing params" });

    await slackSvc.postReply(cfg.slackToken, channel, text, thread_ts);
    res.json({ ok: true });
  } catch (e) {
    console.error("[reply]", e.message);
    res.json({ ok: false, error: e.message });
  }
});

// ─── Slack add reaction ───────────────────────────────────────────────────────
app.post("/api/slack/react", async (req, res) => {
  try {
    const cfg = await getConfig();
    if (!cfg.slackToken) return res.json({ ok: false });
    const { channel, timestamp, emoji } = req.body;
    await slackSvc.addReaction(cfg.slackToken, channel, timestamp, emoji);
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ─── Slack channel activity (heatmap) ────────────────────────────────────────
app.get("/api/slack/activity", async (req, res) => {
  try {
    const cfg = await getConfig();
    if (!cfg.slackToken) return res.json({ channels: [] });
    const channels = await slackSvc.fetchChannelActivity(
      cfg.slackToken,
      cfg.slackUserId || "",
    );
    res.json({ channels });
  } catch (e) {
    res.json({ channels: [] });
  }
});

// ─── Analytics: action log summary ───────────────────────────────────────────
app.get("/api/analytics", async (req, res) => {
  try {
    const opens = await ActionLog.countDocuments({ event: "app_open" });
    const dones = await ActionLog.countDocuments({ event: "item_done" });
    const recentOpens = await ActionLog.find({ event: "app_open" })
      .sort({ timestamp: -1 })
      .limit(14)
      .lean();

    res.json({ totalOpens: opens, totalDones: dones, recentOpens });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Fetch Slack Channels ─────────────────────────────────────
app.get("/api/slack/channels/all", async (req, res) => {
  try {
    const cfg = await getConfig();

    if (!cfg.slackToken) return res.json({ channels: [] });

    const channels = await slackSvc.fetchChannels(cfg.slackToken);

    res.json({ channels });
  } catch (e) {
    console.error("[channels/all]", e.message);
    res.json({ channels: [] });
  }
});

// ─── Fetch Important Channels ─────────────────────────────────────

app.get("/api/slack/channels/important", async (req, res) => {
  try {
    const cfg = await getConfig();

    const important = cfg.importantChannels || [];

    res.json({ important });
  } catch (e) {
    console.error("[channels/important]", e.message);
    res.json({ important: [] });
  }
});

// ─── Mark Channel Important ─────────────────────────────────────
app.post("/api/slack/channel/important", async (req, res) => {
  try {
    const { channelId } = req.body;

    const cfg = await getConfig();

    if (!cfg.importantChannels.includes(channelId)) {
      cfg.importantChannels.push(channelId);
      await cfg.save();
    }

    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ─── Remove Important Channel ─────────────────────────────────
app.post("/api/slack/channel/unimportant", async (req, res) => {
  try {
    const { channelId } = req.body;

    const cfg = await getConfig();

    cfg.importantChannels = cfg.importantChannels.filter(
      (id) => id !== channelId,
    );

    await cfg.save();

    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false });
  }
});

// ─── Slack Webhook (Event Subscriptions) ──────────────────────────────────────
//
// In your Slack App settings → Event Subscriptions → Request URL:
//   https://<your-ngrok>.ngrok.io/api/slack/webhook
//
// Subscribe to bot events:
//   app_mention, message.channels, message.groups, message.im, message.mpim

app.post("/api/slack/webhook", async (req, res) => {
  const body = req.body;

  // ── Slack URL Verification Challenge ────────────────────────────────────────
  if (body.type === "url_verification") {
    return res.json({ challenge: body.challenge });
  }

  // Acknowledge immediately (Slack requires <3s response)
  res.json({ ok: true });

  // ── Process event asynchronously ────────────────────────────────────────────
  try {
    const event = body.event;
    if (!event) return;

    // Ignore bot messages and message_changed/message_deleted subtypes
    if (event.bot_id) return;

    const cfg = await getConfig();
    if (!cfg.slackToken) return;

    // if (event.user === cfg.slackUserId) return; // ignore your own messages
    if (event.subtype && event.subtype !== "thread_broadcast") return;
    if (!event.text) return;

    // Fetch priority channel IDs from DB
    const priorityChannelIds = cfg.importantChannels || [];

    // Optionally fetch last 3 thread messages for Layer 2 context
    let threadSnippet = [];
    if (event.thread_ts && cfg.slackToken) {
  try {
    const replies = await slackSvc.fetchThreadReplies(
      cfg.slackToken,
      cfg.slackUserId || '',
      event.channel,
      event.thread_ts,
    );
    threadSnippet = replies
      .filter(r => !r.isMe)
      .slice(-3)
      .map(r => r.text || '');
  } catch (e) {
    console.warn('[webhook] thread fetch failed:', e.message);
  }
}

    const pipelineResult = await pipelineSvc.processPipelineMessage(
      event,
      cfg,
      priorityChannelIds,
      threadSnippet,
    );

    console.log(
      `[pipeline] layer=${pipelineResult.layer} action=${pipelineResult.action}`,
      pipelineResult.llmLabel ? `llm=${pipelineResult.llmLabel}` : "",
      `reason=${pipelineResult.reason || "-"}`,
    );
  } catch (err) {
    console.error("[webhook] processing error:", err.message);
  }
});

// ─── Calendar Events ───────────────────────────────────────────

app.get("/api/calendar/events", async (req, res) => {
  try {
    const result = await getCalendarEvents();
    res.json(result);
  } catch (e) {
    console.error("[calendar/events]", e.message);
    res.status(500).json({ events: [], error: e.message });
  }
});

app.post("/api/calendar/events", async (req, res) => {
  try {
    const event = await createCalendarEvent(req.body);
    res.json({ ok: true, event });
  } catch (e) {
    console.error("[calendar/create]", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n✅  Reply Queue API running on http://localhost:${PORT}`);
  console.log(
    `   Frontend: ${process.env.FRONTEND_URL || "http://localhost:3000"}`,
  );
  console.log(
    `   Slack callback: ${process.env.BASE_URL}/auth/slack/callback\n`,
  );
});
