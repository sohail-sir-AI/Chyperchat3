import { initializeApp, getApps, getApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import { getAuth, signInWithPopup, GoogleAuthProvider, signOut } from 'firebase/auth';
import config from '../../firebase-applet-config.json';

const firebaseConfig = {
  apiKey: config.apiKey,
  authDomain: config.authDomain,
  projectId: config.projectId,
  storageBucket: config.storageBucket,
  messagingSenderId: config.messagingSenderId,
  appId: config.appId
};

// Initialize Firebase
const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();

// Initialize Firestore & Auth
export const db = getFirestore(app);
export const auth = getAuth(app);

// Export operation types
export enum OperationType {
  CREATE = 'CREATE',
  READ = 'READ',
  UPDATE = 'UPDATE',
  DELETE = 'DELETE',
  LIST = 'LIST'
}

// Error handler utility
export function handleFirestoreError(error: any, operation: OperationType, resource: string) {
  console.error(`Error during ${operation} on ${resource}:`, error);
  
  if (error.code === 'permission-denied') {
    console.error('Permission denied. Check Firestore security rules.');
  } else if (error.code === 'not-found') {
    console.error(`Resource not found: ${resource}`);
  } else if (error.code === 'already-exists') {
    console.error(`Resource already exists: ${resource}`);
  } else {
    console.error(`Firestore error: ${error.message}`);
  }
}

// Google Sign-In
export async function signInWithGoogle() {
  try {
    const provider = new GoogleAuthProvider();
    provider.addScope('profile');
    provider.addScope('email');
    
    const result = await signInWithPopup(auth, provider);
    return result.user;
  } catch (error) {
    console.error('Google sign-in failed:', error);
    throw error;
  }
}

// Sign Out
export async function logOut() {
  try {
    await signOut(auth);
  } catch (error) {
    console.error('Sign out failed:', error);
    throw error;
  }
}

export default app;
