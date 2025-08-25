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
}

// Run a small ffmpeg encode to burn CPU, then upload a text file to Storage to trigger onObjectFinalized.
function runFfmpegAndUpload(params: {
  uploadId: string;
  label: string;
  fileIndex: number;
  group: string;
}): Promise<void> {
  const { uploadId, label, fileIndex, group } = params;
  return new Promise((resolve) => {
    const colors = [
      "black",
      "white",
      "red",
      "green",
      "blue",
      "purple",
      "orange",
      "yellow",
    ];
    const color = colors[Math.floor(Math.random() * colors.length)];
    const width = 160 + Math.floor(Math.random() * 160);
    const height = 120 + Math.floor(Math.random() * 120);
    crypto.randomBytes(3); // generate entropy (no id needed)
    const ffArgs = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      `color=c=${color}:s=${width}x${height}:d=0.3`,
      "-f",
      "null",
      "-",
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

      // Create token doc similar to original /upload-file endpoint
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
          console.log(
            "🚀 This should trigger the Storage onUploadFileFinalize function!"
          );
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

// CRITICAL: Use dynamic imports with await like main project to create timing windows
async function makeApiRequestWithFFmpeg(opts: {
  url: string;
  data: WorkloadData;
}) {
  // CRITICAL: Dynamic import logger each time
  const { logger } = await import("firebase-functions");
  logger.info(
    "🔥 Using DYNAMIC IMPORTS to create context mixing timing windows like main project"
  );

  // Run ffmpeg workload (errors only)
  await runFFmpegProcessing(opts.data);

  // Skip HTTP calls like successful repro - go straight to ffmpeg simulation burst

  // CRITICAL: Use dynamic imports with await like the main project to create context mixing timing windows
  if (opts.url === "/generateAllPreviewVideosForClipsInUse") {
    // Dynamic import creates timing window where context can get mixed
    console.log(
      "🔥 DYNAMIC IMPORT: Loading generateAllPreviewVideosForClipsInUse"
    );
    const module = await import("./firestore-triggers");
    return await module.generateAllPreviewVideosForClipsInUse(opts.data);
  } else if (opts.url === "/upload-file") {
    // Another dynamic import timing window
    console.log("🔥 DYNAMIC IMPORT: Loading uploadFile");
    const module = await import("./firestore-triggers");
    return await module.uploadFile(opts.data);
  } else if (opts.url === "/simulate-ffmpeg-processing") {
    // Yet another timing window
    console.log("🔥 DYNAMIC IMPORT: Loading simulateFFmpeg");
    const module = await import("./firestore-triggers");
    return await module.simulateFFmpeg();
  }

  return { success: true };
}

// LIGHTWEIGHT processing + MASSIVE parallel storage uploads to trigger race conditions
async function runFFmpegProcessing(data: WorkloadData) {
  // CRITICAL: Dynamic imports for fs, os, path to create timing windows
  const fs = await import("fs/promises");
  const os = await import("os");
  const path = await import("path");

  const uploadId = data.uploadId;
  const numParallelUploads = 20; // Create 20 parallel storage uploads

  try {
    // Create many parallel storage upload tasks instead of heavy processing
    const uploadTasks = Array.from({ length: numParallelUploads }).map(
      async (_, taskIndex) => {
        const tempDir = os.tmpdir();
        const rand = Math.random().toString(36).slice(2, 10);
        const tempFilePath = path.join(
          tempDir,
          `burst-upload-${uploadId}-${taskIndex}-${rand}.txt`
        );

        // Create a simple text file with unique content
        const content = `Burst upload #${taskIndex} for ${uploadId} at ${new Date().toISOString()} - random: ${rand}`;
        await fs.writeFile(tempFilePath, content);

        try {
          const bucket = admin.storage().bucket();
          const storageFilePath = `burst-uploads/${uploadId}/task-${taskIndex}-${rand}.txt`;

          // Create upload token doc for each burst upload
          const uploadToken = `burst-token-${uploadId}-${taskIndex}-${rand}`;
          const tokenRef = admin
            .firestore()
            .collection("storageUploadTokens")
            .doc(uploadToken);

          await tokenRef.set({
            fileStoragePath: storageFilePath,
            dateExpires: admin.firestore.Timestamp.fromDate(
              new Date(Date.now() + 3600000)
            ),
            isConsumed: false,
            dateCreated: admin.firestore.FieldValue.serverTimestamp(),
            taskIndex,
            burstUpload: true,
          });

          await bucket.upload(tempFilePath, {
            destination: storageFilePath,
            metadata: {
              contentType: "text/plain",
              metadata: {
                uploadSource: "burst-processing",
                uploadId,
                uploadToken,
                isBurstUpload: "yes",
                processingType: "parallel-burst-upload",
                taskIndex: taskIndex.toString(),
                timestamp: new Date().toISOString(),
              },
            },
          });

          logger.debug?.("completed burst upload", {
            uploadId,
            taskIndex,
            storageFilePath,
          });

          // Clean up local temp file after upload
          await fs.unlink(tempFilePath);

          return { success: true, taskIndex, filePath: storageFilePath };
        } catch (uploadError) {
          logger.error("Failed burst upload:", { uploadError, taskIndex });
          // Clean up temp file even if upload failed
          try {
            await fs.unlink(tempFilePath);
          } catch {
            /* ignore cleanup errors */
          }
          return { success: false, taskIndex, error: uploadError };
        }
      }
    );

    // Execute all uploads in parallel and wait for completion
    const results = await Promise.all(uploadTasks);
    const successful = results.filter((r) => r.success).length;

    logger.debug?.("burst uploads completed", {
      uploadId,
      totalTasks: numParallelUploads,
      successful,
      failed: numParallelUploads - successful,
    });
  } catch (error) {
    logger.debug?.("burst upload setup failed", {
      message: (error as Error)?.message,
    });
  }
}

// Direct function implementations (extracted from express-app)
export async function generateAllPreviewVideosForClipsInUse(
  data: WorkloadData
) {
  const uploadId = data.uploadId;

  // Simulate getting clips in use (like parent project does) - INCREASE for bug reproduction
  const clipsInUse = ["clip1", "clip2", "clip3"]; // Multiple clips to stress the system

  // Process clips directly
  await Promise.all(
    clipsInUse.map(async (clipId, idx) => {
      return await generateClipPreviewVideo({
        uploadId,
        clipId,
        clipIndex: idx,
      });
    })
  );

  return { success: true, clipsProcessed: clipsInUse.length };
}

async function generateClipPreviewVideo(data: WorkloadData) {
  const { uploadId, clipId, clipIndex } = data;

  // DIRECT ffmpeg simulation
  await simulateFFmpeg();

  // DIRECT file uploads
  const filesToGenerate = 3;
  const uploads = Array.from({ length: filesToGenerate }).map(
    async (_, fileIdx) => {
      const safeIndex = clipIndex ?? 0;
      return await uploadFile({
        uploadId,
        fileIndex: safeIndex * 100 + fileIdx,
        baseContent: `Clip ${clipId} preview file`,
      });
    }
  );

  await Promise.all(uploads);
  return { success: true, filesCreated: uploads.length };
}

export async function simulateFFmpeg() {
  // Random delay to create timing variations
  await new Promise((resolve) => setTimeout(resolve, Math.random() * 200 + 50));

  return { success: true, processed: true };
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

  // minimal log for file generation
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

// Firestore v2 onDocumentUpdated trigger: when a doc's generate flag flips false -> true
export const onUploadUpdate = onDocumentUpdated(
  {
    document: "uploads/{uploadId}",
    ...triggerOptions,
  },
  async (event) => {
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

    // Trigger the exact flow that happens on "confirm timings" click
    // Start generation & parallel uploads
    const promises = [];

    // Start main generation (will trigger Storage events) - WITH REAL FFMPEG
    promises.push(
      makeApiRequestWithFFmpeg({
        url: "/generateAllPreviewVideosForClipsInUse",
        data: { uploadId },
      })
    );

    for (let i = 0; i < 10; i++) {
      promises.push(
        makeApiRequestWithFFmpeg({
          url: "/upload-file",
          data: {
            uploadId,
            fileIndex: 8000 + i,
            baseContent: `Race condition file ${i}`,
          },
        })
      );
    }

    Promise.all(promises).catch((err) => {
      logger.error("Race condition promises failed:", err);
    });

    logger.info("onUploadUpdate queued async work", {
      uploadId,
      tasks: promises.length,
    });
  }
);

// Second concurrent trigger that also makes HTTP requests (mimics parent project pattern)
export const onUploadUpdateSecondary = onDocumentUpdated(
  {
    document: "uploads/{uploadId}",
    ...triggerOptions,
  },
  async (event) => {
    logger.info("onUploadUpdateSecondary start", {
      uploadId: event.params.uploadId,
    });

    const { uploadId } = event.params;
    const beforeData = event.data?.before?.data() ?? {};
    const afterData = event.data?.after?.data() ?? {};

    // Check for a different field change to avoid infinite loops
    // (processingBefore / processingAfter removed - not used in simplified logging)

    // Only trigger when generate flag changes (same as main trigger)
    const generateBefore = beforeData.generate === true;
    const generateAfter = afterData.generate === true;

    if (!generateAfter || generateBefore) return;

    // Parallel uploads
    const rapidFirePromises = [];

    for (let i = 0; i < 15; i++) {
      rapidFirePromises.push(
        makeApiRequestWithFFmpeg({
          url: "/upload-file",
          data: {
            uploadId,
            fileIndex: 7000 + i,
            baseContent: `Secondary rapid fire ${i}`,
          },
        })
      );

      // Add tiny random delays to create MORE timing variations
      if (i % 3 === 0) {
        await new Promise((resolve) => setTimeout(resolve, Math.random() * 10));
      }
    }

    Promise.all(rapidFirePromises).catch((err) => {
      logger.error("Secondary rapid fire failed:", err);
    });

    logger.info("onUploadUpdateSecondary queued async work", {
      uploadId,
      tasks: rapidFirePromises.length,
    });
  }
);
