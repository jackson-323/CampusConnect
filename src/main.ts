declare global {
  interface Window {
    editHostel: (id: string) => void;
  }
}

import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  reload,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut,
  type User
} from "firebase/auth";
import {
  getFirestore,
  collection,
  addDoc,
  setDoc,
  doc,
  deleteDoc,
  updateDoc,
  serverTimestamp,
  query,
  orderBy,
  onSnapshot,
  getDoc,
  getDocs,
  where,
  type DocumentData,
  type DocumentSnapshot
} from "firebase/firestore";
import { auth } from "./firebase";
import { enabledUniversities, pilotUniversityId } from "./config/universities";
import { registerSW } from "virtual:pwa-register";
import "leaflet/dist/leaflet.css";
import hostelImg from "./assets/hostel.png";
import * as L from "leaflet";
import "./style.css";

type StudentRole = "student" | "moderator" | "admin";
type VerificationStatus = "unverified" | "pending" | "verified" | "rejected";

type StudentProfile = {
  uid: string;
  fullName: string;
  username: string;
  email: string;
  universityId: string;
  campusId: string | null;
  course: string;
  yearOfStudy: number | null;
  role: StudentRole;
  emailVerified: boolean;
  verificationStatus: VerificationStatus;
  createdAt: unknown;
  updatedAt: unknown;
  skills?: string;
  photoURL?: string;
  legacyDocumentId?: string;
};

type ProfileDocument = {
  id: string;
  data: DocumentData;
};

const MASENO = {
  lat: -0.003512557416272161,
  lng: 34.60378890590884
};
const ORS_API_KEY = import.meta.env.VITE_ORS_API_KEY;
const hostelIcon = L.icon({
  iconUrl: hostelImg,
  iconSize: [35, 35],
  iconAnchor: [17, 35],
  popupAnchor: [0, -30]
});
registerSW({ immediate: true });
type Hostel = {
  name?: string;
  lat: number;
  lng: number;
  rent?: number;
  water?: boolean;
  wifi?: boolean;
  distanceKm?: number;
  durationMin?: number;
};
const db = getFirestore();
const app = document.querySelector("#app") as HTMLElement;

let currentUser: User | null = null;
let currentProfile: StudentProfile | null = null;
let currentRole: StudentRole = "student";
let currentUsername: string | null = null;
let currentEmail: string | null = null;
let registrationInProgress = false;
let pendingRegistrationProfile: StudentProfile | null = null;
let authProfileError: string | null = null;

function isStudentRole(value: unknown): value is StudentRole {
  return value === "student" || value === "moderator" || value === "admin";
}

function normalizeRole(value: unknown): StudentRole {
  if (isStudentRole(value)) return value;
  return "student";
}

function normalizeVerificationStatus(value: unknown): VerificationStatus {
  if (
    value === "pending" ||
    value === "verified" ||
    value === "rejected" ||
    value === "unverified"
  ) {
    return value;
  }
  return "unverified";
}

function normalizeYearOfStudy(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 12) {
    return value;
  }
  if (typeof value === "string") {
    const match = value.match(/\d+/);
    if (match) {
      const year = Number(match[0]);
      return year >= 1 && year <= 12 ? year : null;
    }
  }
  return null;
}

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#39;"
    };
    return entities[character] ?? character;
  });
}

function createStudentProfile(
  user: User,
  data: Record<string, unknown>,
  legacyDocumentId?: string
): StudentProfile {
  const email = user.email ?? String(data.email ?? "");
  const legacyId =
    legacyDocumentId ??
    (typeof data.legacyDocumentId === "string" ? data.legacyDocumentId : undefined);
  const fullName = String(
    data.fullName ?? data.username ?? user.displayName ?? email.split("@")[0] ?? ""
  );
  const yearOfStudy = normalizeYearOfStudy(data.yearOfStudy ?? data.year);

  return {
    uid: user.uid,
    fullName,
    username: String(data.username ?? fullName),
    email,
    universityId: String(data.universityId ?? pilotUniversityId),
    campusId: typeof data.campusId === "string" ? data.campusId : null,
    course: String(data.course ?? ""),
    yearOfStudy,
    role: normalizeRole(data.role),
    emailVerified: user.emailVerified,
    verificationStatus: normalizeVerificationStatus(data.verificationStatus),
    createdAt: data.createdAt ?? serverTimestamp(),
    updatedAt: data.updatedAt ?? serverTimestamp(),
    ...(typeof data.skills === "string" ? { skills: data.skills } : {}),
    ...(typeof data.photoURL === "string" ? { photoURL: data.photoURL } : {}),
    ...(legacyId ? { legacyDocumentId: legacyId } : {})
  };
}

function profileToDocument(profile: StudentProfile): StudentProfile {
  return { ...profile };
}

async function loadStudentProfile(user: User): Promise<StudentProfile> {
  const profileRef = doc(db, "users", user.uid);
  let profileSnap: DocumentSnapshot<DocumentData> | null = null;
  let profileReadError: unknown;
  try {
    profileSnap = await getDoc(profileRef);
  } catch (error) {
    profileReadError = error;
    console.error("Could not read UID-keyed profile:", error);
  }

  if (profileSnap?.exists()) {
    return createStudentProfile(user, profileSnap.data());
  }

  const email = user.email ?? "";
  let legacySnap: DocumentSnapshot<DocumentData> | null = null;
  if (email) {
    legacySnap = await getDoc(doc(db, "users", email));
  }
  const legacyData = legacySnap?.exists() ? legacySnap.data() : {};
  if (!legacySnap?.exists() && profileReadError) throw profileReadError;
  const profile = createStudentProfile(
    user,
    legacyData,
    legacySnap?.exists() ? email : undefined
  );

  try {
    await setDoc(profileRef, {
      ...legacyData,
      ...profileToDocument(profile),
      updatedAt: serverTimestamp()
    }, { merge: true });
    return profile;
  } catch (error) {
    if (!legacySnap?.exists()) throw error;
    console.error("Could not create UID profile from legacy profile:", error);
    return profile;
  }
}

function clearAuthState() {
  currentUser = null;
  currentProfile = null;
  currentRole = "student";
  currentUsername = null;
  currentEmail = null;
  authProfileError = null;
}

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    clearAuthState();
    pendingRegistrationProfile = null;
    showHome();
    return;
  }

  if (pendingRegistrationProfile?.uid === user.uid) {
    showPendingRegistrationProfile();
    return;
  }
  if (registrationInProgress && !currentProfile) return;

  try {
    const profile = await loadStudentProfile(user);
    if (auth.currentUser?.uid !== user.uid) return;

    currentUser = user;
    currentProfile = profile;
    currentRole = profile.role;
    currentUsername = profile.username;
    currentEmail = user.email;
    authProfileError = null;
    showApp();
  } catch (error) {
    if (auth.currentUser?.uid !== user.uid) return;
    console.error("Could not load student profile:", error);
    currentUser = user;
    authProfileError = "Your account is signed in, but your student profile could not be loaded. Check your connection or Firestore access, then try again.";
    showProfileLoadError();
  }
});

function isAdmin() {
  return currentRole === "admin";
}

function uniqueUserDocuments<T extends { id: string; data: () => DocumentData }>(
  documents: T[]
): T[] {
  const unique = new Map<string, T>();
  for (const document of documents) {
    const data = document.data();
    const email = typeof data.email === "string" ? data.email.toLowerCase() : "";
    const key = email || (typeof data.uid === "string" ? data.uid : document.id);
    const existing = unique.get(key);
    if (!existing || (typeof data.uid === "string" && document.id === data.uid)) {
      unique.set(key, document);
    }
  }
  return [...unique.values()];
}

async function findUserProfileDocument(
  email: string,
  uid?: string
): Promise<ProfileDocument | null> {
  if (uid) {
    try {
      const uidSnap = await getDoc(doc(db, "users", uid));
      if (uidSnap.exists()) return { id: uidSnap.id, data: uidSnap.data() };
    } catch (error) {
      console.error("Could not read UID-keyed profile for chat contact:", error);
    }
  }

  const legacySnap = await getDoc(doc(db, "users", email));
  if (legacySnap.exists()) return { id: legacySnap.id, data: legacySnap.data() };

  const matchingProfiles = await getDocs(
    query(collection(db, "users"), where("email", "==", email))
  );
  const matchingProfile = matchingProfiles.docs.find((profile) => profile.id !== email);
  return matchingProfile
    ? { id: matchingProfile.id, data: matchingProfile.data() }
    : null;
}

function renderAccountStatus(feedback?: string, isError = false): void {
  const container = document.getElementById("accountStatus");
  if (!container) return;
  container.replaceChildren();

  const emailStatus = document.createElement("p");
  emailStatus.textContent = `Email verification: ${currentUser?.emailVerified ? "verified" : "not verified"}.`;
  container.appendChild(emailStatus);

  const universityStatus = document.createElement("p");
  universityStatus.textContent = `University student verification: ${currentProfile?.verificationStatus ?? "unverified"}. This is separate from email verification.`;
  container.appendChild(universityStatus);

  if (currentUser && !currentUser.emailVerified) {
    const actions = document.createElement("div");
    actions.className = "account-status-actions";
    actions.innerHTML = `
      <button id="resendVerificationBtn" type="button" class="auth-btn secondary">Resend verification email</button>
      <button id="refreshVerificationBtn" type="button" class="auth-btn secondary">I have verified my email</button>
    `;
    container.appendChild(actions);

    document.getElementById("resendVerificationBtn")?.addEventListener("click", async (event) => {
      const button = event.currentTarget as HTMLButtonElement;
      button.disabled = true;
      try {
        if (!currentUser) throw new Error("No signed-in user.");
        await sendEmailVerification(currentUser);
        renderAccountStatus("Verification email sent. Check your inbox and spam folder.");
      } catch (error) {
        console.error("Could not resend verification email:", error);
        renderAccountStatus(authErrorMessage(error), true);
      }
    });

    document.getElementById("refreshVerificationBtn")?.addEventListener("click", async (event) => {
      const button = event.currentTarget as HTMLButtonElement;
      button.disabled = true;
      try {
        if (!currentUser) throw new Error("No signed-in user.");
        await reload(currentUser);
        const refreshedUser = auth.currentUser;
        if (!refreshedUser) throw new Error("The signed-in session is no longer available.");
        currentUser = refreshedUser;

        if (!refreshedUser.emailVerified) {
          renderAccountStatus(
            "Firebase still reports this email as unverified. Open the link in your verification email, then try again.",
            true
          );
          return;
        }

        try {
          await setDoc(doc(db, "users", refreshedUser.uid), {
            emailVerified: true,
            updatedAt: serverTimestamp()
          }, { merge: true });
        } catch (error) {
          console.error("Could not sync verified email status to UID profile:", error);
          renderAccountStatus(
            "Firebase confirms your email is verified, but the canonical student profile could not be updated. The legacy profile was not changed.",
            true
          );
          return;
        }

        if (currentProfile) {
          currentProfile = { ...currentProfile, emailVerified: true };
        }

        const legacyDocumentId =
          currentProfile?.legacyDocumentId ?? refreshedUser.email;
        if (!legacyDocumentId || legacyDocumentId === refreshedUser.uid) {
          renderAccountStatus(
            "Email verified and the canonical UID profile was updated. No separate legacy profile could be identified."
          );
          return;
        }

        let legacyProfileExists: boolean;
        try {
          const legacySnap = await getDoc(doc(db, "users", legacyDocumentId));
          legacyProfileExists = legacySnap.exists();
        } catch (error) {
          console.error("Could not check for a legacy email profile:", error);
          renderAccountStatus(
            "Email verified and the canonical UID profile was updated, but the legacy profile could not be checked or synchronized.",
            true
          );
          return;
        }

        if (legacyProfileExists) {
          try {
            await setDoc(doc(db, "users", legacyDocumentId), {
              emailVerified: true,
              updatedAt: serverTimestamp()
            }, { merge: true });
          } catch (error) {
            console.error("Could not sync verified email status to legacy profile:", error);
            renderAccountStatus(
              "Email verified and the canonical UID profile was updated, but the existing legacy profile could not be synchronized.",
              true
            );
            return;
          }
          renderAccountStatus(
            "Email verified and synchronized to the canonical and legacy profiles. University student verification is separate."
          );
          return;
        }

        renderAccountStatus(
          "Email verified and the canonical UID profile was updated. No legacy email-keyed profile was found. University student verification is separate."
        );
      } catch (error) {
        console.error("Could not refresh email verification status:", error);
        renderAccountStatus(authErrorMessage(error), true);
      }
    });
  }

  if (feedback) {
    const message = document.createElement("p");
    message.className = isError ? "auth-feedback auth-feedback-error" : "auth-feedback auth-feedback-success";
    message.setAttribute("role", isError ? "alert" : "status");
    message.textContent = feedback;
    container.appendChild(message);
  }
}

function authErrorMessage(error: unknown): string {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "";

  const messages: Record<string, string> = {
    "auth/email-already-in-use": "An account already exists for this email. Try logging in instead.",
    "auth/invalid-email": "Enter a valid email address.",
    "auth/weak-password": "Choose a stronger password with at least 6 characters.",
    "auth/invalid-credential": "The email or password is incorrect.",
    "auth/user-disabled": "This account has been disabled. Contact support.",
    "auth/too-many-requests": "Too many attempts. Wait a little and try again.",
    "auth/network-request-failed": "Network error. Check your connection and try again.",
    "auth/missing-email": "Enter your email address first.",
    "auth/operation-not-allowed": "Email and password sign-in is not enabled for this Firebase project."
  };

  return messages[code] ?? "Something went wrong. Please try again.";
}

function setAuthFeedback(message: string, isError = true): void {
  const feedback = document.getElementById("authFeedback");
  if (!feedback) return;
  feedback.textContent = message;
  feedback.classList.toggle("auth-feedback-error", isError);
  feedback.classList.toggle("auth-feedback-success", !isError);
}

function setFormBusy(form: HTMLFormElement, busy: boolean, busyText: string): void {
  const button = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (!button) return;
  if (busy) {
    button.dataset.originalText = button.textContent ?? "";
    button.textContent = busyText;
  } else {
    button.textContent = button.dataset.originalText ?? button.textContent;
  }
  button.disabled = busy;
  form.setAttribute("aria-busy", String(busy));
}

function showProfileLoadError(): void {
  app.innerHTML = `
    <div class="auth-wrapper">
      <section class="auth-card" aria-labelledby="profileErrorTitle">
        <div class="auth-logo">🎓 Campus Connect</div>
        <h1 id="profileErrorTitle" class="auth-title">Profile unavailable</h1>
        <p id="authFeedback" class="auth-feedback auth-feedback-error" role="alert">${authProfileError ?? "Your student profile could not be loaded."}</p>
        <div class="auth-actions">
          <button id="retryProfileBtn" class="auth-btn primary full">Retry</button>
          <button id="profileErrorLogoutBtn" class="auth-btn secondary full">Log out</button>
        </div>
      </section>
    </div>
  `;

  document.getElementById("retryProfileBtn")?.addEventListener("click", async () => {
    const user = auth.currentUser;
    if (!user) return showHome();
    const button = document.getElementById("retryProfileBtn") as HTMLButtonElement;
    button.disabled = true;
    button.textContent = "Loading...";
    try {
      const profile = await loadStudentProfile(user);
      if (auth.currentUser?.uid !== user.uid) return;
      currentUser = user;
      currentProfile = profile;
      currentRole = profile.role;
      currentUsername = profile.username;
      currentEmail = user.email;
      authProfileError = null;
      showApp();
    } catch (error) {
      console.error("Could not load student profile:", error);
      authProfileError = "Your profile is still unavailable. Check your connection or Firestore access, then try again.";
      setAuthFeedback(authProfileError);
      button.disabled = false;
      button.textContent = "Retry";
    }
  });
  document.getElementById("profileErrorLogoutBtn")?.addEventListener("click", async () => {
    try {
      await signOut(auth);
    } catch (error) {
      console.error("Logout error:", error);
      setAuthFeedback(authErrorMessage(error));
    }
  });
}

function completeRegistration(user: User, profile: StudentProfile): void {
  currentUser = user;
  currentProfile = profile;
  currentRole = "student";
  currentUsername = profile.username;
  currentEmail = profile.email;
  authProfileError = null;
  pendingRegistrationProfile = null;
  showApp();

  void sendEmailVerification(user).then(
    () => renderAccountStatus("A verification email has been sent. Verify your email address; university student verification is separate."),
    (error: unknown) => {
      console.error("Could not send verification email:", error);
      renderAccountStatus(`Your account was created, but the verification email could not be sent. ${authErrorMessage(error)}`, true);
    }
  );
}

function showPendingRegistrationProfile(): void {
  app.innerHTML = `
    <div class="auth-wrapper">
      <section class="auth-card" aria-labelledby="profileSaveErrorTitle">
        <div class="auth-logo">🎓 Campus Connect</div>
        <h1 id="profileSaveErrorTitle" class="auth-title">Finish setting up your account</h1>
        <p id="authFeedback" class="auth-feedback auth-feedback-error" role="alert">Your Firebase account exists, but its student profile could not be saved.</p>
        <div class="auth-actions">
          <button id="retryRegistrationProfileBtn" class="auth-btn primary full" type="button">Retry profile setup</button>
          <button id="registrationProfileLogoutBtn" class="auth-btn secondary full" type="button">Log out</button>
        </div>
      </section>
    </div>
  `;

  document.getElementById("retryRegistrationProfileBtn")?.addEventListener("click", async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    const profile = pendingRegistrationProfile;
    const user = auth.currentUser;
    if (!profile || !user || user.uid !== profile.uid) return;

    button.disabled = true;
    button.textContent = "Saving...";
    try {
      await setDoc(doc(db, "users", user.uid), profileToDocument(profile));
      completeRegistration(user, profile);
    } catch (error) {
      console.error("Could not retry student profile setup:", error);
      setAuthFeedback(`Profile setup is still unavailable. ${authErrorMessage(error)}`);
      button.disabled = false;
      button.textContent = "Retry profile setup";
    }
  });
  document.getElementById("registrationProfileLogoutBtn")?.addEventListener("click", async () => {
    try {
      await signOut(auth);
    } catch (error) {
      console.error("Logout error:", error);
      setAuthFeedback(authErrorMessage(error));
    }
  });
}

/* ---------------- HOME ---------------- */
function showHome() {
  app.innerHTML = `
  <div class="auth-wrapper">

    <div class="auth-card">

      <div class="auth-logo">
        🎓 Campus Connect
      </div>

      <p class="auth-subtitle">
        Find hostels • Chat • Stay updated
      </p>

      <div class="auth-buttons">
        <button id="loginBtn" class="auth-btn primary">Login</button>
        <button id="registerBtn" class="auth-btn secondary">Create Account</button>
      </div>

    </div>

  </div>
  `;

  document.getElementById("loginBtn")?.addEventListener("click", showLogin);
  document.getElementById("registerBtn")?.addEventListener("click", showRegister);
}
/* ---------------- REGISTER ---------------- */
function showRegister() {
  app.innerHTML = `
  <div class="auth-wrapper">

    <section class="auth-card auth-card-wide" aria-labelledby="registerTitle">
      <div class="auth-logo">🎓 Campus Connect</div>
      <p class="auth-subtitle">Create your student account</p>
      <h1 id="registerTitle" class="auth-title">Join Campus Connect</h1>
      <form id="registerForm" class="auth-form">
        <label for="registerFullName">Full name</label>
        <input id="registerFullName" name="fullName" autocomplete="name" required maxlength="100" class="auth-input" />
        <label for="registerUsername">Username</label>
        <input id="registerUsername" name="username" autocomplete="username" required maxlength="30" pattern="[A-Za-z0-9._\\-]+" class="auth-input" />
        <label for="registerEmail">Email address</label>
        <input id="registerEmail" name="email" type="email" autocomplete="email" required class="auth-input" />
        <label for="registerUniversity">University</label>
        <select id="registerUniversity" name="universityId" required class="auth-input">
          ${enabledUniversities.map((university) => `<option value="${university.id}">${university.name}</option>`).join("")}
        </select>
        <label for="registerCourse">Course / programme</label>
        <input id="registerCourse" name="course" autocomplete="organization-title" required maxlength="120" class="auth-input" />
        <label for="registerYear">Year of study</label>
        <select id="registerYear" name="yearOfStudy" required class="auth-input">
          <option value="">Select year</option>
          ${Array.from({ length: 8 }, (_, index) => `<option value="${index + 1}">Year ${index + 1}</option>`).join("")}
        </select>
        <label for="registerPassword">Password</label>
        <input id="registerPassword" name="password" type="password" autocomplete="new-password" minlength="6" required class="auth-input" />
        <label for="registerPasswordConfirm">Confirm password</label>
        <input id="registerPasswordConfirm" name="passwordConfirm" type="password" autocomplete="new-password" minlength="6" required class="auth-input" />
        <p class="auth-helper">Email verification confirms your email address. University student verification is a separate process.</p>
        <p id="authFeedback" class="auth-feedback" role="status" aria-live="polite"></p>
        <button type="submit" class="auth-btn primary full">Create Account</button>
      </form>
      <p class="auth-switch">
        Already have an account?
        <button id="goLogin" class="auth-link" type="button">Log in</button>
      </p>
      <button id="backBtn" class="auth-back" type="button">← Back</button>
    </div>
  </div>
  `;

  document.getElementById("registerForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const formData = new FormData(form);
    const fullName = String(formData.get("fullName") ?? "").trim();
    const username = String(formData.get("username") ?? "").trim();
    const email = String(formData.get("email") ?? "").trim().toLowerCase();
    const universityId = String(formData.get("universityId") ?? "");
    const course = String(formData.get("course") ?? "").trim();
    const yearOfStudy = Number(formData.get("yearOfStudy"));
    const password = String(formData.get("password") ?? "");
    const passwordConfirm = String(formData.get("passwordConfirm") ?? "");

    if (!fullName) {
      setAuthFeedback("Full name cannot be empty.");
      return;
    }
    if (!username) {
      setAuthFeedback("Username cannot be empty.");
      return;
    }
    if (!course) {
      setAuthFeedback("Course or programme cannot be empty.");
      return;
    }
    if (password !== passwordConfirm) {
      setAuthFeedback("The passwords do not match.");
      return;
    }
    if (!enabledUniversities.some((university) => university.id === universityId)) {
      setAuthFeedback("Select an enabled university.");
      return;
    }
    if (!Number.isInteger(yearOfStudy) || yearOfStudy < 1 || yearOfStudy > 8) {
      setAuthFeedback("Select a valid year of study.");
      return;
    }

    setAuthFeedback("");
    setFormBusy(form, true, "Creating account...");
    registrationInProgress = true;
    let accountCreated = false;
    let createdProfile: StudentProfile | null = null;
    try {
      const credential = await createUserWithEmailAndPassword(auth, email, password);
      accountCreated = true;
      const now = serverTimestamp();
      const profile: StudentProfile = {
        uid: credential.user.uid,
        fullName,
        username,
        email: credential.user.email ?? email,
        universityId,
        campusId: null,
        course,
        yearOfStudy,
        role: "student",
        emailVerified: credential.user.emailVerified,
        verificationStatus: "unverified",
        createdAt: now,
        updatedAt: now
      };

      createdProfile = profile;
      pendingRegistrationProfile = profile;
      await setDoc(doc(db, "users", credential.user.uid), profileToDocument(profile));
      registrationInProgress = false;
      completeRegistration(credential.user, profile);
    } catch (error) {
      registrationInProgress = false;
      if (accountCreated) {
        console.error("Account created but student profile could not be saved:", error);
        authProfileError = "Your account was created, but its student profile could not be saved. Check Firestore access and retry.";
        if (createdProfile) {
          pendingRegistrationProfile = createdProfile;
          showPendingRegistrationProfile();
        } else {
          setAuthFeedback(authProfileError);
        }
      } else {
        setAuthFeedback(authErrorMessage(error));
      }
    } finally {
      setFormBusy(form, false, "");
    }
  });

  document.getElementById("goLogin")?.addEventListener("click", showLogin);
  document.getElementById("backBtn")?.addEventListener("click", showHome);
}
/* ---------------- LOGIN ---------------- */
function showLogin() {
  app.innerHTML = `
    <div class="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-white">
      
      <!-- Navbar -->
      <nav class="glass-card m-4 p-4 flex justify-between items-center">
        <div class="text-2xl font-bold gradient-text">CampusConnect</div>
        <div class="hidden md:flex gap-6">
          <a href="#" class="hover:text-emerald-400 transition">Home</a>
          <a href="#" class="hover:text-emerald-400 transition">Explore Hostels</a>
          <a href="#" class="hover:text-emerald-400 transition">Marketplace</a>
          <a href="#" class="hover:text-emerald-400 transition">Community</a>
          <a href="#" class="hover:text-emerald-400 transition">About Us</a>
        </div>
        <div class="flex gap-3">
          <button onclick="document.getElementById('loginForm').scrollIntoView({behavior:'smooth'})" 
            class="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 transition-all hover:scale-105 duration-300">
            Login
          </button>
          <button id="landingSignUp" 
            class="px-4 py-2 rounded-lg border-emerald-400 hover:bg-emerald-400/10 transition-all hover:scale-105 duration-300">
            Sign Up
          </button>
        </div>
      </nav>

      <!-- Hero -->
      <section class="max-w-6xl mx-auto px-4 py-20 text-center">
        <h1 class="text-5xl md:text-7xl font-extrabold mb-6 fade-in">
          CONNECT.<br>DISCOVER.<br>
          <span class="gradient-text text-emerald-400">LIVE CAMPUS.</span>
        </h1>
        <p class="text-xl text-slate-300 mb-10 max-w-2xl mx-auto fade-in">
          Your all-in-one student companion. Find hostels, chat with students, explore campus and stay updated.
        </p>
        
        <!-- Main Buttons -->
        <div class="flex flex-wrap justify-center gap-4 mb-20">
          <button onclick="document.getElementById('loginForm').scrollIntoView({behavior:'smooth'})" 
            class="px-8 py-4 rounded-xl bg-blue-600 hover:bg-blue-700 font-semibold text-lg shadow-lg shadow-blue-600/30 hover:scale-105 transition-all duration-300">
            Explore Hostels
          </button>
          <button onclick="document.getElementById('loginForm').scrollIntoView({behavior:'smooth'})" 
            class="px-8 py-4 rounded-xl bg-emerald-600 hover:bg-emerald-700 font-semibold text-lg shadow-lg shadow-emerald-600/30 hover:scale-105 transition-all duration-300">
            Join Community
          </button>
          <button onclick="document.getElementById('loginForm').scrollIntoView({behavior:'smooth'})" 
            class="px-8 py-4 rounded-xl glass-card border-white/20 hover:bg-white/10 font-semibold text-lg hover:scale-105 transition-all duration-300">
            Open Map
          </button>
        </div>

        <!-- Feature Cards -->
        <div class="grid grid-cols-1 md:grid-cols-4 gap-6 mb-20">
          <div class="glass-card p-6 rounded-2xl hover:scale-105 transition-all duration-300 group">
            <div class="text-4xl mb-4 group-hover:scale-110 transition">🏠</div>
            <h3 class="font-bold text-lg mb-2">Find Hostels</h3>
            <p class="text-slate-400 text-sm">Verified listings near campus</p>
          </div>
          <div class="glass-card p-6 rounded-2xl hover:scale-105 transition-all duration-300 group">
            <div class="text-4xl mb-4 group-hover:scale-110 transition">💬</div>
            <h3 class="font-bold text-lg mb-2">Chat & Connect</h3>
            <p class="text-slate-400 text-sm">Talk to fellow students</p>
          </div>
          <div class="glass-card p-6 rounded-2xl hover:scale-105 transition-all duration-300 group">
            <div class="text-4xl mb-4 group-hover:scale-110 transition">🛒</div>
            <h3 class="font-bold text-lg mb-2">Buy & Sell</h3>
            <p class="text-slate-400 text-sm">Student marketplace</p>
          </div>
          <div class="glass-card p-6 rounded-2xl hover:scale-105 transition-all duration-300 group">
            <div class="text-4xl mb-4 group-hover:scale-110 transition">📢</div>
            <h3 class="font-bold text-lg mb-2">Stay Updated</h3>
            <p class="text-slate-400 text-sm">Campus announcements</p>
          </div>
        </div>

        <!-- Login Form - Kept for functionality -->
        <div id="loginForm" class="max-w-md mx-auto glass-card p-8 rounded-2xl">
          <h2 class="text-2xl font-bold mb-6">Login to Continue</h2>
          <form id="loginFormElement" class="space-y-4">
            <input type="email" id="loginEmail" name="email" autocomplete="email" placeholder="Email address" required
              class="w-full p-3 rounded-lg bg-slate-800 border-slate-700 focus:border-blue-500 outline-none transition">
            <input type="password" id="loginPassword" name="password" autocomplete="current-password" placeholder="Password" required
              class="w-full p-3 rounded-lg bg-slate-800 border-slate-700 focus:border-blue-500 outline-none transition">
            <button type="submit" 
              class="w-full py-3 rounded-lg bg-blue-600 hover:bg-blue-700 font-semibold transition-all hover:scale-105 duration-300">
              Login
            </button>
          </form>
          <button id="forgotPasswordBtn" type="button" class="auth-link">Forgot password?</button>
          <p id="authFeedback" class="auth-feedback" role="status" aria-live="polite"></p>
          <p class="mt-4 text-sm text-slate-400">
            Don't have an account? <button id="landingSignUpBottom" type="button" class="auth-link">Sign Up</button>
          </p>
        </div>
      </section>
    </div>
  `;

  const signUp = () => showRegister();
  document.getElementById("landingSignUp")?.addEventListener("click", signUp);
  document.getElementById("landingSignUpBottom")?.addEventListener("click", signUp);
  document.getElementById("loginFormElement")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const email = (document.getElementById("loginEmail") as HTMLInputElement).value.trim().toLowerCase();
    const password = (document.getElementById("loginPassword") as HTMLInputElement).value;

    setAuthFeedback("");
    setFormBusy(form, true, "Signing in...");
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (error) {
      console.error("Login failed:", error);
      setAuthFeedback(authErrorMessage(error));
    } finally {
      setFormBusy(form, false, "");
    }
  });
  document.getElementById("forgotPasswordBtn")?.addEventListener("click", async () => {
    const email = (document.getElementById("loginEmail") as HTMLInputElement).value.trim();
    if (!email) {
      setAuthFeedback("Enter your email address above, then choose Forgot password.");
      return;
    }

    const button = document.getElementById("forgotPasswordBtn") as HTMLButtonElement;
    button.disabled = true;
    try {
      await sendPasswordResetEmail(auth, email);
      setAuthFeedback("If an account exists for that email, a password reset link has been sent.", false);
    } catch (error) {
      console.error("Password reset request failed:", error);
      setAuthFeedback(authErrorMessage(error));
    } finally {
      button.disabled = false;
    }
  });
}


/* ---------------- COUNT-UP + DASHBOARD HELPERS ---------------- */
function animateCountUp(el: HTMLElement, target: number, duration = 1200) {
  const start = performance.now();
  const tick = (now: number) => {
    const progress = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    el.textContent = Math.floor(target * eased).toLocaleString();
    if (progress < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

async function loadDashboardStats() {
  try {
    const [usersSnap, hostelsSnap, annSnap] = await Promise.all([
      getDocs(collection(db, "users")),
      getDocs(collection(db, "hostels")),
      getDocs(collection(db, "announcements")),
    ]);

    const userCount = uniqueUserDocuments(usersSnap.docs).length;
    const stats: Record<string, number> = {
      hostels: hostelsSnap.size,
      announcements: annSnap.size,
      active: userCount,
    };

    if (isAdmin()) {
      stats.users = userCount;
    }

    Object.entries(stats).forEach(([key, value]) => {
      const el = document.querySelector(`[data-stat="${key}"]`) as HTMLElement;
      if (el) animateCountUp(el, value);
    });
  } catch (err) {
    console.error("Stats load error:", err);
  }
}

function showAdminStudents() {
  if (!isAdmin()) {
    showProfile();
    return;
  }

  app.innerHTML = `
  <div class="min-h-screen bg-gradient-to-br from-gray-950 via-purple-950/30 to-gray-950 animate-royal-bg text-white/90 px-5 pt-5 pb-10">
    <div class="max-w-lg mx-auto">
      <div class="flex items-center gap-3 mb-6">
        <button id="backBtn" class="bg-white/5 backdrop-blur-xl border border-white/10 rounded-xl px-3 py-2 hover:border-purple-500/50 transition-all duration-300">⬅</button>
        <h1 class="text-xl font-bold bg-gradient-to-r from-purple-400 via-pink-400 to-rose-400 bg-clip-text text-transparent">Students</h1>
      </div>
      <div id="studentsList" class="flex flex-col gap-3"></div>
    </div>
  </div>
  `;

  document.getElementById("backBtn")?.addEventListener("click", showApp);

  onSnapshot(collection(db, "users"), (snapshot) => {
    const list = document.getElementById("studentsList");
    if (!list) return;
    list.innerHTML = "";

    uniqueUserDocuments(snapshot.docs).forEach((docSnap) => {
      const user = docSnap.data();
      const div = document.createElement("div");
      div.className =
        "bg-white/5 backdrop-blur-xl border border-white/10 rounded-2xl p-4 hover:bg-white/10 hover:border-purple-500/50 transition-all duration-300";
      div.innerHTML = `
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 rounded-full bg-gradient-to-r from-purple-600 via-pink-600 to-rose-600 flex items-center justify-center font-bold text-sm">
            ${(user.username || "?").charAt(0).toUpperCase()}
          </div>
          <div class="text-left">
            <p class="font-semibold">${user.username || "Unknown"}</p>
            <p class="text-xs text-white/50">${user.email || ""}</p>
            ${user.role === "admin" ? '<span class="inline-block mt-1 bg-gradient-to-r from-purple-600 to-rose-600 px-2 py-0.5 rounded-full text-[10px] font-bold">ADMIN</span>' : ""}
          </div>
        </div>
      `;
      list.appendChild(div);
    });
  });
}

function initBuzzFab() {
  const fab = document.getElementById("buzzFab");
  const menu = document.getElementById("buzzMenu");

  fab?.addEventListener("click", (e) => {
    e.stopPropagation();
    menu?.classList.toggle("hidden");
    menu?.classList.toggle("flex");
  });

  document.addEventListener("click", () => {
    menu?.classList.add("hidden");
    menu?.classList.remove("flex");
  });

  document.getElementById("buzzPost")?.addEventListener("click", () => {
    menu?.classList.add("hidden");
    menu?.classList.remove("flex");
    if (!isAdmin()) return alert("Only admins can post announcements");
    openAnnouncements();
  });

  document.getElementById("buzzHostel")?.addEventListener("click", () => {
    menu?.classList.add("hidden");
    menu?.classList.remove("flex");
    if (!isAdmin()) return alert("Only admins can add hostels");
    showMapScreen();
  });

  document.getElementById("buzzReport")?.addEventListener("click", () => {
    menu?.classList.add("hidden");
    menu?.classList.remove("flex");
    openReportModal();
  });
}

function openReportModal() {
  const existing = document.getElementById("reportModal");
  if (existing) existing.remove();

  const modal = document.createElement("div");
  modal.id = "reportModal";
  modal.className =
    "fixed inset-0 z-[200] bg-gray-950/70 backdrop-blur-sm flex items-center justify-center p-4";
  modal.innerHTML = `
    <div class="bg-white/5 backdrop-blur-xl border border-white/10 rounded-2xl p-6 w-full max-w-md text-white">
      <h3 class="text-lg font-bold mb-4 bg-gradient-to-r from-purple-400 via-pink-400 to-rose-400 bg-clip-text text-transparent">🚩 Submit Report</h3>
      <textarea id="reportText" placeholder="Describe the issue..." rows="4"
        class="w-full box-border p-3 rounded-xl border border-white/15 bg-white/5 text-white resize-y mb-4 font-[inherit]"></textarea>
      <div class="flex gap-3 justify-end">
        <button id="reportCancel"
          class="px-4 py-2 rounded-xl border border-white/15 bg-white/5 text-white cursor-pointer hover:border-purple-500/50 transition-all duration-300">Cancel</button>
        <button id="reportSubmit"
          class="px-4 py-2 rounded-xl bg-gradient-to-r from-purple-600 via-pink-600 to-rose-600 shadow-lg shadow-purple-500/40 shadow-rose-500/30 text-white font-semibold cursor-pointer hover:scale-105 transition-all duration-300">Submit</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  document.getElementById("reportCancel")?.addEventListener("click", () => modal.remove());
  document.getElementById("reportSubmit")?.addEventListener("click", () => {
    alert("Report submitted — thank you!");
    modal.remove();
  });
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.remove();
  });
}

function initBottomNav() {
  const nav = document.querySelector(".bottom-nav");
  if (!nav) return;
  const [home, chat, map, ann, profile] = nav.querySelectorAll("button");
  home?.addEventListener("click", showApp);
  chat?.addEventListener("click", openChatModule);
  map?.addEventListener("click", showMapScreen);
  ann?.addEventListener("click", openAnnouncements);
  profile?.addEventListener("click", showProfile);
}

function bindLogout() {
  document.getElementById("logout")?.addEventListener("click", async () => {
    try {
      await signOut(auth);
    } catch (error) {
      console.error("Logout error:", error);
      renderAccountStatus(authErrorMessage(error), true);
    }
  });
}

/* ---------------- MAIN APP — ROYAL ACADEMIC DASHBOARD ---------------- */
function showApp() {
  const admin = isAdmin();
  const cardClass =
    "bg-white/5 backdrop-blur-xl border border-white/10 rounded-2xl hover:bg-white/10 hover:scale-[1.02] hover:border-purple-500/50 transition-all duration-300";
  const textGrad =
    "bg-gradient-to-r from-purple-400 via-pink-400 to-rose-400 bg-clip-text text-transparent";
  const statNum =
    "text-3xl font-extrabold bg-gradient-to-r from-purple-400 via-pink-400 to-rose-400 bg-clip-text text-transparent drop-shadow-[0_0_10px_rgba(168,85,247,0.6)]";

  app.innerHTML = `
  <div class="min-h-screen relative overflow-hidden pb-28 px-5 pt-5 bg-gradient-to-br from-gray-950 via-purple-950/30 to-gray-950 animate-royal-bg text-white/85">

    <div class="fixed top-5 right-5 z-50 flex items-center gap-2 px-4 py-2 rounded-full bg-white/5 backdrop-blur-xl border border-white/10 text-[0.65rem] font-bold tracking-widest text-rose-400">
      <span class="relative flex h-2.5 w-2.5">
        <span class="absolute inline-flex h-full w-full rounded-full bg-rose-500 opacity-75 animate-ping"></span>
        <span class="relative inline-flex h-2.5 w-2.5 rounded-full bg-rose-500"></span>
      </span>
      ACTIVE PULSE
    </div>

    <div class="max-w-lg mx-auto relative z-10">

      <header class="text-center mb-4">
        <h1 class="text-3xl font-extrabold ${textGrad} drop-shadow-[0_0_20px_rgba(168,85,247,0.35)] m-0 mb-4">
          🎓 Campus Connect
        </h1>
      </header>

      <section id="accountStatus" class="account-status" aria-live="polite"></section>

      <!-- Gown cape hero -->
      <div class="w-full h-40 rounded-2xl mb-6 overflow-hidden relative bg-gradient-to-br from-purple-900 via-pink-900 to-rose-900">
        <svg class="absolute inset-0 w-full h-full animate-cape-wave" viewBox="0 0 400 160" fill="none" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <linearGradient id="gownGradient" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stop-color="#9333ea"/>
              <stop offset="50%" stop-color="#ec4899"/>
              <stop offset="100%" stop-color="#f43f5e"/>
            </linearGradient>
          </defs>
          <path d="M80 120 Q120 90 160 120 Q200 150 240 120 Q280 90 320 120 L340 160 L60 160 Z" fill="url(#gownGradient)" opacity="0.35"/>
          <path class="animate-pulse" d="M100 115 Q140 95 180 115 Q220 135 260 115 Q300 95 340 115" stroke="url(#gownGradient)" stroke-width="2" fill="none" opacity="0.6"/>
          <polygon points="190,55 210,55 205,40 195,40" fill="url(#gownGradient)"/>
          <rect x="185" y="55" width="30" height="8" rx="2" fill="url(#gownGradient)"/>
          <path d="M170 63 Q200 95 230 63 L220 120 Q200 140 180 120 Z" fill="url(#gownGradient)" opacity="0.85"/>
          <path d="M155 120 Q200 145 245 120 L250 160 L150 160 Z" fill="url(#gownGradient)" opacity="0.5"/>
        </svg>
        <p class="absolute bottom-3 left-0 right-0 text-center text-xs text-white/60 z-10">
          Maseno University GIS Edition
        </p>
      </div>

      <p class="text-center text-white/60 mb-8 m-0">
        Welcome, <strong class="text-white">${currentUsername}</strong>
        ${admin ? '<span class="inline-block ml-2 bg-gradient-to-r from-purple-600 to-rose-600 px-3 py-1 rounded-full text-xs font-bold text-white">ADMIN</span>' : ""}
      </p>

      <section class="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-10">
        ${
          admin
            ? `<button id="statPrimary" class="${cardClass} p-5 text-center cursor-pointer">
                <span class="block text-[0.65rem] uppercase tracking-wider text-white/45 mb-1">Students</span>
                <span class="block ${statNum}" data-stat="users">0</span>
              </button>`
            : `<button id="statPrimary" class="${cardClass} p-5 text-center cursor-pointer">
                <span class="block text-[0.65rem] uppercase tracking-wider text-white/45 mb-1">My Profile</span>
                <span class="block text-3xl">👤</span>
              </button>`
        }
        <div class="${cardClass} p-5 text-center cursor-default">
          <span class="block text-[0.65rem] uppercase tracking-wider text-white/45 mb-1">Hostels</span>
          <span class="block ${statNum}" data-stat="hostels">0</span>
        </div>
        <div class="${cardClass} p-5 text-center cursor-default">
          <span class="block text-[0.65rem] uppercase tracking-wider text-white/45 mb-1">Updates</span>
          <span class="block ${statNum}" data-stat="announcements">0</span>
        </div>
        <div class="${cardClass} p-5 text-center cursor-default">
          <span class="block text-[0.65rem] uppercase tracking-wider text-white/45 mb-1">Live Now</span>
          <span class="block ${statNum}" data-stat="active">0</span>
        </div>
      </section>

      <h2 class="text-xs font-bold tracking-[0.25em] ${textGrad} mb-4 pl-1">NAVIGATE CAMPUS</h2>
      <div class="grid grid-cols-2 sm:grid-cols-3 gap-4 mb-10">
        <button id="chatModule" class="${cardClass} flex flex-col items-center justify-center gap-2 p-7 cursor-pointer border-none text-inherit font-[inherit]">
          <span class="text-3xl">💬</span>
          <span class="text-sm font-semibold">Chat</span>
        </button>
        <button id="annModule" class="${cardClass} flex flex-col items-center justify-center gap-2 p-7 cursor-pointer border-none text-inherit font-[inherit]">
          <span class="text-3xl">📢</span>
          <span class="text-sm font-semibold">Announcements</span>
        </button>
        <button id="mapModule" class="${cardClass} flex flex-col items-center justify-center gap-2 p-7 cursor-pointer border-none text-inherit font-[inherit]">
          <span class="text-3xl">🗺️</span>
          <span class="text-sm font-semibold">Campus Map</span>
        </button>
      </div>

      <h2 class="text-xs font-bold tracking-[0.25em] ${textGrad} mb-4 pl-1">MANAGE DETAILS</h2>
      <div class="grid grid-cols-2 sm:grid-cols-3 gap-4 mb-10">
        <button class="${cardClass} flex flex-col items-center justify-center gap-2 p-7 cursor-pointer border-none text-inherit font-[inherit]">
          <span class="text-3xl">📊</span>
          <span class="text-sm font-semibold">GIS Data Hub</span>
        </button>
        <button id="profileModule" class="${cardClass} flex flex-col items-center justify-center gap-2 p-7 cursor-pointer border-none text-inherit font-[inherit]">
          <span class="text-3xl">👤</span>
          <span class="text-sm font-semibold">My Profile</span>
        </button>
        <button id="logout" class="${cardClass} flex flex-col items-center justify-center gap-2 p-7 cursor-pointer border-none font-[inherit] bg-gradient-to-r from-purple-600 via-pink-600 to-rose-600 shadow-lg shadow-purple-500/40 shadow-rose-500/30 text-white hover:scale-105">
          <span class="text-3xl">🚪</span>
          <span class="text-sm font-semibold">Logout</span>
        </button>
      </div>

    </div>

    <nav class="bottom-nav fixed bottom-4 left-1/2 -translate-x-1/2 w-[calc(100%-2rem)] max-w-md flex justify-around py-3 px-2 z-50 bg-white/5 backdrop-blur-xl border border-white/10 rounded-2xl">
      <button aria-label="Home" class="bg-transparent border-none text-2xl cursor-pointer p-2 rounded-xl hover:bg-white/10 hover:scale-110 transition-all duration-200 m-0">🏠</button>
      <button aria-label="Chat" class="bg-transparent border-none text-2xl cursor-pointer p-2 rounded-xl hover:bg-white/10 hover:scale-110 transition-all duration-200 m-0">💬</button>
      <button aria-label="Map" class="bg-transparent border-none text-2xl cursor-pointer p-2 rounded-xl hover:bg-white/10 hover:scale-110 transition-all duration-200 m-0">🗺️</button>
      <button aria-label="Announcements" class="bg-transparent border-none text-2xl cursor-pointer p-2 rounded-xl hover:bg-white/10 hover:scale-110 transition-all duration-200 m-0">📢</button>
      <button aria-label="Profile" class="bg-transparent border-none text-2xl cursor-pointer p-2 rounded-xl hover:bg-white/10 hover:scale-110 transition-all duration-200 m-0">👤</button>
    </nav>

    <div class="fixed bottom-24 right-5 z-50 flex flex-col items-end gap-3">
      <div id="buzzMenu" class="hidden flex-col gap-2">
        <button id="buzzPost" class="${cardClass} px-4 py-2.5 border-none cursor-pointer text-sm font-semibold text-white whitespace-nowrap font-[inherit]">📝 Post</button>
        <button id="buzzHostel" class="${cardClass} px-4 py-2.5 border-none cursor-pointer text-sm font-semibold text-white whitespace-nowrap font-[inherit]">🏠 Add Hostel</button>
        <button id="buzzReport" class="${cardClass} px-4 py-2.5 border-none cursor-pointer text-sm font-semibold text-white whitespace-nowrap font-[inherit]">🚩 Report</button>
      </div>
      <button id="buzzFab" class="px-5 py-3.5 border-none rounded-full cursor-pointer font-bold text-sm text-white bg-gradient-to-r from-purple-600 via-pink-600 to-rose-600 shadow-lg shadow-purple-500/40 shadow-rose-500/30 hover:scale-105 transition-all duration-300 animate-cape-wave m-0">
        ✨ Buzz Actions
      </button>
    </div>

  </div>
  `;

  bindLogout();
  document.getElementById("statPrimary")?.addEventListener("click", () => {
    if (isAdmin()) showAdminStudents();
    else showProfile();
  });
  document.getElementById("profileModule")?.addEventListener("click", showProfile);
  document.getElementById("chatModule")?.addEventListener("click", openChatModule);
  document.getElementById("mapModule")?.addEventListener("click", showMapScreen);
  document.getElementById("annModule")?.addEventListener("click", openAnnouncements);
  initBottomNav();
  initBuzzFab();
  renderAccountStatus(
    currentProfile?.legacyDocumentId
      ? "Your existing email-keyed profile is preserved. No legacy profile or chat data was deleted."
      : undefined
  );
  loadDashboardStats();
}


function openChatModule() {
  app.innerHTML = `
    <div class="wa-container">

      <div class="wa-sidebar">
        <div class="wa-header">
          👤 ${currentUsername}
        </div>

        <div id="usersList" class="wa-users"></div>

        <button id="backHome">⬅ Back</button>
      </div>

      <div class="wa-chat-area" id="chatArea">
        <div class="wa-empty">
          Select a user to start chatting
        </div>
      </div>

    </div>
  `;

  document.getElementById("backHome")?.addEventListener("click", showApp);
  loadUsers();
}
/* ---------------- USERS LIST ---------------- */
function loadUsers() {
  const usersRef = collection(db, "users");
  const usersList = document.getElementById("usersList");

  if (!usersList) return;

  onSnapshot(usersRef, (snapshot) => {
    usersList.innerHTML = "";

    uniqueUserDocuments(snapshot.docs).forEach((docSnap) => {
      const user = docSnap.data();

      if (
        typeof user.email !== "string" ||
        user.email === currentEmail ||
        user.uid === currentUser?.uid
      ) return;

      const div = document.createElement("div");
      div.className = "wa-user";

      div.innerHTML = `
        <div class="wa-avatar">
          ${(user.username || "?").charAt(0).toUpperCase()}
        </div>
        <div>${user.username || user.fullName || "Student"}</div>
      `;

      div.onclick = () => openChat(
        user.email,
        user.username || user.fullName || "Student",
        typeof user.uid === "string" ? user.uid : docSnap.id
      );

      usersList.appendChild(div);
    });
  });
}

/* ---------------- OPEN CHAT ---------------- */
function openChat(otherEmail: string, username: string, otherUid?: string) {

  const chatId = getChatId(currentEmail!, otherEmail);

  const chatArea = document.getElementById("chatArea")!;

  chatArea.innerHTML = `
    <div class="wa-chat">

      <div class="wa-chat-header">
        <button id="backBtn">←</button>

        <div>${username}</div>

        <button id="viewProfileBtn">👤</button>
      </div>

      <div id="messages" class="wa-messages"></div>

      <div class="wa-input">
        <input id="msgInput" placeholder="Type message..." />
        <button id="sendBtn">➤</button>
      </div>

    </div>
  `;

  document.getElementById("backBtn")?.addEventListener("click", showApp);

  document.getElementById("sendBtn")?.addEventListener("click", () => {
    sendMessage(chatId);
  });

  document.getElementById("viewProfileBtn")?.addEventListener("click", () => {
    viewUserProfile(otherEmail, otherUid);
  });

  loadMessages(chatId);
}
/* ---------------- CHAT ID ---------------- */
function getChatId(a: string, b: string) {
  return [a, b].sort().join("_");
}

/* ---------------- SEND MESSAGE ---------------- */
async function sendMessage(chatId: string) {
  const input = document.getElementById("msgInput") as HTMLInputElement;

  if (!input.value.trim() || !currentEmail) return;

  await addDoc(collection(db, "chats", chatId, "messages"), {
  text: input.value,
  sender: currentEmail,
  createdAt: serverTimestamp()
});
input.value = "";
input.placeholder = "Sending...";
setTimeout(() => {
  input.placeholder = "Type message...";
}, 300);
  input.value = "";
}
/* ---------------- LOAD MESSAGES ---------------- */
function loadMessages(chatId: string) {
  if (!currentEmail) return;

  const q = query(
    collection(db, "chats", chatId, "messages"),
    orderBy("createdAt")
  );

  onSnapshot(q, (snapshot) => {
    const messagesDiv = document.getElementById("messages");
    if (!messagesDiv) return;

    messagesDiv.innerHTML = "";

    let lastDate: string | null = null;

    snapshot.forEach((docSnap) => {
      const msg = docSnap.data();

      const isMe = msg.sender === currentEmail;

      const dateObj = msg.createdAt?.toDate?.();

      // FORMAT TIME
      const time = dateObj
        ? new Date(dateObj).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit"
          })
        : "";

      // FORMAT DATE (Today / Yesterday / Full date)
      let formattedDate = "";

      if (dateObj) {
        const today = new Date();
        const yesterday = new Date();
        yesterday.setDate(today.getDate() - 1);

        if (dateObj.toDateString() === today.toDateString()) {
          formattedDate = "Today";
        } else if (dateObj.toDateString() === yesterday.toDateString()) {
          formattedDate = "Yesterday";
        } else {
          formattedDate = dateObj.toDateString();
        }
      }

      // 👉 DATE SEPARATOR (THIS IS THE KEY PART)
      if (formattedDate && formattedDate !== lastDate) {
        const sep = document.createElement("div");

        sep.style.textAlign = "center";
        sep.style.margin = "10px 0";
        sep.style.fontSize = "12px";
        sep.style.opacity = "0.6";

        sep.textContent = formattedDate;

        messagesDiv.appendChild(sep);

        lastDate = formattedDate;
      }

      // MESSAGE BUBBLE
      const div = document.createElement("div");

      div.className = `wa-msg ${isMe ? "me" : "them"}`;

      div.innerHTML = `
        <div>${msg.text}</div>
        <div class="wa-time">${time}</div>
      `;

      messagesDiv.appendChild(div);
    });

    // auto scroll
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
  });
}

function openAnnouncements() {
  app.innerHTML = `
  <div class="ann-container">

    <div class="ann-header">
      📢 Announcements
      <button id="backBtn">⬅</button>
    </div>

    ${currentRole === "admin" ? `
<div class="ann-create">
  <input id="title" placeholder="Title" />
  <textarea id="message" placeholder="Message"></textarea>

  <select id="type">
    <option value="general">General</option>
    <option value="event">Event</option>
    <option value="urgent">Urgent</option>
  </select>

  <button id="postBtn">Post</button>
</div>
` : ""}
    <div id="annList" class="ann-list"></div>

  </div>
  `;

  document.getElementById("backBtn")?.addEventListener("click", showApp);

if (currentRole === "admin") {
   // show delete button
}
  if (currentRole === "admin") {
  document.getElementById("postBtn")
    ?.addEventListener("click", postAnnouncement);
}
  loadAnnouncements();
}

async function postAnnouncement() {
  const titleInput = document.getElementById("title") as HTMLInputElement;
  const messageInput = document.getElementById("message") as HTMLTextAreaElement;
  const typeInput = document.getElementById("type") as HTMLSelectElement;

  const title = titleInput.value.trim();
  const message = messageInput.value.trim();
  const type = typeInput.value;

  if (!title || !message) {
    alert("Fill all fields");
    return;
  }

  try {
    await addDoc(collection(db, "announcements"), {
      title,
      message,
      type,
      author: currentUsername || "Admin",
      createdAt: serverTimestamp(),
      pinned: false
    });

    titleInput.value = "";
    messageInput.value = "";

    alert("Announcement posted successfully");
  } catch (error) {
    console.error("Error posting announcement:", error);
    alert("Failed to post announcement");
  }
}
function loadAnnouncements() {
  const q = query(
    collection(db, "announcements"),
    orderBy("createdAt", "desc")
  );

  onSnapshot(q, (snapshot) => {
    const annList = document.getElementById("annList");
    if (!annList) return;

    annList.innerHTML = "";

    snapshot.forEach((docSnap) => {
      const ann = docSnap.data();

      const div = document.createElement("div");
      div.className = "ann-card";

      const time = ann.createdAt?.toDate
        ? new Date(ann.createdAt.toDate()).toLocaleString()
        : "";

      div.innerHTML = `
        <div class="ann-type ${ann.type}">
          ${(ann.type || "general").toUpperCase()}
        </div>

        <h3>${ann.title || ""}</h3>
        <p>${ann.message || ""}</p>

        <div class="ann-meta">
          👤 ${ann.author || "Unknown"} • 🕒 ${time}
        </div>

        ${
          currentRole === "admin"
            ? `
              <div class="ann-actions">
                <button class="pin-btn">
                  ${ann.pinned ? "📌 Unpin" : "📌 Pin"}
                </button>

                <button class="delete-btn">
                  🗑 Delete
                </button>
              </div>
            `
            : ""
        }
      `;

      annList.appendChild(div);

      const deleteBtn = div.querySelector(".delete-btn");
      const pinBtn = div.querySelector(".pin-btn");

      pinBtn?.addEventListener("click", async () => {
        await updateDoc(doc(db, "announcements", docSnap.id), {
          pinned: !ann.pinned
        });
      });

      deleteBtn?.addEventListener("click", async () => {
        if (!confirm("Delete this announcement?")) return;

        await deleteDoc(doc(db, "announcements", docSnap.id));
      });
    });
  });


}
function showMapScreen() {
  app.innerHTML = `
    <div class="map-container">
      <div id="map" style="height: 80vh; width: 100%;"></div>

      <div id="hostelForm" class="hostel-form" style="display:none;">
        <h3>Add Hostel</h3>

        <input id="hostelName" placeholder="Hostel name">
        <input id="hostelRent" type="number" placeholder="Rent">

        <label><input type="checkbox" id="waterCheck"> Water</label>
        <label><input type="checkbox" id="wifiCheck"> WiFi</label>

        <button id="saveHostelBtn">Save</button>
        <button id="cancelHostelBtn">Cancel</button>
      </div>
      <button id="backBtn" class="map-back-btn">⬅ Back to Dashboard</button>
    </div>
  `;

  document.getElementById("backBtn")?.addEventListener("click", showApp);
 setupHostelForm(); // ✅ ADD THIS
  setTimeout(() => initMap(), 100);
  
  document.getElementById("saveHostelBtn")?.addEventListener("click", async () => {
  const loc = (window as any).pendingHostelLocation;

  if (!loc) {
    alert("Click map first");
    return;
  }

  const name = (document.getElementById("hostelName") as HTMLInputElement).value;
  const rent = Number((document.getElementById("hostelRent") as HTMLInputElement).value);
  const water = (document.getElementById("waterCheck") as HTMLInputElement).checked;
  const wifi = (document.getElementById("wifiCheck") as HTMLInputElement).checked;

  if (!name) return alert("Enter name");

  const route = await getRouteDistance(
    MASENO.lat,
    MASENO.lng,
    loc.lat,
    loc.lng
  );

  await addDoc(collection(db, "hostels"), {
    name,
    rent,
    water,
    wifi,
    lat: loc.lat,
    lng: loc.lng,
    distanceKm: route.distanceKm,
    durationMin: route.durationMin
  });

  (document.getElementById("hostelForm") as HTMLElement).style.display = "none";

  console.log("HOSTEL ADDED");
});
document.getElementById("cancelHostelBtn")?.addEventListener("click", () => {
  (document.getElementById("hostelForm") as HTMLElement).style.display = "none";
});
}

/* ========= EDIT ========= */

(window as any).editHostel = async (id: string) => {
  const snap = await getDoc(doc(db, "hostels", id));
  if (!snap.exists()) return;

  const data = snap.data();

  const form = document.getElementById("hostelForm") as HTMLElement;

  const nameInput = document.getElementById("hostelName") as HTMLInputElement;
  const rentInput = document.getElementById("hostelRent") as HTMLInputElement;
  const waterCheck = document.getElementById("waterCheck") as HTMLInputElement;
  const wifiCheck = document.getElementById("wifiCheck") as HTMLInputElement;

  // fill form with existing data
  nameInput.value = data.name || "";
  rentInput.value = data.rent || "";
  waterCheck.checked = data.water || false;
  wifiCheck.checked = data.wifi || false;

  form.style.display = "block";

  // store edit state
  (window as any).editMode = true;
  (window as any).editId = id;
};
/* ========= DELETE ========= */

(window as any).deleteHostel = async (id: string) => {

  if (!confirm("Delete this hostel?")) return;

  await deleteDoc(doc(db, "hostels", id));

  alert("Hostel deleted");
};
async function getRouteDistance(
  startLat: number,
  startLng: number,
  endLat: number,
  endLng: number
) {
  try {
    if (!ORS_API_KEY) {
      throw new Error("VITE_ORS_API_KEY is not configured.");
    }

    const response = await fetch(
      "https://api.openrouteservice.org/v2/directions/foot-walking",
      {
        method: "POST",
        headers: {
          Authorization: ORS_API_KEY,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          coordinates: [
            [startLng, startLat],
            [endLng, endLat]
          ]
        })
      }
    );

    if (!response.ok) {
      throw new Error(`OpenRouteService returned HTTP ${response.status}.`);
    }

    const data = await response.json();
    const summary = data.routes?.[0]?.summary;
    if (
      typeof summary?.distance !== "number" ||
      typeof summary?.duration !== "number"
    ) {
      throw new Error("OpenRouteService response did not contain route details.");
    }

    return {
      distanceKm: summary.distance / 1000,
      durationMin: summary.duration / 60
    };

  } catch (error) {
    console.error("Could not calculate hostel walking route:", error);
    return {
      distanceKm: null,
      durationMin: null
    };
  }
}

async function initMap() {

  const oldMap = document.getElementById("map");
  if (!oldMap) return;

  const map = L.map("map").setView([-0.00368, 34.6089], 14);

  const osm = L.tileLayer(
    "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    {
      attribution: "© OpenStreetMap"
    }
  );

  const satellite = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    {
      attribution: "© Esri"
    }
  );

  osm.addTo(map);

  L.control.layers({
    Street: osm,
    Satellite: satellite
  }).addTo(map);

  L.circle([-0.00368, 34.6089], {
    radius: 8000,
    color: "blue",
    fillOpacity: 0.05
  }).addTo(map);
 L.marker([-0.003512557416272161, 34.60378890590884]).addTo(map)
  .bindPopup("Siriba Gate");

  loadHostels(map);

map.on("click", (e: any) => {
  if (!isAdmin()) {
    alert("Only admin can add hostels");
    return;
  }

  (window as any).pendingHostelLocation = e.latlng;

  const form = document.getElementById("hostelForm") as HTMLElement;
  form.style.display = "block";

  // reset edit mode
  (window as any).editMode = false;
  (window as any).editId = null;
});
}

function loadHostels(map: L.Map) {

  onSnapshot(collection(db, "hostels"), (snapshot) => {

    snapshot.forEach((docSnap) => {

      const h = docSnap.data() as Hostel;
      const id = docSnap.id;

      if (!h.lat || !h.lng) return;

      const marker = L.marker(
  [h.lat, h.lng],
  { icon: hostelIcon }
).addTo(map);

      marker.bindPopup(`
  <b>${h.name || "Unknown Hostel"}</b><br><br>

  💰 Rent: ${h.rent ?? "N/A"}<br>
  🚰 Water: ${h.water ? "Available" : "Not available"}<br>
  📶 WiFi: ${h.wifi ? "Available" : "Not available"}<br>

  📍 Distance: ${h.distanceKm ? h.distanceKm.toFixed(2) + " km" : "N/A"}<br>
  ⏱ Time: ${h.durationMin ? Math.round(h.durationMin) + " min walk" : "N/A"}<br><br>

  <button id="edit-${id}">✏ Edit</button>
  <button id="del-${id}">🗑 Delete</button>
`);
marker.on("popupopen", () => {
  
  const delBtn = document.getElementById(`del-${id}`);
const editBtn = document.getElementById(`edit-${id}`);

editBtn?.addEventListener("click", () => {
  console.log("edit clicked");
});
  

  delBtn?.addEventListener("click", async () => {
  if (!isAdmin()) {
    alert("Only admin can delete hostels");
    return;
  }

  if (!confirm("Delete hostel?")) return;

  await deleteDoc(doc(db, "hostels", id));
});
document.getElementById("saveHostelBtn")?.addEventListener("click", async () => {
  const loc = (window as any).pendingHostelLocation;

  const name = (document.getElementById("hostelName") as HTMLInputElement).value;
  const rent = Number((document.getElementById("hostelRent") as HTMLInputElement).value);
  const water = (document.getElementById("waterCheck") as HTMLInputElement).checked;
  const wifi = (document.getElementById("wifiCheck") as HTMLInputElement).checked;

  const isEdit = (window as any).editMode;
  const editId = (window as any).editId;

  if (isEdit && editId) {
    // EDIT MODE
    await updateDoc(doc(db, "hostels", editId), {
      name,
      rent,
      water,
      wifi
    });

    (window as any).editMode = false;
    (window as any).editId = null;

    alert("Hostel updated!");
  } else {
    // CREATE MODE (your existing logic stays untouched)
    const route = await getRouteDistance(
      MASENO.lat,
      MASENO.lng,
      loc.lat,
      loc.lng
    );

    await addDoc(collection(db, "hostels"), {
      name,
      rent,
      water,
      wifi,
      lat: loc.lat,
      lng: loc.lng,
      distanceKm: route.distanceKm,
      durationMin: route.durationMin
    });

    alert("Hostel added!");
  }

  (document.getElementById("hostelForm") as HTMLElement).style.display = "none";
});
});
    });

  });

}
function setupHostelForm() {
  const saveBtn = document.getElementById("saveHostelBtn");

  saveBtn?.addEventListener("click", async () => {
    const loc = (window as any).pendingHostelLocation;

    if (!loc) {
      alert("Click map first");
      return;
    }

    const name = (document.getElementById("hostelName") as HTMLInputElement).value;
    const rent = Number((document.getElementById("hostelRent") as HTMLInputElement).value);
    const water = (document.getElementById("waterCheck") as HTMLInputElement).checked;
    const wifi = (document.getElementById("wifiCheck") as HTMLInputElement).checked;

    if (!name) return alert("Enter name");

    const isEdit = (window as any).editMode;
    const editId = (window as any).editId;

    if (isEdit && editId) {
      await updateDoc(doc(db, "hostels", editId), {
        name,
        rent,
        water,
        wifi
      });

      (window as any).editMode = false;
      (window as any).editId = null;

      alert("Updated");
    } else {
      const route = await getRouteDistance(
        MASENO.lat,
        MASENO.lng,
        loc.lat,
        loc.lng
      );

      await addDoc(collection(db, "hostels"), {
        name,
        rent,
        water,
        wifi,
        lat: loc.lat,
        lng: loc.lng,
        distanceKm: route.distanceKm,
        durationMin: route.durationMin
      });

      alert("Added");
    }

    (document.getElementById("hostelForm") as HTMLElement).style.display = "none";
  });

  document.getElementById("cancelHostelBtn")?.addEventListener("click", () => {
    (document.getElementById("hostelForm") as HTMLElement).style.display = "none";
  });
}
function showProfile() {
  app.innerHTML = `
    <div class="profile-page">

      <div class="profile-header">
        <button id="backBtn">⬅</button>
        <h2>My Profile</h2>
      </div>

      <div class="profile-card">
        <img
          id="profileImage"
          src="https://via.placeholder.com/120"
          class="profile-pic"
        >

        <input type="file" id="photoInput">

        <input id="course" placeholder="Course">
        
        <select id="year">
          <option value="">Select Year</option>
          ${Array.from({ length: 8 }, (_, index) => `<option value="${index + 1}">Year ${index + 1}</option>`).join("")}
        </select>

        <textarea
          id="skills"
          placeholder="Skills e.g GIS, Coding, Design">
        </textarea>

        <button id="saveProfile">
          Save Profile
        </button>
        <p id="profileFeedback" role="status" aria-live="polite"></p>

      </div>
    </div>
  `;

  document.getElementById("saveProfile")?.addEventListener("click", async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    const feedback = document.getElementById("profileFeedback");
    const course = (document.getElementById("course") as HTMLInputElement).value.trim();
    const yearOfStudyValue = (document.getElementById("year") as HTMLSelectElement).value;
    const yearOfStudy = yearOfStudyValue ? Number(yearOfStudyValue) : null;
    const skills = (document.getElementById("skills") as HTMLTextAreaElement).value.trim();
    const file = (document.getElementById("photoInput") as HTMLInputElement).files?.[0];

    if (file && (!file.type.startsWith("image/") || file.size > 2 * 1024 * 1024)) {
      if (feedback) feedback.textContent = "Choose an image smaller than 2 MB.";
      return;
    }

    button.disabled = true;
    button.textContent = "Saving...";
    try {
      let photoURL = currentProfile?.photoURL ?? "";
      if (file) {
        photoURL = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            if (typeof reader.result === "string") resolve(reader.result);
            else reject(new Error("The selected image could not be read."));
          };
          reader.onerror = () => reject(reader.error ?? new Error("The selected image could not be read."));
          reader.readAsDataURL(file);
        });
      }

      await saveStudentProfileChanges({
        course,
        yearOfStudy,
        skills,
        photoURL,
        year: yearOfStudy ? `Year ${yearOfStudy}` : ""
      });
      if (feedback) {
        feedback.textContent = "Profile saved.";
        feedback.className = "auth-feedback auth-feedback-success";
      }
    } catch (error) {
      console.error("Could not save student profile:", error);
      if (feedback) {
        feedback.textContent = `Profile could not be saved. ${authErrorMessage(error)}`;
        feedback.className = "auth-feedback auth-feedback-error";
      }
    } finally {
      button.disabled = false;
      button.textContent = "Save Profile";
    }
  });

  document.getElementById("backBtn")
    ?.addEventListener("click", showApp);

  loadProfile();
}

async function saveStudentProfileChanges(
  changes: Partial<StudentProfile> & { year?: string }
): Promise<void> {
  if (!currentUser || !currentProfile) throw new Error("No student profile is loaded.");

  const profileChanges = { ...changes };
  delete profileChanges.legacyDocumentId;
  const updatedAt = serverTimestamp();
  const updateData: Record<string, unknown> = {
    ...profileChanges,
    uid: currentUser.uid,
    email: currentUser.email ?? currentProfile.email,
    updatedAt
  };

  try {
    await setDoc(doc(db, "users", currentUser.uid), updateData, { merge: true });
  } catch (error) {
    if (!currentProfile.legacyDocumentId) throw error;
    console.error("Could not save UID profile; falling back to legacy profile:", error);
    await setDoc(
      doc(db, "users", currentProfile.legacyDocumentId),
      updateData,
      { merge: true }
    );
    currentProfile = {
      ...currentProfile,
      ...profileChanges,
      updatedAt
    };
    return;
  }

  if (currentProfile.legacyDocumentId) {
    await setDoc(doc(db, "users", currentProfile.legacyDocumentId), updateData, { merge: true });
  }

  currentProfile = {
    ...currentProfile,
    ...profileChanges,
    updatedAt
  };
}

async function loadProfile() {
  if (!currentProfile) return;
  (document.getElementById("course") as HTMLInputElement).value = currentProfile.course;
  (document.getElementById("skills") as HTMLTextAreaElement).value = currentProfile.skills ?? "";
  (document.getElementById("year") as HTMLSelectElement).value =
    currentProfile.yearOfStudy?.toString() ?? "";

  if (currentProfile.photoURL) {
    const profileImage = document.getElementById("profileImage") as HTMLImageElement;
    profileImage.src = currentProfile.photoURL;
  }
}
async function viewUserProfile(email: string, uid?: string) {
  const profileDocument = await findUserProfileDocument(email, uid);
  if (!profileDocument) return;
  const user = profileDocument.data;

  app.innerHTML = `
    <div class="profile-page">

      <button id="backBtn">⬅ Back</button>

      <div class="profile-card">

        <img
          src="${escapeHtml(user.photoURL || 'https://via.placeholder.com/120')}"
          class="profile-pic"
        >

        <h2>${escapeHtml(user.username || user.fullName || "Student")}</h2>

        <p><b>Course:</b> ${escapeHtml(user.course || "Not set")}</p>

        <p><b>Year:</b> ${escapeHtml(user.yearOfStudy ?? user.year ?? "Not set")}</p>

        <p><b>Skills:</b> ${escapeHtml(user.skills || "Not set")}</p>

      </div>

    </div>
  `;

  document.getElementById("backBtn")
    ?.addEventListener("click", openChatModule);
}
