import { app, db, ref, get } from "./firebase-config.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";

const auth = getAuth(app);

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

export async function getAccessForUser(moduleKey, user) {
  const moduleSnap = await get(ref(db, `modules/${moduleKey}`));
  const moduleData = moduleSnap.val() || null;

  if (!moduleData) return { allowed: true, reason: "module_not_declared_soft_mvp", module: null };
  if (moduleData.active === false) return { allowed: false, reason: "module_inactive", module: moduleData };
  if (moduleData.accessMode === "public") return { allowed: true, reason: "public", module: moduleData };
  if (!user) return { allowed: false, reason: "not_authenticated", module: moduleData };
  if (moduleData.accessMode === "free_authenticated") return { allowed: true, reason: "free_authenticated", module: moduleData };

  const [accessSnap, subscriptionSnap] = await Promise.all([
    get(ref(db, `userAccess/${user.uid}`)),
    get(ref(db, `subscriptions/${user.uid}`))
  ]);
  const access = accessSnap.val() || {};
  const subscription = subscriptionSnap.val() || null;

  if (isActiveGrant(access.allModules)) return { allowed: true, reason: "all_modules", module: moduleData };
  if (isActiveGrant(access.modules?.[moduleKey])) return { allowed: true, reason: "module_grant", module: moduleData };
  if (isActiveGrant(subscription) && (subscription.scope === "allModules" || subscription.modules?.[moduleKey] === true)) {
    return { allowed: true, reason: "subscription", module: moduleData };
  }
  return { allowed: false, reason: "no_grant", module: moduleData };
}

function renderBlocked(moduleKey, reason) {
  document.body.innerHTML = `<main style="min-height:100vh;display:grid;place-items:center;padding:24px;font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#f8fafc;color:#111827"><section style="max-width:560px;padding:28px;border:1px solid #e5e7eb;border-radius:24px;background:white;box-shadow:0 20px 50px rgba(15,23,42,.10)"><p style="margin:0 0 8px;color:#7c3aed;font-weight:900;text-transform:uppercase;letter-spacing:.08em">Modulys</p><h1 style="margin:0 0 10px;font-size:32px">Accès non disponible</h1><p style="color:#64748b">Votre compte ne possède pas encore l’accès au module <strong>${moduleKey}</strong>. Raison : ${reason}.</p><a href="https://modulys.top/mes-modules.html" style="display:inline-flex;margin-top:14px;padding:12px 18px;border-radius:999px;background:#7c3aed;color:white;text-decoration:none;font-weight:800">Retour à mes modules</a></section></main>`;
}

export async function enforceModuleAccess(moduleKey, options = {}) {
  const mode = options.mode || "soft";
  try {
    const user = await waitForCurrentUser(options.timeoutMs || 1400);
    const access = await getAccessForUser(moduleKey, user);
    if (access.allowed) return true;
    if (mode === "hard") {
      renderBlocked(moduleKey, access.reason);
      return false;
    }
    return true;
  } catch (error) {
    console.warn("Modulys access check skipped", error);
    return mode !== "hard";
  }
}
