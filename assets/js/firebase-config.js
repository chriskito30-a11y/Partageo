import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getDatabase,
  ref,
  set,
  update,
  onValue,
  get,
  remove,
  push,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js";

export const firebaseConfig = {
  apiKey: "AIzaSyBRXQ1tLE-zyYWgEwF_HM21EM-ToAIZ1QM",
  authDomain: "impro-ead69.firebaseapp.com",
  databaseURL: "https://impro-ead69-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "impro-ead69",
  storageBucket: "impro-ead69.firebasestorage.app",
  messagingSenderId: "574031727979",
  appId: "1:574031727979:web:1bff48266668f3a930902e"
};

export const FIREBASE_READY = true;

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

export {
  app,
  db,
  ref,
  set,
  update,
  onValue,
  get,
  remove,
  push,
  serverTimestamp
};
