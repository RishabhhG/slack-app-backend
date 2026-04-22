import mongoose from 'mongoose';

// ─── Config (per-user settings & OAuth tokens) ────────────────────────────────
const configSchema = new mongoose.Schema(
  {
    userId: { type: String, default: 'default', unique: true, index: true },
    yourName: { type: String, default: 'You' },
    slackToken: { type: String, default: null },
    slackUserId: { type: String, default: null },
    slackTeamId: { type: String, default: null },
    slackTeamName: { type: String, default: null },
    googleTokens: { type: mongoose.Schema.Types.Mixed, default: null },
    ngrokUrl: { type: String, default: null },
    importantChannels: { type: [String], default: [] },
  },
  { timestamps: true }
);

// ─── FeedItem (direct requests added by the PM) ───────────────────────────────
const feedItemSchema = new mongoose.Schema(
  {
    userId: { type: String, default: 'default', index: true },
    source: { type: String, enum: ['slack', 'gmail', 'direct'], required: true },
    type: { type: String, enum: ['TASK', 'QUESTION', 'UNCLEAR', 'Request'], default: 'Request' },
    title: { type: String, required: true },
    meta: { type: String, default: '' },
    raisedBy: { type: String, default: '' },
    priority: { type: String, enum: ['high', 'medium', 'low'], default: 'medium' },
    url: { type: String, default: null },
    rawTime: { type: Number, default: () => Date.now() },
    done: { type: Boolean, default: false },
    doneAt: { type: Date, default: null },

    // Slack-specific
    channelId: { type: String, default: null },
    channelName: { type: String, default: null },
    slackTs: { type: String, default: null },
    isDm: { type: Boolean, default: false },
    isThread: { type: Boolean, default: false },
    threadTs: { type: String, default: null },

    // Pipeline classification
    confidence: { type: String, enum: ['high', 'low', 'forced'], default: 'high' },
    has_deadline: { type: Boolean, default: false },
    has_question_mark: { type: Boolean, default: false },
    mention_count: { type: Number, default: 1 },
    layer: { type: Number, default: null },
    llmLabel: { type: String, enum: ['TASK', 'QUESTION', 'SOCIAL', 'INFO', 'UNCLEAR', null], default: null },

    // Thread timeline
    timeline: [
      {
        by: { type: String },
        at: { type: Date, default: () => new Date() },
        text: { type: String },
      },
    ],
  },
  { timestamps: true }
);

// ─── ActionLog (tracks Done clicks & App Opens for analytics) ─────────────────
const actionLogSchema = new mongoose.Schema(
  {
    userId: { type: String, default: 'default', index: true },
    event: {
      type: String,
      enum: ['app_open', 'item_done'],
      required: true,
    },
    itemId: { type: String, default: null },
    itemSource: { type: String, default: null },
    timestamp: { type: Date, default: () => new Date() },
  },
  { timestamps: false }
);

// Sparse TTL — keep logs for 90 days automatically
actionLogSchema.index({ timestamp: 1 }, { expireAfterSeconds: 90 * 24 * 3600 });

export const Config = mongoose.models.Config || mongoose.model('Config', configSchema);
export const FeedItem = mongoose.models.FeedItem || mongoose.model('FeedItem', feedItemSchema);
export const ActionLog = mongoose.models.ActionLog || mongoose.model('ActionLog', actionLogSchema);

export default { Config, FeedItem, ActionLog };
