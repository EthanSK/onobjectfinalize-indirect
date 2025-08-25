import admin from "firebase-admin";
import { logger } from "firebase-functions";
import { onDocumentUpdated } from "firebase-functions/v2/firestore";
import { spawn } from "child_process";
import crypto from "crypto";
import * as path from "path";
import * as os from "os";
import { promises as fs } from "fs";

// Initialize Admin SDK only once.
if (!admin.apps.length) {
  admin.initializeApp();
}

// Trigger options like parent project
const triggerOptions = {
  memory: "512MiB" as const,
  maxInstances: 10,
  invoker: "private" as const,
  concurrency: 1000, // Key: high concurrency like parent project
};

interface WorkloadData {
  uploadId: string;
  clipId?: string;
  clipIndex?: number;
  fileIndex?: number;
  baseContent?: string;
  musicVideoId?: string;
}

// Simple FFmpeg + file upload (like your original)
function runFfmpegAndUpload(params: {
  uploadId: string;
  label: string;
  fileIndex: number;
  group: string;
}): Promise<void> {
  const { uploadId, label, fileIndex, group } = params;
  return new Promise((resolve) => {
    const colors = [
      "black", "white", "red", "green", "blue", "purple", "orange", "yellow"
    ];
    const color = colors[Math.floor(Math.random() * colors.length)];
    const width = 160 + Math.floor(Math.random() * 160);
    const height = 120 + Math.floor(Math.random() * 120);
    crypto.randomBytes(3); // generate entropy
    
    const ffArgs = [
      "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
      `color=c=${color}:s=${width}x${height}:d=0.3`, "-f", "null", "-"
    ];
    
    const startedAt = Date.now();
    let ffmpegRan = false;

    const finalizeUpload = (ffmpegOk: boolean, exitCode?: number) => {
      const rand = crypto.randomBytes(4).toString("hex");
      const filePath = `uploads/${uploadId}-${fileIndex}-${rand}.txt`;
      const bucket = admin.storage().bucket();
      const uploadToken = `token-${uploadId}-${fileIndex}-${rand}`;
      const durationMs = Date.now() - startedAt;
      const content = [
        "FFMPEG_SIMULATION RESULT",
        `uploadId=${uploadId}`,
        `label=${label}`,
        `group=${group}`,
        `color=${color}`,
        `dimension=${width}x${height}`,
        `ffmpegOk=${ffmpegOk}`,
        `exitCode=${exitCode}`,
        `durationMs=${durationMs}`,
        `ts=${new Date().toISOString()}`,
      ].join("\n");

      // Create token doc
      const tokenRef = admin
        .firestore()
        .collection("storageUploadTokens")
        .doc(uploadToken);
      tokenRef
        .set({
          fileStoragePath: filePath,
          dateExpires: admin.firestore.Timestamp.fromDate(
            new Date(Date.now() + 3600000)
          ),
          isConsumed: false,
          dateCreated: admin.firestore.FieldValue.serverTimestamp(),
        })
        .catch((e) =>
          logger.error("Failed to create token doc", {
            uploadToken,
            e: e.message,
          })
        );

      bucket
        .file(filePath)
        .save(content, {
          contentType: "text/plain",
          metadata: {
            metadata: {
              uploadSource: "firestore-trigger-ffmpeg",
              uploadId,
              fileIndex: String(fileIndex),
              uploadToken,
              group,
            },
          },
        })
        .then(() => {
          console.log(`🚀 UPLOADED FILE TO STORAGE: ${filePath}`);
          logger.info(`Uploaded ${filePath} after ffmpeg simulation`);
          resolve();
        })
        .catch((e) => {
          logger.error(`Failed to upload ${filePath}`, { e: e.message });
          resolve();
        });
    };

    // Try to run actual ffmpeg
    const ffmpegProc = spawn("ffmpeg", ffArgs, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timeout = setTimeout(() => {
      if (!ffmpegRan) {
        ffmpegProc.kill("SIGTERM");
        finalizeUpload(false, -1);
      }
    }, 500);

    ffmpegProc.on("exit", (code) => {
      if (!ffmpegRan) {
        ffmpegRan = true;
        clearTimeout(timeout);
        finalizeUpload(true, code ?? -1);
      }
    });

    ffmpegProc.on("error", () => {
      if (!ffmpegRan) {
        ffmpegRan = true;
        clearTimeout(timeout);
        finalizeUpload(false, -2);
      }
    });
  });
}

// CRITICAL: Create axiosist routing within same function instance (like real broken flow)
async function makeApiRequestWithFFmpeg(opts: {
  url: string;
  data: WorkloadData;
}): Promise<any> {
  const { logger } = await import("firebase-functions");
  
  console.log(`🔥 AXIOSIST: Creating Express app within same trigger function for ${opts.url}`);
  
  try {
    // CRITICAL: Create axiosist mock adapter to route through Express app (like main project)
    const { default: express } = await import('express');
    const { createAdapter } = await import('axiosist');
    const axios = await import('axios');
    
    // Create Express app within the SAME FUNCTION INSTANCE (this is the key bug scenario)
    const app = express();
    app.use(express.json());
    
    // Add endpoints that mirror your real app structure
    app.post('/generateAllClipPreviewsAndStitch', async (req, res) => {
      console.log('🚀 AXIOSIST ENDPOINT: /generateAllClipPreviewsAndStitch called within same function');
      
      // This triggers MORE ffmpeg work within the same function instance!
      const result = await triggerGenerateClipPreview(req.body);
      res.json(result);
    });
    
    app.post('/triggerClipPreviewVideo', async (req, res) => {
      console.log('🚀 AXIOSIST ENDPOINT: /triggerClipPreviewVideo called within same function');
      const result = await triggerClipPreviewVideo(req.body);
      res.json(result);
    });
    
    // Create axios instance with axiosist adapter (routes through Express in-memory)
    const axiosInstance = axios.default.create({
      adapter: createAdapter(app), 
      timeout: 30000,
    });
    
    console.log(`🔥 AXIOSIST CALL: Making ${opts.url} request through in-memory Express app`);
    const response = await axiosInstance.post(opts.url, opts.data);
    console.log('🔥 AXIOSIST SUCCESS: Request completed within same function instance');
    return response.data;
    
  } catch (error) {
    console.log('🔥 AXIOSIST FALLBACK: Mock adapter failed');
    logger.info('Axiosist failed, using fallback', { 
      error: error instanceof Error ? error.message : String(error) 
    });
    
    // Fallback to direct calls
    if (opts.url === "/generateAllClipPreviewsAndStitch") {
      return await triggerGenerateClipPreview(opts.data);
    } else if (opts.url === "/triggerClipPreviewVideo") {
      return await triggerClipPreviewVideo(opts.data);
    }
  }

  return { success: true };
}

// Simulate the real flow: triggerClipPreviewVideo calls that lead to more axiosist routing
async function triggerClipPreviewVideo(data: WorkloadData): Promise<any> {
  const { uploadId, clipId, clipIndex } = data;
  console.log(`🎬 TRIGGER CLIP PREVIEW: Processing clip ${clipId} (index ${clipIndex})`);
  
  // This simulates your triggerClipPreviewVideo function
  // In debug mode, this creates axiosist routing to generateAllClipPreviewsAndStitch
  const result: any = await makeApiRequestWithFFmpeg({
    url: "/generateAllClipPreviewsAndStitch",
    data: { 
      uploadId, 
      clipId, 
      clipIndex,
      musicVideoId: data.musicVideoId 
    },
  });
  
  return result;
}

// This gets called via axiosist within the same function instance
async function triggerGenerateClipPreview(data: WorkloadData) {
  const { uploadId, clipId, musicVideoId } = data;
  console.log(`🔥 GENERATE CLIP PREVIEW: Starting FFmpeg tasks for clip ${clipId}`);
  
  // This does a bunch of FFmpeg video tasks (the actual CPU/IO work)
  await runActualFFmpegWork(data);
  
  // Create a few file uploads (not spam, just realistic amount)
  const uploads = [];
  for (let i = 0; i < 2; i++) {
    uploads.push(uploadFile({
      uploadId,
      fileIndex: (data.clipIndex || 0) * 10 + i,
      baseContent: `Clip ${clipId} preview video`,
      musicVideoId,
    }));
  }
  
  await Promise.all(uploads);
  return { success: true, clipsProcessed: 1, filesCreated: uploads.length };
}

// Actual FFmpeg work that causes the timing issues
async function runActualFFmpegWork(data: WorkloadData) {
  console.log(`🎬 FFMPEG WORK: Running actual video processing for ${data.clipId}`);
  
  // Simulate real FFmpeg work - not too much spam, but enough to create timing windows
  const tasks = [];
  for (let i = 0; i < 3; i++) {
    tasks.push(runFfmpegAndUpload({
      uploadId: data.uploadId,
      label: `clip-${data.clipId}-task-${i}`,
      fileIndex: i,
      group: 'preview-generation',
    }));
  }
  
  await Promise.all(tasks);
}

export async function uploadFile(data: WorkloadData) {
  const { uploadId, fileIndex, baseContent } = data;

  if (!uploadId || fileIndex === undefined || !baseContent) {
    throw new Error("Missing required fields");
  }

  const bucket = admin.storage().bucket();
  const rand = Math.random().toString(36).slice(2, 10);
  const filePath = `uploads/${uploadId}-${fileIndex + 1}-${rand}.txt`;
  const content = `${baseContent} file#${
    fileIndex + 1
  } rand=${rand} @ ${new Date().toISOString()}`;

  const tempFilePath = path.join(
    os.tmpdir(),
    `temp-${uploadId}-${fileIndex + 1}-${rand}.txt`
  );
  await fs.writeFile(tempFilePath, content);

  logger.debug?.("uploading file", { uploadId, fileIndex, filePath });

  // Create upload token doc
  const uploadToken = `token-${uploadId}-${fileIndex}-${Math.random()
    .toString(36)
    .slice(2)}`;
  const tokenRef = admin
    .firestore()
    .collection("storageUploadTokens")
    .doc(uploadToken);
  await tokenRef.set({
    fileStoragePath: filePath,
    dateExpires: admin.firestore.Timestamp.fromDate(
      new Date(Date.now() + 3600000)
    ),
    isConsumed: false,
    dateCreated: admin.firestore.FieldValue.serverTimestamp(),
  });

  await bucket.upload(tempFilePath, {
    destination: filePath,
    metadata: {
      contentType: "text/plain",
      metadata: {
        uploadSource: "server",
        uploadId,
        fileIndex: (fileIndex + 1).toString(),
        uploadToken,
        isPreviewVideo: "yes",
        originalClipId: `clip-${fileIndex}`,
      },
    },
  });

  await fs.unlink(tempFilePath);
  return { success: true, filePath };
}

// Main trigger (like previewVideoMusicVideoGenerationDocTrigger)
export const onUploadUpdate = onDocumentUpdated(
  {
    document: "uploads/{uploadId}",
    ...triggerOptions,
  },
  async (event) => {
    console.log("🔥🔥🔥 MAIN TRIGGER FIRED: previewVideoMusicVideoGenerationDocTrigger equivalent!");
    logger.info("onUploadUpdate start", { uploadId: event.params.uploadId });

    const { uploadId } = event.params;
    const beforeData = event.data?.before?.data() ?? {};
    const afterData = event.data?.after?.data() ?? {};

    // Only act on transition generate: false/undefined -> true
    const generateBefore = beforeData.generate === true;
    const generateAfter = afterData.generate === true;
    if (!generateAfter || generateBefore) {
      logger.debug?.("onUploadUpdate skip (no flag transition)", { uploadId });
      return;
    }

    console.log("🔥 MAIN TRIGGER: Starting triggerClipPreviewVideo calls (like real broken flow)");

    // This kicks off triggerClipPreviewVideo calls (like your real app)
    const clipPromises = [];
    
    // Process a few clips (like your real app would)
    const clipsToProcess = ['clip-1', 'clip-2', 'clip-3'];
    for (let i = 0; i < clipsToProcess.length; i++) {
      const clipId = clipsToProcess[i];
      console.log(`🎬 KICKING OFF: triggerClipPreviewVideo for ${clipId}`);
      
      clipPromises.push(
        makeApiRequestWithFFmpeg({
          url: "/triggerClipPreviewVideo",
          data: { 
            uploadId, 
            clipId, 
            clipIndex: i,
            musicVideoId: `mv-${uploadId}` 
          },
        })
      );
    }

    // Don't await - let them run async (like your real trigger)
    Promise.all(clipPromises).catch((err) => {
      logger.error("Clip preview promises failed:", err);
    });

    logger.info("onUploadUpdate kicked off clip processing", {
      uploadId,
      clipsStarted: clipsToProcess.length,
    });
  }
);