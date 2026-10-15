// Import the functions you need from the SDKs you need
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

// TODO: Replace with your actual Firebase configuration object
export const firebaseConfig = {
  apiKey: "AIzaSyAP1gHokXnMtJbdJbbF6ldXYl2XVtkRijY",
  authDomain: "jt-water-refilling.firebaseapp.com",
  projectId: "jt-water-refilling",
  storageBucket: "jt-water-refilling.firebasestorage.app",
  messagingSenderId: "150599072120",
  appId: "1:150599072120:web:2a4b069a73af0e95ea708d"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);