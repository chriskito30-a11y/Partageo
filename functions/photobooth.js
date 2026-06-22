import { randomUUID } from "node:crypto";
import { getDatabase } from "firebase-admin/database";
import { getStorage } from "firebase-admin/storage";
import { HttpsError, onCall } from "firebase-functions/v2/https";

const MODULE_ID = "photoboothlive";
const SESSIONS_PATH = `moduleData/${MODULE_ID}/sessions`;
const STORAGE_BUCKET = "impro-ead69.firebasestorage.app";
const REGION = "europe-west1";
const EVENT_PASS_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_EVENT_AHEAD_MS = 366 * 24 * 60 * 60 * 1000;
const CREATION_LEASE_MS = 5 * 60 * 1000;
const UPLOAD_LEASE_MS = 5 * 60 * 1000;
const SLOT_RESERVATION_MS = 10 * 60 * 1000;
const CALLABLE_OPTIONS = { region: REGION, timeoutSeconds: 60, memory: "256MiB", maxInstances: 20 };

function normalizeTimestamp(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function isActiveGrant(grant, now = Date.now()) {
  if (!grant) return false;
  if (grant === true) return true;
  if (typeof grant !== "object") return false;
  const status = String(grant.status || "active").toLowerCase();
  if (!["active", "trial", "lifetime"].includes(status)) return false;
  if (grant.lifetime === true || status === "lifetime") return true;
  if (Object.hasOwn(grant, "expiresAt")) {
    const expiresAt = normalizeTimestamp(grant.expiresAt);
    return expiresAt !== null && expiresAt > now;
  }
  return true;
}

function isActiveEventPassGrant(grant, now = Date.now()) {
  if (!isActiveGrant(grant, now) || grant === true || typeof grant !== "object") return false;
  if (Object.hasOwn(grant, "expiresAt")) return true;
  const createdAt = normalizeTimestamp(grant.createdAt || grant.grantedAt || grant.startsAt);
  return createdAt !== null && createdAt <= now && createdAt + EVENT_PASS_DURATION_MS > now;
}

function cleanText(value, maxLength) {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") throw new HttpsError("invalid-argument", "Valeur texte invalide.");
  return value.trim().slice(0, maxLength);
}

function normalizeSlug(value, maxLength = 48) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength);
}

function makeSessionId(title) {
  const base = normalizeSlug(title, 28) || "album";
  return `${base}-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

function parisPeriods(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit"
  }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return { month: `${parts.year}-${parts.month}`, year: parts.year };
}

function parisUtcOffsetMinutes(date) {
  const zoneName = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Paris",
    timeZoneName: "longOffset"
  }).formatToParts(date).find((part) => part.type === "timeZoneName")?.value || "GMT+00:00";
  const match = zoneName.match(/^GMT([+-])(\d{2}):(\d{2})$/);
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "-" ? -minutes : minutes;
}

function parisEndOfDay(value, now) {
  if (!value) return now;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new HttpsError("invalid-argument", "Date d’événement invalide.");
  const [year, month, day] = value.split("-").map(Number);
  const approximate = new Date(Date.UTC(year, month - 1, day, 23, 59, 59));
  if (approximate.getUTCFullYear() !== year || approximate.getUTCMonth() !== month - 1 || approximate.getUTCDate() !== day) {
    throw new HttpsError("invalid-argument", "Date d’événement invalide.");
  }
  const timestamp = approximate.getTime() - parisUtcOffsetMinutes(approximate) * 60 * 1000;
  if (timestamp > now + MAX_EVENT_AHEAD_MS) throw new HttpsError("invalid-argument", "La date de l’événement est trop éloignée.");
  return timestamp;
}

function requireSignedIn(request, { allowAnonymous = false } = {}) {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "Authentification requise.");
  if (!allowAnonymous && request.auth.token?.firebase?.sign_in_provider === "anonymous") {
    throw new HttpsError("permission-denied", "Un compte Modulys est requis.");
  }
  return request.auth.uid;
}

function requireSafeInteger(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new HttpsError("failed-precondition", `${label} invalide.`);
  }
  return number;
}

async function resolveCommercialAccess(db, uid) {
  const now = Date.now();
  const [moduleSnap, adminsSnap, adminSnap, accessSnap, subscriptionSnap] = await Promise.all([
    db.ref(`modules/${MODULE_ID}`).get(),
    db.ref(`admins/${uid}`).get(),
    db.ref(`admin/${uid}`).get(),
    db.ref(`userAccess/${uid}`).get(),
    db.ref(`subscriptions/${uid}`).get()
  ]);
  const moduleData = moduleSnap.val();
  if (!moduleData || moduleData.active === false) throw new HttpsError("failed-precondition", "PhotoboothLive est indisponible.");

  const access = accessSnap.val() || {};
  const subscription = subscriptionSnap.val() || {};
  const isAdmin = adminsSnap.val() === true || adminSnap.val() === true;
  let planId = isAdmin ? "lifetime" : "free";
  let entitlement = access;

  if (!isAdmin) {
    const accessPlanId = String(access.planId || "free").toLowerCase();
    const subscriptionPlanId = String(subscription.planId || "").toLowerCase();
    const moduleGrant = access.modules?.[MODULE_ID];
    const subscriptionModuleGrant = subscription.modules?.[MODULE_ID];
    const activeAccess = isActiveGrant(access, now);
    const activeSubscription = isActiveGrant(subscription, now);

    if (accessPlanId === "event_pass" && activeAccess && isActiveEventPassGrant(moduleGrant, now)) {
      planId = "event_pass";
      entitlement = { ...access, ...moduleGrant };
    } else if (accessPlanId !== "event_pass" && accessPlanId !== "free" && activeAccess && (isActiveGrant(access.allModules, now) || isActiveGrant(moduleGrant, now))) {
      planId = accessPlanId;
      entitlement = typeof moduleGrant === "object" ? { ...access, ...moduleGrant } : access;
    } else if (subscriptionPlanId === "event_pass" && activeSubscription && isActiveEventPassGrant(subscriptionModuleGrant, now)) {
      planId = "event_pass";
      entitlement = { ...subscription, ...subscriptionModuleGrant };
    } else if (subscriptionPlanId && subscriptionPlanId !== "event_pass" && activeSubscription && (subscription.scope === "allModules" || isActiveGrant(subscriptionModuleGrant, now))) {
      planId = subscriptionPlanId;
      entitlement = subscription;
    } else if (moduleData.accessMode !== "free_authenticated") {
      throw new HttpsError("permission-denied", "Aucun accès actif à PhotoboothLive.");
    }
  }

  const planSnap = await db.ref(`plans/${planId}`).get();
  const plan = planSnap.val();
  if (!plan || plan.active === false) throw new HttpsError("failed-precondition", "Offre inactive ou non configurée.");
  const limits = moduleData.limits?.[planId];
  if (!limits) throw new HttpsError("failed-precondition", "Limites PhotoboothLive non configurées pour cette offre.");
  if (Number(plan.limits?.eventsPerPeriod) !== Number(limits.eventsPerPeriod)
    || Number(plan.limits?.participantsPerEvent) !== Number(limits.participantsPerEvent)
    || String(plan.limits?.quotaPeriod) !== String(limits.quotaPeriod)) {
    throw new HttpsError("failed-precondition", "Catalogue commercial PhotoboothLive incohérent.");
  }

  const quotaPeriod = String(limits.quotaPeriod || "month");
  let billingPeriod = "";
  if (quotaPeriod === "grant") {
    billingPeriod = String(entitlement.grantId || "");
    if (!/^grant-[A-Za-z0-9_-]{6,58}$/.test(billingPeriod)) throw new HttpsError("failed-precondition", "Pass événement sans identifiant de quota valide.");
  } else {
    const periods = parisPeriods(new Date(now));
    billingPeriod = quotaPeriod === "year" ? periods.year : periods.month;
  }

  return { isAdmin, planId, plan, limits, billingPeriod };
}

async function assertLease(lockRef, token) {
  const current = await lockRef.get();
  if (current.child("token").val() !== token || Number(current.child("expiresAt").val() || 0) <= Date.now()) {
    throw new HttpsError("aborted", "L’opération a perdu son verrou serveur. Réessayez.");
  }
}

async function withLease(db, lockPath, leaseMs, callback) {
  const lockRef = db.ref(lockPath);
  const token = randomUUID();
  const now = Date.now();
  const result = await lockRef.transaction((current) => {
    if (current?.expiresAt > now) return;
    return { token, expiresAt: now + leaseMs };
  }, undefined, false);
  if (!result.committed || result.snapshot.child("token").val() !== token) {
    throw new HttpsError("aborted", "Une opération est déjà en cours. Réessayez dans quelques secondes.");
  }

  try {
    return await callback({ lockRef, token });
  } finally {
    try {
      await lockRef.transaction((current) => current?.token === token ? null : current, undefined, false);
    } catch (error) {
      console.error("Photobooth lease release failed", { lockPath, error });
    }
  }
}

function isFinalizedSlot(session, slot) {
  if (!slot?.participantId) return false;
  return Boolean(slot.finalizedAt || session.publicWrites?.[slot.participantId] || session.gallery?.[slot.participantId]);
}

function isJpeg(buffer) {
  return buffer.length >= 4
    && buffer[0] === 0xff
    && buffer[1] === 0xd8
    && buffer[2] === 0xff
    && buffer[buffer.length - 2] === 0xff
    && buffer[buffer.length - 1] === 0xd9;
}

export const createPhotoboothSession = onCall(CALLABLE_OPTIONS, async (request) => {
  const uid = requireSignedIn(request);
  const db = getDatabase();
  const requestId = String(request.data?.requestId || "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
    throw new HttpsError("invalid-argument", "Identifiant de création invalide.");
  }
  if (request.data?.moderationEnabled !== undefined && typeof request.data.moderationEnabled !== "boolean") {
    throw new HttpsError("invalid-argument", "Option de modération invalide.");
  }
  const title = cleanText(request.data?.title, 120) || "Mon album photo";
  const subtitle = cleanText(request.data?.subtitle, 160) || "Partagez vos plus beaux souvenirs";
  const welcomeMessage = cleanText(request.data?.welcomeMessage, 260) || "Scannez le QR code, ajoutez votre photo et laissez un message souvenir.";
  const eventDate = cleanText(request.data?.eventDate, 10);
  const moderationEnabled = Boolean(request.data?.moderationEnabled);

  return withLease(db, `serverLocks/${MODULE_ID}/create/${uid}`, CREATION_LEASE_MS, async ({ lockRef, token }) => {
    const requestRef = db.ref(`serverRequests/${MODULE_ID}/create/${uid}/${requestId}`);
    const existingRequest = await requestRef.get();
    const existingSessionId = String(existingRequest.child("sessionId").val() || "");
    if (existingSessionId) {
      const existingExpiry = Number((await db.ref(`${SESSIONS_PATH}/${existingSessionId}/expiresAt`).get()).val() || 0);
      if (existingExpiry > Date.now()) return { sessionId: existingSessionId };
      await requestRef.remove();
    }

    const access = await resolveCommercialAccess(db, uid);
    const periodLimit = requireSafeInteger(access.limits.eventsPerPeriod, "Quota d’événements", { min: 1, max: 10000 });
    const participantsLimit = requireSafeInteger(access.limits.participantsPerEvent, "Quota de participants", { min: 1, max: 250 });
    const retentionHours = requireSafeInteger(access.limits.retentionHours, "Rétention", { min: 1, max: 72 });
    const maxPhotoSizeBytes = requireSafeInteger(access.limits.maxPhotoSizeBytes, "Taille de photo", { min: 1, max: 1_000_000 });
    if (![24, 48, 72].includes(retentionHours)) throw new HttpsError("failed-precondition", "Rétention PhotoboothLive invalide.");

    const usagePath = `usage/${uid}/${access.billingPeriod}/${MODULE_ID}`;
    const usageSnap = await db.ref(usagePath).get();
    const rawUsed = usageSnap.child("eventsCreated").val();
    const used = rawUsed === null ? 0 : requireSafeInteger(rawUsed, "Compteur d’usage", { max: 1000000 });
    if (!access.isAdmin && used >= periodLimit) {
      throw new HttpsError("resource-exhausted", "Limite de l’offre atteinte.", {
        reason: "quota",
        period: access.billingPeriod,
        offerName: access.plan.name || access.planId,
        limits: access.limits
      });
    }

    const sessionId = makeSessionId(title);
    const now = Date.now();
    const retentionAnchorAt = parisEndOfDay(eventDate, now);
    const expiresAt = Math.max(now + 2 * 60 * 60 * 1000, retentionAnchorAt + retentionHours * 60 * 60 * 1000);
    const storagePath = `${MODULE_ID}-${retentionHours}h/${sessionId}`;
    const publicData = { title, subtitle, welcomeMessage, expiresAt, participantsLimit, maxPhotoSizeBytes, retentionHours, storagePath };
    const session = {
      ownerUid: uid,
      ownerEmail: String(request.auth.token?.email || "").slice(0, 180),
      moduleId: MODULE_ID,
      planId: access.planId,
      billingPeriod: access.billingPeriod,
      creationRequestId: requestId,
      createdAt: now,
      updatedAt: now,
      retentionAnchorAt,
      expiresAt,
      storagePath,
      public: publicData,
      config: {
        ...publicData,
        eventDate,
        photosPerParticipant: 1,
        moderationEnabled,
        videoEnabled: false
      },
      stats: { participantsCount: 0, photosCount: 0, approvedCount: 0, pendingCount: 0 }
    };

    await assertLease(lockRef, token);
    const updates = { [`${SESSIONS_PATH}/${sessionId}`]: session };
    updates[`serverRequests/${MODULE_ID}/create/${uid}/${requestId}`] = { sessionId, createdAt: now, expiresAt };
    if (!access.isAdmin) {
      updates[`${usagePath}/eventsCreated`] = used + 1;
      updates[`${usagePath}/entities/${sessionId}`] = true;
      updates[`${usagePath}/updatedAt`] = now;
    }
    await db.ref().update(updates);
    return { sessionId };
  });
});

export const reservePhotoboothSlot = onCall(CALLABLE_OPTIONS, async (request) => {
  const participantId = requireSignedIn(request, { allowAnonymous: true });
  const sessionId = normalizeSlug(request.data?.sessionId, 48);
  if (!sessionId) throw new HttpsError("invalid-argument", "Session invalide.");
  const sessionRef = getDatabase().ref(`${SESSIONS_PATH}/${sessionId}`);
  let outcome = null;
  let failure = "unavailable";

  const result = await sessionRef.transaction((session) => {
    outcome = null;
    failure = "unavailable";
    const now = Date.now();
    if (!session || Number(session.expiresAt || 0) <= now) return;
    const limit = Number(session.config?.participantsLimit || 0);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 250) return;

    session.slots ||= {};
    session.slotOwners ||= {};
    const knownSlotId = session.slotOwners[participantId];
    const knownSlot = knownSlotId ? session.slots[knownSlotId] : null;
    if (knownSlot?.participantId === participantId) {
      const reservationExpiresAt = Number(knownSlot.reservationExpiresAt || Number(knownSlot.createdAt || 0) + SLOT_RESERVATION_MS);
      if (isFinalizedSlot(session, knownSlot) || reservationExpiresAt > now) {
        outcome = { slotId: knownSlotId };
        return session;
      }
      delete session.slots[knownSlotId];
      delete session.slotOwners[participantId];
    }

    let slotId = "";
    for (let index = 1; index <= limit; index += 1) {
      const candidate = String(index).padStart(2, "0");
      const slot = session.slots[candidate];
      const reservationExpiresAt = Number(slot?.reservationExpiresAt || Number(slot?.createdAt || 0) + SLOT_RESERVATION_MS);
      if (!slot || (!isFinalizedSlot(session, slot) && reservationExpiresAt <= now)) {
        if (slot?.participantId) delete session.slotOwners[slot.participantId];
        slotId = candidate;
        break;
      }
    }
    if (!slotId) {
      failure = "capacity";
      return;
    }

    session.slots[slotId] = { id: slotId, participantId, createdAt: now, reservationExpiresAt: now + SLOT_RESERVATION_MS };
    session.slotOwners[participantId] = slotId;
    session.updatedAt = now;
    outcome = { slotId };
    return session;
  }, undefined, false);

  if (!result.committed || !outcome) {
    if (failure === "capacity") throw new HttpsError("resource-exhausted", "La limite de participants est atteinte.");
    throw new HttpsError("failed-precondition", "Galerie expirée ou indisponible.");
  }
  return outcome;
});

export const finalizePhotoboothUpload = onCall(CALLABLE_OPTIONS, async (request) => {
  const participantId = requireSignedIn(request, { allowAnonymous: true });
  const sessionId = normalizeSlug(request.data?.sessionId, 48);
  const slotId = cleanText(request.data?.slotId, 3);
  const participantName = cleanText(request.data?.participantName, 80);
  const message = cleanText(request.data?.message, 180);
  const photoBase64 = request.data?.photoBase64;
  if (typeof photoBase64 !== "string" || photoBase64.length > 1_400_000) {
    throw new HttpsError("invalid-argument", "Photo encodée invalide.");
  }
  if (!sessionId || !/^\d{2,3}$/.test(slotId) || !participantName || !photoBase64) {
    throw new HttpsError("invalid-argument", "Soumission incomplète.");
  }

  const db = getDatabase();
  return withLease(db, `serverLocks/${MODULE_ID}/uploads/${sessionId}/${participantId}`, UPLOAD_LEASE_MS, async ({ lockRef, token }) => {
    const sessionRef = db.ref(`${SESSIONS_PATH}/${sessionId}`);
    const [expirySnap, pathSnap, sizeSnap, anchorSnap, slotSnap, writeSnap, gallerySnap] = await Promise.all([
      sessionRef.child("expiresAt").get(),
      sessionRef.child("storagePath").get(),
      sessionRef.child("config/maxPhotoSizeBytes").get(),
      sessionRef.child("retentionAnchorAt").get(),
      sessionRef.child(`slots/${slotId}`).get(),
      sessionRef.child(`publicWrites/${participantId}`).get(),
      sessionRef.child(`gallery/${participantId}`).get()
    ]);
    if (writeSnap.exists() || gallerySnap.exists()) return { item: writeSnap.val() || gallerySnap.val() };
    const now = Date.now();
    if (Number(expirySnap.val() || 0) <= now) throw new HttpsError("failed-precondition", "Galerie expirée ou indisponible.");
    const slot = slotSnap.val();
    if (!slot || slot.participantId !== participantId) throw new HttpsError("permission-denied", "Créneau participant invalide.");
    const reservationExpiresAt = Number(slot.reservationExpiresAt || Number(slot.createdAt || 0) + SLOT_RESERVATION_MS);
    if (!slot.finalizedAt && reservationExpiresAt <= now) throw new HttpsError("failed-precondition", "Réservation expirée. Recommencez l’envoi.");

    const maxPhotoSizeBytes = requireSafeInteger(sizeSnap.val(), "Taille de photo", { min: 1, max: 1_000_000 });
    if (photoBase64.length % 4 !== 0 || photoBase64.length > Math.ceil(maxPhotoSizeBytes / 3) * 4 + 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(photoBase64)) {
      throw new HttpsError("invalid-argument", "Photo encodée invalide.");
    }
    const photo = Buffer.from(photoBase64, "base64");
    if (photo.length < 4 || photo.length > maxPhotoSizeBytes || !isJpeg(photo)) {
      throw new HttpsError("invalid-argument", "Le fichier doit être un JPEG valide dans la limite de l’offre.");
    }

    const storageRoot = String(pathSnap.val() || "");
    if (!storageRoot.match(/^photoboothlive-(24|48|72)h\/[a-z0-9-]{6,48}$/)) {
      throw new HttpsError("failed-precondition", "Chemin Storage invalide.");
    }
    const expectedPath = `${storageRoot}/${participantId}/photo.jpg`;
    const retentionAnchorAt = Number(anchorSnap.val() || 0);
    if (!Number.isFinite(retentionAnchorAt) || retentionAnchorAt <= 0) throw new HttpsError("failed-precondition", "Ancre de rétention invalide.");
    const downloadToken = randomUUID();
    const bucket = getStorage().bucket(STORAGE_BUCKET);
    const file = bucket.file(expectedPath);
    try {
      await file.save(photo, {
        resumable: false,
        validation: "crc32c",
        metadata: {
          contentType: "image/jpeg",
          cacheControl: "private, max-age=3600",
          customTime: new Date(retentionAnchorAt).toISOString(),
          metadata: {
            moduleId: MODULE_ID,
            sessionId,
            participantId,
            slotId,
            firebaseStorageDownloadTokens: downloadToken
          }
        }
      });
    } catch (error) {
      console.error("Photobooth server upload failed", { sessionId, participantId, error });
      throw new HttpsError("internal", "Téléversement impossible.");
    }

    await assertLease(lockRef, token);
    const imageUrl = `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(bucket.name)}/o/${encodeURIComponent(expectedPath)}?alt=media&token=${encodeURIComponent(downloadToken)}`;
    let existingItem = null;
    let abortReason = "unavailable";
    const result = await sessionRef.transaction((session) => {
      existingItem = null;
      abortReason = "unavailable";
      const committedAt = Date.now();
      if (!session || Number(session.expiresAt || 0) <= committedAt) return;
      if (session.publicWrites?.[participantId] || session.gallery?.[participantId]) {
        existingItem = session.publicWrites?.[participantId] || session.gallery?.[participantId];
        abortReason = "existing";
        return;
      }
      const currentSlot = session.slots?.[slotId];
      if (!currentSlot || currentSlot.participantId !== participantId) {
        abortReason = "slot";
        return;
      }
      const currentReservationExpiry = Number(currentSlot.reservationExpiresAt || Number(currentSlot.createdAt || 0) + SLOT_RESERVATION_MS);
      if (!currentSlot.finalizedAt && currentReservationExpiry <= committedAt) {
        abortReason = "reservation";
        return;
      }

      const autoApprove = session.config?.moderationEnabled === false;
      const status = autoApprove ? "approved" : "pending";
      const item = { id: participantId, slotId, participantId, participantName, imageUrl, storagePath: expectedPath, message, status, createdAt: committedAt };
      session.participants ||= {};
      session.publicWrites ||= {};
      session.gallery ||= {};
      session.stats ||= {};
      session.participants[participantId] = { id: participantId, slotId, name: participantName, joinedAt: committedAt, lastSeenAt: committedAt };
      session.publicWrites[participantId] = item;
      if (autoApprove) session.gallery[participantId] = { ...item, approvedAt: committedAt };
      session.slots[slotId] = { ...currentSlot, finalizedAt: committedAt };
      delete session.slots[slotId].reservationExpiresAt;
      session.stats.participantsCount = Object.keys(session.participants).length;
      session.stats.photosCount = Object.keys(session.publicWrites).length;
      session.stats.approvedCount = Object.keys(session.gallery).length;
      session.stats.pendingCount = Object.values(session.publicWrites).filter((entry) => entry?.status === "pending").length;
      session.updatedAt = committedAt;
      existingItem = item;
      return session;
    }, undefined, false);

    if (!result.committed) {
      if (abortReason === "existing" && existingItem) return { item: existingItem };
      try {
        await file.delete({ ignoreNotFound: true });
      } catch (error) {
        console.error("Photobooth orphan cleanup failed", { expectedPath, error });
      }
      if (abortReason === "slot") throw new HttpsError("permission-denied", "Créneau participant invalide.");
      if (abortReason === "reservation") throw new HttpsError("failed-precondition", "Réservation expirée. Recommencez l’envoi.");
      throw new HttpsError("failed-precondition", "Galerie expirée ou indisponible.");
    }
    return { item: existingItem };
  });
});
