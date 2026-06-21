import { getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { app, db, ref, get, onValue, set, update, remove } from "./firebase-config.js";
import { getAccessForUser } from "./modulys-access.js";
import { generateItems, slugify } from "./data.js";

const auth = getAuth(app);
const $ = id => document.getElementById(id);
let eventId = new URLSearchParams(location.search).get("event") || "";
let eventData = null, registrations = {}, items = {}, contributions = {}, allEvents = {};
let currentUser = null;
let isSuperAdmin = false;

$("eventId").value = eventId;
$("loginForm").addEventListener("submit", async e => {
  e.preventDefault();
  try{
    await signInWithEmailAndPassword(auth, $("adminEmail").value, $("adminPassword").value);
  }catch(err){
    $("loginFeedback").textContent = err.message;
  }
});
$("logoutBtn").addEventListener("click", () => signOut(auth));
$("newEventBtn").addEventListener("click", resetEventForm);

onAuthStateChanged(auth, async user => {
  if(!user){
    $("loginCard").classList.remove("hidden");
    $("adminArea").classList.add("hidden");
    return;
  }
  currentUser = user;
  const [adminsSnap, adminSnap, access] = await Promise.all([
    get(ref(db, `admins/${user.uid}`)),
    get(ref(db, `admin/${user.uid}`)),
    getAccessForUser("partageo", user)
  ]);
  isSuperAdmin = Boolean(adminsSnap.val() || adminSnap.val());
  if(!isSuperAdmin && !access.allowed){
    $("loginFeedback").textContent = "Compte connecté, mais accès Partageo non disponible dans Modulys.";
    await signOut(auth);
    return;
  }
  $("loginCard").classList.add("hidden");
  $("adminArea").classList.remove("hidden");
  subscribeEventsList();
  if(eventId) subscribe(eventId);
});

function subscribeEventsList(){
  const listEl = $("eventsList");
  if(listEl) listEl.innerHTML = '<p class="muted">Chargement des événements…</p>';
  onValue(ref(db, "events"), snap => {
    allEvents = snap.val() || {};
    renderEventsList();
  }, err => {
    if(listEl) listEl.innerHTML = `<p class="feedback">Impossible de charger les événements : ${esc(err.message || err.code || err)}</p>`;
  });
}

function subscribe(id){
  eventId = id;
  history.replaceState(null,"",`admin.html?event=${eventId}`);
  $("eventId").value = eventId;
  onValue(ref(db, `events/${eventId}`), s => { eventData = s.val(); fillForm(); render(); });
  onValue(ref(db, `registrations/${eventId}`), s => { registrations = s.val() || {}; render(); });
  onValue(ref(db, `contributionItems/${eventId}`), s => { items = s.val() || {}; render(); });
  onValue(ref(db, `contributions/${eventId}`), s => { contributions = s.val() || {}; render(); });
}

function fillForm(){
  if(!eventData) return;
  ["title","description","eventDate","registrationDeadline","contributionDeadline"].forEach(k=>{ if($(k)) $(k).value = eventData[k] || ""; });
  $("generalNoteInput").value = eventData.generalNote || "";
  $("manualPhase2").checked = !!eventData.manualPhase2;
}
function resetEventForm(){
  eventId = ""; eventData = null; registrations = {}; items = {}; contributions = {};
  history.replaceState(null,"","admin.html");
  $("eventForm").reset();
  $("eventId").value = "";
  $("eventFeedback").textContent = "Nouveau formulaire prêt.";
  $("dashboard").classList.add("hidden");
  $("adminTables").classList.add("hidden");
}
function totalGuests(){ return Object.values(registrations).reduce((s,r)=>s+Number(r.guests||0),0); }
function takenFor(item){ return Object.values(contributions).filter(c=>c.itemId===item.id).reduce((s,c)=>s+(item.isQuantityBased?Number(c.quantity||1):1),0); }
function publicUrl(id){ return `${location.origin}${location.pathname.replace("admin.html","index.html")}?event=${id}`; }
function adminUrl(id){ return `${location.origin}${location.pathname}?event=${id}`; }

$("eventForm").addEventListener("submit", async e => {
  e.preventDefault();
  const id = slugify($("eventId").value.trim());
  const payload = {
    id,
    title:$("title").value.trim(),
    description:$("description").value.trim(),
    eventDate:$("eventDate").value,
    registrationDeadline:$("registrationDeadline").value,
    contributionDeadline:$("contributionDeadline").value,
    generalNote:$("generalNoteInput").value.trim(),
    manualPhase2:$("manualPhase2").checked,
    updatedAt:Date.now(),
    createdAt:eventData?.createdAt || Date.now(),
    ownerUid:eventData?.ownerUid || currentUser?.uid || ""
  };
  await set(ref(db, `events/${id}`), payload);
  $("eventFeedback").textContent = "Événement enregistré. Tu peux maintenant le retrouver dans Mes événements.";
  subscribe(id);
});

$("generateItemsBtn").addEventListener("click", async () => {
  if(!eventId) return;
  const generated = {}; generateItems(totalGuests()).forEach(item => generated[item.id] = item);
  await set(ref(db, `contributionItems/${eventId}`), generated);
});
$("itemForm").addEventListener("submit", async e => {
  e.preventDefault();
  if(!eventId) return;
  const id = slugify($("itemName").value);
  await set(ref(db, `contributionItems/${eventId}/${id}`), { id, name:$("itemName").value.trim(), needed:Number($("itemNeeded").value), note:$("itemNote").value.trim(), isQuantityBased:$("itemIsQuantity").checked });
  e.target.reset();
});
$("deleteEventBtn").addEventListener("click", async () => {
  if(confirm("Supprimer définitivement cet événement ?")){
    await Promise.all([
      remove(ref(db,`events/${eventId}`)),
      remove(ref(db,`registrations/${eventId}`)),
      remove(ref(db,`contributionItems/${eventId}`)),
      remove(ref(db,`contributions/${eventId}`))
    ]);
    location.href="admin.html";
  }
});

function renderEventsList(){
  const list = Object.values(allEvents)
    .filter(ev => isSuperAdmin || ev.ownerUid === currentUser?.uid)
    .sort((a,b)=>String(b.eventDate||"").localeCompare(String(a.eventDate||"")));
  if(!list.length){
    $("eventsList").innerHTML = '<p class="muted">Aucun événement créé pour le moment.</p>';
    return;
  }
  $("eventsList").innerHTML = list.map(ev => `
    <article class="event-card">
      <div>
        <h3>${esc(ev.title || ev.id)}</h3>
        <p class="muted">${esc(ev.eventDate || "Date non définie")} · identifiant : <strong>${esc(ev.id)}</strong></p>
        <p><a href="${publicUrl(ev.id)}" target="_blank" rel="noopener">Lien public</a></p>
        <span class="copy-feedback" id="copy-${esc(ev.id)}"></span>
      </div>
      <div class="event-card-actions">
        <button type="button" data-open-event="${esc(ev.id)}">Modifier</button>
        <button type="button" class="ghost" data-copy-public="${esc(ev.id)}">Copier le lien</button>
      </div>
    </article>`).join("");
  document.querySelectorAll("[data-open-event]").forEach(btn => btn.onclick = () => subscribe(btn.dataset.openEvent));
  document.querySelectorAll("[data-copy-public]").forEach(btn => btn.onclick = () => copyPublicLink(btn.dataset.copyPublic));
}
async function copyPublicLink(id){
  const url = publicUrl(id);
  try{
    await navigator.clipboard.writeText(url);
    const el = $(`copy-${id}`); if(el) el.textContent = "Lien copié.";
  }catch(_){
    prompt("Copie le lien public :", url);
  }
}

function render(){
  if(!eventData) return;
  $("dashboard").classList.remove("hidden");
  $("adminTables").classList.remove("hidden");
  $("adminTotalGuests").textContent = totalGuests();
  $("adminRegistrations").textContent = Object.keys(registrations).length;
  const url = publicUrl(eventId);
  $("publicLink").href = url;
  $("publicLink").textContent = url;
  renderRegistrationsAdmin();
  $("adminItemsTable").innerHTML = Object.values(items).map(item=>`<tr><td><input data-id="${item.id}" data-field="name" value="${esc(item.name)}"></td><td><input type="number" min="1" data-id="${item.id}" data-field="needed" value="${Number(item.needed||1)}"><br><small>${takenFor(item)} pris</small></td><td><textarea data-id="${item.id}" data-field="note">${esc(item.note||"")}</textarea></td><td class="row-actions"><button data-save="${item.id}">Sauver</button><button class="danger" data-delete="${item.id}">Supprimer</button></td></tr>`).join("");
  document.querySelectorAll("[data-save]").forEach(btn => btn.onclick = () => saveItem(btn.dataset.save));
  document.querySelectorAll("[data-delete]").forEach(btn => btn.onclick = () => remove(ref(db,`contributionItems/${eventId}/${btn.dataset.delete}`)));
}

function renderRegistrationsAdmin(){
  const rows = Object.values(registrations);
  if(!rows.length){
    $("registrationsList").innerHTML = "<p>Aucun inscrit.</p>";
    return;
  }
  $("registrationsList").innerHTML = rows
    .sort((a,b)=>String(a.name||"").localeCompare(String(b.name||""), "fr"))
    .map(r=>{
      const uid = r.uid || "";
      const userContribs = Object.values(contributions).filter(c => c.uid === uid);
      const contribText = userContribs.length
        ? userContribs.map(c => `${esc(c.label || "Apport")} <span class="muted">(${esc((items[c.itemId]?.name) || c.itemId || "")})</span>`).join("<br>")
        : '<span class="muted">Aucun apport choisi pour le moment.</span>';
      return `<article class="registration-card">
        <div class="registration-main">
          <strong>${esc(r.name)}</strong> · ${Number(r.guests||0)} personne(s)
          <br><span class="muted">${esc(r.comment||"")}</span>
          <div class="contrib-summary">${contribText}</div>
        </div>
        <div class="access-code-admin">
          <label>Code accès public
            <input data-registration-code="${esc(uid)}" value="${esc(r.accessCode || "")}" maxlength="12" inputmode="numeric" />
          </label>
          <button type="button" class="ghost" data-save-registration-code="${esc(uid)}">Modifier le code</button>
          <span class="copy-feedback" id="reg-code-feedback-${esc(uid)}"></span>
        </div>
      </article>`;
    }).join("");
  document.querySelectorAll("[data-save-registration-code]").forEach(btn => btn.onclick = () => saveRegistrationCode(btn.dataset.saveRegistrationCode));
}

async function saveRegistrationCode(uid){
  const input = document.querySelector(`[data-registration-code="${CSS.escape(uid)}"]`);
  const code = String(input?.value || "").trim();
  const feedback = $(`reg-code-feedback-${uid}`);
  if(code.length < 4 || code.length > 12){
    if(feedback) feedback.textContent = "Code entre 4 et 12 caractères.";
    return;
  }
  await update(ref(db, `registrations/${eventId}/${uid}`), { accessCode: code, updatedAt: Date.now() });
  if(feedback) feedback.textContent = "Code modifié.";
}

async function saveItem(id){
  const patch = {};
  document.querySelectorAll(`[data-id="${id}"]`).forEach(el => patch[el.dataset.field] = el.dataset.field === "needed" ? Number(el.value) : el.value);
  await update(ref(db,`contributionItems/${eventId}/${id}`), patch);
}
function esc(str){ return String(str).replace(/[&<>'"]/g, s => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;","\"":"&quot;"}[s])); }
