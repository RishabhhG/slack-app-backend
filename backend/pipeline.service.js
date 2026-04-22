/**
 * pipeline.service.js — 3-layer message classification pipeline
 *
 * Layer 0 — Priority Channel Rules (fast-pass, bypass all)
 * Layer 1 — Rule-based Filter (regex + keywords, ~70% of messages)
 * Layer 2 — LLM Classification via Gemini API (~30% grey-zone messages)
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import { FeedItem } from "./models.js";
import { WebClient } from '@slack/web-api';
import slackSvc from './slack.service.js';

// ─── Gemini Setup ─────────────────────────────────────────────────────────────

console.log("GEMINI_API_KEY present:", !!process.env.GEMINI_API_KEY);
console.log("Key length:", process.env.GEMINI_API_KEY?.length);

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const geminiModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

// ─── Constants ────────────────────────────────────────────────────────────────
const GREETING_PATTERNS = [
  /\bhappy birthday\b/i,
  /\bcongrats\b/i,
  /\bcongratulations\b/i,
  /\bwelcome\b/i,
  /\bhaha\b/i,
  /\blol\b/i,
  /\bthanks\b/i,
  /\bthank you\b/i,
  /\bty\b/i,
];

const DEADLINE_KEYWORDS = [
  /\bby eod\b/i,
  /\btomorrow\b/i,
  /\bfriday\b/i,
  /\basap\b/i,
  /\burgent\b/i,
  /\btoday\b/i,
];

const ACTION_VERBS = [
  /\bcan you\b/i,
  /\bplease\b/i,
  /\bcould you\b/i,
  /\bshare\b/i,
  /\breview\b/i,
  /\bcheck\b/i,
  /\bcreate\b/i,
  /\bsend\b/i,
  /\bconfirm\b/i,
  /\bhelp\b/i,
  /\bdeclare\b/i,
  /\bfix\b/i,
];

// ─── Helpers ──────────────────────────────────────────────────────────────────
function wordCount(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function matchesAny(text, patterns) {
  return patterns.some((p) => p.test(text));
}

function isPureEmoji(text) {
  // Remove all emoji characters and whitespace; if nothing remains, it's pure emoji
  const stripped = text.replace(
    /[\u{1F300}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\s]/gu,
    "",
  );
  return stripped.length === 0 && text.trim().length > 0;
}

// ─── Layer 0 — Priority Channel Rules ────────────────────────────────────────
/**
 * @param {object} message - Slack event payload
 * @param {string[]} priorityChannelIds - Channel IDs marked as priority
 * @param {string} botUserId - The user's Slack @USER_ID to watch for
 * @returns {{ pass: boolean, card?: object }}
 */
function layer0(message, priorityChannelIds, botUserId) {
  const inPriorityChannel = priorityChannelIds.includes(message.channel);
  const mentionsUser = message.text && message.text.includes(`<@${botUserId}>`);

  if (inPriorityChannel && mentionsUser) {
    return {
      pass: true,
      card: {
        confidence: "forced",
        type: "TASK",
        priority: true,
        layer: 0,
      },
    };
  }

  return { pass: false };
}

// ─── Layer 1 — Rule-based Filter ─────────────────────────────────────────────
/**
 * @returns {{ result: 'exclude'|'include'|'layer2', reason?: string }}
 */
function layer1(message) {
  const text = message.text || "";
  const wc = wordCount(text);

  // --- Auto-Exclude ---
  if (matchesAny(text, GREETING_PATTERNS)) {
    return { result: "exclude", reason: "greeting_pattern" };
  }

  if (isPureEmoji(text)) {
    return { result: "exclude", reason: "pure_emoji" };
  }

  if (message.type === "reaction_added") {
    return { result: "exclude", reason: "reaction_event" };
  }

  if (message.bot_id || message.subtype === "bot_message") {
    return { result: "exclude", reason: "bot_sender" };
  }

  const isBroadcastMention = /@channel|@here|@everyone/.test(text);
  if (isBroadcastMention) {
    return { result: "exclude", reason: "broadcast_mention" };
  }

  if (wc < 3 && !text.includes("?") && !matchesAny(text, ACTION_VERBS)) {
    return { result: "exclude", reason: "too_short_no_action" };
  }

  // --- Auto-Include (fast-pass) ---
  const hasDirectMention =
    message.slackUserId && text.includes(`<@${message.slackUserId}>`);
  const hasQuestionMark = text.includes("?");

  if (hasQuestionMark && hasDirectMention) {
    return { result: "include", reason: "question_with_direct_mention" };
  }

  if (matchesAny(text, DEADLINE_KEYWORDS)) {
    return { result: "include", reason: "deadline_language" };
  }

  if (matchesAny(text, ACTION_VERBS) && wc >= 6) {
    return { result: "include", reason: "action_verb_sufficient_length" };
  }

  // --- Grey zone → Layer 2 ---
  return { result: "layer2", reason: "ambiguous" };
}

// ─── Layer 2 — Gemini LLM Classification ─────────────────────────────────────

// Pre-LLM optimization: skip API call for obvious cases
function preLayer2Check(text) {
  const wc = wordCount(text);

  if (wc < 4 && !text.includes("?")) {
    return { skip: true, label: "SOCIAL", reason: "pre_llm_too_short" };
  }

  if (matchesAny(text, DEADLINE_KEYWORDS)) {
    return { skip: true, label: "TASK", reason: "pre_llm_deadline" };
  }

  return { skip: false };
}

/**
 * @param {object} message
 * @param {string} context - 'DM' | 'Group' | 'Channel'
 * @param {string[]} threadSnippet - Last 3 messages in thread
 * @returns {Promise<{ label: string, confidence: string }>}
 */
async function layer2(message, context = "Channel", threadSnippet = []) {
  const text = message.text || "";

  // Pre-LLM optimization
  const pre = preLayer2Check(text);
  if (pre.skip) {
    return {
      label: pre.label,
      confidence: pre.label === "TASK" ? "high" : "low",
      reason: pre.reason,
      usedLLM: false,
    };
  }

  const senderName = message.senderName || message.user || "Unknown";
  const threadContext =
    threadSnippet.length > 0
      ? threadSnippet.map((t) => `"${t}"`).join("\n  ")
      : "No prior thread";

  const prompt = `You are a classifier for Slack messages. Classify the message into exactly one label.

Labels:
- TASK     → Someone is asking the recipient to do something specific
- QUESTION → Someone is asking a question expecting an answer
- SOCIAL   → Casual chat, greetings, reactions, banter
- INFO     → Sharing information, no action or reply needed
- UNCLEAR  → Cannot determine intent

Message: "${text}"
Sender: "${senderName}"
Context: "${context}"
Thread (last 3 msgs):
  ${threadContext}

Reply with ONLY the label word, nothing else.`;

  try {
    const result = await geminiModel.generateContent(prompt);
    const raw = result.response.text().trim().toUpperCase();
    const validLabels = ["TASK", "QUESTION", "SOCIAL", "INFO", "UNCLEAR"];
    const label = validLabels.includes(raw) ? raw : "UNCLEAR";

    return {
      label,
      confidence: label === "UNCLEAR" ? "low" : "high",
      usedLLM: true,
    };
  } catch (err) {
    console.error("[Layer2 Gemini error]", err.message);
    return {
      label: "UNCLEAR",
      confidence: "low",
      usedLLM: false,
      error: err.message,
    };
  }
}

// ─── Main Pipeline Entrypoint ─────────────────────────────────────────────────
/**
 * Process a single incoming Slack message through the full pipeline.
 *
 * @param {object} message         - Slack event payload
 * @param {object} config          - DB config doc (cfg)
 * @param {string[]} priorityChannelIds
 * @param {string[]} threadSnippet - Last 3 messages in thread (for Layer 2)
 * @returns {Promise<object>}      - Pipeline result
 */
async function processPipelineMessage(
  message,
  config,
  priorityChannelIds = [],
  threadSnippet = [],
) {
  const slackUserId = config.slackUserId || "";
  const result = {
    processed: false,
    layer: null,
    action: null, // 'exclude' | 'include' | 'forced'
    card: null,
    reason: null,
    llmLabel: null,
  };

  // ── Layer 0 ──────────────────────────────────────────────────────────────
  const l0 = layer0(message, priorityChannelIds, slackUserId);
  if (l0.pass) {
    result.layer = 0;
    result.action = "forced";
    result.card = await buildCard(
      message,
      {
        confidence: "forced",
        type: "TASK",
        priority: true,
        layer: 0,
      },
      config,
    );
    result.processed = true;
    await upsertCard(result.card);
    return result;
  }

  // ── Layer 1 ──────────────────────────────────────────────────────────────
  // Inject slackUserId so Layer 1 can check direct mention
  const msgWithCtx = { ...message, slackUserId };
  const l1 = layer1(msgWithCtx);
  result.layer = 1;
  result.reason = l1.reason;

  if (l1.result === "exclude") {
    result.action = "exclude";
    result.processed = true;
    return result;
  }

  if (l1.result === "include") {
    result.action = "include";
    result.card = await buildCard(
      message,
      {
        confidence: "high",
        type: "TASK",
        priority: false,
        layer: 1,
      },
      config,
    );
    result.processed = true;
    await upsertCard(result.card);
    return result;
  }

  // ── Layer 2 ──────────────────────────────────────────────────────────────
  result.layer = 2;
  const isDM = message.channel_type === "im";
  const isGroup =
    message.channel_type === "mpim" || message.channel_type === "group";
  const context = isDM ? "DM" : isGroup ? "Group" : "Channel";

  const l2 = await layer2(message, context, threadSnippet);
  result.llmLabel = l2.label;
  result.reason = l2.reason || null;

  const labelActionMap = {
    TASK: "include",
    QUESTION: "include",
    SOCIAL: "exclude",
    INFO: "exclude",
    UNCLEAR: "include", // low confidence, greyed out
  };

  result.action = labelActionMap[l2.label] || "exclude";

  if (result.action === "include") {
    const cardMeta = {
      confidence: l2.confidence,
      type:
        l2.label === "QUESTION"
          ? "QUESTION"
          : l2.label === "UNCLEAR"
            ? "UNCLEAR"
            : "TASK",
      priority: false,
    };
    result.card = await buildCard(
      message,
      {
        confidence: l2.confidence,
        type: cardMeta.type,
        priority: false,
        layer: 2,
        llmLabel: l2.label,
      },
      config,
    );
    result.processed = true;
    await upsertCard(result.card);
  } else {
    result.processed = true;
  }

  return result;
}

// ─── Build Card from message ──────────────────────────────────────────────────
async function buildCard(message, meta, config) {
  const rawText = message.text || '';
  let resolvedText = rawText;
  let senderName = message.senderName || message.user || 'unknown';

  if (config.slackToken) {
    const slack = new WebClient(config.slackToken); // ← one instance, user token
    resolvedText = await slackSvc.resolveTextMentions(slack, rawText);
    if (message.user) {
      senderName = await slackSvc.resolveUserName(slack, message.user);
    }
  }

  const preview = resolvedText.length > 120
    ? resolvedText.slice(0, 117) + '...'
    : resolvedText;

  const hasDeadline = matchesAny(resolvedText, DEADLINE_KEYWORDS);
  const hasQuestionMark = resolvedText.includes('?');

  return {
    source: 'slack',
    type: meta.type || 'TASK',
    channel: message.channel,
    raisedBy: message.user || 'unknown',
    senderName,
    preview,
    priority: meta.priority || false,
    confidence: meta.confidence || 'high',
    has_deadline: hasDeadline,
    has_question_mark: hasQuestionMark,
    thread_ts: message.thread_ts || message.ts,
    slackTs: message.ts,
    channelId: message.channel,
    isDm: message.channel_type === 'im',
    isThread: !!message.thread_ts,
    rawTime: message.ts ? Math.floor(parseFloat(message.ts) * 1000) : Date.now(),
    layer: meta.layer || null,
    llmLabel: meta.llmLabel || null,
  };
}

// ─── Upsert card (dedup by thread_ts) ────────────────────────────────────────
async function upsertCard(card) {
  const dedupKey = card.thread_ts;

  const existing = await FeedItem.findOne({
    source: "slack",
    threadTs: dedupKey,
    done: false,
  });

  if (existing) {
    // Append to timeline
    existing.timeline.push({
      by: card.raisedBy,
      at: new Date(),
      text: card.preview,
    });

    existing.mention_count += 1;
    existing.rawTime = Date.now(); // bump to top

    // Priority can only go up, never down
    if (card.priority) existing.priority = "high";

    await existing.save();
    return { created: false, id: existing._id };
  }

  // Create new card
  const doc = await FeedItem.create({
    source: "slack",
    type: card.type,
    title: card.preview,
    meta: `From ${card.senderName || card.raisedBy}`,
    raisedBy: card.raisedBy,
    priority: card.priority ? "high" : "medium",
    rawTime: card.rawTime,
    channelId: card.channelId,
    slackTs: card.slackTs,
    isDm: card.isDm,
    isThread: card.isThread,
    threadTs: card.thread_ts,

    // New fields
    confidence: card.confidence,
    has_deadline: card.has_deadline,
    has_question_mark: card.has_question_mark,
    layer: card.layer,
    llmLabel: card.llmLabel || null,
    mention_count: 1,
    timeline: [
      {
        by: card.raisedBy,
        at: new Date(),
        text: card.preview,
      },
    ],
  });

  return { created: true, id: doc._id };
}

export default { processPipelineMessage, layer0, layer1, layer2, preLayer2Check };
