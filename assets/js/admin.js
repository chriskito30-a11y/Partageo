import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { getDatabase, ref, get, onValue, set, update, remove, push } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js";
import { firebaseConfig } from "./firebase-config.js";
import { generateItems, slugify } from "./data.js";

const app = initializeApp(firebaseConfig), auth = getAuth(app), db = getDatabase(app);
const $ = id => document.getElementById(id);
let eventId = new URLSearchParams(location.search).get("event") || "";
let eventData = null, registrations = {}, items = {}, contributions = {};

$("eventId").value = eventId;
$("loginForm").addEventListener("submit", async e => { e.preventDefault(); try{ await signInWithEmailAndPassword(auth, $("adminEmail").value, $("adminPassword").value); }catch(err){ $("loginFeedback").textContent = err.message; } });
$("logoutBtn").addEventListener("click", () => signOut(auth));

onAuthStateChanged(auth, async user => {
  if(!user){ $("loginCard").classList.remove("hidden"); $("adminArea").classList.add("hidden"); return; }
  const adminSnap = await get(ref(db, `admins/${user.uid}`));
  if(!adminSnap.val()){ $("loginFeedback").textContent = "Compte connecté, mais UID non autorisé dans /admins."; await signOut(auth); return; }
  $("loginCard").classList.add("hidden"); $("adminArea").classList.remove("hidden");
  if(eventId) subscribe(eventId);
});

function subscribe(id){
  eventId = id; history.replaceState(null,"",`admin.html?event=${eventId}`); $("eventId").value = eventId;
  onValue(ref(db, `events/${eventId}`), s => { eventData = s.val(); fillForm(); render(); });
  onValue(ref(db, `registrations/${eventId}`), s => { registrations = s.val() || {}; render(); });
  onValue(ref(db, `contributionItems/${eventId}`), s => { items = s.val() || {}; render(); });
  onValue(ref(db, `contributions/${eventId}`), s => { contributions = s.val() || {}; render(); });
}
function fillForm(){ if(!eventData) return; ["title","description","eventDate","registrationDeadline","contributionDeadline"].forEach(k=>{ if($(k)) $(k).value = eventData[k] || ""; }); $("generalNoteInput").value = eventData.generalNote || ""; $("manualPhase2").checked = !!eventData.manualPhase2; }
function totalGuests(){ return Object.values(registrations).reduce((s,r)=>s+Number(r.guests||0),0); }
function takenFor(item){ return Object.values(contributions).filter(c=>c.itemId===item.id).reduce((s,c)=>s+(item.isQuantityBased?Number(c.quantity||1):1),0); }

$("eventForm").addEventListener("submit", async e => {
  e.preventDefault(); const id = slugify($("eventId").value.trim());
  const payload = { id, title:$("title").value.trim(), description:$("description").value.trim(), eventDate:$("eventDate").value, registrationDeadline:$("registrationDeadline").value, contributionDeadline:$("contributionDeadline").value, generalNote:$("generalNoteInput").value.trim(), manualPhase2:$("manualPhase2").checked, updatedAt:Date.now(), createdAt:eventData?.createdAt || Date.now() };
  await set(ref(db, `events/${id}`), payload); $("eventFeedback").textContent = "Événement enregistré."; subscribe(id);
});

$("generateItemsBtn").addEventListener("click", async () => {
  const generated = {}; generateItems(totalGuests()).forEach(item => generated[item.id] = item);
  await set(ref(db, `contributionItems/${eventId}`), generated);
});
$("itemForm").addEventListener("submit", async e => {
  e.preventDefault(); const id = slugify($("itemName").value); await set(ref(db, `contributionItems/${eventId}/${id}`), { id, name:$("itemName").value.trim(), needed:Number($("itemNeeded").value), note:$("itemNote").value.trim(), isQuantityBased:$("itemIsQuantity").checked }); e.target.reset();
});
$("deleteEventBtn").addEventListener("click", async () => { if(confirm("Supprimer définitivement cet événement ?")){ await Promise.all([remove(ref(db,`events/${eventId}`)),remove(ref(db,`registrations/${eventId}`)),remove(ref(db,`contributionItems/${eventId}`)),remove(ref(db,`contributions/${eventId}`))]); location.href="admin.html"; } });

function render(){
  if(!eventData) return; $("dashboard").classList.remove("hidden"); $("adminTables").classList.remove("hidden");
  $("adminTotalGuests").textContent = totalGuests(); $("adminRegistrations").textContent = Object.keys(registrations).length;
  const url = `${location.origin}${location.pathname.replace("admin.html","index.html")}?event=${eventId}`; $("publicLink").href = url; $("publicLink").textContent = url;
  $("registrationsList").innerHTML = Object.values(registrations).map(r=>`<article><strong>${esc(r.name)}</strong> · ${Number(r.guests||0)} personne(s)<br><span class="muted">${esc(r.comment||"")}</span></article>`).join("") || "<p>Aucun inscrit.</p>";
  $("adminItemsTable").innerHTML = Object.values(items).map(item=>`<tr><td><input data-id="${item.id}" data-field="name" value="${esc(item.name)}"></td><td><input type="number" min="1" data-id="${item.id}" data-field="needed" value="${Number(item.needed||1)}"><br><small>${takenFor(item)} pris</small></td><td><textarea data-id="${item.id}" data-field="note">${esc(item.note||"")}</textarea></td><td class="row-actions"><button data-save="${item.id}">Sauver</button><button class="danger" data-delete="${item.id}">Supprimer</button></td></tr>`).join("");
  document.querySelectorAll("[data-save]").forEach(btn => btn.onclick = () => saveItem(btn.dataset.save));
  document.querySelectorAll("[data-delete]").forEach(btn => btn.onclick = () => remove(ref(db,`contributionItems/${eventId}/${btn.dataset.delete}`)));
}
async function saveItem(id){ const patch = {}; document.querySelectorAll(`[data-id="${id}"]`).forEach(el => patch[el.dataset.field] = el.dataset.field === "needed" ? Number(el.value) : el.value); await update(ref(db,`contributionItems/${eventId}/${id}`), patch); }
function esc(str){ return String(str).replace(/[&<>'"]/g, s => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;","\"":"&quot;"}[s])); }
