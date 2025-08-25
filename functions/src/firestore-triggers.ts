import admin from "firebase-admin";
import { onDocumentUpdated } from "firebase-functions/v2/firestore";
import { logger } from "firebase-functions";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { spawn } from "child_process";

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

// Minimal helper to mimic processing workload (kept for behavior, logs trimmed)
async function makeApiRequestWithFFmpeg(opts: {
  url: string;
  data: WorkloadData;
}) {
  // Run ffmpeg workload (errors only)
  await runFFmpegProcessing(opts.data);

  if (opts.url === "/generateAllPreviewVideosForClipsInUse") {
    return await generateAllPreviewVideosForClipsInUse(opts.data);
  } else if (opts.url === "/upload-file") {
    return await uploadFile(opts.data);
  } else if (opts.url === "/simulate-ffmpeg-processing") {
    return await simulateFFmpeg();
  }

  return { success: true };
}

// REAL FFMPEG processing to create CPU load and I/O blocking
async function runFFmpegProcessing(data: WorkloadData) {
  const uploadId = data.uploadId;

  try {
    // Create temp paths
    const tempDir = os.tmpdir();
    // input file path (unused after change, kept for clarity of workload intent)
    // (input file path removed to avoid unused variable warnings)
    const outputFile = path.join(
      tempDir,
      `output-${uploadId}-${Math.random().toString(36).slice(2)}.mp4`
    );

    // Generate a complex, CPU-intensive test video with ffmpeg
    const ffmpegProcess = spawn(
      "ffmpeg",
      [
        "-f",
        "lavfi",
        "-i",
        "testsrc=duration=5:size=1280x720:rate=60", // 5 seconds, 1280x720, 60fps - much larger
        "-c:v",
        "libx264",
        "-preset",
        "veryslow", // Maximum CPU usage - very slow encoding
        "-crf",
        "18", // High quality = more CPU work
        "-x264-params",
        "me=umh:subme=10:ref=16:bframes=16:b-adapt=2:direct=auto:weightb=1:analyse=all:8x8dct=1:trellis=2:fast-pskip=0:mixed-refs=1", // Complex x264 options for max CPU load
        "-threads",
        "0", // Use all available CPU cores
        "-y", // Overwrite output
        outputFile,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    // Wait for ffmpeg to complete (creates blocking I/O)
    await new Promise<void>((resolve) => {
      ffmpegProcess.stderr?.on("data", () => {
        /* discard noisy ffmpeg stderr */
      });

      ffmpegProcess.on("close", async (code) => {
        if (code === 0) {
          // Upload the generated video to storage instead of deleting it
          try {
            const bucket = admin.storage().bucket();
            const rand = Math.random().toString(36).slice(2, 10);
            const storageFilePath = `ffmpeg-outputs/${uploadId}-${rand}.mp4`;

            // Create upload token doc for the ffmpeg output
            const uploadToken = `ffmpeg-token-${uploadId}-${Math.random()
              .toString(36)
              .slice(2)}`;
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
            });

            await bucket.upload(outputFile, {
              destination: storageFilePath,
              metadata: {
                contentType: "video/mp4",
                metadata: {
                  uploadSource: "ffmpeg-processing",
                  uploadId,
                  uploadToken,
                  isFFmpegOutput: "yes",
                  processingType: "test-video-generation",
                },
              },
            });

            logger.debug?.("uploaded ffmpeg output", {
              uploadId,
              storageFilePath,
            });

            // Clean up local temp file after upload
            await fs.unlink(outputFile);
          } catch (uploadError) {
            logger.error("Failed to upload ffmpeg output:", uploadError);
            // Clean up temp file even if upload failed
            try {
              await fs.unlink(outputFile);
            } catch {
              /* ignore cleanup errors */
            }
          }
          resolve();
        } else {
          logger.debug?.("ffmpeg non-zero exit (ignored)", { code });
          // Still resolve to continue the test - ffmpeg might not be installed
          resolve();
        }
      });

      ffmpegProcess.on("error", (err: unknown) => {
        logger.debug?.(
          "ffmpeg spawn failed (likely not installed, continuing)",
          { message: (err as Error)?.message }
        );
        // Still resolve to continue the test - ffmpeg might not be installed
        resolve();
      });

      // Timeout after 60 seconds (increased for heavy encoding)
      setTimeout(() => {
        ffmpegProcess.kill("SIGKILL");
        resolve();
      }, 60000);
    });
  } catch (error) {
    logger.debug?.("ffmpeg setup failed (continuing)", {
      message: (error as Error)?.message,
    });
    // Continue anyway - ffmpeg might not be available
  }
}

// Direct function implementations (extracted from express-app)
async function generateAllPreviewVideosForClipsInUse(data: WorkloadData) {
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

async function simulateFFmpeg() {
  // Random delay to create timing variations
  await new Promise((resolve) => setTimeout(resolve, Math.random() * 200 + 50));

  return { success: true, processed: true };
}

async function uploadFile(data: WorkloadData) {
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
