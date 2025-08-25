import admin from 'firebase-admin';
import { logger } from 'firebase-functions';
import express from 'express';
import axios from 'axios';

// Initialize Admin SDK only once.
if (!admin.apps.length) {
  admin.initializeApp();
}

// Create Express app
export const app = express();
app.use(express.json());

// Global server registry (like parent project)
class ServerRegistry {
  private static server: express.Application | undefined;

  static registerServer(server: express.Application): void {
    this.server = server;
  }

  static getServer(): express.Application | undefined {
    return this.server;
  }
}

// Register the server
ServerRegistry.registerServer(app);

// HTTP routing interceptor service (like parent project)
import type { AxiosInstance, InternalAxiosRequestConfig } from 'axios';

class HttpRoutingInterceptorService {
  constructor(axiosInstance: AxiosInstance) {
    this.setupRequestInterceptor(axiosInstance);
  }

  setupRequestInterceptor(axiosInstance: AxiosInstance): void {
    const isInspectFunctions = process.execArgv.some((arg) =>
      arg.includes('--inspect'),
    );

    if (isInspectFunctions) {
      axiosInstance.interceptors.request.use(
        async (config: InternalAxiosRequestConfig) => {
          if (config.url?.startsWith('/')) {
            try {
              const { createAdapter } = await import('axiosist');
              const expressApp = ServerRegistry.getServer();
              if (expressApp) {
                config.adapter = createAdapter(expressApp);
                logger.debug?.('axiosist adapter', { url: config.url });
              }
            } catch (error) {
              logger.debug?.('axiosist load failed', {
                message: (error as Error).message,
              });
            }
          }
          return config;
        },
      );
    }
  }
}

// Make API request function (exactly like parent project)
interface ApiRequestOpts {
  url: string;
  data: Record<string, unknown>;
}
async function makeApiRequest(opts: ApiRequestOpts) {
  // Create NEW axios instance for each request (key difference!)
  const axiosInstance = axios.create();

  // Create NEW interceptor service for each request (like parent)
  new HttpRoutingInterceptorService(axiosInstance);

  logger.debug?.('api request', { url: opts.url });

  return await axiosInstance.post(opts.url, opts.data);
}

// Add generateAllPreviewVideosForClipsInUse endpoint (like parent project)
app.post('/generateAllPreviewVideosForClipsInUse', async (req, res) => {
  const { uploadId } = req.body;

  logger.info('generateAllPreviewVideosForClipsInUse', { uploadId });

  // Simulate getting clips in use (like parent project does) - INCREASE for bug reproduction
  const clipsInUse = ['clip1', 'clip2', 'clip3']; // Multiple clips to stress the system

  // Trigger individual clip preview generation for each clip (like parent)
  await Promise.all(
    clipsInUse.map(async (clipId, idx) => {
      // Each call creates a NEW axios instance with NEW interceptor (key bug trigger!)
      return makeApiRequest({
        url: '/generateClipPreviewVideo',
        data: {
          uploadId,
          clipId,
          idx,
        },
      });
    }),
  );

  logger.debug?.('generateAllPreviewVideosForClipsInUse done', {
    uploadId,
    clipCount: clipsInUse.length,
  });
  res.json({ success: true, clipsProcessed: clipsInUse.length });
});

// Add generateClipPreviewVideo endpoint (like parent project)
app.post('/generateClipPreviewVideo', async (req, res) => {
  const { uploadId, clipId, idx } = req.body as {
    uploadId: string;
    clipId: string;
    idx: number;
  };

  logger.info('generateClipPreviewVideo', { uploadId, clipId });

  // DEEP NESTING: First do ffmpeg simulation then file uploads (like parent project)
  // This mimics the complex nested HTTP calls that happen in the real bug
  await makeApiRequest({
    url: '/simulate-ffmpeg-processing',
    data: { uploadId, clipId },
  });

  // This is where the actual file uploads happen (like preview video generation)
  const filesToGenerate = 3; // Multiple files to stress the system
  const uploads = Array.from({ length: filesToGenerate }).map(
    async (_, fileIdx) => {
      return makeApiRequest({
        url: '/upload-file',
        data: {
          uploadId,
          fileIndex: idx * 100 + fileIdx, // Unique index per clip
          baseContent: `Clip ${clipId} preview file`,
        },
      });
    },
  );

  const results = await Promise.all(uploads);
  logger.debug?.('generateClipPreviewVideo done', {
    uploadId,
    clipId,
    filesCreated: results.length,
  });

  res.json({ success: true, filesCreated: results.length });
});

// Add ffmpeg simulation endpoint (like parent project's video processing)
app.post('/simulate-ffmpeg-processing', async (req, res) => {
  const { uploadId, clipId } = req.body as { uploadId: string; clipId: string };

  logger.debug?.('ffmpeg simulate start', { uploadId, clipId });

  // Simulate some video processing that might affect function state
  // This could potentially cause context mixing between trigger types
  // CRITICAL: Add async operations that might confuse the event context
  await new Promise((resolve) => setTimeout(resolve, Math.random() * 200 + 50)); // Random delay

  // Force some module imports during processing (might affect context)
  // Removed unused imports to reduce noise

  logger.debug?.('ffmpeg mid', { uploadId, clipId });

  logger.debug?.('ffmpeg simulate done', { uploadId, clipId });
  res.json({ success: true, processed: true });
});

// API endpoint that uploads files to Storage
app.post('/upload-file', async (req, res) => {
  const { uploadId, fileIndex, baseContent } = req.body;

  if (!uploadId || fileIndex === undefined || !baseContent) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const fs = await import('fs/promises');
  const os = await import('os');
  const path = await import('path');

  const bucket = admin.storage().bucket();
  const rand = Math.random().toString(36).slice(2, 10);
  const filePath = `uploads/${uploadId}-${fileIndex + 1}-${rand}.txt`;
  const content = `${baseContent} file#${fileIndex + 1} rand=${rand} @ ${new Date().toISOString()}`;

  const tempFilePath = path.join(
    os.tmpdir(),
    `temp-${uploadId}-${fileIndex + 1}-${rand}.txt`,
  );
  await fs.writeFile(tempFilePath, content);

  logger.debug?.('upload-file', { uploadId, fileIndex, filePath });

  // Create a fake upload token doc in Firestore (like parent project)
  const uploadToken = `token-${uploadId}-${fileIndex}-${Math.random().toString(36).slice(2)}`;
  const tokenRef = admin
    .firestore()
    .collection('storageUploadTokens')
    .doc(uploadToken);
  await tokenRef.set({
    fileStoragePath: filePath,
    dateExpires: admin.firestore.Timestamp.fromDate(
      new Date(Date.now() + 3600000),
    ), // 1 hour from now
    isConsumed: false,
    dateCreated: admin.firestore.FieldValue.serverTimestamp(),
  });

  await bucket.upload(tempFilePath, {
    destination: filePath,
    metadata: {
      contentType: 'text/plain',
      metadata: {
        uploadSource: 'server',
        uploadId,
        fileIndex: (fileIndex + 1).toString(),
        uploadToken, // Add upload token metadata (key for parent project)
        isPreviewVideo: 'yes',
        originalClipId: `clip-${fileIndex}`,
      },
    },
  });

  await fs.unlink(tempFilePath);

  res.json({ success: true, filePath });
});
