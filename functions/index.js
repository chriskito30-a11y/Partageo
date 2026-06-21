import { initializeApp } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";
import { onSchedule } from "firebase-functions/v2/scheduler";

initializeApp();

export const cleanupExpiredPartageoEvents = onSchedule({
  schedule: "every day 03:30",
  timeZone: "Europe/Paris",
  region: "europe-west1"
}, async () => {
  const db = getDatabase();
  const snap = await db.ref("events").get();
  const events = snap.val() || {};
  const now = Date.now();
  const updates = {};
  for (const [eventId, event] of Object.entries(events)) {
    if (!event.eventDate) continue;
    const deleteAfter = new Date(`${event.eventDate}T23:59:59+02:00`).getTime() + 24 * 60 * 60 * 1000;
    if (now > deleteAfter) {
      updates[`events/${eventId}`] = null;
      updates[`registrations/${eventId}`] = null;
      updates[`contributionItems/${eventId}`] = null;
      updates[`contributions/${eventId}`] = null;
    }
  }
  if (Object.keys(updates).length) await db.ref().update(updates);
});
