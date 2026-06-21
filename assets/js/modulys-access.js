import { app, db, ref, get, set } from "./firebase-config.js";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";

const auth = getAuth(app);
const DEFAULT_FREE_LIMITS = { eventsPerMonth: 1, participantsPerEvent: 30 };

function normalizeTimestamp(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return value;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function isActiveGrant(grant) {
  if (!grant) return false;
  if (grant === true) return true;
  const status = String(grant.status || "active").toLowerCase();
  if (!["active", "trial", "lifetime"].includes(status)) return false;
  if (grant.lifetime === true || status === "lifetime") return true;
  const expiresAt = normalizeTimestamp(grant.expiresAt);
  return !expiresAt || expiresAt > Date.now();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function currentBillingPeriod(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

export function waitForCurrentUser(timeoutMs = 1400) {
  return new Promise((resolve) => {
    let done = false;
    let unsubscribe = () => {};
    const finish = (user) => {
      if (done) return;
      done = true;
      try { unsubscribe(); } catch {}
      resolve(user || null);
    };
    unsubscribe = onAuthStateChanged(auth, finish, () => finish(null));
    window.setTimeout(() => finish(auth.currentUser || null), timeoutMs);
  });
}

function resolveLimits(moduleKey, moduleData = {}, planData = {}) {
  const moduleFree = moduleData?.limits?.free || {};
  const planLimits = planData?.limits || {};
  const perModule = planLimits?.[moduleKey] || {};
  return {
    eventsPerMonth: Number(moduleFree.eventsPerMonth || perModule.eventsPerMonth || planLimits.eventsPerMonth || DEFAULT_FREE_LIMITS.eventsPerMonth),
    participantsPerEvent: Number(moduleFree.participantsPerEvent || perModule.participantsPerEvent || planLimits.participantsPerEvent || DEFAULT_FREE_LIMITS.participantsPerEvent)
  };
}

export async function getAccessForUser(moduleKey, user) {
  const moduleSnap = await get(ref(db, `modules/${moduleKey}`));
  const moduleData = moduleSnap.val() || null;

  if (!moduleData) return { allowed: false, reason: "module_not_declared", module: null };
  if (moduleData.active === false) return { allowed: false, reason: "module_inactive", module: moduleData };
  if (moduleData.accessMode === "public") return { allowed: true, reason: "public", module: moduleData };
  if (!user) return { allowed: false, reason: "not_authenticated", module: moduleData };

  const [adminsSnap, adminSnap, accessSnap, subscriptionSnap, freePlanSnap] = await Promise.all([
    get(ref(db, `admins/${user.uid}`)),
    get(ref(db, `admin/${user.uid}`)),
    get(ref(db, `userAccess/${user.uid}`)),
    get(ref(db, `subscriptions/${user.uid}`)),
    get(ref(db, "plans/free"))
  ]);

  const isAdmin = Boolean(adminsSnap.val() || adminSnap.val());
  const access = accessSnap.val() || {};
  const subscription = subscriptionSnap.val() || null;
  const freePlan = freePlanSnap.val() || {};
  const freeLimits = resolveLimits(moduleKey, moduleData, freePlan);

  if (isAdmin) return { allowed: true, reason: "admin", module: moduleData, isAdmin, access, subscription, planId: "admin", limits: null, unlimited: true };
  if (isActiveGrant(access.allModules)) return { allowed: true, reason: "all_modules", module: moduleData, isAdmin, access, subscription, planId: access.planId || "custom", limits: null, unlimited: true };
  if (isActiveGrant(access.modules?.[moduleKey])) return { allowed: true, reason: "module_grant", module: moduleData, isAdmin, access, subscription, planId: access.planId || "custom", limits: null, unlimited: true };
  if (isActiveGrant(subscription) && (subscription.scope === "allModules" || subscription.modules?.[moduleKey] === true)) {
    return { allowed: true, reason: "subscription", module: moduleData, isAdmin, access, subscription, planId: subscription.planId || "subscription", limits: null, unlimited: true };
  }

  if (moduleData.accessMode === "free_authenticated") {
    return { allowed: true, reason: "free_authenticated", module: moduleData, isAdmin, access, subscription, planId: "free", limits: freeLimits, unlimited: false };
  }

  return { allowed: false, reason: "no_grant", module: moduleData, isAdmin, access, subscription, planId: "none", limits: freeLimits, unlimited: false };
}

function reasonLabel(reason) {
  return {
    not_authenticated: "Vous devez vous connecter avec votre compte Modulys pour ouvrir ce module.",
    module_not_declared: "Ce module n’est pas encore déclaré dans Firebase.",
    module_inactive: "Ce module est actuellement désactivé.",
    no_grant: "Votre compte ne possède pas encore les droits pour ce module.",
    free_limit_reached: "La limite gratuite de ce module est atteinte pour ce mois."
  }[reason] || "Accès non disponible.";
}

function renderLoginRequired(moduleKey, reason) {
  const safeModule = escapeHtml(moduleKey);
  document.body.innerHTML = `<main style="min-height:100vh;display:grid;place-items:center;padding:24px;font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:linear-gradient(135deg,#f8fafc,#eef2ff);color:#111827">
    <section style="width:min(100%,560px);padding:28px;border:1px solid #e5e7eb;border-radius:24px;background:white;box-shadow:0 20px 50px rgba(15,23,42,.10)">
      <p style="margin:0 0 8px;color:#7c3aed;font-weight:900;text-transform:uppercase;letter-spacing:.08em">Modulys</p>
      <h1 style="margin:0 0 10px;font-size:30px">Connexion requise</h1>
      <p style="margin:0 0 18px;color:#64748b">${escapeHtml(reasonLabel(reason))}</p>
      <form id="modulysModuleLoginForm" style="display:grid;gap:12px">
        <label style="display:grid;gap:6px;font-weight:700">Email
          <input id="modulysModuleEmail" type="email" autocomplete="email" required style="width:100%;box-sizing:border-box;border:1px solid #d1d5db;border-radius:14px;padding:12px 14px;font:inherit">
        </label>
        <label style="display:grid;gap:6px;font-weight:700">Mot de passe
          <input id="modulysModulePassword" type="password" autocomplete="current-password" required style="width:100%;box-sizing:border-box;border:1px solid #d1d5db;border-radius:14px;padding:12px 14px;font:inherit">
        </label>
        <button type="submit" style="border:0;border-radius:999px;background:#7c3aed;color:white;padding:13px 18px;font-weight:900;cursor:pointer">Me connecter</button>
        <p id="modulysModuleLoginFeedback" style="min-height:20px;margin:0;color:#dc2626;font-weight:700"></p>
      </form>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:16px">
        <a href="https://modulys.top/mes-modules.html" style="color:#7c3aed;font-weight:800;text-decoration:none">Créer un compte / Mes modules</a>
        <button id="modulysModuleLogout" type="button" style="border:0;background:transparent;color:#64748b;font-weight:800;cursor:pointer">Changer de compte</button>
      </div>
      <p style="margin:16px 0 0;color:#94a3b8;font-size:13px">Module : <strong>${safeModule}</strong></p>
    </section>
  </main>`;

  const form = document.getElementById("modulysModuleLoginForm");
  const feedback = document.getElementById("modulysModuleLoginFeedback");
  const logoutBtn = document.getElementById("modulysModuleLogout");
  logoutBtn?.addEventListener("click", async () => {
    await signOut(auth);
    location.reload();
  });
  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (feedback) feedback.textContent = "Connexion…";
    try {
      const email = document.getElementById("modulysModuleEmail")?.value || "";
      const password = document.getElementById("modulysModulePassword")?.value || "";
      await signInWithEmailAndPassword(auth, email.trim(), password);
      location.reload();
    } catch (error) {
      if (feedback) feedback.textContent = "Connexion impossible. Vérifiez l’email, le mot de passe ou les domaines autorisés Firebase.";
      console.warn("Modulys module login failed", error);
    }
  });
}

function renderBlocked(moduleKey, reason) {
  if (reason === "not_authenticated") {
    renderLoginRequired(moduleKey, reason);
    return;
  }
  document.body.innerHTML = `<main style="min-height:100vh;display:grid;place-items:center;padding:24px;font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#f8fafc;color:#111827"><section style="max-width:560px;padding:28px;border:1px solid #e5e7eb;border-radius:24px;background:white;box-shadow:0 20px 50px rgba(15,23,42,.10)"><p style="margin:0 0 8px;color:#7c3aed;font-weight:900;text-transform:uppercase;letter-spacing:.08em">Modulys</p><h1 style="margin:0 0 10px;font-size:32px">Accès non disponible</h1><p style="color:#64748b">${escapeHtml(reasonLabel(reason))}</p><a href="https://modulys.top/mes-modules.html" style="display:inline-flex;margin-top:14px;padding:12px 18px;border-radius:999px;background:#7c3aed;color:white;text-decoration:none;font-weight:800">Retour à mes modules</a></section></main>`;
}

export async function enforceModuleAccess(moduleKey, options = {}) {
  const mode = options.mode || "soft";
  try {
    const user = await waitForCurrentUser(options.timeoutMs || 1800);
    const access = await getAccessForUser(moduleKey, user);
    if (access.allowed) return true;
    if (mode === "hard") {
      renderBlocked(moduleKey, access.reason);
      return false;
    }
    return true;
  } catch (error) {
    console.warn("Modulys access check failed", error);
    if (mode === "hard") {
      renderBlocked(moduleKey, "access_check_error");
      return false;
    }
    return true;
  }
}

export async function getModuleAccessContext(moduleKey) {
  const user = await waitForCurrentUser(1800);
  const access = await getAccessForUser(moduleKey, user);
  if (!user || !access.allowed) {
    throw new Error(reasonLabel(access.reason));
  }
  return { user, ...access };
}

export async function readModuleUsage(moduleKey, userUid, period = currentBillingPeriod()) {
  const snap = await get(ref(db, `usage/${userUid}/${period}/${moduleKey}`));
  const data = snap.val() || {};
  return {
    eventsCreated: Number(data.eventsCreated || 0),
    entities: data.entities || {}
  };
}

export async function assertCanCreateModuleEvent(moduleKey) {
  const context = await getModuleAccessContext(moduleKey);
  const period = currentBillingPeriod();
  if (context.unlimited) return { ...context, period, usage: { eventsCreated: 0 } };

  const limits = context.limits || DEFAULT_FREE_LIMITS;
  const usage = await readModuleUsage(moduleKey, context.user.uid, period);
  if (usage.eventsCreated >= limits.eventsPerMonth) {
    throw new Error(`Limite gratuite atteinte : ${limits.eventsPerMonth} création par mois pour ce module. Passez à une offre payante ou attendez le mois prochain.`);
  }
  return { ...context, period, usage };
}

export function buildModuleEntityMeta(context) {
  const limits = context.limits || {};
  return {
    ownerUid: context.user?.uid || "",
    ownerEmail: context.user?.email || "",
    moduleId: context.module?.id || "",
    planId: context.unlimited ? (context.planId || "admin") : "free",
    billingPeriod: context.period || currentBillingPeriod(),
    limits: {
      eventsPerMonth: context.unlimited ? 0 : Number(limits.eventsPerMonth || DEFAULT_FREE_LIMITS.eventsPerMonth),
      participantsPerEvent: context.unlimited ? 0 : Number(limits.participantsPerEvent || DEFAULT_FREE_LIMITS.participantsPerEvent)
    }
  };
}

export async function recordModuleEventUsage(moduleKey, entityId, context) {
  if (!context || context.unlimited) return;
  const period = context.period || currentBillingPeriod();
  const uid = context.user?.uid;
  if (!uid || !entityId) return;
  const current = Number(context.usage?.eventsCreated || 0);
  const next = current + 1;
  await set(ref(db, `usage/${uid}/${period}/${moduleKey}/eventsCreated`), next);
  await set(ref(db, `usage/${uid}/${period}/${moduleKey}/entities/${entityId}`), true);
  await set(ref(db, `usage/${uid}/${period}/${moduleKey}/updatedAt`), Date.now());
}

export function getParticipantLimitFromEntity(entity = {}, fallback = DEFAULT_FREE_LIMITS.participantsPerEvent) {
  const direct = Number(entity?.limits?.participantsPerEvent || entity?.participantsLimit || entity?.config?.participantsLimit || entity?.meta?.participantsLimit || 0);
  return direct > 0 ? direct : fallback;
}
