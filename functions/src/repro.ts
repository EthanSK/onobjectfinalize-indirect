// Minimal reproduction: Firestore onDocumentUpdated trigger indirectly causes
// Storage onObjectFinalized events via in-memory Express + axiosist calls.
// Shows potential misrouting / cross-trigger interference when using
// axiosist (request adapter) inside a Firestore trigger with high concurrency.

import admin from 'firebase-admin';
import { logger } from 'firebase-functions';
import { onDocumentUpdated } from 'firebase-functions/v2/firestore';
import { onObjectFinalized } from 'firebase-functions/v2/storage';
import express from 'express';
import axios from 'axios';

// Initialize Admin SDK once.
if (!admin.apps.length) {
  admin.initializeApp();
}

// High concurrency mirrors original environment (key for reproduction)
const triggerOptions = {
  memory: '512MiB' as const,
  maxInstances: 10,
  invoker: 'private' as const,
  concurrency: 1000,
};

// ---------------------------------------------------------------------------
// In-memory Express app + axiosist adapter usage
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());

// Endpoint invoked only via in-memory axios (axiosist) inside the Firestore trigger.
app.post('/process-clip', async (req, res) => {
  const { uploadId, clipId, clipIndex } = req.body as {
    uploadId: string; clipId: string; clipIndex: number;
  };
  logger.info('process-clip begin', { uploadId, clipId, clipIndex });

  // Simulate brief variable work (timing window) but keep it tiny.
  await new Promise(r => setTimeout(r, 50 + Math.random() * 50));

  // Create exactly 1 small text object per clip (sufficient to trigger finalize).
  const bucket = admin.storage().bucket();
  const rand = Math.random().toString(36).slice(2, 8);
  const filePath = `uploads/${uploadId}-${clipIndex}-${rand}.txt`;

  // Create a token doc (mirrors parent pattern). Storage finalize will look it up.
  const uploadToken = `tok-${uploadId}-${clipIndex}-${rand}`;
  const tokenRef = admin.firestore().collection('storageUploadTokens').doc(uploadToken);
  await tokenRef.set({
    fileStoragePath: filePath,
    isConsumed: false,
    dateCreated: admin.firestore.FieldValue.serverTimestamp(),
  });

  await bucket.file(filePath).save(
    `clip=${clipId} idx=${clipIndex} rand=${rand} @ ${new Date().toISOString()}`,
    {
      contentType: 'text/plain',
      metadata: { metadata: { uploadId, clipId, uploadToken } },
    },
  );

  logger.info('process-clip uploaded', { filePath });
  res.json({ success: true, filePath });
});

// Helper: call the in-memory endpoint through axiosist adapter.
async function callInProcessEndpoint(path: string, data: any) {
  // Dynamically import axiosist only when needed (keeps reproduction surface small).
  const { createAdapter } = await import('axiosist');
  const instance = axios.create({ adapter: createAdapter(app), timeout: 15000 });
  return instance.post(path, data).then(r => r.data);
}

// ---------------------------------------------------------------------------
// Firestore trigger: when uploads/{id}.generate toggles false->true start work
// ---------------------------------------------------------------------------
export const onUploadUpdate = onDocumentUpdated({
  document: 'uploads/{uploadId}',
  ...triggerOptions,
}, async event => {
  const { uploadId } = event.params;
  const before = event.data?.before?.data() ?? {};
  const after = event.data?.after?.data() ?? {};

  // Only on generate flag rising edge
  if (before.generate === true || after.generate !== true) {
    return; // no-op
  }

  logger.info('onUploadUpdate start', { uploadId });

  // Kick off a handful of in-memory HTTP calls (enough to reproduce).
  const clips = ['a', 'b', 'c'];
  const promises = clips.map((clipId, i) =>
    callInProcessEndpoint('/process-clip', { uploadId, clipId, clipIndex: i })
      .catch(e => logger.error('process-clip failed', { uploadId, clipId, e: (e as Error).message }))
  );

  // Intentionally do not await (matches original pattern of fire-and-forget).
  Promise.all(promises).catch(e => logger.error('clip batch failure', e));

  logger.info('onUploadUpdate dispatched', { uploadId, clipCount: clips.length });
});

// ---------------------------------------------------------------------------
// Storage finalize trigger: verifies upload token & updates parent doc
// ---------------------------------------------------------------------------
export const onUploadFileFinalize = onObjectFinalized({
  ...triggerOptions,
}, async event => {
  const name = event.data.name;
  if (!name || !name.startsWith('uploads/')) return;

  const meta = event.data.metadata;
  const uploadToken = meta?.uploadToken;
  if (uploadToken) {
    const tokenRef = admin.firestore().collection('storageUploadTokens').doc(uploadToken);
    const tokSnap = await tokenRef.get();
    if (tokSnap.exists) {
      const d = tokSnap.data() as { isConsumed?: boolean; fileStoragePath?: string } | undefined;
      if (d && !d.isConsumed && d.fileStoragePath === name) {
        await tokenRef.update({ isConsumed: true, dateConsumed: admin.firestore.FieldValue.serverTimestamp() });
      }
    }
  }

  // Derive uploadId: uploads/{uploadId}-clipIndex-rand.txt
  const base = name.split('/').pop()!;
  const uploadId = base.split('-')[0];
  const ref = admin.firestore().doc(`uploads/${uploadId}`);
  await ref.set({
    lastFileFinalizedAt: admin.firestore.FieldValue.serverTimestamp(),
    verifiedUploads: admin.firestore.FieldValue.arrayUnion(name),
  }, { merge: true });

  logger.info('onUploadFileFinalize updated doc', { name, uploadId });
});
