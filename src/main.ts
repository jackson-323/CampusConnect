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
  documentId,
  runTransaction,
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
  discoverable: boolean;
  publicProfileId?: string;
  legacyDocumentId?: string;
};

type DiscoverableStudent = {
  publicProfileId: string;
  fullName: string;
  username: string;
  universityId: string;
  course: string;
  yearOfStudy: number | null;
  skills: string;
  photoURL: string;
};

type ConnectionStatus = "pending" | "accepted" | "rejected" | "cancelled";
type ConnectionRecord = {
  id: string;
  participantUids: string[];
  participantProfileIds: string[];
  requesterUid: string;
  recipientUid: string;
  status: ConnectionStatus;
  createdAt: unknown;
  updatedAt: unknown;
  updatedByUid?: string;
  requesterProfile?: StudentProfileSnapshot;
  recipientProfile?: StudentProfileSnapshot;
};

type ConnectionAction = "request" | "accept" | "reject" | "cancel" | "remove";
type StudentProfileSnapshot = Omit<DiscoverableStudent, "publicProfileId"> & {
  publicProfileId: string;
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
let currentIsAdmin = false;
let currentUsername: string | null = null;
let currentEmail: string | null = null;
let registrationInProgress = false;
let pendingRegistrationProfile: StudentProfile | null = null;
let authProfileError: string | null = null;
let studentDiscoveryUnsubscribe: (() => void) | null = null;
let discoveryConnectionsUnsubscribe: (() => void) | null = null;
let connectionScreenUnsubscribe: (() => void) | null = null;
let profileConnectionUnsubscribe: (() => void) | null = null;

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
    discoverable: data.discoverable === true,
    ...(typeof data.publicProfileId === "string"
      ? { publicProfileId: data.publicProfileId }
      : {}),
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
      uid: user.uid,
      fullName: profile.fullName,
      username: profile.username,
      email,
      universityId: profile.universityId,
      campusId: profile.campusId,
      course: profile.course,
      yearOfStudy: profile.yearOfStudy,
      ...(profile.yearOfStudy ? { year: `Year ${profile.yearOfStudy}` } : {}),
      role: "student",
      emailVerified: user.emailVerified,
      verificationStatus: "unverified",
      createdAt: legacyData.createdAt ?? serverTimestamp(),
      updatedAt: serverTimestamp(),
      discoverable: legacyData.discoverable === true,
      ...(typeof legacyData.publicProfileId === "string"
        ? { publicProfileId: legacyData.publicProfileId }
        : {}),
      ...(profile.skills ? { skills: profile.skills } : {}),
      ...(profile.photoURL ? { photoURL: profile.photoURL } : {})
    }, { merge: true });
    return profile;
  } catch (error) {
    if (!legacySnap?.exists()) throw error;
    console.error("Could not create UID profile from legacy profile:", error);
    return profile;
  }
}

function clearAuthState() {
  stopConnectionUiListeners();
  currentUser = null;
  currentProfile = null;
  currentRole = "student";
  currentIsAdmin = false;
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

  stopConnectionUiListeners();
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
    const token = await user.getIdTokenResult();
    currentIsAdmin = token.claims.admin === true;
    currentRole = currentIsAdmin ? "admin" : "student";
    currentUsername = profile.username;
    currentEmail = user.email;
    authProfileError = null;
    showApp();
    void ensurePublicProfileRecord();
  } catch (error) {
    if (auth.currentUser?.uid !== user.uid) return;
    console.error("Could not load student profile:", error);
    currentUser = user;
    authProfileError = "Your account is signed in, but your student profile could not be loaded. Check your connection or Firestore access, then try again.";
    showProfileLoadError();
  }
});

function isAdmin() {
  return currentIsAdmin;
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

function isConnectionStatus(value: unknown): value is ConnectionStatus {
  return value === "pending" ||
    value === "accepted" ||
    value === "rejected" ||
    value === "cancelled";
}

function toConnectionRecord(id: string, data: DocumentData): ConnectionRecord | null {
  const participantUids = Array.isArray(data.participantUids)
    ? data.participantUids.filter((uid: unknown): uid is string => typeof uid === "string")
    : [];
  const participantProfileIds = Array.isArray(data.participantProfileIds)
    ? data.participantProfileIds.filter((profileId: unknown): profileId is string =>
        typeof profileId === "string"
      )
    : [];
  if (
    participantUids.length !== 2 ||
    participantUids[0] === participantUids[1] ||
    typeof data.requesterUid !== "string" ||
    typeof data.recipientUid !== "string" ||
    !participantUids.includes(data.requesterUid) ||
    !participantUids.includes(data.recipientUid) ||
    !isConnectionStatus(data.status)
  ) {
    return null;
  }
  return {
    id,
    participantUids,
    participantProfileIds,
    requesterUid: data.requesterUid,
    recipientUid: data.recipientUid,
    status: data.status,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
    ...(typeof data.updatedByUid === "string" ? { updatedByUid: data.updatedByUid } : {}),
    ...(isStudentProfileSnapshot(data.requesterProfile)
      ? { requesterProfile: data.requesterProfile }
      : {}),
    ...(isStudentProfileSnapshot(data.recipientProfile)
      ? { recipientProfile: data.recipientProfile }
      : {})
  };
}

function isStudentProfileSnapshot(value: unknown): value is StudentProfileSnapshot {
  if (!value || typeof value !== "object") return false;
  const profile = value as Record<string, unknown>;
  return typeof profile.publicProfileId === "string" &&
    typeof profile.fullName === "string" &&
    typeof profile.username === "string" &&
    typeof profile.universityId === "string" &&
    typeof profile.course === "string" &&
    (profile.yearOfStudy === null || typeof profile.yearOfStudy === "number") &&
    typeof profile.skills === "string" &&
    typeof profile.photoURL === "string";
}

function currentStudentUid(): string {
  const uid = currentUser?.uid;
  if (!uid || auth.currentUser?.uid !== uid) {
    throw new Error("Your signed-in session is no longer available. Please sign in again.");
  }
  return uid;
}

function sortedParticipantUids(firstUid: string, secondUid: string): [string, string] {
  return firstUid < secondUid ? [firstUid, secondUid] : [secondUid, firstUid];
}

function legacyConnectionIdFor(firstUid: string, secondUid: string): string {
  return `pair_${encodeURIComponent(JSON.stringify(sortedParticipantUids(firstUid, secondUid)))}`;
}

function connectionIdFor(firstUid: string, secondUid: string): string {
  const [first, second] = sortedParticipantUids(firstUid, secondUid);
  return `pair_${first}~${second}`;
}

function publicProfileProjection(
  data: Record<string, unknown>,
  publicProfileId: string,
  ownerUid: string
): Record<string, unknown> {
  return {
    ownerUid,
    publicProfileId,
    fullName: typeof data.fullName === "string" ? data.fullName.slice(0, 100) : "",
    username: typeof data.username === "string" ? data.username.slice(0, 30) : "",
    universityId: typeof data.universityId === "string" ? data.universityId.slice(0, 100) : "",
    course: typeof data.course === "string" ? data.course.slice(0, 120) : "",
    yearOfStudy: Number.isInteger(data.yearOfStudy) ? data.yearOfStudy : null,
    skills: typeof data.skills === "string" ? data.skills.slice(0, 500) : "",
    photoURL: typeof data.photoURL === "string" && data.photoURL.length <= 700000
      ? data.photoURL
      : "",
    discoverable: true
  };
}

function publicSnapshot(
  data: Record<string, unknown>,
  publicProfileId: string
): StudentProfileSnapshot {
  const projection = publicProfileProjection(data, publicProfileId, "");
  const photoURL = typeof projection.photoURL === "string" && projection.photoURL.length <= 150000
    ? projection.photoURL
    : "";
  const yearOfStudy = projection.yearOfStudy;
  return {
    publicProfileId,
    fullName: String(projection.fullName),
    username: String(projection.username),
    universityId: String(projection.universityId),
    course: String(projection.course),
    yearOfStudy: typeof yearOfStudy === "number" ? yearOfStudy : null,
    skills: String(projection.skills),
    photoURL
  };
}

async function updateStudentConnection(
  targetPublicProfileId: string,
  action: ConnectionAction,
  knownConnection: ConnectionRecord | null = null
): Promise<ConnectionStatus> {
  const uid = currentStudentUid();
  const userRef = doc(db, "users", uid);
  const targetProfileRef = doc(db, "publicProfiles", targetPublicProfileId);

  return runTransaction(db, async (transaction) => {
    const userSnapshot = await transaction.get(userRef);
    if (!userSnapshot.exists()) throw new Error("Your student profile is not available.");
    const userData = userSnapshot.data();
    const ownProfileId = typeof userData.publicProfileId === "string"
      ? userData.publicProfileId
      : currentProfile?.publicProfileId;
    if (!ownProfileId) throw new Error("Your public student profile is still being prepared.");

    let targetUid = knownConnection?.participantUids.find((participantUid) => participantUid !== uid);
    let targetData: Record<string, unknown> | null = null;
    if (!targetUid || action === "request") {
      const targetSnapshot = await transaction.get(targetProfileRef);
      if (!targetSnapshot.exists() || targetSnapshot.data().discoverable !== true) {
        throw new Error("This student is no longer available for a connection request.");
      }
      targetData = targetSnapshot.data();
      const projectedUid = targetData.ownerUid;
      if (typeof projectedUid !== "string" || projectedUid === uid) {
        throw new Error("This student profile is not available for connections.");
      }
      if (targetUid && targetUid !== projectedUid) {
        throw new Error("The connection profile identity changed. Reload and try again.");
      }
      targetUid = projectedUid;
    }
    if (!targetUid || targetUid === uid) {
      throw new Error("You cannot connect with yourself.");
    }

    const legacyRef = doc(db, "connections", legacyConnectionIdFor(uid, targetUid));
    const currentRef = doc(db, "connections", connectionIdFor(uid, targetUid));
    const knownRef = knownConnection ? doc(db, "connections", knownConnection.id) : null;
    const refs = [...new Set([legacyRef.path, currentRef.path, ...(knownRef ? [knownRef.path] : [])])]
      .map((path) => doc(db, path));
    const snapshots = await Promise.all(refs.map((ref) => transaction.get(ref)));
    const found = snapshots.flatMap((snapshot) => {
      if (!snapshot.exists()) return [];
      const record = toConnectionRecord(snapshot.id, snapshot.data());
      if (!record) {
        throw new Error("An existing connection record is malformed and needs review.");
      }
      return [{ ref: snapshot.ref, record }];
    });
    if (found.length > 1) {
      throw new Error("Duplicate connection records need review before they can be changed.");
    }
    const existing = found[0] ?? null;
    if (existing && (
      !existing.record.participantUids.includes(uid) ||
      !existing.record.participantUids.includes(targetUid)
    )) {
      throw new Error("This connection record has invalid participants.");
    }

    const participantUids = sortedParticipantUids(uid, targetUid);
    const currentProfileId = targetPublicProfileId;
    const participantProfileIds = existing?.record.participantProfileIds.length === 2
      ? existing.record.participantProfileIds
      : participantUids.map((participantUid) =>
          participantUid === uid ? ownProfileId : currentProfileId
        );
    const ownSnapshot = publicSnapshot(userData, ownProfileId);
    const targetSnapshot = targetData
      ? publicSnapshot(targetData, targetPublicProfileId)
      : null;
    let requesterUid = existing?.record.requesterUid ?? uid;
    let recipientUid = existing?.record.recipientUid ?? targetUid;
    let nextStatus: ConnectionStatus;

    if (!existing) {
      if (action !== "request" || !targetSnapshot) {
        throw new Error("This connection request is not available.");
      }
      nextStatus = "pending";
    } else if (action === "request") {
      if (existing.record.status === "pending") {
        if (existing.record.requesterUid === uid) return existing.record.status;
        if (existing.record.recipientUid !== uid) {
          throw new Error("This connection request is not available to you.");
        }
        nextStatus = "accepted";
      } else {
        if (!targetSnapshot) {
          throw new Error("This student is no longer available for a connection request.");
        }
        requesterUid = uid;
        recipientUid = targetUid;
        nextStatus = "pending";
      }
    } else if (action === "accept" || action === "reject") {
      if (existing.record.recipientUid !== uid || existing.record.status !== "pending") {
        throw new Error("Only the recipient can respond to a pending request.");
      }
      nextStatus = action === "accept" ? "accepted" : "rejected";
    } else if (action === "cancel") {
      if (existing.record.requesterUid !== uid || existing.record.status !== "pending") {
        throw new Error("Only the requester can cancel a pending request.");
      }
      nextStatus = "cancelled";
    } else {
      if (existing.record.status !== "accepted") {
        throw new Error("Only an accepted connection can be removed.");
      }
      nextStatus = "cancelled";
    }

    const updatedAt = serverTimestamp();
    if (existing) {
      const updates: Record<string, unknown> = {
        status: nextStatus,
        updatedAt,
        updatedByUid: uid
      };
      if (nextStatus === "pending" && existing.record.status !== "pending") {
        updates.requesterUid = requesterUid;
        updates.recipientUid = recipientUid;
        if (!targetSnapshot) {
          throw new Error("The target profile could not be loaded.");
        }
        updates.requesterProfile = requesterUid === uid ? ownSnapshot : targetSnapshot;
        updates.recipientProfile = recipientUid === uid ? ownSnapshot : targetSnapshot;
      }
      transaction.update(existing.ref, updates);
    } else {
      if (!targetSnapshot) throw new Error("The target profile could not be loaded.");
      transaction.set(currentRef, {
        pairId: currentRef.id,
        participantUids,
        participantProfileIds,
        requesterUid: uid,
        recipientUid: targetUid,
        requesterProfile: ownSnapshot,
        recipientProfile: targetSnapshot,
        status: nextStatus,
        createdAt: updatedAt,
        updatedAt,
        updatedByUid: uid
      });
    }
    return nextStatus;
  });
}

async function loadPublicProfilesById(profileIds: string[]): Promise<Map<string, DocumentData>> {
  const uniqueIds = [...new Set(profileIds)];
  const profiles = new Map<string, DocumentData>();
  for (let index = 0; index < uniqueIds.length; index += 30) {
    const chunk = uniqueIds.slice(index, index + 30);
    if (!chunk.length) continue;
    const snapshot = await getDocs(
      query(
        collection(db, "publicProfiles"),
        where("discoverable", "==", true),
        where(documentId(), "in", chunk)
      )
    );
    for (const profile of snapshot.docs) {
      profiles.set(profile.id, profile.data());
    }
  }
  return profiles;
}

function stopConnectionScreenListener(): void {
  connectionScreenUnsubscribe?.();
  connectionScreenUnsubscribe = null;
}

function stopProfileConnectionListener(): void {
  profileConnectionUnsubscribe?.();
  profileConnectionUnsubscribe = null;
}

function stopStudentDiscoveryListener(): void {
  studentDiscoveryUnsubscribe?.();
  studentDiscoveryUnsubscribe = null;
  discoveryConnectionsUnsubscribe?.();
  discoveryConnectionsUnsubscribe = null;
}

function stopConnectionUiListeners(): void {
  stopStudentDiscoveryListener();
  stopConnectionScreenListener();
  stopProfileConnectionListener();
}

function connectionActionFor(
  connection: ConnectionRecord | null,
  uid: string,
  otherProfileId: string
): { label: string; action: ConnectionAction | null } {
  if (!connection || connection.status === "cancelled") {
    return { label: "Connect", action: "request" };
  }
  if (connection.status === "accepted") {
    return { label: "Connected", action: null };
  }
  if (connection.status === "rejected") {
    return { label: "Request Rejected · Send again", action: "request" };
  }
  if (
    connection.participantProfileIds.includes(otherProfileId) &&
    connection.requesterUid === uid
  ) {
    return { label: "Request Sent", action: "cancel" };
  }
  if (
    connection.participantProfileIds.includes(otherProfileId) &&
    connection.recipientUid === uid
  ) {
    return { label: "Accept Request", action: "accept" };
  }
  return { label: "Connection unavailable", action: null };
}

function subscribeConnectionAction(targetPublicProfileId: string, container: HTMLElement): () => void {
  container.replaceChildren();
  const button = document.createElement("button");
  button.type = "button";
  button.className = "connection-action-button";
  button.disabled = true;
  button.textContent = "Loading connection...";
  const feedback = document.createElement("span");
  feedback.className = "connection-action-feedback";
  feedback.setAttribute("role", "status");
  container.append(button, feedback);

  let connection: ConnectionRecord | null = null;
  let operationPending = false;
  const relationshipQuery = query(
    collection(db, "connections"),
    where("participantUids", "array-contains", currentStudentUid())
  );
  const render = () => {
    const state = connectionActionFor(
      connection,
      currentUser?.uid ?? "",
      targetPublicProfileId
    );
    button.textContent = state.label;
    button.disabled = operationPending || !state.action;
    button.classList.toggle("connection-action-primary", state.action === "request");
    button.classList.toggle("connection-action-muted", !state.action || state.action === "cancel");
  };

  button.addEventListener("click", async () => {
    const state = connectionActionFor(
      connection,
      currentUser?.uid ?? "",
      targetPublicProfileId
    );
    if (!state.action || operationPending) return;
    operationPending = true;
    feedback.textContent = "";
    feedback.classList.remove("connection-action-error");
    render();
    try {
      const result = await updateStudentConnection(
        targetPublicProfileId,
        state.action,
        connection
      );
      feedback.textContent = result === "accepted"
        ? "You are now connected."
        : state.action === "request"
          ? "Connection request sent."
          : state.action === "accept"
            ? "Connection request accepted."
            : "Connection request cancelled.";
    } catch (error) {
      console.error("Could not update student connection:", error);
      feedback.textContent = error instanceof Error ? error.message : authErrorMessage(error);
      feedback.classList.add("connection-action-error");
    } finally {
      operationPending = false;
      render();
    }
  });

  return onSnapshot(
    relationshipQuery,
    (snapshot) => {
      connection = snapshot.docs
        .map((item) => toConnectionRecord(item.id, item.data()))
        .find((item) => item?.participantProfileIds.includes(targetPublicProfileId)) ?? null;
      render();
    },
    (error) => {
      console.error("Could not load student connection:", error);
      button.disabled = true;
      button.textContent = "Connection status unavailable";
      feedback.textContent = "Could not load connection status. Please retry.";
      feedback.classList.add("connection-action-error");
    }
  );
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

        if (currentProfile) {
          currentProfile = { ...currentProfile, emailVerified: true };
        }

        renderAccountStatus(
          "Email verified. Firebase Authentication remains the source of truth for this status. University student verification is separate."
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
      const token = await user.getIdTokenResult();
      currentIsAdmin = token.claims.admin === true;
      currentRole = currentIsAdmin ? "admin" : "student";
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
  void ensurePublicProfileRecord();

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
        discoverable: false,
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
    const [publicProfilesSnap, hostelsSnap, annSnap] = await Promise.all([
      getDocs(query(collection(db, "publicProfiles"), where("discoverable", "==", true))),
      getDocs(collection(db, "hostels")),
      getDocs(collection(db, "announcements"))
    ]);

    const stats: Record<string, number> = {
      hostels: hostelsSnap.size,
      announcements: annSnap.size,
      active: publicProfilesSnap.size,
    };

    if (isAdmin()) {
      const usersSnap = await getDocs(collection(db, "users"));
      stats.users = uniqueUserDocuments(usersSnap.docs).length;
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
  const [home, chat, map, ann, profile, discover, connections, requests] =
    nav.querySelectorAll("button");
  home?.addEventListener("click", showApp);
  chat?.addEventListener("click", openChatModule);
  map?.addEventListener("click", showMapScreen);
  ann?.addEventListener("click", openAnnouncements);
  profile?.addEventListener("click", showProfile);
  discover?.addEventListener("click", showDiscoverStudents);
  connections?.addEventListener("click", showMyConnections);
  requests?.addEventListener("click", showConnectionRequests);
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
  stopConnectionUiListeners();
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
        <button id="discoverModule" class="${cardClass} flex flex-col items-center justify-center gap-2 p-7 cursor-pointer border-none text-inherit font-[inherit]">
          <span class="text-3xl">🔎</span>
          <span class="text-sm font-semibold">Discover Students</span>
        </button>
        <button id="connectionsModule" class="${cardClass} flex flex-col items-center justify-center gap-2 p-7 cursor-pointer border-none text-inherit font-[inherit]">
          <span class="text-3xl">🤝</span>
          <span class="text-sm font-semibold">My Connections</span>
        </button>
        <button id="requestsModule" class="${cardClass} flex flex-col items-center justify-center gap-2 p-7 cursor-pointer border-none text-inherit font-[inherit]">
          <span class="text-3xl">📨</span>
          <span class="text-sm font-semibold">Connection Requests</span>
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
      <button aria-label="Discover students" class="bg-transparent border-none text-2xl cursor-pointer p-2 rounded-xl hover:bg-white/10 hover:scale-110 transition-all duration-200 m-0">🔎</button>
      <button aria-label="My connections" class="bg-transparent border-none text-2xl cursor-pointer p-2 rounded-xl hover:bg-white/10 hover:scale-110 transition-all duration-200 m-0">🤝</button>
      <button aria-label="Connection requests" class="bg-transparent border-none text-2xl cursor-pointer p-2 rounded-xl hover:bg-white/10 hover:scale-110 transition-all duration-200 m-0">📨</button>
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
  document.getElementById("discoverModule")?.addEventListener("click", showDiscoverStudents);
  document.getElementById("connectionsModule")?.addEventListener("click", showMyConnections);
  document.getElementById("requestsModule")?.addEventListener("click", showConnectionRequests);
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
  stopConnectionUiListeners();
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
  const usersRef = query(
    collection(db, "publicProfiles"),
    where("discoverable", "==", true)
  );
  const usersList = document.getElementById("usersList");

  if (!usersList) return;

  onSnapshot(usersRef, (snapshot) => {
    usersList.innerHTML = "";

    uniqueUserDocuments(snapshot.docs).forEach((docSnap) => {
      const user = docSnap.data();

      if (docSnap.id === currentProfile?.publicProfileId) return;

      const div = document.createElement("div");
      div.className = "wa-user";

      div.innerHTML = `
        <div class="wa-avatar">
          ${(user.username || "?").charAt(0).toUpperCase()}
        </div>
        <div>${user.username || user.fullName || "Student"}</div>
      `;

      div.onclick = () => openChat(
        docSnap.id,
        user.username || user.fullName || "Student"
      );

      usersList.appendChild(div);
    });
  }, (error) => {
    console.error("Could not load chat contacts:", error);
    usersList.textContent = "Student contacts could not be loaded.";
  });
}

/* ---------------- OPEN CHAT ---------------- */
async function ensureStudentChat(publicProfileId: string): Promise<string> {
  const uid = currentStudentUid();
  const userRef = doc(db, "users", uid);
  const existingChats = await getDocs(query(
    collection(db, "chats"),
    where("participantUids", "array-contains", uid)
  ));
  const existingByProfile = existingChats.docs.find((chat) => {
    const data = chat.data();
    if (
      !Array.isArray(data.participantUids) ||
      data.participantUids.length !== 2 ||
      !data.participantUids.includes(uid) ||
      !Array.isArray(data.participantProfileIds) ||
      data.participantProfileIds.length !== 2
    ) {
      return false;
    }
    const ownIndex = data.participantUids.indexOf(uid);
    const otherIndex = ownIndex === 0 ? 1 : 0;
    return data.participantProfileIds[otherIndex] === publicProfileId;
  });
  if (existingByProfile) return existingByProfile.id;

  const targetProfileRef = doc(db, "publicProfiles", publicProfileId);
  const targetSnapshot = await getDoc(targetProfileRef);
  if (!targetSnapshot.exists() || targetSnapshot.data().discoverable !== true) {
    throw new Error("This student is no longer available for chat.");
  }
  const targetData = targetSnapshot.data();
  const targetUid = targetData.ownerUid;
  if (typeof targetUid !== "string" || targetUid === uid) {
    throw new Error("This student profile is not available for chat.");
  }

  const participantUids = sortedParticipantUids(uid, targetUid);
  const ownProfileId = currentProfile?.publicProfileId;
  if (!ownProfileId) {
    throw new Error("Your public student profile is still being prepared.");
  }
  const participantProfileIds = participantUids.map((participantUid) =>
    participantUid === uid ? ownProfileId : publicProfileId
  );
  const chatId = `chat_${participantUids[0]}~${participantUids[1]}`;
  const chatRef = doc(db, "chats", chatId);

  return runTransaction(db, async (transaction) => {
    const [userSnapshot, currentTarget, chatSnapshot] = await Promise.all([
      transaction.get(userRef),
      transaction.get(targetProfileRef),
      transaction.get(chatRef)
    ]);
    if (!userSnapshot.exists() || !currentTarget.exists()) {
      throw new Error("A student profile is no longer available for chat.");
    }
    if (
      userSnapshot.data().publicProfileId !== participantProfileIds[participantUids.indexOf(uid)] ||
      currentTarget.data().ownerUid !== targetUid ||
      currentTarget.data().discoverable !== true
    ) {
      throw new Error("A student profile changed while opening the chat. Reload and try again.");
    }
    if (chatSnapshot.exists()) {
      const existing = chatSnapshot.data();
      if (
        !Array.isArray(existing.participantUids) ||
        existing.participantUids.length !== 2 ||
        !existing.participantUids.includes(uid) ||
        !existing.participantUids.includes(targetUid)
      ) {
        throw new Error("This chat record has invalid participants.");
      }
      return chatSnapshot.id;
    }

    const timestamp = serverTimestamp();
    transaction.set(chatRef, {
      participantUids,
      participantProfileIds,
      createdAt: timestamp,
      updatedAt: timestamp
    });
    return chatId;
  });
}

function openChat(otherPublicProfileId: string, username: string) {
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

  const sendButton = document.getElementById("sendBtn") as HTMLButtonElement;
  const messageInput = document.getElementById("msgInput") as HTMLInputElement;
  sendButton.disabled = true;
  messageInput.disabled = true;
  document.getElementById("viewProfileBtn")?.addEventListener("click", () => {
    stopConnectionUiListeners();
    void viewPublicStudentProfile(otherPublicProfileId, openChatModule);
  });

  void (async () => {
    try {
      const chatId = await ensureStudentChat(otherPublicProfileId);
      if (!document.getElementById("messages")) return;
      sendButton.disabled = false;
      messageInput.disabled = false;
      sendButton.addEventListener("click", () => {
        void sendMessage(chatId);
      });
      loadMessages(chatId);
    } catch (error) {
      console.error("Could not open student chat:", error);
      const messages = document.getElementById("messages");
      if (messages) {
        messages.textContent = "This chat could not be opened. Check your connection or try again.";
      }
    }
  })();
}
/* ---------------- SEND MESSAGE ---------------- */
async function sendMessage(chatId: string) {
  const input = document.getElementById("msgInput") as HTMLInputElement;

  if (!input.value.trim() || !currentEmail || !currentUser) return;

  await addDoc(collection(db, "chats", chatId, "messages"), {
    text: input.value.trim(),
    sender: currentEmail,
    senderUid: currentUser.uid,
    createdAt: serverTimestamp()
  });
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
    ownerUid: currentStudentUid(),
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
      ownerUid: currentStudentUid(),
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
        ownerUid: currentStudentUid(),
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
  stopConnectionUiListeners();
  if (!currentProfile) return;

  const profile = currentProfile;
  const universityName =
    enabledUniversities.find((university) => university.id === profile.universityId)?.name ??
    (profile.universityId || "Not set");
  const initials = profile.fullName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("") || "?";

  app.innerHTML = `
    <div class="profile-page">
      <div class="profile-header">
        <button id="backBtn" class="profile-back" type="button" aria-label="Back to dashboard">←</button>
        <div>
          <p class="profile-eyebrow">CAMPUS CONNECT</p>
          <h1>My Profile</h1>
        </div>
      </div>

      <div class="profile-layout">
        <section class="profile-card profile-summary" aria-labelledby="profileName">
          <div class="profile-identity">
            <div class="profile-avatar" id="profileAvatar">
              <span id="profileImageFallback" aria-hidden="true">${escapeHtml(initials)}</span>
              <img id="profileImage" alt="${escapeHtml(profile.fullName)} profile photograph" hidden>
            </div>
            <div class="profile-identity-copy">
              <p class="profile-eyebrow">STUDENT PROFILE</p>
              <h2 id="profileName">${escapeHtml(profile.fullName || "Student")}</h2>
              <p class="profile-username">@${escapeHtml(profile.username || "student")}</p>
            </div>
          </div>

          <dl class="profile-details">
            <div><dt>University</dt><dd>${escapeHtml(universityName)}</dd></div>
            <div><dt>Course / programme</dt><dd>${escapeHtml(profile.course || "Not set")}</dd></div>
            <div><dt>Year of study</dt><dd>${profile.yearOfStudy ? `Year ${profile.yearOfStudy}` : "Not set"}</dd></div>
            <div><dt>Skills and interests</dt><dd class="profile-skills">${escapeHtml(profile.skills?.trim() || "Not set")}</dd></div>
          </dl>
        </section>

        <section class="profile-card profile-editor" aria-labelledby="profileEditTitle">
          <div class="profile-section-heading">
            <div>
              <p class="profile-eyebrow">YOUR DETAILS</p>
              <h2 id="profileEditTitle">Edit profile</h2>
            </div>
            <span class="profile-editable-tag">Editable</span>
          </div>

          <form id="profileForm" class="profile-form">
            <div class="profile-photo-field">
              <div class="profile-avatar profile-avatar-small" id="profilePhotoPreview">
                <span id="profilePhotoFallback" aria-hidden="true">${escapeHtml(initials)}</span>
                <img id="profilePhotoImage" alt="Profile photograph preview" hidden>
              </div>
              <div class="profile-photo-control">
                <label for="photoInput">Profile photograph</label>
                <input id="photoInput" name="photo" type="file" accept="image/jpeg,image/png,image/webp">
                <p class="profile-field-hint">JPEG, PNG or WebP. Maximum 10 MB; resized before saving.</p>
              </div>
            </div>

            <div class="profile-form-field">
              <label for="course">Course / programme</label>
              <input id="course" name="course" type="text" maxlength="120" required>
            </div>

            <div class="profile-form-field">
              <label for="year">Year of study</label>
              <select id="year" name="yearOfStudy" required>
                <option value="">Select year</option>
                ${Array.from({ length: 8 }, (_, index) => `<option value="${index + 1}">Year ${index + 1}</option>`).join("")}
              </select>
            </div>

            <div class="profile-form-field">
              <label for="skills">Skills and interests</label>
              <textarea id="skills" name="skills" maxlength="500" rows="4" placeholder="e.g. GIS, coding, design"></textarea>
              <p class="profile-field-hint">Up to 500 characters.</p>
            </div>

            <div class="profile-discovery-setting">
              <label class="profile-discovery-toggle" for="discoverable">
                <span>
                  <strong>Show my profile in Discover Students</strong>
                  <span id="discoveryPreferenceDescription" class="profile-field-hint"></span>
                </span>
                <input id="discoverable" name="discoverable" type="checkbox" ${profile.discoverable ? "checked" : ""}>
              </label>
              <p id="discoveryPreferenceFeedback" class="profile-feedback" role="status" aria-live="polite"></p>
            </div>

            <div class="profile-form-actions">
              <button id="discardProfile" class="profile-button profile-button-secondary" type="button">Discard changes</button>
              <button id="saveProfile" class="profile-button profile-button-primary" type="submit">Save profile</button>
            </div>
            <p id="profileFeedback" class="profile-feedback" role="status" aria-live="polite"></p>
          </form>
        </section>

        <section class="profile-card profile-account" aria-labelledby="accountInfoTitle">
          <div class="profile-section-heading">
            <div>
              <p class="profile-eyebrow">ACCOUNT</p>
              <h2 id="accountInfoTitle">Account information</h2>
            </div>
            <span class="profile-readonly-tag">Read only</span>
          </div>
          <p class="profile-field-hint">These account details are not editable here. University student verification remains deferred and is not required to use profile features.</p>
          <dl class="profile-details profile-account-details">
            <div><dt>Email</dt><dd>${escapeHtml(profile.email || "Not set")}</dd></div>
            <div><dt>Firebase UID</dt><dd class="profile-uid">${escapeHtml(profile.uid)}</dd></div>
            <div><dt>Role</dt><dd>${escapeHtml(profile.role)}</dd></div>
            <div><dt>Email verification</dt><dd>${currentUser?.emailVerified ? "Verified" : "Not verified"}</dd></div>
            <div><dt>University student verification</dt><dd>${escapeHtml(profile.verificationStatus)}</dd></div>
          </dl>
        </section>
      </div>
    </div>
  `;

  const form = document.getElementById("profileForm") as HTMLFormElement;
  const photoInput = document.getElementById("photoInput") as HTMLInputElement;
  const photoImage = document.getElementById("profilePhotoImage") as HTMLImageElement;
  const photoFallback = document.getElementById("profilePhotoFallback") as HTMLSpanElement;
  const feedback = document.getElementById("profileFeedback") as HTMLParagraphElement;
  const saveButton = document.getElementById("saveProfile") as HTMLButtonElement;
  const discardButton = document.getElementById("discardProfile") as HTMLButtonElement;
  const discoverableInput = document.getElementById("discoverable") as HTMLInputElement;
  const discoveryDescription = document.getElementById("discoveryPreferenceDescription") as HTMLSpanElement;
  const discoveryFeedback = document.getElementById("discoveryPreferenceFeedback") as HTMLParagraphElement;
  let previewUrl: string | null = null;
  let saving = false;
  let savingDiscoveryPreference = false;

  const setPhotoPreview = (photoUrl: string) => {
    photoImage.hidden = !photoUrl;
    photoFallback.hidden = Boolean(photoUrl);
    if (photoUrl) photoImage.src = photoUrl;
    else photoImage.removeAttribute("src");
  };
  const setFeedback = (message: string, isError = false) => {
    feedback.textContent = message;
    feedback.className = `profile-feedback${message ? (isError ? " profile-feedback-error" : " profile-feedback-success") : ""}`;
  };
  const releasePreview = () => {
    if (!previewUrl) return;
    URL.revokeObjectURL(previewUrl);
    previewUrl = null;
  };
  const restoreProfileForm = (message: string) => {
    (document.getElementById("course") as HTMLInputElement).value = profile.course;
    (document.getElementById("year") as HTMLSelectElement).value =
      profile.yearOfStudy?.toString() ?? "";
    (document.getElementById("skills") as HTMLTextAreaElement).value = profile.skills ?? "";
    photoInput.value = "";
    releasePreview();
    setPhotoPreview(profile.photoURL ?? "");
    setFeedback(message);
  };

  (document.getElementById("course") as HTMLInputElement).value = profile.course;
  (document.getElementById("year") as HTMLSelectElement).value =
    profile.yearOfStudy?.toString() ?? "";
  (document.getElementById("skills") as HTMLTextAreaElement).value = profile.skills ?? "";
  setPhotoPreview(profile.photoURL ?? "");
  const updateDiscoveryDescription = () => {
    discoveryDescription.textContent = discoverableInput.checked
      ? "Your public profile details will appear in student discovery."
      : "Your profile is hidden from student discovery unless you turn this on.";
  };
  updateDiscoveryDescription();

  discoverableInput.addEventListener("change", async () => {
    if (savingDiscoveryPreference) return;
    savingDiscoveryPreference = true;
    discoverableInput.disabled = true;
    discoveryFeedback.textContent = "";
    try {
      const legacySynchronized = await saveStudentDiscoveryPreference(discoverableInput.checked);
      updateDiscoveryDescription();
      discoveryFeedback.textContent = legacySynchronized
        ? "Discovery preference saved."
        : "Preference saved to your UID profile, but its legacy email-keyed copy could not be synchronized.";
      discoveryFeedback.className = `profile-feedback${legacySynchronized ? "" : " profile-feedback-error"}`;
    } catch (error) {
      console.error("Could not save student discovery preference:", error);
      discoverableInput.checked = currentProfile?.discoverable ?? false;
      updateDiscoveryDescription();
      discoveryFeedback.textContent =
        `Discovery preference could not be saved. ${error instanceof Error ? error.message : authErrorMessage(error)}`;
      discoveryFeedback.className = "profile-feedback profile-feedback-error";
    } finally {
      savingDiscoveryPreference = false;
      discoverableInput.disabled = false;
    }
  });

  photoInput.addEventListener("change", () => {
    releasePreview();
    const file = photoInput.files?.[0];
    if (!file) {
      setPhotoPreview(profile.photoURL ?? "");
      setFeedback("");
      return;
    }
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      photoInput.value = "";
      setPhotoPreview(profile.photoURL ?? "");
      setFeedback("Choose a JPEG, PNG or WebP image.", true);
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      photoInput.value = "";
      setPhotoPreview(profile.photoURL ?? "");
      setFeedback("Choose an image smaller than 10 MB.", true);
      return;
    }
    previewUrl = URL.createObjectURL(file);
    setPhotoPreview(previewUrl);
    setFeedback("Photo preview ready. Save profile to apply it.");
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (saving || !form.reportValidity()) return;

    const courseInput = document.getElementById("course") as HTMLInputElement;
    const yearInput = document.getElementById("year") as HTMLSelectElement;
    const skillsInput = document.getElementById("skills") as HTMLTextAreaElement;
    const course = courseInput.value.trim();
    const yearOfStudy = Number(yearInput.value);
    const skills = skillsInput.value.trim();
    const file = photoInput.files?.[0];

    if (!course || course.length > 120) {
      setFeedback("Enter a course or programme name (up to 120 characters).", true);
      courseInput.focus();
      return;
    }
    if (!Number.isInteger(yearOfStudy) || yearOfStudy < 1 || yearOfStudy > 8) {
      setFeedback("Select a valid year of study.", true);
      yearInput.focus();
      return;
    }
    if (skills.length > 500) {
      setFeedback("Skills and interests must be 500 characters or fewer.", true);
      skillsInput.focus();
      return;
    }

    saving = true;
    saveButton.disabled = true;
    discardButton.disabled = true;
    photoInput.disabled = true;
    saveButton.textContent = file ? "Preparing photo..." : "Saving...";
    setFeedback("");
    try {
      const changes: ProfileEdits = { course, yearOfStudy, skills };
      if (file) {
        changes.photoURL = await compressProfileImage(file);
        saveButton.textContent = "Saving...";
      }

      await saveStudentProfileChanges(changes);
      releasePreview();
      photoInput.value = "";
      showProfile();
      const updatedFeedback = document.getElementById("profileFeedback");
      if (updatedFeedback) {
        updatedFeedback.textContent = "Profile saved successfully.";
        updatedFeedback.className = "profile-feedback profile-feedback-success";
      }
    } catch (error) {
      console.error("Could not save student profile:", error);
      const message =
        typeof error === "object" && error !== null && "code" in error
          ? authErrorMessage(error)
          : error instanceof Error
            ? error.message
            : authErrorMessage(error);
      setFeedback(`Profile could not be saved. ${message}`, true);
    } finally {
      saving = false;
      saveButton.disabled = false;
      discardButton.disabled = false;
      photoInput.disabled = false;
      saveButton.textContent = "Save profile";
    }
  });

  discardButton.addEventListener("click", () => restoreProfileForm("Unsaved changes discarded."));
  document.getElementById("backBtn")?.addEventListener("click", showApp);

  photoImage.addEventListener("error", () => {
    photoImage.hidden = true;
    photoFallback.hidden = false;
  });
}

function networkStudentFromDocument(
  publicProfileId: string,
  data: DocumentData
): DiscoverableStudent {
  return {
    publicProfileId,
    fullName: String(data.fullName ?? data.username ?? "Student"),
    username: String(data.username ?? data.fullName ?? "student"),
    universityId: String(data.universityId ?? pilotUniversityId),
    course: String(data.course ?? ""),
    yearOfStudy: normalizeYearOfStudy(data.yearOfStudy ?? data.year),
    skills: typeof data.skills === "string" ? data.skills : "",
    photoURL: typeof data.photoURL === "string" ? data.photoURL : ""
  };
}

function studentFromConnection(
  connection: ConnectionRecord,
  participantUid: string,
  publicProfiles: Map<string, DocumentData>
): DiscoverableStudent | null {
  const index = connection.participantUids.indexOf(participantUid);
  if (index < 0) return null;
  const publicProfileId = connection.participantProfileIds[index];
  if (!publicProfileId) return null;
  const publicProfile = publicProfiles.get(publicProfileId);
  if (publicProfile) return networkStudentFromDocument(publicProfileId, publicProfile);
  const snapshot = participantUid === connection.requesterUid
    ? connection.requesterProfile
    : connection.recipientProfile;
  return snapshot ? networkStudentFromDocument(publicProfileId, snapshot) : null;
}

function createNetworkStudentCard(
  student: DiscoverableStudent,
  onProfile: () => void
): HTMLElement {
  const card = document.createElement("article");
  card.className = "network-student-card";
  const avatar = document.createElement("span");
  avatar.className = "discover-avatar";
  const initials = student.fullName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("") || "?";
  const fallback = document.createElement("span");
  fallback.textContent = initials;
  avatar.appendChild(fallback);

  if (student.photoURL) {
    const image = document.createElement("img");
    image.src = student.photoURL;
    image.alt = "";
    image.addEventListener("error", () => image.remove());
    image.addEventListener("load", () => fallback.remove());
    avatar.appendChild(image);
  }

  const details = document.createElement("div");
  details.className = "discover-student-details";
  const name = document.createElement("strong");
  name.className = "discover-student-name";
  name.textContent = student.fullName;
  const username = document.createElement("span");
  username.className = "discover-student-username";
  username.textContent = `@${student.username}`;
  const university = document.createElement("span");
  university.className = "discover-student-meta";
  university.textContent =
    enabledUniversities.find((item) => item.id === student.universityId)?.name ??
    student.universityId;
  const course = document.createElement("span");
  course.className = "discover-student-meta";
  course.textContent = [
    student.course || "Course not set",
    student.yearOfStudy ? `Year ${student.yearOfStudy}` : ""
  ].filter(Boolean).join(" · ");
  details.append(name, username, course, university);

  const profileButton = document.createElement("button");
  profileButton.type = "button";
  profileButton.className = "discover-profile-button";
  profileButton.textContent = "View profile";
  profileButton.addEventListener("click", onProfile);
  card.append(avatar, details, profileButton);
  return card;
}

async function showMyConnections(): Promise<void> {
  stopConnectionUiListeners();
  const uid = currentStudentUid();
  app.innerHTML = `
    <main class="network-page">
      <header class="discover-header">
        <button id="connectionsBack" class="profile-back" type="button" aria-label="Back to dashboard">←</button>
        <div>
          <p class="profile-eyebrow">YOUR STUDENT NETWORK</p>
          <h1>My Connections</h1>
          <p id="connectionsCount" class="discover-intro">Loading connections...</p>
        </div>
      </header>
      <p id="connectionsStatus" class="discover-status" role="status" aria-live="polite">
        <span class="discover-spinner" aria-hidden="true"></span>Loading your connections...
      </p>
      <div id="connectionsError" class="discover-status discover-status-error" role="alert" hidden></div>
      <section id="connectionsList" class="network-list" aria-label="Accepted student connections"></section>
    </main>
  `;

  const count = document.getElementById("connectionsCount") as HTMLParagraphElement;
  const status = document.getElementById("connectionsStatus") as HTMLParagraphElement;
  const error = document.getElementById("connectionsError") as HTMLDivElement;
  const list = document.getElementById("connectionsList") as HTMLElement;
  let renderGeneration = 0;
  let previousUids: string | null = null;

  document.getElementById("connectionsBack")?.addEventListener("click", showApp);
  if (!document.getElementById("connectionsList")) return;
  connectionScreenUnsubscribe = onSnapshot(
    query(collection(db, "connections"), where("participantUids", "array-contains", uid)),
    async (snapshot) => {
      const accepted = snapshot.docs
        .map((item) => toConnectionRecord(item.id, item.data()))
        .filter((item): item is ConnectionRecord =>
          Boolean(item && item.status === "accepted" && item.participantUids.includes(uid))
        );
      const otherProfileIds = accepted
        .map((connection) => {
          const index = connection.participantUids.findIndex(
            (participantUid) => participantUid !== uid
          );
          return connection.participantProfileIds[index];
        })
        .filter((profileId): profileId is string => Boolean(profileId))
        .sort();
      const signature = otherProfileIds.join("|");
      count.textContent = `${accepted.length} ${accepted.length === 1 ? "connection" : "connections"}`;
      error.hidden = true;

      if (signature === previousUids) return;
      previousUids = signature;
      const generation = ++renderGeneration;
      list.replaceChildren();

      if (!otherProfileIds.length) {
        status.hidden = true;
        const empty = document.createElement("p");
        empty.className = "discover-empty";
        empty.textContent = "You do not have any connections yet. Discover students to grow your network.";
        list.appendChild(empty);
        return;
      }

      status.hidden = false;
      status.innerHTML = '<span class="discover-spinner" aria-hidden="true"></span>Loading connection profiles...';
      try {
        const profiles = await loadPublicProfilesById(otherProfileIds);
        if (generation !== renderGeneration) return;
        status.hidden = true;
        for (const publicProfileId of otherProfileIds) {
          const connection = accepted.find((item) =>
            item.participantProfileIds.includes(publicProfileId)
          );
          if (!connection) continue;
          const otherIndex = connection.participantProfileIds.indexOf(publicProfileId);
          const otherUid = connection.participantUids[otherIndex];
          const student = studentFromConnection(connection, otherUid, profiles);
          if (!student) continue;
          const card = createNetworkStudentCard(student, () => {
            stopConnectionScreenListener();
            void viewStudentProfileFromConnection(student, showMyConnections);
          });
          const removeButton = document.createElement("button");
          removeButton.type = "button";
          removeButton.className = "connection-remove-button";
          removeButton.textContent = "Remove connection";
          const feedback = document.createElement("span");
          feedback.className = "connection-action-feedback";
          feedback.setAttribute("role", "status");
          removeButton.addEventListener("click", async () => {
            if (!window.confirm(`Remove ${student.fullName} from your connections? Your profile and chat history will not be deleted.`)) {
              return;
            }
            removeButton.disabled = true;
            feedback.textContent = "";
            try {
              await updateStudentConnection(
                student.publicProfileId,
                "remove",
                connection
              );
              feedback.textContent = "Connection removed.";
            } catch (actionError) {
              console.error("Could not remove student connection:", actionError);
              feedback.textContent = actionError instanceof Error
                ? actionError.message
                : authErrorMessage(actionError);
              feedback.classList.add("connection-action-error");
              removeButton.disabled = false;
            }
          });
          card.append(removeButton, feedback);
          list.appendChild(card);
        }

        if (!list.childElementCount) {
          const empty = document.createElement("p");
          empty.className = "discover-empty";
          empty.textContent = "Your connections are saved, but their profiles are unavailable.";
          list.appendChild(empty);
        }
      } catch (loadError) {
        if (generation !== renderGeneration) return;
        console.error("Could not load connected student profiles:", loadError);
        status.hidden = true;
        error.textContent = "Your connections loaded, but student profiles could not be retrieved. Try again.";
        error.hidden = false;
      }
    },
    (listenerError) => {
      console.error("Could not load student connections:", listenerError);
      status.hidden = true;
      error.textContent = "Your connections could not be loaded. Check your connection or Firestore access, then try again.";
      error.hidden = false;
    }
  );
}

function showConnectionRequests(): void {
  stopConnectionUiListeners();
  const uid = currentStudentUid();
  app.innerHTML = `
    <main class="network-page">
      <header class="discover-header">
        <button id="requestsBack" class="profile-back" type="button" aria-label="Back to dashboard">←</button>
        <div>
          <p class="profile-eyebrow">YOUR STUDENT NETWORK</p>
          <h1>Connection Requests</h1>
          <p class="discover-intro">Review incoming requests and manage the ones you have sent.</p>
        </div>
      </header>
      <div id="requestsError" class="discover-status discover-status-error" role="alert" hidden></div>
      <section class="network-request-section" aria-labelledby="incomingRequestsTitle">
        <div class="network-section-heading">
          <h2 id="incomingRequestsTitle">Incoming requests</h2>
          <span id="incomingRequestCount" class="network-count">0</span>
        </div>
        <p id="incomingRequestsEmpty" class="discover-empty">Loading incoming requests...</p>
        <div id="incomingRequests" class="network-list"></div>
      </section>
      <section class="network-request-section" aria-labelledby="outgoingRequestsTitle">
        <div class="network-section-heading">
          <h2 id="outgoingRequestsTitle">Outgoing requests</h2>
          <span id="outgoingRequestCount" class="network-count">0</span>
        </div>
        <p id="outgoingRequestsEmpty" class="discover-empty">Loading outgoing requests...</p>
        <div id="outgoingRequests" class="network-list"></div>
      </section>
    </main>
  `;

  document.getElementById("requestsBack")?.addEventListener("click", showApp);
  const incomingList = document.getElementById("incomingRequests") as HTMLElement;
  const outgoingList = document.getElementById("outgoingRequests") as HTMLElement;
  const incomingEmpty = document.getElementById("incomingRequestsEmpty") as HTMLParagraphElement;
  const outgoingEmpty = document.getElementById("outgoingRequestsEmpty") as HTMLParagraphElement;
  const incomingCount = document.getElementById("incomingRequestCount") as HTMLSpanElement;
  const outgoingCount = document.getElementById("outgoingRequestCount") as HTMLSpanElement;
  const error = document.getElementById("requestsError") as HTMLDivElement;
  let renderGeneration = 0;
  let previousRequestSignature: string | null = null;

  void (async () => {
    try {
      if (!document.getElementById("incomingRequests")) return;
      connectionScreenUnsubscribe = onSnapshot(
        query(collection(db, "connections"), where("participantUids", "array-contains", uid)),
        async (snapshot) => {
          const records = snapshot.docs
            .map((item) => toConnectionRecord(item.id, item.data()))
            .filter((item): item is ConnectionRecord => Boolean(item));
          const incoming = records.filter(
            (connection) => connection.status === "pending" && connection.recipientUid === uid
          );
          const outgoing = records.filter(
            (connection) => connection.status === "pending" && connection.requesterUid === uid
          );
          incomingCount.textContent = String(incoming.length);
          outgoingCount.textContent = String(outgoing.length);
          const profileIds = [...new Set([
            ...incoming.flatMap((connection) => connection.participantProfileIds),
            ...outgoing.flatMap((connection) => connection.participantProfileIds)
          ])].sort();
          const signature = `${incoming.map((item) => item.id).sort().join(",")}|${outgoing.map((item) => item.id).sort().join(",")}`;
          error.hidden = true;
          if (signature === previousRequestSignature) return;
          previousRequestSignature = signature;
          const generation = ++renderGeneration;
          incomingList.replaceChildren();
          outgoingList.replaceChildren();
          incomingEmpty.hidden = incoming.length > 0;
          outgoingEmpty.hidden = outgoing.length > 0;
          incomingEmpty.textContent = incoming.length ? "Loading incoming requests..." : "No incoming requests.";
          outgoingEmpty.textContent = outgoing.length ? "Loading outgoing requests..." : "No outgoing requests.";

          if (!profileIds.length) return;

          try {
            const profiles = await loadPublicProfilesById(profileIds);
            if (generation !== renderGeneration) return;
            incomingEmpty.hidden = incoming.length > 0;
            outgoingEmpty.hidden = outgoing.length > 0;
            incomingEmpty.textContent = "No incoming requests.";
            outgoingEmpty.textContent = "No outgoing requests.";

            for (const connection of incoming) {
              const student = studentFromConnection(connection, connection.requesterUid, profiles);
              if (!student) continue;
              const card = createNetworkStudentCard(student, () => {
                stopConnectionScreenListener();
                void viewStudentProfileFromConnection(student, showConnectionRequests);
              });
              const actions = document.createElement("div");
              actions.className = "network-card-actions";
              const feedback = document.createElement("span");
              feedback.className = "connection-action-feedback";
              feedback.setAttribute("role", "status");
              for (const action of ["accept", "reject"] as const) {
                const button = document.createElement("button");
                button.type = "button";
                button.className = action === "accept"
                  ? "connection-action-button connection-action-primary"
                  : "connection-remove-button";
                button.textContent = action === "accept" ? "Accept" : "Reject";
                button.addEventListener("click", async () => {
                  button.disabled = true;
                  for (const sibling of actions.querySelectorAll("button")) sibling.disabled = true;
                  feedback.textContent = "";
                  try {
                    await updateStudentConnection(student.publicProfileId, action, connection);
                    feedback.textContent = action === "accept"
                      ? "Connection request accepted."
                      : "Connection request rejected.";
                  } catch (actionError) {
                    console.error("Could not respond to student connection request:", actionError);
                    feedback.textContent = actionError instanceof Error
                      ? actionError.message
                      : authErrorMessage(actionError);
                    feedback.classList.add("connection-action-error");
                    for (const sibling of actions.querySelectorAll("button")) sibling.disabled = false;
                  }
                });
                actions.appendChild(button);
              }
              actions.appendChild(feedback);
              card.appendChild(actions);
              incomingList.appendChild(card);
            }

            for (const connection of outgoing) {
              const student = studentFromConnection(connection, connection.recipientUid, profiles);
              if (!student) continue;
              const card = createNetworkStudentCard(student, () => {
                stopConnectionScreenListener();
                void viewStudentProfileFromConnection(student, showConnectionRequests);
              });
              const actions = document.createElement("div");
              actions.className = "network-card-actions";
              const pending = document.createElement("span");
              pending.className = "network-pending-label";
              pending.textContent = "Pending";
              const cancelButton = document.createElement("button");
              cancelButton.type = "button";
              cancelButton.className = "connection-remove-button";
              cancelButton.textContent = "Cancel request";
              const feedback = document.createElement("span");
              feedback.className = "connection-action-feedback";
              feedback.setAttribute("role", "status");
              cancelButton.addEventListener("click", async () => {
                cancelButton.disabled = true;
                feedback.textContent = "";
                try {
                  await updateStudentConnection(student.publicProfileId, "cancel", connection);
                  feedback.textContent = "Connection request cancelled.";
                } catch (actionError) {
                  console.error("Could not cancel student connection request:", actionError);
                  feedback.textContent = actionError instanceof Error
                    ? actionError.message
                    : authErrorMessage(actionError);
                  feedback.classList.add("connection-action-error");
                  cancelButton.disabled = false;
                }
              });
              actions.append(pending, cancelButton, feedback);
              card.appendChild(actions);
              outgoingList.appendChild(card);
            }

            if (incoming.length && !incomingList.childElementCount) {
              incomingEmpty.textContent = "Incoming request profiles are unavailable.";
              incomingEmpty.hidden = false;
            }
            if (outgoing.length && !outgoingList.childElementCount) {
              outgoingEmpty.textContent = "Outgoing request profiles are unavailable.";
              outgoingEmpty.hidden = false;
            }
          } catch (loadError) {
            if (generation !== renderGeneration) return;
            console.error("Could not load request profiles:", loadError);
            error.textContent = "Requests loaded, but student profiles could not be retrieved. Try again.";
            error.hidden = false;
            incomingEmpty.textContent = incoming.length ? "Could not load incoming request profiles." : "No incoming requests.";
            outgoingEmpty.textContent = outgoing.length ? "Could not load outgoing request profiles." : "No outgoing requests.";
            incomingEmpty.hidden = false;
            outgoingEmpty.hidden = false;
          }
        },
        (listenerError) => {
          console.error("Could not load connection requests:", listenerError);
          error.textContent = "Connection requests could not be loaded. Check your connection or Firestore access, then try again.";
          error.hidden = false;
          incomingEmpty.textContent = "Unable to load incoming requests.";
          outgoingEmpty.textContent = "Unable to load outgoing requests.";
          incomingEmpty.hidden = false;
          outgoingEmpty.hidden = false;
        }
      );
    } catch (loadError) {
      console.error("Could not prepare connection requests:", loadError);
      error.textContent = "Connection requests could not be prepared. Please try again.";
      error.hidden = false;
      incomingEmpty.textContent = "Unable to load incoming requests.";
      outgoingEmpty.textContent = "Unable to load outgoing requests.";
      incomingEmpty.hidden = false;
      outgoingEmpty.hidden = false;
    }
  })();
}

function showDiscoverStudents(): void {
  stopConnectionUiListeners();
  app.innerHTML = `
    <main class="discover-page">
      <header class="discover-header">
        <button id="discoverBack" class="profile-back" type="button" aria-label="Back to dashboard">←</button>
        <div>
          <p class="profile-eyebrow">CAMPUS CONNECT</p>
          <h1>Discover Students</h1>
          <p class="discover-intro">Find students who have chosen to share their profiles.</p>
        </div>
      </header>

      <section class="discover-controls" aria-label="Search and filter students">
        <label class="discover-search">
          <span>Search students</span>
          <input id="discoverSearch" type="search" placeholder="Search by name or username" autocomplete="off">
        </label>
        <label>
          <span>University</span>
          <select id="discoverUniversity"><option value="">All universities</option></select>
        </label>
        <label>
          <span>Course</span>
          <select id="discoverCourse"><option value="">All courses</option></select>
        </label>
        <label>
          <span>Year of study</span>
          <select id="discoverYear"><option value="">All years</option></select>
        </label>
        <button id="clearDiscoverFilters" class="discover-clear" type="button">Clear filters</button>
      </section>

      <p id="discoverStatus" class="discover-status" role="status" aria-live="polite"><span class="discover-spinner" aria-hidden="true"></span>Loading student profiles...</p>
      <div id="discoverError" class="discover-status discover-status-error" role="alert" hidden></div>
      <section id="discoverResults" class="discover-results" aria-label="Discoverable student profiles"></section>
    </main>
  `;

  document.getElementById("discoverBack")?.addEventListener("click", () => {
    stopStudentDiscoveryListener();
    showApp();
  });
  const searchInput = document.getElementById("discoverSearch") as HTMLInputElement;
  const universityFilter = document.getElementById("discoverUniversity") as HTMLSelectElement;
  const courseFilter = document.getElementById("discoverCourse") as HTMLSelectElement;
  const yearFilter = document.getElementById("discoverYear") as HTMLSelectElement;
  const status = document.getElementById("discoverStatus") as HTMLParagraphElement;
  const errorMessage = document.getElementById("discoverError") as HTMLDivElement;
  const results = document.getElementById("discoverResults") as HTMLElement;
  let students: DiscoverableStudent[] = [];
  let relationships = new Map<string, ConnectionRecord>();

  const buildOptions = (
    select: HTMLSelectElement,
    defaultLabel: string,
    options: Array<{ value: string; label: string }>,
    selectedValue: string
  ) => {
    select.innerHTML = `<option value="">${escapeHtml(defaultLabel)}</option>${options
      .map((option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`)
      .join("")}`;
    if (options.some((option) => option.value === selectedValue)) {
      select.value = selectedValue;
    }
  };

  const renderResults = () => {
    const searchTerm = searchInput.value.trim().toLocaleLowerCase();
    const universityId = universityFilter.value;
    const course = courseFilter.value;
    const year = yearFilter.value;
    const matches = students.filter((student) => {
      const matchesSearch =
        !searchTerm ||
        student.fullName.toLocaleLowerCase().includes(searchTerm) ||
        student.username.toLocaleLowerCase().includes(searchTerm);
      return (
        matchesSearch &&
        (!universityId || student.universityId === universityId) &&
        (!course || student.course === course) &&
        (!year || String(student.yearOfStudy ?? "") === year)
      );
    });

    results.replaceChildren();
    if (!matches.length) {
      const emptyState = document.createElement("p");
      emptyState.className = "discover-empty";
      emptyState.textContent = students.length
        ? "No students match these search terms or filters. Try clearing or adjusting them."
        : "No students have chosen to appear in Discover Students yet.";
      results.appendChild(emptyState);
      return;
    }

    for (const student of matches) {
      const universityName =
        enabledUniversities.find((university) => university.id === student.universityId)?.name ??
        student.universityId ??
        "University not set";
      const initials = student.fullName
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part.charAt(0).toUpperCase())
        .join("") || "?";
      const card = document.createElement("article");
      card.className = "discover-student-card";

      const avatar = document.createElement("span");
      avatar.className = "discover-avatar";
      const fallback = document.createElement("span");
      fallback.textContent = initials;
      avatar.appendChild(fallback);
      if (student.photoURL) {
        const image = document.createElement("img");
        image.src = student.photoURL;
        image.alt = "";
        image.addEventListener("error", () => image.remove());
        image.addEventListener("load", () => fallback.remove());
        avatar.appendChild(image);
      }

      const details = document.createElement("span");
      details.className = "discover-student-details";
      const name = document.createElement("strong");
      name.className = "discover-student-name";
      name.textContent = student.fullName;
      const username = document.createElement("span");
      username.className = "discover-student-username";
      username.textContent = `@${student.username}`;
      const university = document.createElement("span");
      university.className = "discover-student-meta";
      university.textContent = universityName;
      const courseAndYear = document.createElement("span");
      courseAndYear.className = "discover-student-meta";
      courseAndYear.textContent = [
        student.course || "Course not set",
        student.yearOfStudy ? `Year ${student.yearOfStudy}` : ""
      ].filter(Boolean).join(" · ");
      details.append(name, username, university, courseAndYear);

      if (student.skills) {
        const skills = document.createElement("span");
        skills.className = "discover-student-skills";
        skills.textContent = student.skills;
        details.appendChild(skills);
      }
      const actions = document.createElement("div");
      actions.className = "discover-student-actions";
      const profileButton = document.createElement("button");
      profileButton.type = "button";
      profileButton.className = "discover-profile-button";
      profileButton.textContent = "View profile";
      profileButton.addEventListener("click", () => {
        stopConnectionUiListeners();
        void viewPublicStudentProfile(student.publicProfileId, showDiscoverStudents);
      });
      actions.appendChild(profileButton);

      const state = connectionActionFor(
        relationships.get(student.publicProfileId) ?? null,
        currentUser?.uid ?? "",
        student.publicProfileId
      );
      const connectButton = document.createElement("button");
      connectButton.type = "button";
      connectButton.className = "connection-action-button";
      connectButton.textContent = state.label;
      connectButton.disabled = !state.action;
      connectButton.classList.toggle("connection-action-primary", state.action === "request");
      connectButton.classList.toggle("connection-action-muted", !state.action || state.action === "cancel");
      const actionFeedback = document.createElement("span");
      actionFeedback.className = "connection-action-feedback";
      actionFeedback.setAttribute("role", "status");
      connectButton.addEventListener("click", async () => {
        const latestState = connectionActionFor(
          relationships.get(student.publicProfileId) ?? null,
          currentUser?.uid ?? "",
          student.publicProfileId
        );
        if (!latestState.action || connectButton.disabled) return;
        connectButton.disabled = true;
        actionFeedback.textContent = "";
        actionFeedback.classList.remove("connection-action-error");
        try {
          const result = await updateStudentConnection(
            student.publicProfileId,
            latestState.action,
            relationships.get(student.publicProfileId) ?? null
          );
          actionFeedback.textContent = result === "accepted"
            ? "You are now connected."
            : latestState.action === "request"
              ? "Request sent."
              : latestState.action === "accept"
                ? "Request accepted."
                : "Request cancelled.";
        } catch (error) {
          console.error("Could not update student connection:", error);
          actionFeedback.textContent = error instanceof Error ? error.message : authErrorMessage(error);
          actionFeedback.classList.add("connection-action-error");
        } finally {
          connectButton.disabled = false;
          const updatedState = connectionActionFor(
            relationships.get(student.publicProfileId) ?? null,
            currentUser?.uid ?? "",
            student.publicProfileId
          );
          connectButton.textContent = updatedState.label;
          connectButton.disabled = !updatedState.action;
        }
      });
      actions.append(connectButton, actionFeedback);

      card.append(avatar, details, actions);
      card.addEventListener("click", (event) => {
        if ((event.target as HTMLElement).closest("button")) return;
        stopConnectionUiListeners();
        void viewPublicStudentProfile(student.publicProfileId, showDiscoverStudents);
      });
      results.appendChild(card);
    }
  };

  const updateFilters = () => {
    const selectedUniversity = universityFilter.value;
    const selectedCourse = courseFilter.value;
    const selectedYear = yearFilter.value;
    const universityIds = new Set([
      ...enabledUniversities.map((university) => university.id),
      ...students.map((student) => student.universityId).filter(Boolean)
    ]);

    buildOptions(
      universityFilter,
      "All universities",
      [...universityIds].sort((a, b) => a.localeCompare(b)).map((id) => ({
        value: id,
        label: enabledUniversities.find((university) => university.id === id)?.name ?? id
      })),
      selectedUniversity
    );
    buildOptions(
      courseFilter,
      "All courses",
      [...new Set(students.map((student) => student.course.trim()).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b))
        .map((value) => ({ value, label: value })),
      selectedCourse
    );
    buildOptions(
      yearFilter,
      "All years",
      [...new Set(students.map((student) => student.yearOfStudy).filter(
        (year): year is number => year !== null
      ))]
        .sort((a, b) => a - b)
        .map((year) => ({ value: String(year), label: `Year ${year}` })),
      selectedYear
    );
  };

  searchInput.addEventListener("input", renderResults);
  universityFilter.addEventListener("change", renderResults);
  courseFilter.addEventListener("change", renderResults);
  yearFilter.addEventListener("change", renderResults);
  document.getElementById("clearDiscoverFilters")?.addEventListener("click", () => {
    searchInput.value = "";
    universityFilter.value = "";
    courseFilter.value = "";
    yearFilter.value = "";
    renderResults();
    searchInput.focus();
  });

  const discoverableQuery = query(
    collection(db, "publicProfiles"),
    where("discoverable", "==", true)
  );
  studentDiscoveryUnsubscribe = onSnapshot(
    discoverableQuery,
    (snapshot) => {
      students = uniqueUserDocuments(snapshot.docs)
        .filter((document) => {
          const data = document.data();
          const universityId = String(data.universityId ?? pilotUniversityId);
          return (
            data.discoverable === true &&
            enabledUniversities.some((university) => university.id === universityId) &&
            document.id !== currentProfile?.publicProfileId
          );
        })
        .map((document) => {
          const data = document.data();
          return {
            publicProfileId: document.id,
            fullName: String(data.fullName ?? data.username ?? "Student"),
            username: String(data.username ?? data.fullName ?? "student"),
            universityId: String(data.universityId ?? pilotUniversityId),
            course: String(data.course ?? ""),
            yearOfStudy: normalizeYearOfStudy(data.yearOfStudy ?? data.year),
            skills: typeof data.skills === "string" ? data.skills : "",
            photoURL: typeof data.photoURL === "string" ? data.photoURL : ""
          };
        });

      errorMessage.hidden = true;
      status.hidden = true;
      updateFilters();
      renderResults();
    },
    (error) => {
      console.error("Could not load discoverable student profiles:", error);
      status.hidden = true;
      results.replaceChildren();
      errorMessage.textContent = "Student profiles could not be loaded. Check your connection or Firestore access, then try again.";
      errorMessage.hidden = false;
    }
  );

  discoveryConnectionsUnsubscribe = onSnapshot(
    query(
      collection(db, "connections"),
      where("participantUids", "array-contains", currentStudentUid())
    ),
    (snapshot) => {
      relationships = new Map<string, ConnectionRecord>();
      for (const relationshipDocument of snapshot.docs) {
        const connection = toConnectionRecord(
          relationshipDocument.id,
          relationshipDocument.data()
        );
        if (!connection) continue;
        const otherIndex = connection.participantUids.findIndex((uid) => uid !== currentUser?.uid);
        const otherProfileId = connection.participantProfileIds[otherIndex];
        if (otherProfileId) relationships.set(otherProfileId, connection);
      }
      renderResults();
    },
    (error) => {
      console.error("Could not load student connection states:", error);
      errorMessage.textContent = "Student profiles loaded, but connection states could not be loaded.";
      errorMessage.hidden = false;
    }
  );
}

type ProfileEdits = Pick<StudentProfile, "course" | "yearOfStudy" | "skills"> &
  Partial<Pick<StudentProfile, "photoURL">>;

const MAX_PROFILE_PHOTO_BYTES = 10 * 1024 * 1024;
const MAX_COMPRESSED_PHOTO_BYTES = 500 * 1024;

async function compressProfileImage(file: File): Promise<string> {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
    throw new Error("Choose a JPEG, PNG or WebP image.");
  }
  if (file.size > MAX_PROFILE_PHOTO_BYTES) {
    throw new Error("Choose an image smaller than 10 MB.");
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("The selected image could not be opened."));
      image.src = objectUrl;
    });

    if (!image.naturalWidth || !image.naturalHeight) {
      throw new Error("The selected image has invalid dimensions.");
    }

    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image processing is unavailable in this browser.");

    const initialScale = Math.min(1, 512 / image.naturalWidth, 512 / image.naturalHeight);
    let width = Math.max(1, Math.round(image.naturalWidth * initialScale));
    let height = Math.max(1, Math.round(image.naturalHeight * initialScale));

    for (let resizeAttempt = 0; resizeAttempt < 6; resizeAttempt += 1) {
      canvas.width = width;
      canvas.height = height;
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, width, height);
      context.drawImage(image, 0, 0, width, height);

      for (const quality of [0.82, 0.68, 0.54, 0.4]) {
        const blob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, "image/jpeg", quality)
        );
        if (blob && blob.size <= MAX_COMPRESSED_PHOTO_BYTES) {
          return await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
              if (typeof reader.result === "string") resolve(reader.result);
              else reject(new Error("The processed image could not be read."));
            };
            reader.onerror = () =>
              reject(reader.error ?? new Error("The processed image could not be read."));
            reader.readAsDataURL(blob);
          });
        }
      }

      width = Math.max(1, Math.floor(width * 0.75));
      height = Math.max(1, Math.floor(height * 0.75));
    }

    throw new Error("This photo could not be compressed enough to save. Choose a different image.");
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function saveStudentProfileChanges(
  changes: ProfileEdits
): Promise<void> {
  if (!currentUser || !currentProfile) throw new Error("No student profile is loaded.");

  const updatedAt = serverTimestamp();
  const updateData: Record<string, unknown> = {
    ...changes,
    year: `Year ${changes.yearOfStudy}`,
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
      ...changes,
      updatedAt
    };
    return;
  }

  currentProfile = {
    ...currentProfile,
    ...changes,
    updatedAt
  };

  if (currentProfile.legacyDocumentId) {
    try {
      await setDoc(doc(db, "users", currentProfile.legacyDocumentId), updateData, { merge: true });
    } catch (error) {
      console.error("Could not synchronize legacy email-keyed profile:", error);
      throw new Error(
        "Your UID profile was saved, but its legacy email-keyed copy could not be synchronized. Try saving again."
      );
    }
  }
  if (currentProfile.discoverable) {
    try {
      await syncPublicProfile();
    } catch (error) {
      console.error("Could not synchronize public student profile:", error);
      throw new Error(
        "Your private profile was saved, but its discoverable profile could not be updated."
      );
    }
  }
}

async function ensurePublicProfileRecord(): Promise<void> {
  if (!currentUser || !currentProfile) return;
  try {
    const uid = currentStudentUid();
    const userRef = doc(db, "users", uid);
    const publicProfileId = await runTransaction(db, async (transaction) => {
      const profileSnapshot = await transaction.get(userRef);
      if (!profileSnapshot.exists()) {
        throw new Error("Your student profile is not available.");
      }
      const profileData = profileSnapshot.data();
      const id = typeof profileData.publicProfileId === "string"
        ? profileData.publicProfileId
        : currentProfile?.publicProfileId ?? crypto.randomUUID();
      const discoverable = profileData.discoverable === true;
      if (profileData.publicProfileId !== id) {
        transaction.update(userRef, {
          publicProfileId: id,
          updatedAt: serverTimestamp()
        });
      }
      transaction.set(doc(db, "publicProfileOwners", id), { uid }, { merge: true });
      if (discoverable) {
        transaction.set(
          doc(db, "publicProfiles", id),
          publicProfileProjection(profileData, id, uid)
        );
      }
      return id;
    });
    currentProfile = {
      ...currentProfile,
      publicProfileId,
      discoverable: currentProfile.discoverable
    };
  } catch (error) {
    console.error("Could not initialize public student profile metadata:", error);
  }
}

async function syncPublicProfile(): Promise<void> {
  if (!currentUser || !currentProfile) throw new Error("No student profile is loaded.");
  if (!currentProfile.publicProfileId) await ensurePublicProfileRecord();
  const uid = currentStudentUid();
  const userRef = doc(db, "users", uid);
  await runTransaction(db, async (transaction) => {
    const profileSnapshot = await transaction.get(userRef);
    if (!profileSnapshot.exists()) throw new Error("Your student profile is not available.");
    const data = profileSnapshot.data();
    const id = data.publicProfileId;
    if (typeof id !== "string") {
      throw new Error("Your public student profile is still being prepared.");
    }
    if (data.discoverable !== true) return;
    transaction.set(
      doc(db, "publicProfiles", id),
      publicProfileProjection(data, id, uid)
    );
    transaction.set(doc(db, "publicProfileOwners", id), { uid }, { merge: true });
  });
}

async function saveStudentDiscoveryPreference(discoverable: boolean): Promise<boolean> {
  if (!currentUser || !currentProfile) throw new Error("No student profile is loaded.");

  if (!currentProfile.publicProfileId) await ensurePublicProfileRecord();
  const uid = currentStudentUid();
  const userRef = doc(db, "users", uid);
  const updatedAt = serverTimestamp();
  const publicProfileId = await runTransaction(db, async (transaction) => {
    const profileSnapshot = await transaction.get(userRef);
    if (!profileSnapshot.exists()) throw new Error("Your student profile is not available.");
    const data = profileSnapshot.data();
    const id = data.publicProfileId;
    if (typeof id !== "string") {
      throw new Error("Your public student profile is still being prepared.");
    }
    transaction.update(userRef, { discoverable, updatedAt });
    const ownerRef = doc(db, "publicProfileOwners", id);
    transaction.set(ownerRef, { uid }, { merge: true });
    if (discoverable) {
      transaction.set(
        doc(db, "publicProfiles", id),
        publicProfileProjection({ ...data, discoverable }, id, uid)
      );
    } else {
      transaction.delete(doc(db, "publicProfiles", id));
    }
    return id;
  });
  currentProfile = { ...currentProfile, discoverable, publicProfileId };

  if (currentProfile.legacyDocumentId) {
    await setDoc(doc(db, "users", currentProfile.legacyDocumentId), {
      discoverable,
      updatedAt
    }, { merge: true });
  }
  return true;
}

async function viewPublicStudentProfile(
  publicProfileId: string,
  onBack: () => void = openChatModule
): Promise<void> {
  stopProfileConnectionListener();
  let profileData: DocumentData | null = null;
  try {
    const profileSnapshot = await getDoc(doc(db, "publicProfiles", publicProfileId));
    if (profileSnapshot.exists() && profileSnapshot.data().discoverable === true) {
      profileData = profileSnapshot.data();
    }
  } catch (error) {
    console.error("Could not load student profile:", error);
    showUnavailableStudentProfile(
      onBack,
      "This student profile could not be loaded. Check your connection and try again."
    );
    return;
  }
  if (!profileData) {
    showUnavailableStudentProfile(onBack, "This student profile is no longer available.");
    return;
  }
  renderStudentProfileView(profileData, publicProfileId, onBack);
}

function viewStudentProfileFromConnection(
  student: DiscoverableStudent,
  onBack: () => void
): void {
  stopProfileConnectionListener();
  renderStudentProfileView(student, student.publicProfileId, onBack);
}

function showUnavailableStudentProfile(onBack: () => void, message: string): void {
  app.innerHTML = `
    <div class="profile-page">
      <button id="backBtn" class="profile-back" type="button">← Back</button>
      <p class="discover-status discover-status-error" role="alert">${escapeHtml(message)}</p>
    </div>
  `;
  document.getElementById("backBtn")?.addEventListener("click", onBack);
}

function renderStudentProfileView(
  user: DocumentData,
  publicProfileId: string,
  onBack: () => void
): void {
  const ownProfile = publicProfileId === currentProfile?.publicProfileId;
  const universityId = String(user.universityId ?? pilotUniversityId);
  const universityName =
    enabledUniversities.find((university) => university.id === universityId)?.name ??
    universityId;

  app.innerHTML = `
    <div class="profile-page">
      <header class="profile-header">
        <button id="backBtn" class="profile-back" type="button" aria-label="Back">←</button>
        <div>
          <p class="profile-eyebrow">CAMPUS CONNECT</p>
          <h1>Student Profile</h1>
        </div>
      </header>
      <section class="profile-card profile-summary profile-public-view">
        <div class="profile-identity">
          <div class="profile-avatar">
            <span id="publicProfileFallback" aria-hidden="true">${escapeHtml(
              String(user.fullName ?? user.username ?? "Student")
                .split(/\s+/)
                .filter(Boolean)
                .slice(0, 2)
                .map((part: string) => part.charAt(0).toUpperCase())
                .join("") || "?"
            )}</span>
            ${typeof user.photoURL === "string" && user.photoURL
              ? `<img src="${escapeHtml(user.photoURL)}" alt="${escapeHtml(user.fullName || "Student")} profile photograph">`
              : ""}
          </div>
          <div class="profile-identity-copy">
            <p class="profile-eyebrow">STUDENT</p>
            <h2>${escapeHtml(user.fullName || user.username || "Student")}</h2>
            <p class="profile-username">@${escapeHtml(user.username || "student")}</p>
          </div>
        </div>
        <dl class="profile-details">
          <div><dt>University</dt><dd>${escapeHtml(universityName)}</dd></div>
          <div><dt>Course / programme</dt><dd>${escapeHtml(user.course || "Not set")}</dd></div>
          <div><dt>Year of study</dt><dd>${escapeHtml(normalizeYearOfStudy(user.yearOfStudy ?? user.year) ?? "Not set")}</dd></div>
          <div><dt>Skills and interests</dt><dd class="profile-skills">${escapeHtml(user.skills || "Not set")}</dd></div>
        </dl>
        ${ownProfile ? "" : `
          <div class="profile-connection-actions" id="profileConnectionActions"></div>
        `}
      </section>
    </div>
  `;

  document.getElementById("backBtn")
    ?.addEventListener("click", () => {
      stopProfileConnectionListener();
      onBack();
    });
  if (!ownProfile) {
    const actions = document.getElementById("profileConnectionActions");
    if (actions) {
      profileConnectionUnsubscribe = subscribeConnectionAction(publicProfileId, actions);
    }
  }
}
