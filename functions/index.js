import { initializeApp } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";
import { getStorage } from "firebase-admin/storage";
import { onSchedule } from "firebase-functions/v2/scheduler";

export { createPhotoboothSession, reservePhotoboothSlot, finalizePhotoboothUpload } from "./photobooth.js";

initializeApp();

const STORAGE_BUCKET = "impro-ead69.firebasestorage.app";

function parisQuotaPeriods(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit"
  }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return { month: `${parts.year}-${parts.month}`, year: parts.year };
}

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

export const cleanupExpiredPhotoboothSessions = onSchedule({
  schedule: "every day 00:05",
  timeZone: "Europe/Paris",
  region: "europe-west1"
}, async () => {
  const db = getDatabase();
  const now = Date.now();
  const expiredSnap = await db.ref("moduleData/photoboothlive/sessions")
    .orderByChild("expiresAt")
    .endAt(now)
    .limitToFirst(200)
    .get();
  const updates = {};
  const bucket = getStorage().bucket(STORAGE_BUCKET);
  const expiredSessions = [];
  expiredSnap.forEach((sessionSnap) => expiredSessions.push({ sessionId: sessionSnap.key, session: sessionSnap.val() || {} }));

  for (let offset = 0; offset < expiredSessions.length; offset += 10) {
    const batch = expiredSessions.slice(offset, offset + 10);
    const results = await Promise.all(batch.map(async ({ sessionId, session }) => {
      const expiresAt = Number(session.expiresAt || 0);
      if (expiresAt <= 0 || expiresAt > now) return null;
      try {
        const storagePath = String(session.storagePath || "");
        if (storagePath) await bucket.deleteFiles({ prefix: `${storagePath.replace(/\/+$/, "")}/` });
        return { sessionId, session };
      } catch (error) {
        console.error("Photobooth expiry cleanup failed", { sessionId, error });
        return null;
      }
    }));
    for (const result of results.filter(Boolean)) {
      updates[`moduleData/photoboothlive/sessions/${result.sessionId}`] = null;
      if (result.session.ownerUid && result.session.creationRequestId) {
        updates[`serverRequests/photoboothlive/create/${result.session.ownerUid}/${result.session.creationRequestId}`] = null;
      }
    }
  }

  if (Object.keys(updates).length) await db.ref().update(updates);
});

export const refreshPhotoboothQuotaPeriods = onSchedule({
  schedule: "every 60 minutes",
  timeZone: "Europe/Paris",
  region: "europe-west1"
}, async () => {
  const db = getDatabase();
  await db.ref("quotaPeriods").set(parisQuotaPeriods());
});
