import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyCfGBQxwN7uaxVk-kYZwFmQsFdu8bYzIRc",
  authDomain: "campus-connect-cbba5.firebaseapp.com",
  projectId: "campus-connect-cbba5",
  storageBucket: "campus-connect-cbba5.appspot.com", // ✅ FIXED
  messagingSenderId: "878310726789",
  appId: "1:878310726789:web:476ee57e7b9ad0f1cf1dec"
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);