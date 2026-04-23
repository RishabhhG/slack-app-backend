/**
 * calendar.service.js
 * Google Calendar service functions
 */

import { google } from "googleapis";
import { Config } from "./models.js";

// ─── Build OAuth client ─────────────────────────────────────────
export function buildOAuthClient(config) {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${process.env.BASE_URL}/auth/google/callback`
  );

  if (config.googleTokens) {
    client.setCredentials(config.googleTokens);

    client.on("tokens", async (tokens) => {
      if (tokens.refresh_token) {
        config.googleTokens = { ...config.googleTokens, ...tokens };
        await config.save();
      }
    });
  }

  return client;
}

// ─── Get events ─────────────────────────────────────────────────
export async function getCalendarEvents() {
  const cfg = await Config.findOne({ userId: "default" });

  if (!cfg?.googleTokens) {
    return { events: [], error: "not_connected" };
  }

  const auth = buildOAuthClient(cfg);
  const calendar = google.calendar({ version: "v3", auth });

  const now = new Date();
  const thirtyDaysOut = new Date();
  thirtyDaysOut.setDate(thirtyDaysOut.getDate() + 30);

  const response = await calendar.events.list({
    calendarId: "primary",
    timeMin: now.toISOString(),
    timeMax: thirtyDaysOut.toISOString(),
    maxResults: 100,
    singleEvents: true,
    orderBy: "startTime",
  });

  return { events: response.data.items || [] };
}

// ─── Create event ───────────────────────────────────────────────
export async function createCalendarEvent(data) {
  const cfg = await Config.findOne({ userId: "default" });

  if (!cfg?.googleTokens) {
    throw new Error("Google Calendar not connected");
  }

  const {
    title,
    date,
    startTime,
    endTime,
    description,
    location,
    attendees,
    meetLink,
  } = data;

  const auth = buildOAuthClient(cfg);
  const calendar = google.calendar({ version: "v3", auth });

  const startDateTime = new Date(`${date}T${startTime}`).toISOString();

  const endDateTime = endTime
    ? new Date(`${date}T${endTime}`).toISOString()
    : new Date(
        new Date(`${date}T${startTime}`).getTime() + 60 * 60 * 1000
      ).toISOString();

  const attendeeList = attendees
    ? attendees
        .split(",")
        .map((e) => ({ email: e.trim() }))
        .filter((a) => a.email)
    : [];

  const eventBody = {
    summary: title,
    description: description || "",
    location: location || "",
    start: { dateTime: startDateTime, timeZone: "Asia/Kolkata" },
    end: { dateTime: endDateTime, timeZone: "Asia/Kolkata" },
    attendees: attendeeList,
    ...(meetLink && {
      conferenceData: {
        createRequest: {
          requestId: `rq-${Date.now()}`,
          conferenceSolutionKey: { type: "hangoutsMeet" },
        },
      },
    }),
  };

  const created = await calendar.events.insert({
    calendarId: "primary",
    requestBody: eventBody,
    conferenceDataVersion: meetLink ? 1 : 0,
    sendUpdates: attendeeList.length > 0 ? "all" : "none",
  });

  return created.data;
}