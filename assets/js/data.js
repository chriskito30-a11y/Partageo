export const CATEGORY_NOTES = {
  "Chips / biscuits apéro / olives":"prévoir 3 à 4 paquets ou équivalent",
  "Charcuterie / fromage apéro":"plateau ou boîtes à partager",
  "Cakes salés / quiches / pizzas":"découpé si possible + contenant",
  "Salades froides":"salade de riz, pâtes, taboulé, pommes de terre… + couvert de service",
  "Plats salés faciles à partager":"wraps, feuilletés, mini-sandwichs…",
  "Desserts gâteaux / tartes":"découpé si possible",
  "Desserts individuels / fruits":"crêpes, muffins, fruits, bonbons…",
  "Sodas / jus / eau pétillante":"2 grandes bouteilles minimum par inscrit",
  "Eau plate":"pack d’eau ou grandes bouteilles",
  "Bières":"1 pack de 12 minimum par inscrit",
  "Vin / punch / apéritif":"1 à 2 bouteilles ou équivalent",
  "Pain":"3 baguettes minimum par inscrit",
  "Gobelets / assiettes / serviettes":"prévoir pour 20 à 25 personnes chacun",
  "Couverts":"prévoir pour tout le monde",
  "Glaçons / glacières":"glaçons ou glacière avec pains de glace",
  "Tables repas":"tables de 6 à 8 places",
  "Chaises":"indiquer le nombre de chaises apportées",
  "Tables buffet":"pour salé, desserts, boissons"
};

export const BASE_SCALE = {
  10: [1,1,2,1,1,1,1,1,1,1,1,1,1,1,1,2,10,1],
  20: [2,1,3,2,2,2,1,2,2,2,1,1,1,1,1,3,20,1],
  30: [3,2,4,3,2,3,2,4,2,3,2,2,1,1,1,4,30,2],
  40: [4,2,5,4,3,4,2,5,3,4,2,2,2,1,2,5,40,2],
  50: [5,3,6,5,4,5,3,6,3,5,3,3,2,1,2,7,55,3]
};

export const CATEGORIES = Object.keys(CATEGORY_NOTES);

export function generateItems(totalGuests){
  const guests = Math.max(1, Number(totalGuests || 1));
  let bucket = 10;
  if (guests > 10 && guests <= 20) bucket = 20;
  else if (guests > 20 && guests <= 30) bucket = 30;
  else if (guests > 30 && guests <= 40) bucket = 40;
  else if (guests > 40 && guests <= 50) bucket = 50;
  const factor = guests > 50 ? Math.ceil(guests / 50) : 1;
  return CATEGORIES.map((name, index) => ({
    id: slugify(name),
    name,
    needed: Math.max(1, BASE_SCALE[bucket][index] * factor),
    note: CATEGORY_NOTES[name],
    isQuantityBased: name === "Chaises"
  }));
}

export function slugify(value){
  return value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]+/g,"-").replace(/(^-|-$)/g,"").slice(0,60);
}

export function getPhase(event){
  const now = Date.now();
  if (!event) return "registration";
  if (event.manualPhase2 === true) return "contribution";
  if (event.registrationDeadline && now >= new Date(event.registrationDeadline).getTime()) return "contribution";
  return "registration";
}
