import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { app, db, ref, onValue, set, push } from "./firebase-config.js";
import { getPhase } from "./data.js";

const auth = getAuth(app);
const eventId = new URLSearchParams(location.search).get("event");
let uid = null, eventData = null, registrations = {}, items = {}, contributions = {};
let activeRegistrationKey = null;

const $ = (id) => document.getElementById(id);
const fmt = (d) => d ? new Date(d).toLocaleString("fr-FR", {dateStyle:"medium", timeStyle:"short"}) : "—";
const storageKey = () => `partageo:${eventId}:registration`;

signInAnonymously(auth).catch(console.error);
onAuthStateChanged(auth, user => {
  uid = user?.uid || null;
  if(eventId && uid){
    restoreLocalRegistration();
    subscribe();
  }
});
if(!eventId){ $("loadingCard").classList.add("hidden"); $("noEventCard").classList.remove("hidden"); }

function subscribe(){
  onValue(ref(db, `events/${eventId}`), snap => { eventData = snap.val(); render(); });
  onValue(ref(db, `registrations/${eventId}`), snap => { registrations = snap.val() || {}; ensureActiveRegistration(); render(); });
  onValue(ref(db, `contributionItems/${eventId}`), snap => { items = snap.val() || {}; render(); });
  onValue(ref(db, `contributions/${eventId}`), snap => { contributions = snap.val() || {}; render(); });
}

function restoreLocalRegistration(){
  try{
    const saved = JSON.parse(localStorage.getItem(storageKey()) || "null");
    if(saved?.registrationKey) activeRegistrationKey = saved.registrationKey;
  }catch(_){ /* localStorage unavailable */ }
}
function saveLocalRegistration(registrationKey, accessCode){
  activeRegistrationKey = registrationKey;
  try{ localStorage.setItem(storageKey(), JSON.stringify({ registrationKey, accessCode })); }catch(_){ /* ignore */ }
}
function ensureActiveRegistration(){
  if(activeRegistrationKey && registrations[activeRegistrationKey]) return;
  if(uid && registrations[uid]) activeRegistrationKey = uid;
}
function currentRegistration(){ return activeRegistrationKey ? registrations[activeRegistrationKey] : null; }
function totalGuests(){ return Object.values(registrations).reduce((sum,r)=>sum + Number(r.guests || 0),0); }
function takenFor(item){
  return Object.values(contributions).filter(c => c.itemId === item.id).reduce((sum,c)=> sum + (item.isQuantityBased ? Number(c.quantity || 1) : 1), 0);
}
function makeCode(){ return String(Math.floor(1000 + Math.random() * 9000)); }
function normalizeName(str){ return String(str || "").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }

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
  if(reg){
    $("regName").value = reg.name || "";
    $("regGuests").value = reg.guests || 1;
    $("regComment").value = reg.comment || "";
    $("activeIdentity").classList.remove("hidden");
    $("activeIdentity").textContent = `Inscription active : ${reg.name}. Code personnel : ${reg.accessCode || "déjà créé"}.`;
  }else{
    $("activeIdentity").classList.add("hidden");
  }
  renderItemSelect(); renderTable();
}

function getSelectedContributionItemIds(){
  return Array.from(document.querySelectorAll("#contribItemsList input[type='checkbox']:checked")).map(input => input.value);
}

function updateQuantityVisibility(){
  const selectedIds = new Set(getSelectedContributionItemIds());
  const needsQuantity = Object.values(items).some(item => selectedIds.has(item.id) && item.isQuantityBased);
  $("quantityWrap").classList.toggle("hidden", !needsQuantity);
}

function renderItemSelect(){
  const list = $("contribItemsList");
  const previouslySelected = new Set(getSelectedContributionItemIds());
  list.innerHTML = "";

  const availableItems = Object.values(items).filter(item => Number(item.needed || 0) - takenFor(item) > 0);
  availableItems.forEach(item => {
    const remaining = Number(item.needed || 0) - takenFor(item);
    const option = document.createElement("label");
    option.className = "choice-card";
    option.innerHTML = `
      <input type="checkbox" value="${escapeHtml(item.id)}" ${previouslySelected.has(item.id) ? "checked" : ""} />
      <span>
        <strong>${escapeHtml(item.name)}</strong>
        <small>${remaining} restant(s)${item.isQuantityBased ? " · quantité possible" : ""}</small>
      </span>`;
    list.appendChild(option);
  });

  if(!availableItems.length){
    const empty = document.createElement("p");
    empty.className = "muted choice-empty";
    empty.textContent = "Aucune catégorie disponible";
    list.appendChild(empty);
  }
  updateQuantityVisibility();
}
$("contribItemsList").addEventListener("change", updateQuantityVisibility);

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
  const name = $("regName").value.trim();
  const existing = currentRegistration();
  const registrationKey = activeRegistrationKey || uid;
  const accessCode = existing?.accessCode || makeCode();
  const guests = Number($("regGuests").value);
  const participantLimit = Number(eventData?.participantsLimit ?? eventData?.limits?.participantsPerEvent ?? 30);
  const previousGuests = Number(existing?.guests || 0);
  const projectedGuests = totalGuests() - previousGuests + guests;
  if (participantLimit > 0 && projectedGuests > participantLimit) {
    $("registrationFeedback").textContent = `Limite incluse atteinte : ${participantLimit} participant(s) maximum pour cet événement.`;
    return;
  }
  const payload = {
    uid: registrationKey,
    ownerAuthUid: uid,
    name,
    nameKey: normalizeName(name),
    accessCode,
    guests,
    comment: $("regComment").value.trim(),
    updatedAt: Date.now(),
    createdAt: existing?.createdAt || Date.now()
  };
  await set(ref(db, `registrations/${eventId}/${registrationKey}`), payload);
  saveLocalRegistration(registrationKey, accessCode);
  $("registrationFeedback").innerHTML = `Participation enregistrée. <strong>Ton code personnel : ${escapeHtml(accessCode)}</strong>. Garde-le pour revenir modifier ton inscription ou indiquer ce que tu apportes.`;
});

$("recoverForm").addEventListener("submit", e => {
  e.preventDefault();
  const nameKey = normalizeName($("recoverName").value);
  const code = $("recoverCode").value.trim();
  const found = Object.entries(registrations).find(([_, r]) => r.nameKey === nameKey && String(r.accessCode || "") === code);
  if(!found){
    $("recoverFeedback").textContent = "Aucune inscription trouvée avec ce nom et ce code.";
    return;
  }
  saveLocalRegistration(found[0], code);
  $("recoverFeedback").textContent = "Inscription retrouvée. Tu peux maintenant la modifier ou indiquer ce que tu apportes.";
  render();
});

$("contributionForm").addEventListener("submit", async e => {
  e.preventDefault(); if(!uid) return;
  const selectedItemIds = getSelectedContributionItemIds();
  const selectedItems = selectedItemIds.map(id => Object.values(items).find(item => item.id === id)).filter(Boolean);
  const reg = currentRegistration();
  if(!reg){ $("contributionFeedback").textContent = "Inscris-toi d’abord ou retrouve ton inscription avec ton code personnel."; return; }
  if(!selectedItems.length){ $("contributionFeedback").textContent = "Choisis au moins une catégorie à apporter."; return; }

  const label = $("contribLabel").value.trim();
  const comment = $("contribComment").value.trim();
  const quantity = Number($("contribQty").value || 1);
  await Promise.all(selectedItems.map(item => {
    const contributionRef = push(ref(db, `contributions/${eventId}`));
    return set(contributionRef, {
      id: contributionRef.key,
      uid,
      registrationUid: activeRegistrationKey,
      itemId:item.id,
      name: reg.name,
      label,
      quantity: item.isQuantityBased ? quantity : 1,
      comment,
      createdAt: Date.now()
    });
  }));
  $("contributionForm").reset();
  updateQuantityVisibility();
  $("contributionFeedback").textContent = selectedItems.length > 1 ? "Merci, tes apports sont enregistrés." : "Merci, ton apport est enregistré.";
});

function escapeHtml(str){ return String(str).replace(/[&<>'"]/g, s => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;","\"":"&quot;"}[s])); }
