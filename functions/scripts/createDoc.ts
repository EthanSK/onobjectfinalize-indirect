import admin from 'firebase-admin';

// Use the same project ID as .firebaserc to ensure writes hit the same emulator namespace as Functions
const DEFAULT_EMULATOR_PROJECT_ID =
  'firebase-cli-emulator-race-condition-repro';

if (!process.env.GOOGLE_CLOUD_PROJECT && !process.env.GCLOUD_PROJECT) {
  process.env.GOOGLE_CLOUD_PROJECT = DEFAULT_EMULATOR_PROJECT_ID;
}

// Emit explicit diagnostics so we can see mismatches quickly
if (!process.env.FIRESTORE_EMULATOR_HOST) {
  // Allow script invocation to still work if caller forgot to set it
  process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
}
if (
  !process.env.FIREBASE_STORAGE_EMULATOR_HOST &&
  !process.env.STORAGE_EMULATOR_HOST
) {
  process.env.FIREBASE_STORAGE_EMULATOR_HOST = '127.0.0.1:9199';
  process.env.STORAGE_EMULATOR_HOST = '127.0.0.1:9199';
}

console.log('[createDoc] project', process.env.GOOGLE_CLOUD_PROJECT);

if (!admin.apps.length) {
  admin.initializeApp({ projectId: process.env.GOOGLE_CLOUD_PROJECT });
  console.log('[createDoc] admin init');
}

async function main() {
  console.log('Creating test docs...');

  // Create multiple documents rapidly (like clicking confirm timings multiple times)
  const promises = Array.from({ length: 3 }).map(async (_, i) => {
    const col = admin.firestore().collection('uploads');
    const docRef = await col.add({
      content: `Rapid test content ${i} ` + new Date().toISOString(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      generate: false,
      testRun: i,
    });
    console.log(`Created uploads/${docRef.id}`);

    // Add slight delay between creates to stagger the triggers
    await new Promise((resolve) => setTimeout(resolve, i * 100));

    // Now flip generate -> true to trigger onDocumentUpdated logic.
    await docRef.update({ generate: true });
    console.log(`Updated uploads/${docRef.id} generate=true`);

    return docRef.id;
  });

  const docIds = await Promise.all(promises);
  console.log(`Done. Docs: ${docIds.join(', ')}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
