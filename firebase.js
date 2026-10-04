import { initializeApp, getApps, getApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { initializeFirestore, getFirestore, setLogLevel, terminate } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';

// Suppress transient internal gRPC stream reset warnings in Node.js
try {
  setLogLevel('error');
} catch (e) {}

// Credentials for Siaramaina clan informatics Firebase project
const firebaseConfig = {
  apiKey: typeof process !== 'undefined' && process.env?.VITE_FIREBASE_API_KEY ? process.env.VITE_FIREBASE_API_KEY : "AIzaSyCVqmSgm2sDGbgzbfMqfCJib6aWP7ivO54",
  authDomain: typeof process !== 'undefined' && process.env?.VITE_FIREBASE_AUTH_DOMAIN ? process.env.VITE_FIREBASE_AUTH_DOMAIN : "siaramaina-clan-informat-bf7f2.firebaseapp.com",
  projectId: typeof process !== 'undefined' && process.env?.VITE_FIREBASE_PROJECT_ID ? process.env.VITE_FIREBASE_PROJECT_ID : "siaramaina-clan-informat-bf7f2",
  storageBucket: typeof process !== 'undefined' && process.env?.VITE_FIREBASE_STORAGE_BUCKET ? process.env.VITE_FIREBASE_STORAGE_BUCKET : "siaramaina-clan-informat-bf7f2.firebasestorage.app",
  messagingSenderId: typeof process !== 'undefined' && process.env?.VITE_FIREBASE_MESSAGING_SENDER_ID ? process.env.VITE_FIREBASE_MESSAGING_SENDER_ID : "900054800353",
  appId: typeof process !== 'undefined' && process.env?.VITE_FIREBASE_APP_ID ? process.env.VITE_FIREBASE_APP_ID : "1:900054800353:web:99a37be72c837ae6e264a0",
  measurementId: typeof process !== 'undefined' && process.env?.VITE_FIREBASE_MEASUREMENT_ID ? process.env.VITE_FIREBASE_MEASUREMENT_ID : "G-JNSLYC8L87"
};

const databaseId = typeof process !== 'undefined' && process.env?.VITE_FIREBASE_FIRESTORE_DATABASE_ID ? process.env.VITE_FIREBASE_FIRESTORE_DATABASE_ID : "ai-studio-siaramainaclanin-460807ca-5792-43ae-aa12-303da9af9152";

// Initialize Firebase App
const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();

// Initialize Firestore targeting the dedicated clan database instance with resilient long polling
let dbInstance;
try {
  dbInstance = initializeFirestore(app, {
    experimentalForceLongPolling: true,
  }, databaseId);
} catch (e) {
  try {
    dbInstance = getFirestore(app, databaseId);
  } catch (e2) {
    dbInstance = getFirestore(app);
  }
}
const db = dbInstance;

async function terminateFirestore() {
  if (dbInstance) {
    try {
      await terminate(dbInstance);
    } catch (err) {}
  }
}

// Initialize Firebase Authentication
const auth = getAuth(app);

// Initialize Firebase Storage
const storage = getStorage(app);

// Export initialized instances
export { app, db, auth, storage, firebaseConfig, databaseId, terminateFirestore };
export default app;
