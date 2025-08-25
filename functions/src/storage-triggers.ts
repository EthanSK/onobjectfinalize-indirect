import admin from 'firebase-admin';
import { onObjectFinalized } from 'firebase-functions/v2/storage';
import { logger } from 'firebase-functions';

// Initialize Admin SDK only once.
if (!admin.apps.length) {
  admin.initializeApp();
}

// Trigger options like parent project
const triggerOptions = {
  memory: '512MiB' as const,
  maxInstances: 10,
  invoker: 'private' as const,
  concurrency: 1000, // Key: high concurrency like parent project
};

// Storage v2 onObjectFinalized trigger: when the file is finalized, mark Firestore doc with finalizedAt.
export const onUploadFileFinalize = onObjectFinalized(
  {
    ...triggerOptions,
  },
  async (event) => {
    logger.info('onUploadFileFinalize', { name: event.data.name });

    const name = event.data.name;
    if (!name) return;
    if (!name.startsWith('uploads/')) {
      return; // Ignore other files.
    }

    // Try to access metadata like parent project
    const metadata = event.data.metadata;

    // **KEY: Add upload token verification (like parent project)**
    if (metadata?.uploadToken) {
      const tokenRef = admin
        .firestore()
        .collection('storageUploadTokens')
        .doc(metadata.uploadToken);

      // **CRITICAL: Multiple Firestore operations per Storage event (like parent)**
      const tokenDoc = await tokenRef.get();
      const tokenData = tokenDoc.data();

      if (!tokenData) {
        logger.warn('upload token missing', {
          uploadToken: metadata.uploadToken,
        });
        return;
      }

      if (tokenData.isConsumed) {
        logger.debug?.('token already consumed', {
          uploadToken: metadata.uploadToken,
        });
        return;
      }

      if (tokenData.fileStoragePath !== name) {
        logger.warn('token file mismatch', {
          expected: tokenData.fileStoragePath,
          actual: name,
        });
        return;
      }

      // **CRITICAL: Mark token as consumed (FIRESTORE WRITE)**
      await tokenRef.update({
        dateConsumed: admin.firestore.FieldValue.serverTimestamp(),
        isConsumed: true,
      });
    }

    // Expect pattern uploads/{uploadId}-<counter>-<rand>.txt
    const base = name.split('/').pop();
    if (!base) return;
    const mainIdPart = base.split('-')[0];
    const uploadId = mainIdPart.replace(/\.txt$/, '');

    const ref = admin.firestore().doc(`uploads/${uploadId}`);

    // **CRITICAL: Additional Firestore update (3rd Firestore operation per Storage event)**
    await ref.set(
      {
        lastFileFinalizedAt: admin.firestore.FieldValue.serverTimestamp(),
        processing: true,
        verifiedUploads: admin.firestore.FieldValue.arrayUnion(name),
      },
      { merge: true },
    );
  },
);
