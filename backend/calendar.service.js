/**
 * calendar.service.js
 * Google Calendar Service
 */

import { google } from "googleapis";
import { Config } from "./models.js";

const TIMEZONE = process.env.TIMEZONE || "Asia/Kolkata";

/* -------------------------------------------------------------------------- */
/*                               OAuth Client                                 */
/* -------------------------------------------------------------------------- */

export function buildOAuthClient(config) {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${process.env.BASE_URL}/auth/google/callback`
  );

  if (!config?.googleTokens) {
    return client;
  }

  client.setCredentials(config.googleTokens);

  // Automatically save refreshed tokens
  client.on("tokens", async (tokens) => {
    try {
      config.googleTokens = {
        ...config.googleTokens,
        ...tokens,
      };

      await config.save();
    } catch (err) {
      console.error("Failed to save refreshed Google tokens:", err);
    }
  });

  return client;
}

/* -------------------------------------------------------------------------- */
/*                           Calendar Helper                                  */
/* -------------------------------------------------------------------------- */

async function getCalendarClient() {
  const config = await Config.findOne({ userId: "default" });

  if (!config?.googleTokens) {
    throw new Error("Google Calendar not connected");
  }

  const auth = buildOAuthClient(config);

  return {
    calendar: google.calendar({
      version: "v3",
      auth,
    }),
    config,
  };
}

/* -------------------------------------------------------------------------- */
/*                           Fetch Calendar Events                            */
/* -------------------------------------------------------------------------- */

export async function getCalendarEvents({
  days = 30,
  maxResults = 100,
} = {}) {
  try {
    const { calendar } = await getCalendarClient();

    const now = new Date();

    const end = new Date();
    end.setDate(end.getDate() + days);

    const { data } = await calendar.events.list({
      calendarId: "primary",
      timeMin: now.toISOString(),
      timeMax: end.toISOString(),
      maxResults,
      singleEvents: true,
      orderBy: "startTime",
    });

    return {
      success: true,
      events: data.items || [],
    };
  } catch (err) {
    console.error("Google Calendar Fetch Error:", err);

    return {
      success: false,
      events: [],
      error: err.message,
    };
  }
}

/* -------------------------------------------------------------------------- */
/*                           Create Calendar Event                            */
/* -------------------------------------------------------------------------- */

export async function createCalendarEvent(data) {
  const {
    title,
    date,
    startTime,
    endTime,
    description = "",
    location = "",
    attendees = "",
    meetLink = false,
    reminders = true,
    recurrence,
    allDay = false,
  } = data;

  if (!title) {
    throw new Error("Event title is required.");
  }

  if (!date) {
    throw new Error("Event date is required.");
  }

  const { calendar } = await getCalendarClient();

  let start;
  let end;

  if (allDay) {
    const nextDay = new Date(date);
    nextDay.setDate(nextDay.getDate() + 1);

    start = {
      date,
    };

    end = {
      date: nextDay.toISOString().split("T")[0],
    };
  } else {
    if (!startTime) {
      throw new Error("Start time is required.");
    }

    const startDate = new Date(`${date}T${startTime}`);

    const endDate = endTime
      ? new Date(`${date}T${endTime}`)
      : new Date(startDate.getTime() + 60 * 60 * 1000);

    start = {
      dateTime: startDate.toISOString(),
      timeZone: TIMEZONE,
    };

    end = {
      dateTime: endDate.toISOString(),
      timeZone: TIMEZONE,
    };
  }

  const attendeeList = attendees
    .split(",")
    .map((email) => email.trim())
    .filter(Boolean)
    .map((email) => ({ email }));

  const event = {
    summary: title,
    description,
    location,
    start,
    end,
    attendees: attendeeList,

    ...(recurrence && {
      recurrence: [recurrence],
    }),

    ...(reminders && {
      reminders: {
        useDefault: false,
        overrides: [
          {
            method: "popup",
            minutes: 10,
          },
          {
            method: "email",
            minutes: 30,
          },
        ],
      },
    }),

    ...(meetLink && {
      conferenceData: {
        createRequest: {
          requestId: `meet-${Date.now()}`,
          conferenceSolutionKey: {
            type: "hangoutsMeet",
          },
        },
      },
    }),
  };

  try {
    const { data: createdEvent } = await calendar.events.insert({
      calendarId: "primary",
      requestBody: event,
      conferenceDataVersion: meetLink ? 1 : 0,
      sendUpdates: attendeeList.length ? "all" : "none",
    });

    return {
      success: true,
      event: createdEvent,
    };
  } catch (err) {
    console.error("Google Calendar Create Event Error:", err);

    throw new Error(
      err?.response?.data?.error?.message ||
        err.message ||
        "Failed to create calendar event."
    );
  }
}

/* -------------------------------------------------------------------------- */
/*                           Delete Calendar Event                            */
/* -------------------------------------------------------------------------- */

export async function deleteCalendarEvent(eventId) {
  if (!eventId) {
    throw new Error("Event ID is required.");
  }

  const { calendar } = await getCalendarClient();

  await calendar.events.delete({
    calendarId: "primary",
    eventId,
    sendUpdates: "all",
  });

  return {
    success: true,
  };
}

/* -------------------------------------------------------------------------- */
/*                           Update Calendar Event                            */
/* -------------------------------------------------------------------------- */

export async function updateCalendarEvent(eventId, updates) {
  if (!eventId) {
    throw new Error("Event ID is required.");
  }

  const { calendar } = await getCalendarClient();

  const { data: existing } = await calendar.events.get({
    calendarId: "primary",
    eventId,
  });

  const updated = {
    ...existing,
    ...updates,
  };

  const { data } = await calendar.events.update({
    calendarId: "primary",
    eventId,
    requestBody: updated,
    sendUpdates: "all",
  });

  return {
    success: true,
    event: data,
  };
}
