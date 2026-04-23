/**
 * gmail.service.js
 * Encapsulates all Gmail API calls.
 */
import { google } from 'googleapis';

/**
 * Build an authenticated OAuth2 client from stored tokens.
 */
function buildOAuthClient(config) {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${process.env.BASE_URL}/auth/google/callback`
  );
  if (config.googleTokens) {
    client.setCredentials(config.googleTokens);
  }
  return client;
}

/**
 * Fetch unread Gmail threads that likely need a reply.
 *
 * @param {object} config  Config doc from MongoDB
 * @returns {Promise<Array>} Normalised feed items
 */
async function fetchGmail(config) {
  if (!config.googleTokens) return [];

  try {
    const auth = buildOAuthClient(config);
    const gmail = google.gmail({ version: 'v1', auth });

    const list = await gmail.users.messages.list({
      userId: 'me',
      q: 'is:unread in:inbox',
      maxResults: 20,
    });

    if (!list.data.messages) return [];

    const items = [];
    for (const msg of list.data.messages.slice(0, 15)) {
      const full = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'metadata',
        metadataHeaders: ['Subject', 'From', 'Date'],
      });

      const headers = full.data.payload.headers;
      const subject =
        headers.find((h) => h.name === 'Subject')?.value || '(no subject)';
      const from = headers.find((h) => h.name === 'From')?.value || '';
      const date = headers.find((h) => h.name === 'Date')?.value || '';
      const fromName =
        from.replace(/<.*>/, '').trim() || from.split('@')[0] || from;
      const snippet = full.data.snippet || '';
      const replyExpected =
        /reply|response|feedback|thoughts|please|can you|could you|let me know/i.test(
          snippet + subject
        );

      items.push({
        id: `gmail_${msg.id}`,
        source: 'gmail',
        type: replyExpected ? 'Reply expected' : 'FYI',
        title: subject,
        meta: `${fromName} · ${snippet.slice(0, 80)}…`,
        raisedBy: fromName,
        time: new Date(date).toLocaleString(),
        priority: replyExpected ? 'high' : 'low',
        url: `https://mail.google.com/mail/u/0/#inbox/${msg.id}`,
        rawTime: new Date(date).getTime() || Date.now(),
      });
    }
    return items;
  } catch (e) {
    console.error('[Gmail] fetch error:', e.message);
    return [];
  }
}

/**
 * Generate the Google OAuth consent URL.
 */
function getAuthUrl() {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${process.env.BASE_URL}/auth/google/callback`
  );
  return client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/calendar',   
      'https://www.googleapis.com/auth/calendar.events',
    ],
    prompt: 'consent',
  });
}

/**
 * Exchange an auth code for tokens.
 */
async function exchangeCode(code) {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${process.env.BASE_URL}/auth/google/callback`
  );
  const { tokens } = await client.getToken(code);
  return tokens;
}

export default { fetchGmail, getAuthUrl, exchangeCode };
