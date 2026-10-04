import { initializeApp, getApps, getApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getStorage } from 'firebase/storage';
import fs from 'fs';
import path from 'path';

// Load configuration from firebase-applet-config.json or environment
let appletConfig = {};
try {
  if (typeof process !== 'undefined' && process.cwd) {
    const configPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
    if (fs.existsSync(configPath)) {
      appletConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
  }
} catch (e) {
  // Browser fallback
}

export const firebaseConfig = {
  apiKey: appletConfig.apiKey || "AIzaSyCVqmSgm2sDGbgzbfMqfCJib6aWP7ivO54",
  authDomain: appletConfig.authDomain || "siaramaina-clan-informat-bf7f2.firebaseapp.com",
  projectId: appletConfig.projectId || "siaramaina-clan-informat-bf7f2",
  storageBucket: appletConfig.storageBucket || "siaramaina-clan-informat-bf7f2.firebasestorage.app",
  messagingSenderId: appletConfig.messagingSenderId || "900054800353",
  appId: appletConfig.appId || "1:900054800353:web:acf8982723941309e264a0",
  measurementId: appletConfig.measurementId || ""
};

export const databaseId = appletConfig.firestoreDatabaseId || "ai-studio-siaramainaclanin-460807ca-5792-43ae-aa12-303da9af9152";

// Initialize Firebase App
export const app = getApps().length === 0 
  ? initializeApp(firebaseConfig) 
  : getApps()[0];

import { initializeFirestore, getFirestore, setLogLevel, terminate } from 'firebase/firestore';

// Suppress transient internal gRPC stream reset warnings in Node.js/browsers
try {
  setLogLevel('error');
} catch (e) {
  // Ignore if unsupported in environment
}

// Initialize Firestore targeting the dedicated clan database instance with resilient long polling
let firestoreInstance;
try {
  firestoreInstance = initializeFirestore(app, {
    experimentalForceLongPolling: true,
  }, databaseId);
} catch (e) {
  try {
    firestoreInstance = getFirestore(app, databaseId);
  } catch (e2) {
    firestoreInstance = getFirestore(app);
  }
}
export const db = firestoreInstance;

/**
 * Gracefully terminates the Firestore instance, closing active gRPC/WebChannel streams.
 */
export async function terminateFirestore() {
  if (firestoreInstance) {
    try {
      await terminate(firestoreInstance);
    } catch (err) {
      // Ignore termination error on process teardown
    }
  }
}

// Initialize Firebase Authentication
export const auth = getAuth(app);

// Initialize Firebase Storage
export const storage = getStorage(app);

export default app;
