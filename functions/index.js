const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");
const crypto = require("crypto");

admin.initializeApp();
setGlobalOptions({ region: "us-central1", maxInstances: 10 });

const uploadPassword = defineSecret("UPLOAD_PASSWORD");
const BATCH_SIZE = 100;

function passwordsMatch(provided, expected) {
  const a = Buffer.from(String(provided ?? ""), "utf8");
  const b = Buffer.from(String(expected ?? ""), "utf8");
  const width = Math.max(a.length, b.length, 1);
  const paddedA = Buffer.alloc(width);
  const paddedB = Buffer.alloc(width);
  a.copy(paddedA);
  b.copy(paddedB);
  return crypto.timingSafeEqual(paddedA, paddedB) && a.length === b.length;
}

exports.loginWithUploadPassword = onCall(
  {
    secrets: [uploadPassword],
    cors: true,
  },
  async (request) => {
    const password = request.data?.password;
    const expected = uploadPassword.value();

    if (typeof password !== "string" || !passwordsMatch(password, expected)) {
      throw new HttpsError("unauthenticated", "Invalid upload password.");
    }

    const token = await admin.auth().createCustomToken("shared-uploader", {
      role: "uploader",
    });

    return { token };
  }
);

exports.recordDownload = onCall({ cors: true }, async (request) => {
  const shareId = request.data?.shareId;
  if (
    typeof shareId !== "string" ||
    !/^[0-9a-fA-F-]{36}$/.test(shareId)
  ) {
    throw new HttpsError("invalid-argument", "Invalid share id.");
  }

  const ref = admin.firestore().collection("shares").doc(shareId);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "Share not found.");
  }

  const data = snap.data();
  if (data.expiresAt.toMillis() <= Date.now()) {
    throw new HttpsError("failed-precondition", "Share expired.");
  }

  await ref.update({
    downloadCount: admin.firestore.FieldValue.increment(1),
  });

  return { ok: true };
});

exports.cleanupExpiredShares = onSchedule(
  {
    schedule: "every 60 minutes",
    timeZone: "UTC",
  },
  async () => {
    const db = admin.firestore();
    const bucket = admin.storage().bucket();
    const now = admin.firestore.Timestamp.now();

    const snapshot = await db
      .collection("shares")
      .where("expiresAt", "<=", now)
      .limit(BATCH_SIZE)
      .get();

    for (const doc of snapshot.docs) {
      const data = doc.data();
      try {
        if (data.storagePath) {
          await bucket.file(data.storagePath).delete({ ignoreNotFound: true });
        }
        await doc.ref.delete();
      } catch (error) {
        console.error("Failed to delete expired share", doc.id, error);
      }
    }

    console.log(`Cleanup processed ${snapshot.size} expired share(s).`);
  }
);
