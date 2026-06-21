import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { getDatabase, ref, onValue, set, push } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js";
import { firebaseConfig } from "./firebase-config.js";
import { getPhase } from "./data.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);
const eventId = new URLSearchParams(location.search).get("event");
let uid = null, eventData = null, registrations = {}, items = {}, contributions = {};

const $ = (id) => document.getElementById(id);
const fmt = (d) => d ? new Date(d).toLocaleString("fr-FR", {dateStyle:"medium", timeStyle:"short"}) : "—";

signInAnonymously(auth).catch(console.error);
onAuthStateChanged(auth, user => { uid = user?.uid || null; if(eventId) subscribe(); });
if(!eventId){ $("loadingCard").classList.add("hidden"); $("noEventCard").classList.remove("hidden"); }

function subscribe(){
  onValue(ref(db, `events/${eventId}`), snap => { eventData = snap.val(); render(); });
  onValue(ref(db, `registrations/${eventId}`), snap => { registrations = snap.val() || {}; render(); });
  onValue(ref(db, `contributionItems/${eventId}`), snap => { items = snap.val() || {}; render(); });
  onValue(ref(db, `contributions/${eventId}`), snap => { contributions = snap.val() || {}; render(); });
}

function totalGuests(){ return Object.values(registrations).reduce((sum,r)=>sum + Number(r.guests || 0),0); }
function takenFor(item){
  return Object.values(contributions).filter(c => c.itemId === item.id).reduce((sum,c)=> sum + (item.isQuantityBased ? Number(c.quantity || 1) : 1), 0);
}
function currentRegistration(){ return registrations[uid]; }

function render(){
  $("loadingCard").classList.add("hidden");
  if(!eventData){ $("noEventCard").classList.remove("hidden"); return; }
  $("noEventCard").classList.add("hidden"); $("eventCard").classList.remove("hidden"); $("tableSection").classList.remove("hidden");
  $("eventTitle").textContent = eventData.title || "Partageo";
  $("eventDescription").textContent = eventData.description || "";
  $("totalGuests").textContent = totalGuests();
  const phase = getPhase(eventData);
  $("phaseLabel").textContent = phase === "contribution" ? "Qui apporte quoi" : "Inscriptions";
  $("eventDates").textContent = `Événement : ${fmt(eventData.eventDate)} · Inscriptions jusqu’au ${fmt(eventData.registrationDeadline)} · Choix jusqu’au ${fmt(eventData.contributionDeadline)}`;
  $("generalNote").textContent = eventData.generalNote || "";
  $("generalNote").classList.toggle("hidden", !eventData.generalNote);
  $("contributionPanel").classList.toggle("hidden", phase !== "contribution");
  $("registrationPanel").classList.toggle("hidden", false);
  const reg = currentRegistration();
  if(reg){ $("regName").value = reg.name || ""; $("regGuests").value = reg.guests || 1; $("regComment").value = reg.comment || ""; }
  renderItemSelect(); renderTable();
}

function renderItemSelect(){
  const select = $("contribItem"); select.innerHTML = "";
  Object.values(items).forEach(item => {
    const remaining = Number(item.needed || 0) - takenFor(item);
    if(remaining > 0){
      const opt = document.createElement("option"); opt.value = item.id; opt.textContent = `${item.name} — ${remaining} restant(s)`; select.appendChild(opt);
    }
  });
  const selected = Object.values(items).find(i => i.id === select.value);
  $("quantityWrap").classList.toggle("hidden", !selected?.isQuantityBased);
}
$("contribItem").addEventListener("change", renderItemSelect);

function renderTable(){
  const tbody = $("itemsTable"); tbody.innerHTML = "";
  Object.values(items).forEach(item => {
    const related = Object.values(contributions).filter(c => c.itemId === item.id);
    const taken = takenFor(item), needed = Number(item.needed || 0), remaining = Math.max(0, needed - taken);
    const tr = document.createElement("tr");
    const ratio = needed ? taken / needed : 0;
    tr.className = ratio >= 1 ? "status-full" : ratio >= .75 ? "status-warn" : "status-ok";
    tr.innerHTML = `<td><strong>${escapeHtml(item.name)}</strong></td><td>${needed}</td><td>${taken}</td><td>${remaining}</td><td>${escapeHtml(item.note || "")}</td><td>${related.map(c=>`<span class="pill">${escapeHtml(c.name || "?")} : ${escapeHtml(c.label || "")}${item.isQuantityBased ? ` (${Number(c.quantity||1)})` : ""}</span>`).join("") || "—"}</td>`;
    tbody.appendChild(tr);
  });
}

$("registrationForm").addEventListener("submit", async e => {
  e.preventDefault(); if(!uid) return;
  await set(ref(db, `registrations/${eventId}/${uid}`), { uid, name: $("regName").value.trim(), guests: Number($("regGuests").value), comment: $("regComment").value.trim(), updatedAt: Date.now() });
  $("registrationFeedback").textContent = "Participation enregistrée.";
});

$("contributionForm").addEventListener("submit", async e => {
  e.preventDefault(); if(!uid) return;
  const item = Object.values(items).find(i => i.id === $("contribItem").value);
  const reg = currentRegistration();
  if(!reg){ $("contributionFeedback").textContent = "Inscris-toi d’abord comme participant."; return; }
  if(!item){ $("contributionFeedback").textContent = "Aucune catégorie disponible."; return; }
  const contributionRef = push(ref(db, `contributions/${eventId}`));
  await set(contributionRef, { id: contributionRef.key, uid, itemId:item.id, name: reg.name, label: $("contribLabel").value.trim(), quantity: item.isQuantityBased ? Number($("contribQty").value || 1) : 1, comment: $("contribComment").value.trim(), createdAt: Date.now() });
  $("contributionForm").reset(); $("contributionFeedback").textContent = "Merci, ton apport est enregistré.";
});

function escapeHtml(str){ return String(str).replace(/[&<>'"]/g, s => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;","\"":"&quot;"}[s])); }
