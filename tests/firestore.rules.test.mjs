import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { before, after, beforeEach, test } from "node:test";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment
} from "@firebase/rules-unit-testing";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where
} from "firebase/firestore";

const projectId = "campus-connect-cbba5";
let testEnv;

function studentProfile(uid, email, extras = {}) {
  return {
    uid,
    fullName: "Student Example",
    username: uid,
    email,
    universityId: "maseno-university",
    campusId: null,
    course: "Geography",
    yearOfStudy: 2,
    year: "Year 2",
    role: "student",
    emailVerified: false,
    verificationStatus: "unverified",
    createdAt: new Date(),
    updatedAt: new Date(),
    skills: "GIS",
    photoURL: "",
    discoverable: false,
    ...extras
  };
}

function publicProfile(uid, publicProfileId, extras = {}) {
  return {
    ownerUid: uid,
    publicProfileId,
    fullName: "Student Example",
    username: uid,
    universityId: "maseno-university",
    course: "Geography",
    yearOfStudy: 2,
    skills: "GIS",
    photoURL: "",
    discoverable: true,
    ...extras
  };
}

function publicSnapshot(publicProfileId, data) {
  return {
    publicProfileId,
    fullName: data.fullName,
    username: data.username,
    universityId: data.universityId,
    course: data.course,
    yearOfStudy: data.yearOfStudy,
    skills: data.skills,
    photoURL: data.photoURL
  };
}

async function seed(path, data) {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), path), data);
  });
}

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId,
    firestore: {
      rules: await readFile(new URL("../firestore.rules", import.meta.url), "utf8")
    }
  });
});

beforeEach(async () => {
  await testEnv.clearFirestore();
});

after(async () => {
  await testEnv.cleanup();
});

test("unauthenticated users cannot read or write protected collections", async () => {
  await seed("users/student-a", studentProfile("student-a", "a@example.edu"));
  const unauthenticated = testEnv.unauthenticatedContext().firestore();
  await assertFails(getDoc(doc(unauthenticated, "users/student-a")));
  await assertFails(setDoc(doc(unauthenticated, "hostels/new"), {
    name: "Hostel",
    ownerUid: "student-a"
  }));
});

test("registration can create only the authenticated student's initial profile", async () => {
  const student = testEnv.authenticatedContext("student-a", {
    email: "a@example.edu",
    email_verified: false
  }).firestore();

  await assertSucceeds(setDoc(
    doc(student, "users/student-a"),
    studentProfile("student-a", "a@example.edu")
  ));
  await assertFails(setDoc(
    doc(student, "users/student-b"),
    studentProfile("student-b", "b@example.edu")
  ));
  await assertFails(setDoc(
    doc(student, "users/student-a"),
    studentProfile("student-a", "a@example.edu", { role: "admin" })
  ));
});

test("students can read their own UID profile but cannot read or modify another's", async () => {
  await seed("users/student-a", studentProfile("student-a", "a@example.edu"));
  await seed("users/student-b", studentProfile("student-b", "b@example.edu"));
  const student = testEnv.authenticatedContext("student-a", {
    email: "a@example.edu",
    email_verified: false
  }).firestore();

  await assertSucceeds(getDoc(doc(student, "users/student-a")));
  await assertFails(getDoc(doc(student, "users/student-b")));
  await assertFails(updateDoc(doc(student, "users/student-b"), {
    course: "Changed",
    updatedAt: serverTimestamp()
  }));
});

test("students cannot modify protected profile role or verification fields", async () => {
  await seed("users/student-a", studentProfile("student-a", "a@example.edu"));
  const student = testEnv.authenticatedContext("student-a", {
    email: "a@example.edu",
    email_verified: false
  }).firestore();
  const profile = doc(student, "users/student-a");

  await assertSucceeds(updateDoc(profile, {
    course: "Updated Geography",
    yearOfStudy: 3,
    year: "Year 3",
    updatedAt: serverTimestamp()
  }));
  await assertFails(updateDoc(profile, {
    role: "admin",
    updatedAt: serverTimestamp()
  }));
  await assertFails(updateDoc(profile, {
    emailVerified: true,
    updatedAt: serverTimestamp()
  }));
  await assertFails(updateDoc(profile, {
    verificationStatus: "verified",
    updatedAt: serverTimestamp()
  }));
});

test("students can initialize only their own public profile projection atomically", async () => {
  await seed("users/student-a", studentProfile("student-a", "a@example.edu"));
  const student = testEnv.authenticatedContext("student-a", {
    email: "a@example.edu",
    email_verified: false
  }).firestore();
  const profileRef = doc(student, "users/student-a");
  const ownerRef = doc(student, "publicProfileOwners/profile-a");
  const projectionRef = doc(student, "publicProfiles/profile-a");

  await assertSucceeds(runTransaction(student, async (transaction) => {
    transaction.update(profileRef, {
      publicProfileId: "profile-a",
      discoverable: true,
      updatedAt: serverTimestamp()
    });
    transaction.set(ownerRef, { uid: "student-a" });
    transaction.set(projectionRef, publicProfile("student-a", "profile-a"));
  }));
  const visible = await assertSucceeds(getDoc(projectionRef));
  assert.deepEqual(Object.keys(visible.data()).sort(), [
    "course",
    "discoverable",
    "fullName",
    "ownerUid",
    "photoURL",
    "publicProfileId",
    "skills",
    "universityId",
    "username",
    "yearOfStudy"
  ]);
  await assertFails(updateDoc(profileRef, {
    publicProfileId: "another-profile",
    updatedAt: serverTimestamp()
  }));
  await assertFails(setDoc(doc(student, "publicProfileOwners/another-profile"), {
    uid: "student-b"
  }));
});

test("connection participants can request, respond, cancel, retry and remove securely", async () => {
  const profileA = studentProfile("student-a", "a@example.edu", {
    publicProfileId: "profile-a"
  });
  const profileB = studentProfile("student-b", "b@example.edu", {
    publicProfileId: "profile-b"
  });
  const projectionA = publicProfile("student-a", "profile-a");
  const projectionB = publicProfile("student-b", "profile-b");
  await seed("users/student-a", profileA);
  await seed("users/student-b", profileB);
  await seed("publicProfiles/profile-a", projectionA);
  await seed("publicProfiles/profile-b", projectionB);

  const studentA = testEnv.authenticatedContext("student-a", {
    email: "a@example.edu",
    email_verified: false
  }).firestore();
  const studentB = testEnv.authenticatedContext("student-b", {
    email: "b@example.edu",
    email_verified: false
  }).firestore();
  const outsider = testEnv.authenticatedContext("student-c").firestore();
  const connectionRef = doc(studentA, "connections/pair_student-a~student-b");
  const participantUids = ["student-a", "student-b"];
  const participantProfileIds = ["profile-a", "profile-b"];
  const connection = {
    pairId: connectionRef.id,
    participantUids,
    participantProfileIds,
    requesterUid: "student-a",
    recipientUid: "student-b",
    requesterProfile: publicSnapshot("profile-a", projectionA),
    recipientProfile: publicSnapshot("profile-b", projectionB),
    status: "pending",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    updatedByUid: "student-a"
  };

  await assertSucceeds(runTransaction(studentA, async (transaction) => {
    transaction.set(connectionRef, connection);
  }));
  await assertSucceeds(getDoc(connectionRef));
  await assertSucceeds(getDocs(query(
    collection(studentB, "connections"),
    where("participantUids", "array-contains", "student-b")
  )));
  await assertFails(getDocs(collection(studentB, "connections")));
  await assertFails(getDocs(query(
    collection(outsider, "connections"),
    where("participantUids", "array-contains", "student-b")
  )));
  await assertFails(getDoc(doc(outsider, "connections/pair_student-a~student-b")));
  await assertFails(setDoc(doc(studentA, "connections/not-canonical"), connection));
  await assertFails(updateDoc(connectionRef, {
    status: "accepted",
    updatedAt: serverTimestamp(),
    updatedByUid: "student-a"
  }));
  await assertFails(updateDoc(doc(studentB, connectionRef.path), {
    status: "accepted",
    recipientProfile: {
      ...connection.recipientProfile,
      email: "private@example.edu"
    },
    updatedAt: serverTimestamp(),
    updatedByUid: "student-b"
  }));

  await assertSucceeds(updateDoc(doc(studentB, connectionRef.path), {
    status: "rejected",
    updatedAt: serverTimestamp(),
    updatedByUid: "student-b"
  }));
  await assertSucceeds(updateDoc(connectionRef, {
    status: "pending",
    updatedAt: serverTimestamp(),
    updatedByUid: "student-a"
  }));
  await assertSucceeds(updateDoc(connectionRef, {
    status: "cancelled",
    updatedAt: serverTimestamp(),
    updatedByUid: "student-a"
  }));
  await assertSucceeds(updateDoc(connectionRef, {
    status: "pending",
    updatedAt: serverTimestamp(),
    updatedByUid: "student-a"
  }));
  await assertSucceeds(updateDoc(doc(studentB, connectionRef.path), {
    status: "accepted",
    updatedAt: serverTimestamp(),
    updatedByUid: "student-b"
  }));
  await assertFails(updateDoc(doc(outsider, connectionRef.path), {
    status: "cancelled",
    updatedAt: serverTimestamp(),
    updatedByUid: "student-c"
  }));
  await assertSucceeds(updateDoc(connectionRef, {
    status: "cancelled",
    updatedAt: serverTimestamp(),
    updatedByUid: "student-a"
  }));
  await assertFails(deleteDoc(connectionRef));
});

test("chat participants can access legacy email chats and create UID chats without exposing them", async () => {
  await seed("users/student-a", studentProfile("student-a", "a@example.edu", {
    publicProfileId: "profile-a"
  }));
  await seed("users/student-b", studentProfile("student-b", "b@example.edu", {
    publicProfileId: "profile-b"
  }));
  await seed("publicProfiles/profile-a", publicProfile("student-a", "profile-a"));
  await seed("publicProfiles/profile-b", publicProfile("student-b", "profile-b"));
  await seed("chats/a@example.edu_b@example.edu", {
    participantUids: ["student-a", "student-b"],
    participantProfileIds: ["profile-a", "profile-b"]
  });
  await seed("chats/a@example.edu_b@example.edu/messages/old", {
    text: "Legacy history",
    sender: "a@example.edu",
    createdAt: new Date()
  });
  const studentA = testEnv.authenticatedContext("student-a", {
    email: "a@example.edu"
  }).firestore();
  const outsider = testEnv.authenticatedContext("student-c", {
    email: "c@example.edu"
  }).firestore();

  await assertSucceeds(getDoc(doc(studentA, "chats/a@example.edu_b@example.edu/messages/old")));
  await assertSucceeds(getDocs(query(
    collection(studentA, "chats"),
    where("participantUids", "array-contains", "student-a")
  )));
  await assertFails(getDocs(collection(studentA, "chats")));
  await assertFails(getDoc(doc(outsider, "chats/a@example.edu_b@example.edu/messages/old")));
  await assertFails(addDoc(collection(studentA, "chats/a@example.edu_b@example.edu/messages"), {
    text: "Impersonation",
    sender: "b@example.edu",
    senderUid: "student-b",
    createdAt: serverTimestamp()
  }));
  await assertSucceeds(addDoc(collection(studentA, "chats/a@example.edu_b@example.edu/messages"), {
    text: "Authorized message",
    sender: "a@example.edu",
    senderUid: "student-a",
    createdAt: serverTimestamp()
  }));
  await assertFails(updateDoc(doc(studentA, "chats/a@example.edu_b@example.edu/messages/old"), {
    text: "Changed"
  }));
  await assertFails(deleteDoc(doc(studentA, "chats/a@example.edu_b@example.edu/messages/old")));
  await assertFails(getDoc(doc(outsider, "chats/a@example.edu_b@example.edu")));

  const chatRef = doc(studentA, "chats/chat_student-a~student-b");
  await assertSucceeds(runTransaction(studentA, async (transaction) => {
    transaction.set(chatRef, {
      participantUids: ["student-a", "student-b"],
      participantProfileIds: ["profile-a", "profile-b"],
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
  }));
  await assertSucceeds(getDoc(chatRef));
  await assertFails(getDoc(doc(outsider, chatRef.path)));
  await assertFails(updateDoc(chatRef, {
    participantUids: ["student-a", "student-c"]
  }));
});

test("ordinary users cannot publish official announcements", async () => {
  const user = testEnv.authenticatedContext("student-a").firestore();
  await assertFails(addDoc(collection(user, "announcements"), {
    title: "Notice",
    message: "Student-created notice",
    type: "general",
    author: "Student",
    createdAt: serverTimestamp(),
    pinned: false
  }));

  const admin = testEnv.authenticatedContext("admin-a", { admin: true }).firestore();
  await assertSucceeds(addDoc(collection(admin, "announcements"), {
    title: "Notice",
    message: "Official notice",
    type: "general",
    author: "Admin",
    createdAt: serverTimestamp(),
    pinned: false
  }));
});

test("hostel owners and administrators may manage listings but not other owners' listings", async () => {
  await seed("hostels/owned-by-b", {
    name: "B Hostel",
    rent: 10000,
    water: true,
    wifi: true,
    lat: -0.003,
    lng: 34.603,
    distanceKm: null,
    durationMin: null,
    ownerUid: "student-b"
  });
  await seed("hostels/legacy", {
    name: "Legacy Hostel",
    rent: 8000,
    water: false,
    wifi: false,
    lat: -0.004,
    lng: 34.604
  });
  const studentA = testEnv.authenticatedContext("student-a").firestore();
  const studentB = testEnv.authenticatedContext("student-b").firestore();
  const admin = testEnv.authenticatedContext("admin-a", { admin: true }).firestore();

  await assertFails(updateDoc(doc(studentA, "hostels/owned-by-b"), { name: "Hijacked" }));
  await assertSucceeds(updateDoc(doc(studentB, "hostels/owned-by-b"), { name: "Updated" }));
  await assertFails(deleteDoc(doc(studentA, "hostels/owned-by-b")));
  await assertFails(updateDoc(doc(studentB, "hostels/legacy"), { name: "Adopted" }));
  await assertSucceeds(updateDoc(doc(admin, "hostels/legacy"), { name: "Admin updated" }));
});

test("discovery exposes only safe profiles and profile owners control their projection", async () => {
  await seed("users/student-a", studentProfile("student-a", "a@example.edu", {
    publicProfileId: "profile-visible",
    discoverable: true
  }));
  await seed("publicProfileOwners/profile-visible", { uid: "student-a" });
  await seed("publicProfiles/profile-visible", publicProfile("student-a", "profile-visible"));
  const legacyProjection = publicProfile("student-b", "legacy-visible");
  delete legacyProjection.ownerUid;
  delete legacyProjection.publicProfileId;
  await seed("publicProfiles/legacy-visible", legacyProjection);
  await seed("publicProfiles/profile-hidden", publicProfile(
    "student-b",
    "profile-hidden",
    { discoverable: false }
  ));
  const student = testEnv.authenticatedContext("student-a").firestore();

  const visible = await assertSucceeds(getDoc(doc(student, "publicProfiles/profile-visible")));
  assert.equal(visible.data().email, undefined);
  assert.equal(visible.data().role, undefined);
  const legacyVisible = await assertSucceeds(
    getDoc(doc(student, "publicProfiles/legacy-visible"))
  );
  assert.equal(legacyVisible.data().email, undefined);
  await assertFails(getDoc(doc(student, "publicProfiles/profile-hidden")));
  const discovery = await assertSucceeds(getDocs(query(
    collection(student, "publicProfiles"),
    where("discoverable", "==", true)
  )));
  assert.deepEqual(
    discovery.docs.map((profile) => profile.id).sort(),
    ["legacy-visible", "profile-visible"]
  );
  for (const profile of discovery.docs) {
    assert.equal(profile.data().email, undefined);
    assert.equal(profile.data().role, undefined);
  }
  await assertFails(setDoc(doc(student, "publicProfiles/profile-forged"), {
    ...publicProfile("student-a", "profile-forged"),
    email: "private@example.edu"
  }));
  await assertFails(getDoc(doc(student, "publicProfileOwners/profile-visible")));
  await assertFails(updateDoc(doc(student, "publicProfiles/profile-visible"), {
    email: "private@example.edu"
  }));

  await assertSucceeds(runTransaction(student, async (transaction) => {
    transaction.update(doc(student, "users/student-a"), { discoverable: false, updatedAt: serverTimestamp() });
    transaction.delete(doc(student, "publicProfiles/profile-visible"));
  }));
  await assertFails(getDoc(doc(student, "publicProfiles/profile-visible")));
});

test("legacy email-keyed profiles remain restricted to their owning email and UID", async () => {
  await seed("users/a@example.edu", studentProfile("student-a", "a@example.edu"));
  await seed("users/b@example.edu", studentProfile("student-b", "b@example.edu"));
  const studentA = testEnv.authenticatedContext("student-a", {
    email: "a@example.edu",
    email_verified: false
  }).firestore();

  await assertSucceeds(getDoc(doc(studentA, "users/a@example.edu")));
  await assertSucceeds(updateDoc(doc(studentA, "users/a@example.edu"), {
    skills: "Updated",
    updatedAt: serverTimestamp()
  }));
  await assertFails(getDoc(doc(studentA, "users/b@example.edu")));
  await assertFails(updateDoc(doc(studentA, "users/b@example.edu"), {
    skills: "Changed",
    updatedAt: serverTimestamp()
  }));
});

test("unmatched collections are denied by default", async () => {
  const user = testEnv.authenticatedContext("student-a").firestore();
  await assertFails(getDocs(collection(user, "unlistedCollection")));
  await assertFails(setDoc(doc(user, "unlistedCollection/document"), { value: true }));
});
