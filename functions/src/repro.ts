// Clean rebuilt minimal repro with configurable workload to amplify race.
import admin from "firebase-admin";
import { logger } from "firebase-functions";
import { onDocumentUpdated } from "firebase-functions/v2/firestore";
import { onObjectFinalized } from "firebase-functions/v2/storage";

if (!admin.apps.length) {
  admin.initializeApp();
}

const triggerOptions = {
  memory: "512MiB" as const,
  maxInstances: 10,
  invoker: "private" as const,
  concurrency: 1000,
};

interface WorkloadConfig {
  level: "low" | "medium" | "high" | "extreme";
  clips: number;
  spinMs: number;
  extraFilesPerClip: number;
  microtasks: number;
}

function resolveWorkload(): WorkloadConfig {
  const levelEnv = (process.env.SIM_LOAD || "medium").toLowerCase();
  const clips = parseInt(process.env.CLIP_COUNT || "", 10);
  const spinMs = parseInt(process.env.SPIN_MS || "", 10);
  const extraFilesPerClip = parseInt(process.env.EXTRA_FILES || "", 10);
  const microtasks = parseInt(process.env.MICROTASKS || "", 10);
  const baseLevel: WorkloadConfig["level"] = [
    "low",
    "medium",
    "high",
    "extreme",
  ].includes(levelEnv as any)
    ? (levelEnv as any)
    : "medium";
  const presets: Record<
    WorkloadConfig["level"],
    Omit<WorkloadConfig, "level">
  > = {
    low: { clips: 3, spinMs: 0, extraFilesPerClip: 0, microtasks: 50 },
    medium: { clips: 5, spinMs: 5, extraFilesPerClip: 1, microtasks: 200 },
    high: { clips: 8, spinMs: 15, extraFilesPerClip: 2, microtasks: 600 },
    extreme: { clips: 12, spinMs: 40, extraFilesPerClip: 4, microtasks: 1500 },
  };
  const preset = presets[baseLevel];
  return {
    level: baseLevel,
    clips: isNaN(clips) ? preset.clips : clips,
    spinMs: isNaN(spinMs) ? preset.spinMs : spinMs,
    extraFilesPerClip: isNaN(extraFilesPerClip)
      ? preset.extraFilesPerClip
      : extraFilesPerClip,
    microtasks: isNaN(microtasks) ? preset.microtasks : microtasks,
  };
}

function loadIntensityEnv() {
  const raw = process.env.SIM_LOAD || "medium";
  if (/^(low|medium|high|extreme)$/i.test(raw))
    return raw.toLowerCase() as WorkloadConfig["level"];
  return "medium";
}

async function simulateInProcessRouting(
  level: WorkloadConfig["level"],
  forcedMicrotasks?: number
) {
  const start = Date.now();
  const config = {
    low: { routes: 10, iters: 200, dynImports: 1 },
    medium: { routes: 40, iters: 1200, dynImports: 2 },
    high: { routes: 80, iters: 2600, dynImports: 4 },
    extreme: { routes: 120, iters: 4800, dynImports: 6 },
  }[level];

  const routes: Array<() => number> = [];
  for (let i = 0; i < config.routes; i++) {
    const base = i * 13;
    routes.push(() => base ^ ((base << 2) & 0xff));
  }

  let acc = 0;
  const loops =
    forcedMicrotasks && forcedMicrotasks > 0 ? forcedMicrotasks : config.iters;
  for (let i = 0; i < loops; i++) {
    acc +=
      routes[(i + 3) % routes.length]() ^ routes[(i * 7) % routes.length]();
    if ((i & 31) === 0) {
      const obj = { i, acc, t: Date.now() };
      acc ^= JSON.parse(JSON.stringify(obj)).i;
    }
    if ((i & 255) === 0) {
      await Promise.resolve();
    }
    if ((i & 511) === 0) {
      await new Promise<void>((r) => setImmediate(r));
    }
  }

  for (let j = 0; j < config.dynImports; j++) {
    // eslint-disable-next-line no-await-in-loop
    const m = await import("crypto");
    acc ^= m.randomBytes(1)[0];
  }

  for (let k = 0; k < 5; k++) {
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    Promise.resolve().then(() => {});
  }

  if (Math.random() < 0.02) {
    logger.debug?.("simulateInProcessRouting summary", {
      level,
      acc,
      ms: Date.now() - start,
      loops,
    });
  }
}

async function processClip(
  uploadId: string,
  clipId: string,
  clipIndex: number,
  cfg: WorkloadConfig
) {
  logger.info("process-clip begin", {
    uploadId,
    clipId,
    clipIndex,
    mode: "direct",
    wl: cfg.level,
  });
  await simulateInProcessRouting(loadIntensityEnv(), cfg.microtasks);
  if (cfg.spinMs > 0) {
    const end = Date.now() + cfg.spinMs;
    while (Date.now() < end) {
      Math.imul(end, Date.now());
    }
  }
  const bucket = admin.storage().bucket();
  const primaryRand = Math.random().toString(36).slice(2, 8);
  const primaryFile = `uploads/${uploadId}-${clipIndex}-${primaryRand}.txt`;
  await bucket
    .file(primaryFile)
    .save(
      `primary clip=${clipId} idx=${clipIndex} rand=${primaryRand} @ ${new Date().toISOString()}`,
      { contentType: "text/plain" }
    );
  if (cfg.extraFilesPerClip > 0) {
    const writes = Array.from({ length: cfg.extraFilesPerClip }, (_, j) => {
      const r = Math.random().toString(36).slice(2, 8);
      const p = `uploads/${uploadId}-${clipIndex}-extra${j}-${r}.txt`;
      return bucket
        .file(p)
        .save(
          `extra j=${j} clip=${clipId} idx=${clipIndex} rand=${r} @ ${new Date().toISOString()}`,
          { contentType: "text/plain" }
        )
        .catch((e) =>
          logger.error("extra file write failed", {
            p,
            e: (e as Error).message,
          })
        );
    });
    await Promise.all(writes);
  }
  logger.info("process-clip uploaded", {
    primaryFile,
    extras: cfg.extraFilesPerClip,
  });
}

export const onUploadUpdate = onDocumentUpdated(
  {
    document: "uploads/{uploadId}",
    ...triggerOptions,
  },
  async (event) => {
    const wl = resolveWorkload();
    try {
      const ceAny: any = event;
      logger.info("CE onUploadUpdate recv", {
        ceType: ceAny.type,
        ceSource: ceAny.source,
        ceSubject: ceAny.subject,
        dataKeys: Object.keys(ceAny.data || {}),
        wl: wl.level,
      });
    } catch {}

    const { uploadId } = event.params;
    const before = event.data?.before?.data() ?? {};
    const after = event.data?.after?.data() ?? {};
    if (before.generate === true || after.generate !== true) return;

    logger.info("onUploadUpdate start", {
      uploadId,
      wl: wl.level,
      clips: wl.clips,
    });
    const clips = Array.from({ length: wl.clips }, (_, i) => `clip${i}`);
    const promises = clips.map((clipId, i) =>
      processClip(uploadId, clipId, i, wl).catch((e) =>
        logger.error("process-clip failed", {
          uploadId,
          clipId,
          e: (e as Error).message,
        })
      )
    );
    Promise.all(promises).catch((e) => logger.error("clip batch failure", e));
    logger.info("onUploadUpdate dispatched", {
      uploadId,
      clipCount: clips.length,
      wl: wl.level,
    });
  }
);

export const onUploadFileFinalize = onObjectFinalized(
  {
    ...triggerOptions,
  },
  async (event) => {
    try {
      const ceAny: any = event;
      logger.info("CE onUploadFileFinalize recv", {
        ceType: ceAny.type,
        ceSource: ceAny.source,
        ceSubject: ceAny.subject,
        hasName: !!ceAny.data?.name,
      });
    } catch {}
    const name = event.data.name;
    if (!name || !name.startsWith("uploads/")) return;
    const base = name.split("/").pop()!;
    const uploadId = base.split("-")[0];
    await admin
      .firestore()
      .doc(`uploads/${uploadId}`)
      .set(
        {
          lastFileFinalizedAt: admin.firestore.FieldValue.serverTimestamp(),
          verifiedUploads: admin.firestore.FieldValue.arrayUnion(name),
        },
        { merge: true }
      );
    logger.info("onUploadFileFinalize updated doc", { name, uploadId });
  }
);
