import { app, db, ref, get } from "./firebase-config.js";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";

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

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
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

  if (!moduleData) return { allowed: false, reason: "module_not_declared", module: null };
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

function reasonLabel(reason) {
  return {
    not_authenticated: "Vous devez vous connecter avec votre compte Modulys pour ouvrir ce module.",
    module_not_declared: "Ce module n’est pas encore déclaré dans Firebase.",
    module_inactive: "Ce module est actuellement désactivé.",
    no_grant: "Votre compte ne possède pas encore les droits pour ce module."
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
