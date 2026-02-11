"use client";

import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";
import JSZip from "jszip";
import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import styles from "./VoLeveler.module.css";

const LOUDNESS_PRESETS = {
  "ATSC A/85 (-24 LKFS, -2 dBTP)": { I: "-24", TP: "-2", LRA: "7", suffix: "A85" },
  "EBU R128 (-23 LUFS, -1 dBTP)": { I: "-23", TP: "-1", LRA: "7", suffix: "R128" },
  "Mix-ready only (no loudness normalize)": null,
} as const;

const BREATH_COMPAND = {
  Off: null,
  Light: "compand=attacks=0.2:decays=0.8:points=-90/-90|-60/-66|-40/-40|-20/-20|0/0",
  Medium: "compand=attacks=0.2:decays=0.8:points=-90/-90|-60/-70|-40/-40|-20/-20|0/0",
} as const;

const FLOOR_GUARD =
  "compand=attacks=0.05:decays=0.2:points=-90/-95|-70/-74|-60/-60|-50/-50|-20/-20|0/0";
const FLOOR_GUARD_STRONG =
  "compand=attacks=0.04:decays=0.18:points=-90/-100|-75/-82|-64/-65|-52/-53|-20/-20|0/0";

const LEVELER_PRESETS = {
  "Minimal (no auto-leveler)": {
    dyna: null,
    compressor: { threshold: "-27dB", ratio: "1.7" },
  },
  Gentle: {
    dyna: { f: 181, g: 5, m: 5 },
    compressor: { threshold: "-26dB", ratio: "2.05" },
  },
  Balanced: {
    dyna: { f: 221, g: 7, m: 7 },
    compressor: { threshold: "-24dB", ratio: "2.25" },
  },
  Firm: {
    dyna: { f: 271, g: 9, m: 9 },
    compressor: { threshold: "-22dB", ratio: "2.45" },
  },
} as const;

const LEVELER_CONSISTENCY = {
  "Minimal (no auto-leveler)": 0.15,
  Gentle: 0.45,
  Balanced: 0.65,
  Firm: 0.85,
} as const;

const SMART_MATCH_PRESETS = {
  Off: { tone: 0, dynamics: 0 },
  Gentle: { tone: 0.45, dynamics: 0.3 },
  Balanced: { tone: 0.7, dynamics: 0.5 },
} as const;

const CORE_BASE_URL = "ffmpeg/ffmpeg-core";
const ANALYSIS_SAMPLE_SECONDS = 180;
const ANALYSIS_SAMPLE_RATE = 16000;
const ENVELOPE_FRAME_MS = 10;
const ENVELOPE_FLOOR_DB = -120;
const MIX_SEGMENT_SECONDS = 75;
const MIX_SEGMENT_MIN_DURATION_SECONDS = 105;
const BATCH_MEMORY_GUARD_FILE_THRESHOLD = 8;
const BATCH_MEMORY_GUARD_INTERVAL = 3;
const LIMITER_FILTER = "alimiter=limit=-2dB:level=disabled";
const FATAL_FFMPEG_PATTERN = /memory access out of bounds|runtimeerror/i;
const IMPORTANT_LOG_PATTERN = /error|failed|invalid|aborted|out of bounds/i;

const sanitizeBase = (name: string) =>
  name.replace(/\.[^/.]+$/, "").replace(/[^a-zA-Z0-9-_]+/g, "_");

const formatBytes = (bytes: number) => {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const toOddInt = (value: number, min: number, max: number) => {
  let rounded = Math.round(clamp(value, min, max));
  if (rounded % 2 === 0) {
    rounded += rounded >= max ? -1 : 1;
  }
  return rounded;
};

const median = (values: number[]) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
};

const mean = (values: number[]) => {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
};

const percentile = (values: number[], percent: number) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (clamp(percent, 0, 100) / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[lower];
  const weight = rank - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
};

const toDb = (value: number) => {
  if (value <= 0) return ENVELOPE_FLOOR_DB;
  return 20 * Math.log10(value);
};

const fromDb = (db: number) => Math.pow(10, db / 20);

const robustMedian = (values: number[]) => {
  if (values.length === 0) return null;
  const baseMedian = median(values);
  if (baseMedian === null) return null;

  const deviations = values.map((value) => Math.abs(value - baseMedian));
  const mad = median(deviations) ?? 0;
  if (mad <= 1e-6) return baseMedian;

  const scale = 1.4826 * mad;
  const filtered = values.filter((value) => Math.abs(value - baseMedian) / scale <= 2.8);
  return median(filtered.length > 0 ? filtered : values);
};

const downgradeRoomRisk = (risk: RoomRisk): RoomRisk => {
  if (risk === "high") return "medium";
  if (risk === "medium") return "low";
  return "low";
};

const classifyRoomRisk = (roomScore: number): RoomRisk => {
  if (roomScore < 0.33) return "low";
  if (roomScore < 0.58) return "medium";
  return "high";
};

const parseMaybeNumber = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const formatSigned = (value: number, decimals = 1) =>
  `${value >= 0 ? "+" : ""}${value.toFixed(decimals)}`;

const shouldRecycleFfmpegForBatch = (completedCount: number, totalCount: number) =>
  totalCount >= BATCH_MEMORY_GUARD_FILE_THRESHOLD &&
  completedCount < totalCount &&
  completedCount % BATCH_MEMORY_GUARD_INTERVAL === 0;

type OutputEntry = {
  name: string;
  url: string;
  size: number;
  kind: "mixready" | "loudness";
  variant: "clean" | "blend";
};

type FileAnalysis = {
  inputI: number | null;
  inputLRA: number | null;
  inputTP: number | null;
  inputThresh: number | null;
  lowRms: number | null;
  midRms: number | null;
  highRms: number | null;
  noiseFloorDb: number | null;
  speechThresholdDb: number | null;
  reverbScore: number | null;
  echoScore: number | null;
  roomScore: number | null;
  echoDelayMs: number | null;
  analysisConfidence: number | null;
  drynessScore: number | null;
};

type BatchReference = {
  lowTilt: number;
  highTilt: number;
  lra: number;
};

type NoiseRisk = "low" | "medium" | "high";
type RoomRisk = "low" | "medium" | "high";

type AdaptiveProfile = {
  highpassHz: number;
  lowMidGainDb: number;
  presenceGainDb: number;
  airGainDb: number;
  emotionalHarshnessCutDb: number;
  topEndHarshnessCutDb: number;
  levelingNeed: number;
  emotionProtection: number;
  compressorRatioOffset: number;
  compressorThresholdOffsetDb: number;
  dynaTrim: number;
  floorGuardFilter: string;
  noiseRisk: NoiseRisk;
  noiseFloorDb: number | null;
  roomRisk: RoomRisk;
  useDenoise: boolean;
  denoiseStrength: number;
  useTailGate: boolean;
  tailGateStrength: number;
  echoNotchCutDb: number;
  blendIndoorGain: number;
  blendOutdoorGain: number;
  blendIndoorDelayMs: number;
  blendOutdoorDelayMs: number;
};

type JobEntry = {
  file: File;
  base: string;
  inputName: string;
  mixName: string;
  blendMixName: string;
};

const createEmptyAnalysis = (): FileAnalysis => ({
  inputI: null,
  inputLRA: null,
  inputTP: null,
  inputThresh: null,
  lowRms: null,
  midRms: null,
  highRms: null,
  noiseFloorDb: null,
  speechThresholdDb: null,
  reverbScore: null,
  echoScore: null,
  roomScore: null,
  echoDelayMs: null,
  analysisConfidence: null,
  drynessScore: null,
});

export default function VoLeveler() {
  const ffmpegRef = useRef<FFmpeg | null>(null);
  const logBufferRef = useRef<string[]>([]);

  const [files, setFiles] = useState<File[]>([]);
  const [outputs, setOutputs] = useState<OutputEntry[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [status, setStatus] = useState<string>("Idle");
  const [loading, setLoading] = useState(false);
  const [zipBusy, setZipBusy] = useState(false);
  const [zipProgress, setZipProgress] = useState(0);
  const [dragActive, setDragActive] = useState(false);

  const [loudnessTarget, setLoudnessTarget] = useState<keyof typeof LOUDNESS_PRESETS>(
    "ATSC A/85 (-24 LKFS, -2 dBTP)"
  );
  const [keepMixReady, setKeepMixReady] = useState(true);
  const [smartMatchMode, setSmartMatchMode] = useState<keyof typeof SMART_MATCH_PRESETS>("Gentle");
  const [eqCleanup, setEqCleanup] = useState(true);
  const [breathControl, setBreathControl] = useState<keyof typeof BREATH_COMPAND>("Light");
  const [leveler, setLeveler] = useState<keyof typeof LEVELER_PRESETS>("Balanced");
  const [roomCleanup, setRoomCleanup] = useState(true);
  const [sceneBlend, setSceneBlend] = useState(true);
  const [softenHarshness, setSoftenHarshness] = useState(true);
  const [noiseGuard, setNoiseGuard] = useState(true);
  const [floorGuard, setFloorGuard] = useState(true);

  const loudnessConfig = useMemo(() => LOUDNESS_PRESETS[loudnessTarget], [loudnessTarget]);
  const smartMatchConfig = useMemo(() => SMART_MATCH_PRESETS[smartMatchMode], [smartMatchMode]);

  useEffect(() => {
    return () => {
      outputs.forEach((output) => URL.revokeObjectURL(output.url));
    };
  }, [outputs]);

  useEffect(() => {
    return () => {
      if (ffmpegRef.current) {
        try {
          ffmpegRef.current.terminate();
        } catch {
          // Ignore terminate failures during unmount.
        }
        ffmpegRef.current = null;
      }
    };
  }, []);

  const appendLog = (message: string) => {
    setLogs((prev) => [...prev.slice(-300), message]);
  };

  const toBlobURLSafe = async (url: string, mime: string) => {
    try {
      return await toBlobURL(url, mime);
    } catch {
      return undefined;
    }
  };

  const teardownFfmpeg = () => {
    if (!ffmpegRef.current) return;
    try {
      ffmpegRef.current.terminate();
    } catch {
      // Ignore terminate failures while resetting worker state.
    } finally {
      ffmpegRef.current = null;
      logBufferRef.current = [];
    }
  };

  const hasFatalFfmpegSignal = (text: string) => FATAL_FFMPEG_PATTERN.test(text);

  const shouldResetFfmpegForError = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    return hasFatalFfmpegSignal(message) || /RuntimeError|memory access out of bounds/i.test(message);
  };

  const refreshFfmpeg = async (reason: string) => {
    appendLog(`Resetting FFmpeg worker (${reason})...`);
    teardownFfmpeg();
    return await ensureFfmpeg();
  };

  const ensureFfmpeg = async () => {
    if (ffmpegRef.current) return ffmpegRef.current;

    const ffmpeg = new FFmpeg();
    ffmpeg.on("log", ({ message }) => {
      if (message.trim() === "Aborted()") {
        // Common during terminate/reset; not a reliable execution failure signal.
        return;
      }
      logBufferRef.current.push(message);
      if (logBufferRef.current.length > 2000) {
        logBufferRef.current = logBufferRef.current.slice(-1200);
      }
      if (IMPORTANT_LOG_PATTERN.test(message)) {
        appendLog(message);
      }
    });

    ffmpeg.on("progress", ({ progress }) => {
      if (progress > 0) {
        setStatus(`Processing ${(progress * 100).toFixed(0)}%`);
      }
    });

    setStatus("Loading FFmpeg core...");
    const coreURL = await toBlobURL(`${CORE_BASE_URL}.js`, "text/javascript");
    const wasmURL = await toBlobURL(`${CORE_BASE_URL}.wasm`, "application/wasm");
    const workerURL = await toBlobURLSafe(`${CORE_BASE_URL}.worker.js`, "text/javascript");

    await ffmpeg.load({
      coreURL,
      wasmURL,
      ...(workerURL ? { workerURL } : {}),
    });

    ffmpegRef.current = ffmpeg;
    setStatus("FFmpeg ready");
    return ffmpeg;
  };

  const resetLogBuffer = () => {
    const snapshot = logBufferRef.current.join("\n");
    logBufferRef.current = [];
    return snapshot;
  };

  const parseLoudnormJson = (text: string) => {
    const matches = text.match(/\{[\s\S]*?\}/g);
    if (!matches || matches.length === 0) return null;
    try {
      return JSON.parse(matches[matches.length - 1]) as Record<string, unknown>;
    } catch {
      return null;
    }
  };

const parseRmsFromAstats = (text: string) => {
    const matches = text.match(/RMS level dB:\s*(-?(?:\d+(?:\.\d+)?|inf))/gi);
    if (!matches || matches.length === 0) return null;
    const raw = matches[matches.length - 1].split(":").at(-1)?.trim().toLowerCase();
    if (!raw) return null;
    if (raw === "-inf" || raw === "inf") return -120;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
};

const parseDurationSeconds = (text: string) => {
  const match = text.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/i);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes) || !Number.isFinite(seconds)) {
    return null;
  }
  return hours * 3600 + minutes * 60 + seconds;
};

const summarizeFailureLog = (text: string) => {
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const important = lines.filter((line) => IMPORTANT_LOG_PATTERN.test(line));
  const selected = (important.length > 0 ? important : lines).slice(-3);
  return selected.join(" | ");
};

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error));

  const execOrThrow = async (ffmpeg: FFmpeg, args: string[], context: string) => {
    const exitCode = await ffmpeg.exec(args);
    const snapshot = logBufferRef.current.join("\n");
    if (exitCode !== 0) {
      const summary = summarizeFailureLog(snapshot);
      const exitText = exitCode !== 0 ? ` (exit ${exitCode})` : "";
      throw new Error(`${context} failed${exitText}${summary ? `: ${summary}` : ""}`);
    }
  };

  const runRmsAnalysis = async (ffmpeg: FFmpeg, inputName: string, bandFilter: string) => {
    resetLogBuffer();
    await execOrThrow(
      ffmpeg,
      [
        "-hide_banner",
        "-nostdin",
        "-threads",
        "1",
        "-i",
        inputName,
        "-t",
        `${ANALYSIS_SAMPLE_SECONDS}`,
        "-af",
        `${bandFilter},astats=metadata=0:reset=0:measure_perchannel=0`,
        "-f",
        "null",
        "-",
      ],
      "RMS analysis"
    );
    const logText = resetLogBuffer();
    return parseRmsFromAstats(logText);
  };

  const readVirtualFileBytes = async (ffmpeg: FFmpeg, name: string) => {
    const data = await ffmpeg.readFile(name);
    return typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  };

  const toFloatSamples = (bytes: Uint8Array) => {
    const usableLength = bytes.byteLength - (bytes.byteLength % 4);
    if (usableLength <= 0) return new Float32Array(0);
    if (bytes.byteOffset % 4 === 0) {
      return new Float32Array(bytes.buffer, bytes.byteOffset, usableLength / 4).slice();
    }
    const aligned = bytes.slice(0, usableLength);
    return new Float32Array(aligned.buffer, aligned.byteOffset, usableLength / 4);
  };

  const computeEnvelopeMetrics = (samples: Float32Array) => {
    const frameSize = Math.max(1, Math.round((ANALYSIS_SAMPLE_RATE * ENVELOPE_FRAME_MS) / 1000));
    const frameCount = Math.floor(samples.length / frameSize);
    if (frameCount < 20) {
      return {
        noiseFloorDb: null,
        speechThresholdDb: null,
        reverbScore: null,
        echoScore: null,
        roomScore: null,
        echoDelayMs: null,
        analysisConfidence: null,
        drynessScore: null,
      };
    }

    const frameRms = new Array<number>(frameCount);
    const frameDb = new Array<number>(frameCount);
    for (let i = 0; i < frameCount; i += 1) {
      let sumSquares = 0;
      const frameStart = i * frameSize;
      for (let j = 0; j < frameSize; j += 1) {
        const value = samples[frameStart + j] ?? 0;
        sumSquares += value * value;
      }
      const rms = Math.sqrt(sumSquares / frameSize);
      frameRms[i] = rms;
      frameDb[i] = Math.max(ENVELOPE_FLOOR_DB, toDb(rms + 1e-12));
    }

    const noiseFloorDb = clamp(percentile(frameDb, 20) ?? -68, -90, -28);
    const speechThresholdDb = clamp(noiseFloorDb + 12, -58, -26);
    const speechMask = frameDb.map((db) => db > speechThresholdDb);

    const meanSlice = (values: number[], start: number, end: number) => {
      const safeStart = Math.max(0, start);
      const safeEnd = Math.min(values.length, end);
      if (safeEnd <= safeStart) return null;
      let sum = 0;
      for (let i = safeStart; i < safeEnd; i += 1) {
        sum += values[i];
      }
      return sum / (safeEnd - safeStart);
    };

    const reverbEvents: number[] = [];
    let activeSpeechFrames = 0;
    let speechRun = 0;
    for (let i = 0; i < frameCount - 1; i += 1) {
      if (speechMask[i]) {
        activeSpeechFrames += 1;
        speechRun += 1;
      } else {
        speechRun = 0;
      }

      if (speechRun >= 8 && speechMask[i] && !speechMask[i + 1]) {
        const preDb = meanSlice(frameDb, i - 6, i + 1);
        const shortDb = meanSlice(frameDb, i + 2, i + 10);
        const longDb = meanSlice(frameDb, i + 14, i + 30);
        if (preDb === null || shortDb === null || longDb === null) continue;

        const longDrop = preDb - longDb;
        const shortToLongDecay = shortDb - longDb;
        const tailLift = longDb - noiseFloorDb;

        const eventScore = clamp(
          clamp((20 - longDrop) / 20, 0, 1) * 0.55 +
            clamp((8 - shortToLongDecay) / 8, 0, 1) * 0.35 +
            clamp((tailLift - 4) / 12, 0, 1) * 0.1,
          0,
          1
        );
        reverbEvents.push(eventScore);
      }
    }

    const envelopeMean = mean(frameRms);
    const centered = frameRms.map((value) => value - envelopeMean);
    let bestEchoCorr = 0;
    let bestEchoLagFrames = 0;
    for (let lag = 4; lag <= 18; lag += 1) {
      let num = 0;
      let denA = 0;
      let denB = 0;
      for (let i = 0; i < centered.length - lag; i += 1) {
        const a = centered[i];
        const b = centered[i + lag];
        num += a * b;
        denA += a * a;
        denB += b * b;
      }
      const denom = Math.sqrt(denA * denB) + 1e-12;
      const corr = num / denom;
      if (corr > bestEchoCorr) {
        bestEchoCorr = corr;
        bestEchoLagFrames = lag;
      }
    }

    const p90 = percentile(frameDb, 90) ?? -28;
    const dynamicSpread = Math.max(0, p90 - noiseFloorDb);
    const fallbackReverb = clamp((16 - dynamicSpread) / 16, 0, 0.55);
    const reverbScore = clamp(
      reverbEvents.length > 0 ? (median(reverbEvents) ?? fallbackReverb) : fallbackReverb,
      0,
      1
    );
    const echoScore = clamp((bestEchoCorr - 0.16) / 0.34, 0, 1);
    const noiseIndicator = clamp((noiseFloorDb + 48) / 20, 0, 1);
    const roomScore = clamp(reverbScore * 0.62 + echoScore * 0.28 + noiseIndicator * 0.1, 0, 1);

    const speechCoverage = clamp(activeSpeechFrames / Math.max(frameCount * 0.2, 1), 0, 1);
    const eventCoverage = clamp(reverbEvents.length / 6, 0, 1);
    const analysisConfidence = clamp(eventCoverage * 0.65 + speechCoverage * 0.35, 0, 1);
    const drynessScore = clamp(1 - roomScore - noiseIndicator * 0.15, 0, 1);

    return {
      noiseFloorDb,
      speechThresholdDb,
      reverbScore,
      echoScore,
      roomScore,
      echoDelayMs: bestEchoLagFrames > 0 ? bestEchoLagFrames * ENVELOPE_FRAME_MS : null,
      analysisConfidence,
      drynessScore,
    };
  };

  const runEnvelopeAnalysis = async (ffmpeg: FFmpeg, inputName: string) => {
    const analysisName = `${sanitizeBase(inputName)}_envelope_analysis.f32`;
    try {
      resetLogBuffer();
      await execOrThrow(
        ffmpeg,
        [
          "-hide_banner",
          "-nostdin",
          "-threads",
          "1",
          "-y",
          "-i",
          inputName,
          "-t",
          `${ANALYSIS_SAMPLE_SECONDS}`,
          "-ac",
          "1",
          "-ar",
          `${ANALYSIS_SAMPLE_RATE}`,
          "-c:a",
          "pcm_f32le",
          "-f",
          "f32le",
          analysisName,
        ],
        "Envelope analysis render"
      );

      const bytes = await readVirtualFileBytes(ffmpeg, analysisName);
      const samples = toFloatSamples(bytes);
      return computeEnvelopeMetrics(samples);
    } finally {
      await safeDeleteFile(ffmpeg, analysisName);
    }
  };

  const analyzeFile = async (ffmpeg: FFmpeg, inputName: string): Promise<FileAnalysis> => {
    const analysis = createEmptyAnalysis();

    resetLogBuffer();
    await execOrThrow(
      ffmpeg,
      [
        "-hide_banner",
        "-nostdin",
        "-threads",
        "1",
        "-i",
        inputName,
        "-t",
        `${ANALYSIS_SAMPLE_SECONDS}`,
        "-af",
        "loudnorm=I=-24:TP=-2:LRA=7:print_format=json",
        "-f",
        "null",
        "-",
      ],
      "Smart match loudness analysis"
    );

    const loudData = parseLoudnormJson(resetLogBuffer());
    analysis.inputI = parseMaybeNumber(loudData?.input_i);
    analysis.inputLRA = parseMaybeNumber(loudData?.input_lra);
    analysis.inputTP = parseMaybeNumber(loudData?.input_tp);
    analysis.inputThresh = parseMaybeNumber(loudData?.input_thresh);

    analysis.lowRms = await runRmsAnalysis(ffmpeg, inputName, "highpass=f=50,lowpass=f=220");
    analysis.midRms = await runRmsAnalysis(ffmpeg, inputName, "highpass=f=300,lowpass=f=2400");
    analysis.highRms = await runRmsAnalysis(ffmpeg, inputName, "highpass=f=2800,lowpass=f=9000");

    try {
      const envelope = await runEnvelopeAnalysis(ffmpeg, inputName);
      analysis.noiseFloorDb = envelope.noiseFloorDb;
      analysis.speechThresholdDb = envelope.speechThresholdDb;
      analysis.reverbScore = envelope.reverbScore;
      analysis.echoScore = envelope.echoScore;
      analysis.roomScore = envelope.roomScore;
      analysis.echoDelayMs = envelope.echoDelayMs;
      analysis.analysisConfidence = envelope.analysisConfidence;
      analysis.drynessScore = envelope.drynessScore;
    } catch (error) {
      appendLog(
        `[Analysis] Envelope fallback (${inputName}): ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    return analysis;
  };

  const buildBatchReference = (analyses: FileAnalysis[]) => {
    const lowTilts: number[] = [];
    const highTilts: number[] = [];
    const lras: number[] = [];

    for (const analysis of analyses) {
      if (analysis.lowRms !== null && analysis.midRms !== null) {
        lowTilts.push(analysis.lowRms - analysis.midRms);
      }
      if (analysis.highRms !== null && analysis.midRms !== null) {
        highTilts.push(analysis.highRms - analysis.midRms);
      }
      if (analysis.inputLRA !== null) {
        lras.push(analysis.inputLRA);
      }
    }

    const lowTilt = robustMedian(lowTilts);
    const highTilt = robustMedian(highTilts);
    const lra = robustMedian(lras);

    if (lowTilt === null && highTilt === null && lra === null) return null;

    return {
      lowTilt: lowTilt ?? -11,
      highTilt: highTilt ?? -13,
      lra: lra ?? 6,
    } satisfies BatchReference;
  };

  const buildAdaptiveProfile = (analysis: FileAnalysis | undefined, reference: BatchReference | null) => {
    const needsAdaptiveProfile =
      smartMatchConfig.tone > 0 || smartMatchConfig.dynamics > 0 || roomCleanup || sceneBlend;
    if (!needsAdaptiveProfile || !analysis) return null;

    const smartToneEnabled = smartMatchConfig.tone > 0;
    const smartDynamicsEnabled = smartMatchConfig.dynamics > 0;

    const referenceLowTilt = reference?.lowTilt ?? -11;
    const referenceHighTilt = reference?.highTilt ?? -13;
    const referenceLra = reference?.lra ?? 6;

    const lowTilt =
      analysis.lowRms !== null && analysis.midRms !== null
        ? analysis.lowRms - analysis.midRms
        : referenceLowTilt;
    const highTilt =
      analysis.highRms !== null && analysis.midRms !== null
        ? analysis.highRms - analysis.midRms
        : referenceHighTilt;
    const lowTiltDiff = lowTilt - referenceLowTilt;
    const highTiltDiff = highTilt - referenceHighTilt;

    const toneFactor = smartToneEnabled ? smartMatchConfig.tone : 0;
    const dynamicsFactor = smartDynamicsEnabled ? smartMatchConfig.dynamics : 0;

    const highpassHz = Math.round(clamp(80 + lowTiltDiff * 2.2 * toneFactor, 65, 105));
    const lowMidGainDb = clamp(-2 - lowTiltDiff * 0.28 * toneFactor, -3.6, 1.2);

    let presenceGainDb = clamp(-highTiltDiff * 0.45 * toneFactor, -2.2, 1.8);
    let airGainDb = clamp(-highTiltDiff * 0.25 * toneFactor, -1.4, 1.0);

    const lra = analysis.inputLRA ?? referenceLra;
    const lraDiff = lra - referenceLra;
    const compressorRatioOffset = clamp(lraDiff * 0.07 * dynamicsFactor, -0.35, 0.45);
    const compressorThresholdOffsetDb = clamp(lraDiff * 0.6 * dynamicsFactor, -1.5, 1.5);

    const measuredNoiseFloor = analysis.noiseFloorDb ?? -70;
    let noiseRisk: NoiseRisk = "low";
    if (analysis.noiseFloorDb !== null) {
      noiseRisk = measuredNoiseFloor > -50 ? "high" : measuredNoiseFloor > -58 ? "medium" : "low";
    } else if (analysis.inputThresh !== null) {
      // Only use loudnorm threshold when envelope analysis is unavailable.
      noiseRisk = analysis.inputThresh > -33 ? "high" : analysis.inputThresh > -37 ? "medium" : "low";
    }

    const inputTP = analysis.inputTP ?? -9;
    const hotPeakFactor = clamp((inputTP + 9) / 7, 0, 1);
    const brightFactor = clamp((highTiltDiff + 1.8) / 4.5, 0, 1);
    const dynamicFactor = clamp((lra - 5.5) / 7, 0, 1);
    const emotionProtection = clamp(
      (hotPeakFactor * 0.48 + dynamicFactor * 0.4) * dynamicsFactor,
      0,
      0.82
    );
    const levelingNeed = clamp(
      (dynamicFactor * 0.72 + Math.max(0, lraDiff) / 8) * dynamicsFactor,
      0,
      1
    );
    const emotionalHarshnessCutDb = clamp(
      (hotPeakFactor * 0.95 + brightFactor * 0.7) * toneFactor,
      0,
      1.6
    );
    const topEndHarshnessCutDb = clamp(emotionalHarshnessCutDb * 0.75, 0, 1.2);

    const analysisConfidence = analysis.analysisConfidence ?? 0.25;
    const rawRoomScore = analysis.roomScore ?? 0;
    const confidenceScaledRoom = rawRoomScore * clamp(0.75 + analysisConfidence * 0.25, 0.75, 1);
    let roomRisk = classifyRoomRisk(confidenceScaledRoom);
    if (analysisConfidence < 0.35) {
      roomRisk = downgradeRoomRisk(roomRisk);
    }

    if (noiseRisk !== "low" || roomRisk !== "low") {
      const positiveTrim =
        roomRisk === "high" ? 0.2 : roomRisk === "medium" ? 0.45 : noiseRisk === "high" ? 0.35 : 0.7;
      if (presenceGainDb > 0) presenceGainDb *= positiveTrim;
      if (airGainDb > 0) airGainDb *= positiveTrim;
    }

    const roomCleanupEnabled = roomCleanup && analysisConfidence >= 0.45;
    const useDenoise = false;
    const useTailGate = roomCleanupEnabled && roomRisk === "high" && analysisConfidence >= 0.72;
    const denoiseStrength = 0;
    const tailGateStrength = roomRisk === "high" ? 0.12 : 0;
    const echoNotchCutDb = roomCleanupEnabled
      ? clamp((analysis.echoScore ?? 0) * (roomRisk === "high" ? 0.55 : 0.35), 0, 0.6)
      : 0;

    const baseDynaTrim = noiseGuard ? (noiseRisk === "high" ? 3 : noiseRisk === "medium" ? 2 : 0) : 0;
    const roomDynaTrim = roomRisk === "high" ? 1.4 : roomRisk === "medium" ? 0.7 : 0;
    const dynaTrim = baseDynaTrim + roomDynaTrim;

    const dryness = analysis.drynessScore ?? clamp(1 - confidenceScaledRoom, 0, 1);
    const blendRiskDamp = roomRisk === "high" ? 0.08 : roomRisk === "medium" ? 0.28 : 1;
    const blendConfidenceScale = clamp(0.35 + analysisConfidence * 0.65, 0.35, 1);
    const blendBase = clamp(0.025 + dryness * 0.03, 0.02, 0.055);
    const blendAmount = sceneBlend ? blendBase * blendRiskDamp * blendConfidenceScale : 0;
    const blendIndoorGain = clamp(blendAmount * 0.62, 0, 0.07);
    const blendOutdoorGain = clamp(blendAmount * 0.42, 0, 0.055);
    const blendIndoorDelayMs = Math.round(clamp(24 + (1 - dryness) * 8, 22, 36));
    const blendOutdoorDelayMs = Math.round(clamp(52 + (1 - dryness) * 18, 48, 74));

    return {
      highpassHz,
      lowMidGainDb,
      presenceGainDb,
      airGainDb,
      emotionalHarshnessCutDb,
      topEndHarshnessCutDb,
      levelingNeed,
      emotionProtection,
      compressorRatioOffset,
      compressorThresholdOffsetDb,
      dynaTrim,
      floorGuardFilter: noiseRisk === "high" ? FLOOR_GUARD_STRONG : FLOOR_GUARD,
      noiseRisk,
      noiseFloorDb: analysis.noiseFloorDb,
      roomRisk,
      useDenoise,
      denoiseStrength,
      useTailGate,
      tailGateStrength,
      echoNotchCutDb,
      blendIndoorGain,
      blendOutdoorGain,
      blendIndoorDelayMs,
      blendOutdoorDelayMs,
    } satisfies AdaptiveProfile;
  };

  const buildTailGateFilter = (strength: number) => {
    const thresholdDb = clamp(-56 + strength * 4, -56, -52);
    const threshold = fromDb(thresholdDb);
    const ratio = clamp(1.03 + strength * 0.7, 1.03, 1.4);
    const range = clamp(0.82 - strength * 0.16, 0.64, 0.82);
    const attack = Math.round(clamp(24 - strength * 6, 18, 26));
    const release = Math.round(clamp(520 - strength * 120, 380, 520));
    const makeup = 1;
    return `agate=mode=downward:threshold=${threshold.toFixed(5)}:ratio=${ratio.toFixed(
      2
    )}:range=${range.toFixed(3)}:attack=${attack}:release=${release}:makeup=${makeup.toFixed(
      2
    )}:detection=rms:link=average`;
  };

  const buildAdaptiveNoiseReductionFilter = (noiseRisk: NoiseRisk, noiseFloorDb: number | null) => {
    if (noiseRisk === "low") return null;

    const estimatedFloor = noiseFloorDb ?? (noiseRisk === "high" ? -49 : -55);
    const severeNoise = noiseRisk === "high" && estimatedFloor > -46;
    const sigmaDb = clamp(
      estimatedFloor + (severeNoise ? 1.8 : noiseRisk === "high" ? 2.8 : 2.2),
      -56,
      severeNoise ? -46 : -44
    );
    const percent = severeNoise ? 10 : noiseRisk === "high" ? 14 : 9;
    const softness = severeNoise ? 9.0 : noiseRisk === "high" ? 7.8 : 8.6;
    const levels = severeNoise ? 4 : noiseRisk === "high" ? 6 : 5;
    const samples = severeNoise ? 1024 : noiseRisk === "high" ? 4096 : 2048;
    const adaptiveMode = severeNoise ? 0 : 1;

    return `afwtdn=sigma=${sigmaDb.toFixed(
      1
    )}dB:percent=${percent}:adaptive=${adaptiveMode}:samples=${samples}:softness=${softness.toFixed(
      1
    )}:levels=${levels}`;
  };

  type MixRenderOptions = {
    disableRoomCleanup?: boolean;
    disableAdaptiveNoiseReduction?: boolean;
    minimalStabilityChain?: boolean;
    disableLimiter?: boolean;
  };

  const resolveAdaptiveNoiseReductionFilter = (
    profile: AdaptiveProfile | null,
    options?: MixRenderOptions
  ) => {
    if (!noiseGuard || !profile) return null;
    if (options?.minimalStabilityChain || options?.disableAdaptiveNoiseReduction) return null;
    return buildAdaptiveNoiseReductionFilter(profile.noiseRisk, profile.noiseFloorDb);
  };

  const buildMixFilter = (profile: AdaptiveProfile | null, options?: MixRenderOptions) => {
    const filters: string[] = [];
    const levelerSettings = LEVELER_PRESETS[leveler];
    const consistency = LEVELER_CONSISTENCY[leveler];
    const dyn = levelerSettings.dyna;
    const minimalStabilityChain = options?.minimalStabilityChain === true;
    const roomCleanupEnabled = roomCleanup && !options?.disableRoomCleanup && !minimalStabilityChain;

    if (eqCleanup) {
      const highpassHz = profile?.highpassHz ?? 80;
      const lowMidGainDb = profile?.lowMidGainDb ?? -2;
      filters.push(`highpass=f=${highpassHz}`);
      filters.push(`equalizer=f=250:width_type=q:width=1.0:g=${lowMidGainDb.toFixed(2)}`);
    }

    if (dyn) {
      let dynaF: number = dyn.f;
      let dynaG: number = noiseGuard ? Math.max(3, dyn.g - 1) : dyn.g;
      let dynaM: number = noiseGuard ? Math.max(3, dyn.m - 1) : dyn.m;
      let dynaThresholdAmp = 0;

      if (!minimalStabilityChain) {
        if (profile) {
          const adaptiveLift = profile.levelingNeed * 1.8;
          const emotionRelax = profile.emotionProtection * 1.2;
          dynaG = Math.max(3, dynaG + adaptiveLift - profile.dynaTrim - emotionRelax);
          dynaM = Math.max(3, dynaM + adaptiveLift - profile.dynaTrim - emotionRelax);

          // Noisy takes need slower and lower lift to avoid raising room noise in pauses.
          if (noiseGuard) {
            if (profile.noiseRisk === "high" || (profile.noiseFloorDb ?? -70) > -46) {
              dynaF = Math.max(dynaF, 321);
              dynaG = Math.min(dynaG, 3);
              dynaM = Math.min(dynaM, 3);
              const gateDb = clamp((profile.noiseFloorDb ?? -46) + 5.8, -56, -38);
              dynaThresholdAmp = fromDb(gateDb);
            } else if (profile.noiseRisk === "medium" || (profile.noiseFloorDb ?? -70) > -52) {
              dynaF = Math.max(dynaF, 341);
              dynaG = Math.min(dynaG, 4);
              dynaM = Math.min(dynaM, 5);
              const gateDb = clamp((profile.noiseFloorDb ?? -50) + 4.6, -58, -40);
              dynaThresholdAmp = fromDb(gateDb);
            }
          }
        }
      } else {
        // Stability-safe fallback keeps mandatory leveler but removes adaptive modifiers.
        dynaF = dyn.f;
        dynaG = dyn.g;
        dynaM = dyn.m;
      }

      const dynaGInt = toOddInt(dynaG, 3, 301);
      const dynaMValue = toOddInt(dynaM, 3, 301);
      const dynaThreshold =
        dynaThresholdAmp > 0 ? `:t=${clamp(dynaThresholdAmp, fromDb(-60), fromDb(-36)).toFixed(5)}` : "";
      filters.push(`dynaudnorm=f=${dynaF}:g=${dynaGInt}:m=${dynaMValue}${dynaThreshold}`);
    }

    const breath = BREATH_COMPAND[breathControl];
    const adaptiveNoiseReductionFilter = resolveAdaptiveNoiseReductionFilter(profile, options);
    const useAdaptiveNoiseReduction = adaptiveNoiseReductionFilter !== null;
    const roomGateFilter =
      roomCleanupEnabled && (profile?.useTailGate ?? false)
        ? buildTailGateFilter(profile?.tailGateStrength ?? 0.12)
        : null;
    const useRoomGate = roomGateFilter !== null;
    const preferFloorGuard =
      floorGuard &&
      (profile?.noiseRisk === "high" || (noiseGuard && profile?.noiseRisk === "medium"));
    const useFloorGuard = !useRoomGate && floorGuard && (breath === null || preferFloorGuard);
    const useBreathCompand = !useRoomGate && breath !== null && !useFloorGuard;

    if (!minimalStabilityChain && useRoomGate && roomGateFilter) {
      filters.push(roomGateFilter);
    }
    if (!minimalStabilityChain && useBreathCompand) {
      filters.push(breath);
    }
    if (!minimalStabilityChain && useFloorGuard) {
      filters.push(profile?.floorGuardFilter ?? FLOOR_GUARD);
    }

    // Merge static harshness softening with smart-match tone offsets to avoid
    // competing EQ moves on the same bands.
    const basePresenceCut = softenHarshness ? -2.0 : 0;
    const baseAirCut = softenHarshness ? -1.1 : 0;
    const harshPresenceCut = profile?.emotionalHarshnessCutDb ?? 0;
    const harshAirCut = profile?.topEndHarshnessCutDb ?? 0;
    const netPresenceGain = clamp(
      basePresenceCut + (profile?.presenceGainDb ?? 0) - harshPresenceCut,
      -4.0,
      0.7
    );
    const netAirGain = clamp(baseAirCut + (profile?.airGainDb ?? 0) - harshAirCut, -2.7, 0.45);

    if (!minimalStabilityChain && Math.abs(netPresenceGain) >= 0.2) {
      filters.push(`equalizer=f=3500:width_type=q:width=1.15:g=${netPresenceGain.toFixed(2)}`);
    }
    if (!minimalStabilityChain && Math.abs(netAirGain) >= 0.2) {
      filters.push(`equalizer=f=8000:width_type=q:width=0.75:g=${netAirGain.toFixed(2)}`);
    }
    if (!minimalStabilityChain && (profile?.topEndHarshnessCutDb ?? 0) >= 0.45) {
      const topShelfCut = clamp(-0.35 - (profile?.topEndHarshnessCutDb ?? 0) * 0.55, -1.1, -0.35);
      filters.push(`equalizer=f=11200:width_type=q:width=0.7:g=${topShelfCut.toFixed(2)}`);
    }
    if (!minimalStabilityChain && roomCleanupEnabled && (profile?.echoNotchCutDb ?? 0) >= 0.25) {
      const echoNotchGain = -clamp(profile?.echoNotchCutDb ?? 0, 0.25, 0.6);
      filters.push(`equalizer=f=2450:width_type=q:width=1.4:g=${echoNotchGain.toFixed(2)}`);
    }

    const thresholdBase = parseFloat(levelerSettings.compressor.threshold.replace("dB", ""));
    const ratioBase = parseFloat(levelerSettings.compressor.ratio);

    let thresholdAdjust = minimalStabilityChain ? 0 : (profile?.compressorThresholdOffsetDb ?? 0);
    let ratioAdjust = minimalStabilityChain ? 0 : (profile?.compressorRatioOffset ?? 0);
    const levelingNeed = minimalStabilityChain ? 0 : (profile?.levelingNeed ?? 0);
    const emotionProtection = minimalStabilityChain ? 0 : (profile?.emotionProtection ?? 0);

    // Keep upstream processors from sounding overcontrolled.
    if (dyn) {
      thresholdAdjust += 0.25;
      ratioAdjust -= 0.08;
    }
    if (useBreathCompand || useFloorGuard) {
      thresholdAdjust += 0.15;
      ratioAdjust -= 0.05;
    }
    if (useRoomGate) {
      thresholdAdjust += 0.22;
      ratioAdjust -= 0.08;
    }

    // Smarter consistency: tighten when needed, but protect emotional peaks.
    const thresholdTighten = consistency * (0.55 + levelingNeed * 0.75);
    const threshold = clamp(
      thresholdBase + thresholdAdjust - thresholdTighten + emotionProtection * 0.65,
      -32.5,
      -17.2
    );
    const ratio = clamp(
      ratioBase + ratioAdjust + consistency * 0.22 + levelingNeed * 0.3 - emotionProtection * 0.35,
      1.55,
      3.0
    );
    const attack = Math.round(clamp(24 - consistency * 8 + emotionProtection * 8, 14, 30));
    const release = Math.round(clamp(170 - consistency * 45 + emotionProtection * 75, 95, 235));
    const compMix = clamp(0.9 + levelingNeed * 0.07 - emotionProtection * 0.24, 0.7, 0.95);

    filters.push(
      `acompressor=threshold=${threshold.toFixed(1)}dB:ratio=${ratio.toFixed(2)}:attack=${attack}:release=${release}:mix=${compMix.toFixed(2)}:detection=rms`
    );
    if (useAdaptiveNoiseReduction && adaptiveNoiseReductionFilter) {
      filters.push(adaptiveNoiseReductionFilter);
    }
    if (!options?.disableLimiter) {
      filters.push(LIMITER_FILTER);
    }

    return filters.join(",");
  };

  const buildBlendFilter = (profile: AdaptiveProfile | null) => {
    const indoorGain = profile?.blendIndoorGain ?? 0.015;
    const outdoorGain = profile?.blendOutdoorGain ?? 0.01;
    const indoorDelay = Math.round(profile?.blendIndoorDelayMs ?? 28);
    const outdoorDelay = Math.round(profile?.blendOutdoorDelayMs ?? 58);

    const wetTotal = indoorGain + outdoorGain;
    const dryGain = clamp(1 - wetTotal * 0.55, 0.93, 1);

    return [
      "asplit=3[dry][ind_src][out_src]",
      `[ind_src]adelay=${indoorDelay}:all=1,highpass=f=280,lowpass=f=4600,volume=${indoorGain.toFixed(
        4
      )}[ind]`,
      `[out_src]adelay=${outdoorDelay}:all=1,highpass=f=220,lowpass=f=3000,volume=${outdoorGain.toFixed(
        4
      )}[out]`,
      `[dry]volume=${dryGain.toFixed(4)}[dryv]`,
      "[dryv][ind][out]amix=inputs=3:normalize=0,alimiter=limit=-2dB:level=disabled",
    ].join(";");
  };

  const writeOutput = async (
    ffmpeg: FFmpeg,
    name: string,
    kind: OutputEntry["kind"],
    variant: OutputEntry["variant"]
  ): Promise<OutputEntry> => {
    const bytes = await readVirtualFileBytes(ffmpeg, name);
    const blob = new Blob([bytes], { type: "audio/wav" });
    return {
      name,
      url: URL.createObjectURL(blob),
      size: blob.size,
      kind,
      variant,
    };
  };

  const runMixReady = async (
    ffmpeg: FFmpeg,
    inputName: string,
    outputName: string,
    profile: AdaptiveProfile | null,
    options?: MixRenderOptions
  ) => {
    const filterChain = buildMixFilter(profile, options);
    resetLogBuffer();
    await execOrThrow(
      ffmpeg,
      [
        "-hide_banner",
        "-nostdin",
        "-threads",
        "1",
        "-filter_threads",
        "1",
        "-y",
        "-i",
        inputName,
        "-af",
        filterChain,
        "-ar",
        "48000",
        "-ac",
        "1",
        "-c:a",
        "pcm_f32le",
        outputName,
      ],
      "Mix-ready render"
    );
  };

  const runMixReadySplitAdaptiveNr = async (
    ffmpeg: FFmpeg,
    inputName: string,
    outputName: string,
    profile: AdaptiveProfile | null,
    options?: MixRenderOptions
  ) => {
    const adaptiveNoiseReductionFilter = resolveAdaptiveNoiseReductionFilter(profile, options);
    if (!adaptiveNoiseReductionFilter) {
      throw new Error("Split adaptive-NR path unavailable.");
    }

    const preNrFilterChain = buildMixFilter(profile, {
      ...options,
      disableAdaptiveNoiseReduction: true,
      disableLimiter: true,
    });
    const postNrFilterChain = `${adaptiveNoiseReductionFilter},${LIMITER_FILTER}`;
    const tempName = `${sanitizeBase(outputName)}_pre_nr.wav`;

    try {
      resetLogBuffer();
      await execOrThrow(
        ffmpeg,
        [
          "-hide_banner",
          "-nostdin",
          "-threads",
          "1",
          "-filter_threads",
          "1",
          "-y",
          "-i",
          inputName,
          "-af",
          preNrFilterChain,
          "-ar",
          "48000",
          "-ac",
          "1",
          "-c:a",
          "pcm_f32le",
          tempName,
        ],
        "Mix-ready pre-NR render"
      );

      resetLogBuffer();
      await execOrThrow(
        ffmpeg,
        [
          "-hide_banner",
          "-nostdin",
          "-threads",
          "1",
          "-filter_threads",
          "1",
          "-y",
          "-i",
          tempName,
          "-af",
          postNrFilterChain,
          "-ar",
          "48000",
          "-ac",
          "1",
          "-c:a",
          "pcm_f32le",
          outputName,
        ],
        "Mix-ready adaptive-NR compatibility render"
      );
    } finally {
      await safeDeleteFile(ffmpeg, tempName);
    }
  };

  const probeInputDurationSeconds = async (ffmpeg: FFmpeg, inputName: string) => {
    resetLogBuffer();
    await execOrThrow(
      ffmpeg,
      [
        "-hide_banner",
        "-nostdin",
        "-i",
        inputName,
        "-t",
        "0.1",
        "-f",
        "null",
        "-",
      ],
      "Duration probe"
    );
    const logText = resetLogBuffer();
    return parseDurationSeconds(logText);
  };

  const runMixReadySegmented = async (
    ffmpeg: FFmpeg,
    inputName: string,
    outputName: string,
    profile: AdaptiveProfile | null,
    durationSeconds: number,
    options?: MixRenderOptions
  ) => {
    if (durationSeconds < MIX_SEGMENT_MIN_DURATION_SECONDS) {
      throw new Error("Segmented render skipped (input too short).");
    }
    const segmentCount = Math.ceil(durationSeconds / MIX_SEGMENT_SECONDS);
    if (segmentCount < 2) {
      throw new Error("Segmented render skipped (single segment).");
    }

    const filterChain = buildMixFilter(profile, options);
    const tempBase = sanitizeBase(outputName);
    const segmentNames: string[] = [];
    const concatListName = `${tempBase}_segments.txt`;

    try {
      for (let index = 0; index < segmentCount; index += 1) {
        const start = index * MIX_SEGMENT_SECONDS;
        const remaining = durationSeconds - start;
        const span = Math.min(MIX_SEGMENT_SECONDS, Math.max(remaining, 0));
        if (span <= 0.01) break;
        const segmentName = `${tempBase}_seg_${index + 1}.wav`;
        segmentNames.push(segmentName);

        resetLogBuffer();
        await execOrThrow(
      ffmpeg,
      [
        "-hide_banner",
        "-nostdin",
        "-threads",
        "1",
        "-filter_threads",
        "1",
        "-y",
        "-ss",
        start.toFixed(3),
            "-t",
            span.toFixed(3),
            "-i",
            inputName,
            "-af",
            filterChain,
            "-ar",
            "48000",
            "-ac",
            "1",
            "-c:a",
            "pcm_f32le",
            segmentName,
          ],
          `Segment mix-ready render ${index + 1}/${segmentCount}`
        );
      }

      if (segmentNames.length < 2) {
        throw new Error("Segmented render produced insufficient segments.");
      }

      const concatList = `${segmentNames.map((name) => `file '${name}'`).join("\n")}\n`;
      await ffmpeg.writeFile(concatListName, new TextEncoder().encode(concatList));

      resetLogBuffer();
      await execOrThrow(
      ffmpeg,
      [
        "-hide_banner",
        "-nostdin",
        "-threads",
        "1",
        "-y",
        "-f",
        "concat",
          "-safe",
          "0",
          "-i",
          concatListName,
          "-c",
          "copy",
          outputName,
        ],
        "Segment concat render"
      );
    } finally {
      await safeDeleteFile(ffmpeg, concatListName);
      for (const segmentName of segmentNames) {
        await safeDeleteFile(ffmpeg, segmentName);
      }
    }
  };

  const runBlendMixReady = async (
    ffmpeg: FFmpeg,
    inputName: string,
    outputName: string,
    profile: AdaptiveProfile | null
  ) => {
    const filterChain = buildBlendFilter(profile);
    resetLogBuffer();
    await execOrThrow(
      ffmpeg,
      [
        "-hide_banner",
        "-nostdin",
        "-threads",
        "1",
        "-filter_threads",
        "1",
        "-y",
        "-i",
        inputName,
        "-af",
        filterChain,
        "-ar",
        "48000",
        "-ac",
        "1",
        "-c:a",
        "pcm_f32le",
        outputName,
      ],
      "Blend mix-ready render"
    );
  };

  const runOnePassLoudnorm = async (
    ffmpeg: FFmpeg,
    inputName: string,
    outputName: string,
    cfg: NonNullable<(typeof LOUDNESS_PRESETS)[keyof typeof LOUDNESS_PRESETS]>
  ) => {
    resetLogBuffer();
    await execOrThrow(
      ffmpeg,
      [
        "-hide_banner",
        "-nostdin",
        "-threads",
        "1",
        "-filter_threads",
        "1",
        "-y",
        "-i",
        inputName,
        "-af",
        `loudnorm=I=${cfg.I}:TP=${cfg.TP}:LRA=${cfg.LRA}:print_format=summary`,
        "-ar",
        "48000",
        "-ac",
        "1",
        "-c:a",
        "pcm_f32le",
        outputName,
      ],
      "One-pass loudnorm"
    );
  };

  const runLoudnorm = async (
    ffmpeg: FFmpeg,
    inputName: string,
    outputName: string,
    cfg: NonNullable<(typeof LOUDNESS_PRESETS)[keyof typeof LOUDNESS_PRESETS]>
  ) => {
    resetLogBuffer();
    await execOrThrow(
      ffmpeg,
      [
        "-hide_banner",
        "-nostdin",
        "-threads",
        "1",
        "-filter_threads",
        "1",
        "-i",
        inputName,
        "-af",
        `loudnorm=I=${cfg.I}:TP=${cfg.TP}:LRA=${cfg.LRA}:print_format=json`,
        "-f",
        "null",
        "-",
      ],
      "Loudnorm analysis"
    );

    const logText = resetLogBuffer();
    const data = parseLoudnormJson(logText);

    const measuredI = parseMaybeNumber(data?.input_i);
    const measuredTP = parseMaybeNumber(data?.input_tp);
    const measuredLRA = parseMaybeNumber(data?.input_lra);
    const measuredThresh = parseMaybeNumber(data?.input_thresh);
    const offset = parseMaybeNumber(data?.target_offset);

    if (
      measuredI === null ||
      measuredTP === null ||
      measuredLRA === null ||
      measuredThresh === null ||
      offset === null
    ) {
      appendLog("Loudnorm pass1 failed; using one-pass loudnorm.");
      await runOnePassLoudnorm(ffmpeg, inputName, outputName, cfg);
      return;
    }

    resetLogBuffer();
    await execOrThrow(
      ffmpeg,
      [
        "-hide_banner",
        "-nostdin",
        "-threads",
        "1",
        "-filter_threads",
        "1",
        "-y",
        "-i",
        inputName,
        "-af",
        `loudnorm=I=${cfg.I}:TP=${cfg.TP}:LRA=${cfg.LRA}:measured_I=${measuredI}:measured_TP=${measuredTP}:measured_LRA=${measuredLRA}:measured_thresh=${measuredThresh}:offset=${offset}:linear=true:print_format=summary`,
        "-ar",
        "48000",
        "-ac",
        "1",
        "-c:a",
        "pcm_f32le",
        outputName,
      ],
      "Loudnorm render"
    );
  };

  const safeDeleteFile = async (ffmpeg: FFmpeg, name: string) => {
    try {
      await ffmpeg.deleteFile(name);
    } catch {
      // Ignore cleanup failures from missing temp files.
    }
  };

  const buildJobs = (inputFiles: File[]) => {
    const seen = new Map<string, number>();
    return inputFiles.map((file, index) => {
      const baseRaw = sanitizeBase(file.name) || `input_${index + 1}`;
      const count = seen.get(baseRaw) ?? 0;
      seen.set(baseRaw, count + 1);
      const base = count === 0 ? baseRaw : `${baseRaw}_${count + 1}`;
      return {
        file,
        base,
        inputName: `${base}_input.wav`,
        mixName: `${base}_mixready.wav`,
        blendMixName: `${base}_blend_mixready.wav`,
      } satisfies JobEntry;
    });
  };

  const writeJobInput = async (ffmpeg: FFmpeg, job: JobEntry) => {
    // Use a fresh buffer every write; FFmpeg worker postMessage can detach transferred ArrayBuffers.
    await ffmpeg.writeFile(job.inputName, await fetchFile(job.file));
  };

  const processFiles = async () => {
    if (!files.length) return;
    setLoading(true);
    setOutputs([]);
    setLogs([]);
    setStatus("Preparing...");

    try {
      let ffmpeg = await ensureFfmpeg();
      const outputEntries: OutputEntry[] = [];
      const jobs = buildJobs(files);
      const analysisByBase = new Map<string, FileAnalysis>();
      let batchReference: BatchReference | null = null;
      const smartMatchEnabled = smartMatchConfig.tone > 0 || smartMatchConfig.dynamics > 0;
      const needsAnalysis = smartMatchEnabled || roomCleanup || sceneBlend;

      if (needsAnalysis) {
        appendLog(`Deep analysis started for ${jobs.length} file(s) (up to ${ANALYSIS_SAMPLE_SECONDS}s each).`);
        const analyses: FileAnalysis[] = [];
        for (let i = 0; i < jobs.length; i += 1) {
          const job = jobs[i];
          setStatus(`Analyze: ${job.base} (${i + 1}/${jobs.length})`);
          try {
            await writeJobInput(ffmpeg, job);
            const analysis = await analyzeFile(ffmpeg, job.inputName);
            analysisByBase.set(job.base, analysis);
            analyses.push(analysis);
          } catch (error) {
            appendLog(
              `Analysis fallback (${job.base}): ${error instanceof Error ? error.message : String(error)}`
            );
            const fallback = createEmptyAnalysis();
            analysisByBase.set(job.base, fallback);
            analyses.push(fallback);
            if (shouldResetFfmpegForError(error)) {
              ffmpeg = await refreshFfmpeg(`analysis failure on ${job.base}`);
            }
          } finally {
            await safeDeleteFile(ffmpeg, job.inputName);
          }

          if (shouldRecycleFfmpegForBatch(i + 1, jobs.length)) {
            ffmpeg = await refreshFfmpeg(`analysis memory guard (${i + 1}/${jobs.length})`);
          }
        }

        if (smartMatchEnabled) {
          batchReference = buildBatchReference(analyses);
          if (batchReference) {
            appendLog(
              `Reference tone low/mid ${batchReference.lowTilt.toFixed(1)} dB, high/mid ${batchReference.highTilt.toFixed(1)} dB, LRA ${batchReference.lra.toFixed(1)}.`
            );
          } else {
            appendLog("Reference analysis unavailable; using base processing chain.");
          }
        }
      }

      let hadErrors = false;
      for (let i = 0; i < jobs.length; i += 1) {
        const job = jobs[i];
        let cleanLoudName: string | null = null;
        let blendLoudName: string | null = null;
        let blendRendered = false;

        try {
          await writeJobInput(ffmpeg, job);
          const profile = buildAdaptiveProfile(analysisByBase.get(job.base), batchReference);
          const roomScore = profile ? (analysisByBase.get(job.base)?.roomScore ?? 0) : null;

          if (profile) {
            appendLog(
              `[Adaptive] ${job.base}: HPF ${profile.highpassHz} Hz, low-mid ${formatSigned(
                profile.lowMidGainDb
              )} dB, presence ${formatSigned(profile.presenceGainDb)} dB, room ${profile.roomRisk} (${(
                roomScore ?? 0
              ).toFixed(2)}), noise ${profile.noiseRisk} (${(profile.noiseFloorDb ?? -70).toFixed(
                1
              )} dB; adaptive-NR ${noiseGuard && profile.noiseRisk !== "low" ? "on" : "off"}), echo ${
                analysisByBase.get(job.base)?.echoDelayMs ?? 0
              } ms, blend ${
                (profile.blendIndoorGain * 100).toFixed(1)
              }/${(profile.blendOutdoorGain * 100).toFixed(1)}%.`
            );
          }

          const hasRoomFilters = roomCleanup && !!profile && (profile.useTailGate || profile.echoNotchCutDb >= 0.25);
          const hasAdaptiveNoiseReduction = noiseGuard && !!profile && profile.noiseRisk !== "low";

          setStatus(`Mix-ready: ${job.base} (${i + 1}/${jobs.length})`);
          const fallbackStrategies: Array<{ label: string; options?: MixRenderOptions }> = [
            { label: "primary chain" },
          ];
          if (hasRoomFilters) {
            fallbackStrategies.push({
              label: "room cleanup bypass",
              options: { disableRoomCleanup: true },
            });
          }
          if (hasAdaptiveNoiseReduction) {
            fallbackStrategies.push({
              label: "adaptive-NR bypass",
              options: { disableAdaptiveNoiseReduction: true },
            });
          }
          if (hasRoomFilters && hasAdaptiveNoiseReduction) {
            fallbackStrategies.push({
              label: "room cleanup + adaptive-NR bypass",
              options: { disableRoomCleanup: true, disableAdaptiveNoiseReduction: true },
            });
          }
          fallbackStrategies.push({
            label: "stability-safe chain",
            options: {
              disableRoomCleanup: true,
              disableAdaptiveNoiseReduction: true,
              minimalStabilityChain: true,
            },
          });

          let mixRendered = false;
          let fallbackApplied: string | null = null;
          let lastMixError: unknown = null;
          let inputDurationSeconds: number | null | undefined = undefined;

          const ensureInputDuration = async () => {
            if (inputDurationSeconds !== undefined) return inputDurationSeconds;
            try {
              inputDurationSeconds = await probeInputDurationSeconds(ffmpeg, job.inputName);
            } catch {
              inputDurationSeconds = null;
            }
            return inputDurationSeconds;
          };

          for (let strategyIndex = 0; strategyIndex < fallbackStrategies.length; strategyIndex += 1) {
            const strategy = fallbackStrategies[strategyIndex];
            try {
              await runMixReady(ffmpeg, job.inputName, job.mixName, profile, strategy.options);
              mixRendered = true;
              fallbackApplied = strategyIndex === 0 ? null : strategy.label;
              break;
            } catch (error) {
              lastMixError = error;
              const strategyFailureMessage = describeError(error);
              if (shouldResetFfmpegForError(error)) {
                ffmpeg = await refreshFfmpeg(`mix fallback on ${job.base}`);
                await writeJobInput(ffmpeg, job);
              }

              const canRunSplitAdaptiveNr = resolveAdaptiveNoiseReductionFilter(profile, strategy.options) !== null;
              if (canRunSplitAdaptiveNr) {
                try {
                  appendLog(
                    `[MixFallback] ${job.base}: ${strategy.label} failed (${strategyFailureMessage}), trying ${strategy.label} with adaptive-NR compatibility split.`
                  );
                  await runMixReadySplitAdaptiveNr(
                    ffmpeg,
                    job.inputName,
                    job.mixName,
                    profile,
                    strategy.options
                  );
                  mixRendered = true;
                  fallbackApplied =
                    strategyIndex === 0
                      ? "primary chain (adaptive-NR compatibility)"
                      : `${strategy.label} (adaptive-NR compatibility)`;
                  break;
                } catch (splitError) {
                  lastMixError = splitError;
                  if (shouldResetFfmpegForError(splitError)) {
                    ffmpeg = await refreshFfmpeg(`adaptive-NR compatibility fallback on ${job.base}`);
                    await writeJobInput(ffmpeg, job);
                  }
                }
              }

              const durationSeconds = await ensureInputDuration();
              const canRunSegmented =
                durationSeconds !== null && durationSeconds >= MIX_SEGMENT_MIN_DURATION_SECONDS;

              if (canRunSegmented && durationSeconds !== null) {
                try {
                  appendLog(
                    `[MixFallback] ${job.base}: ${strategy.label} failed (${strategyFailureMessage}), trying segmented ${strategy.label}.`
                  );
                  await runMixReadySegmented(
                    ffmpeg,
                    job.inputName,
                    job.mixName,
                    profile,
                    durationSeconds,
                    strategy.options
                  );
                  mixRendered = true;
                  fallbackApplied =
                    strategyIndex === 0 ? "primary chain (segmented)" : `${strategy.label} (segmented)`;
                  break;
                } catch (segmentedError) {
                  lastMixError = segmentedError;
                  if (shouldResetFfmpegForError(segmentedError)) {
                    ffmpeg = await refreshFfmpeg(`segmented mix fallback on ${job.base}`);
                    await writeJobInput(ffmpeg, job);
                  }
                }
              }

              const hasMoreStrategies = strategyIndex < fallbackStrategies.length - 1;
              if (hasMoreStrategies) {
                const finalFailureMessage = describeError(lastMixError);
                appendLog(
                  `[MixFallback] ${job.base}: ${strategy.label} failed (${finalFailureMessage}), trying ${fallbackStrategies[
                    strategyIndex + 1
                  ]?.label}.`
                );
              }
            }
          }

          if (!mixRendered) {
            throw lastMixError ?? new Error("Mix-ready render failed.");
          }
          if (fallbackApplied) {
            appendLog(`[MixFallback] ${job.base}: rendered with ${fallbackApplied}.`);
          }

          const mixOutput = await writeOutput(ffmpeg, job.mixName, "mixready", "clean");
          if (keepMixReady || loudnessConfig === null) {
            outputEntries.push(mixOutput);
          }

          if (sceneBlend) {
            const indoorGain = profile?.blendIndoorGain ?? 0;
            const outdoorGain = profile?.blendOutdoorGain ?? 0;
            if (indoorGain + outdoorGain <= 0.0001) {
              appendLog(`[Blend] ${job.base}: bypassed (low analysis confidence).`);
            } else {
              try {
                setStatus(`Blend: ${job.base} (${i + 1}/${jobs.length})`);
                await runBlendMixReady(ffmpeg, job.mixName, job.blendMixName, profile);
                const blendMixOutput = await writeOutput(ffmpeg, job.blendMixName, "mixready", "blend");
                blendRendered = true;
                if (keepMixReady || loudnessConfig === null) {
                  outputEntries.push(blendMixOutput);
                }
              } catch (error) {
                appendLog(
                  `[Blend] ${job.base}: bypassed (${error instanceof Error ? error.message : String(error)})`
                );
              }
            }
          }

          if (loudnessConfig) {
            cleanLoudName = `${job.base}_${loudnessConfig.suffix}.wav`;
            setStatus(`Loudness clean: ${job.base} (${i + 1}/${jobs.length})`);
            await runLoudnorm(ffmpeg, job.mixName, cleanLoudName, loudnessConfig);
            const loudOutput = await writeOutput(ffmpeg, cleanLoudName, "loudness", "clean");
            outputEntries.push(loudOutput);

            if (sceneBlend && blendRendered) {
              blendLoudName = `${job.base}_blend_${loudnessConfig.suffix}.wav`;
              setStatus(`Loudness blend: ${job.base} (${i + 1}/${jobs.length})`);
              await runLoudnorm(ffmpeg, job.blendMixName, blendLoudName, loudnessConfig);
              const blendLoudOutput = await writeOutput(ffmpeg, blendLoudName, "loudness", "blend");
              outputEntries.push(blendLoudOutput);
            }
          }
        } catch (error) {
          hadErrors = true;
          appendLog(`Error (${job.base}): ${error instanceof Error ? error.message : String(error)}`);
          if (shouldResetFfmpegForError(error)) {
            ffmpeg = await refreshFfmpeg(`processing failure on ${job.base}`);
          }
        } finally {
          await safeDeleteFile(ffmpeg, job.inputName);
          await safeDeleteFile(ffmpeg, job.mixName);
          await safeDeleteFile(ffmpeg, job.blendMixName);
          if (cleanLoudName) {
            await safeDeleteFile(ffmpeg, cleanLoudName);
          }
          if (blendLoudName) {
            await safeDeleteFile(ffmpeg, blendLoudName);
          }
        }

        if (shouldRecycleFfmpegForBatch(i + 1, jobs.length)) {
          ffmpeg = await refreshFfmpeg(`processing memory guard (${i + 1}/${jobs.length})`);
        }
      }

      setOutputs(outputEntries);
      setStatus(hadErrors ? "Done with warnings" : "Done");
    } catch (err) {
      appendLog(`Error: ${err instanceof Error ? err.message : String(err)}`);
      setStatus("Failed");
    } finally {
      setLoading(false);
    }
  };

  const handleFiles = (incoming: FileList | null) => {
    if (!incoming) return;
    const wavs = Array.from(incoming).filter((file) => file.name.toLowerCase().endsWith(".wav"));
    setFiles((prev) => {
      const merged = [...prev];
      const seen = new Set(prev.map((file) => `${file.name}|${file.size}|${file.lastModified}`));
      for (const file of wavs) {
        const key = `${file.name}|${file.size}|${file.lastModified}`;
        if (!seen.has(key)) {
          seen.add(key);
          merged.push(file);
        }
      }
      return merged;
    });
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragActive(false);
    handleFiles(event.dataTransfer.files);
  };

  const downloadOutputsZip = async () => {
    if (outputs.length === 0 || zipBusy) return;

    setZipBusy(true);
    setZipProgress(0);

    try {
      const zip = new JSZip();

      for (let i = 0; i < outputs.length; i += 1) {
        const output = outputs[i];
        const response = await fetch(output.url);
        const blob = await response.blob();
        zip.file(output.name, blob);
        setZipProgress(Math.round(((i + 1) / outputs.length) * 70));
      }

      const zipBlob = await zip.generateAsync(
        {
          type: "blob",
          compression: "DEFLATE",
          compressionOptions: { level: 6 },
        },
        ({ percent }) => {
          setZipProgress(70 + Math.round((percent / 100) * 30));
        }
      );

      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const archiveName = `vo_leveler_outputs_${stamp}.zip`;
      const zipUrl = URL.createObjectURL(zipBlob);
      const link = document.createElement("a");
      link.href = zipUrl;
      link.download = archiveName;
      link.rel = "noopener";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => URL.revokeObjectURL(zipUrl), 30_000);
      appendLog(`ZIP created: ${archiveName} (${formatBytes(zipBlob.size)})`);
    } catch (error) {
      appendLog(`ZIP export failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setZipBusy(false);
      setZipProgress(0);
    }
  };

  return (
    <div>
      <div className={styles.panel}>
        <div className={styles.card}>
          <div
            className={`${styles.dropzone} ${dragActive ? styles.dropActive : ""}`}
            onDragOver={(event) => {
              event.preventDefault();
              setDragActive(true);
            }}
            onDragLeave={() => setDragActive(false)}
            onDrop={onDrop}
          >
            <div className={styles.dropTitle}>Drop WAV files or pick a folder</div>
            <div className={styles.dropHint}>
              Processing runs locally in the browser. Files never leave this machine.
            </div>
            <div className={styles.dropHint}>New drops are added to the current queue.</div>
            <div className={styles.controls}>
              <label className={styles.button}>
                Select Files
                <input
                  type="file"
                  accept=".wav"
                  multiple
                  hidden
                  onChange={(event) => {
                    handleFiles(event.target.files);
                    event.currentTarget.value = "";
                  }}
                />
              </label>
              <label className={`${styles.button} ${styles.buttonSecondary}`}>
                Select Folder
                <input
                  type="file"
                  accept=".wav"
                  multiple
                  hidden
                  // @ts-expect-error webkitdirectory is supported in Chromium-based browsers.
                  webkitdirectory="true"
                  directory="true"
                  onChange={(event) => {
                    handleFiles(event.target.files);
                    event.currentTarget.value = "";
                  }}
                />
              </label>
            </div>
            <div className={styles.fileList}>
              {files.length === 0 && <div className={styles.dropHint}>No files selected.</div>}
              {files.map((file, index) => (
                <div className={styles.fileItem} key={`${file.name}-${file.lastModified}-${index}`}>
                  <div>{file.name}</div>
                  <span>{formatBytes(file.size)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className={styles.card}>
          <div className={styles.optionGrid}>
            <div className={styles.field}>
              <label className={styles.label}>Loudness target</label>
              <select
                className={styles.select}
                value={loudnessTarget}
                onChange={(event) => setLoudnessTarget(event.target.value as keyof typeof LOUDNESS_PRESETS)}
              >
                {Object.keys(LOUDNESS_PRESETS).map((key) => (
                  <option key={key} value={key}>
                    {key}
                  </option>
                ))}
              </select>
            </div>
            <div className={styles.field}>
              <label className={styles.label}>Smart voice match</label>
              <select
                className={styles.select}
                value={smartMatchMode}
                onChange={(event) =>
                  setSmartMatchMode(event.target.value as keyof typeof SMART_MATCH_PRESETS)
                }
              >
                {Object.keys(SMART_MATCH_PRESETS).map((key) => (
                  <option key={key} value={key}>
                    {key}
                  </option>
                ))}
              </select>
            </div>
            <div className={styles.field}>
              <label className={styles.label}>Leveling strength</label>
              <select
                className={styles.select}
                value={leveler}
                onChange={(event) => setLeveler(event.target.value as keyof typeof LEVELER_PRESETS)}
              >
                {Object.keys(LEVELER_PRESETS).map((key) => (
                  <option key={key} value={key}>
                    {key}
                  </option>
                ))}
              </select>
              <div className={styles.label}>
                Smart consistency with emotion protection (tighter average level, preserved performance peaks).
              </div>
            </div>
            <div className={styles.field}>
              <label className={styles.label}>Breath control</label>
              <select
                className={styles.select}
                value={breathControl}
                onChange={(event) => setBreathControl(event.target.value as keyof typeof BREATH_COMPAND)}
              >
                {Object.keys(BREATH_COMPAND).map((key) => (
                  <option key={key} value={key}>
                    {key}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className={styles.toggleRow}>
            <div>
              <strong>EQ cleanup</strong>
              <div className={styles.label}>HPF + small low-mid shaping for consistency</div>
            </div>
            <input
              type="checkbox"
              checked={eqCleanup}
              onChange={(event) => setEqCleanup(event.target.checked)}
            />
          </div>
          <div className={styles.toggleRow}>
            <div>
              <strong>Soften harshness</strong>
              <div className={styles.label}>
                Cinematic softening for bright/emotional lines (3.5 kHz + 8 kHz + gentle top-end trim)
              </div>
            </div>
            <input
              type="checkbox"
              checked={softenHarshness}
              onChange={(event) => setSoftenHarshness(event.target.checked)}
            />
          </div>
          <div className={styles.toggleRow}>
            <div>
              <strong>Room cleanup (auto detect)</strong>
              <div className={styles.label}>
                Detects mild room echo/reverb and applies subtle denoise + tail control only when needed.
              </div>
            </div>
            <input
              type="checkbox"
              checked={roomCleanup}
              onChange={(event) => setRoomCleanup(event.target.checked)}
            />
          </div>
          <div className={styles.toggleRow}>
            <div>
              <strong>Scene blend (adaptive subtle)</strong>
              <div className={styles.label}>
                Adds very light mono early reflections so VO sits in-picture without sounding processed.
              </div>
            </div>
            <input
              type="checkbox"
              checked={sceneBlend}
              onChange={(event) => setSceneBlend(event.target.checked)}
            />
          </div>
          <div className={styles.toggleRow}>
            <div>
              <strong>Noise guard</strong>
              <div className={styles.label}>Limits auto-leveler gain to avoid noise lift</div>
            </div>
            <input
              type="checkbox"
              checked={noiseGuard}
              onChange={(event) => setNoiseGuard(event.target.checked)}
            />
          </div>
          <div className={styles.toggleRow}>
            <div>
              <strong>Floor guard</strong>
              <div className={styles.label}>
                Keeps near-silence quiet; auto-prioritized over breath control on noisy tracks
              </div>
            </div>
            <input
              type="checkbox"
              checked={floorGuard}
              onChange={(event) => setFloorGuard(event.target.checked)}
            />
          </div>
          <div className={styles.toggleRow}>
            <div>
              <strong>Keep mix-ready file</strong>
              <div className={styles.label}>Store _mixready.wav alongside loudness exports</div>
            </div>
            <input
              type="checkbox"
              checked={keepMixReady}
              onChange={(event) => setKeepMixReady(event.target.checked)}
              disabled={loudnessConfig === null}
            />
          </div>

          <div className={styles.controls} style={{ marginTop: 12 }}>
            <button className={styles.button} onClick={processFiles} disabled={loading || files.length === 0}>
              {loading ? "Processing..." : "Run Batch"}
            </button>
            <button
              className={`${styles.button} ${styles.buttonGhost}`}
              onClick={() => {
                setFiles([]);
                setOutputs([]);
                setLogs([]);
                setStatus("Idle");
              }}
              disabled={loading}
            >
              Clear
            </button>
            <div className={styles.progress}>{status}</div>
          </div>

          <div className={styles.footerNote}>
            Smart Voice Match, room cleanup, and scene blend are sequenced to avoid clashing processors.
          </div>
        </div>
      </div>

      <div className={styles.panel}>
        <div className={styles.card}>
          <h3>Outputs</h3>
          {outputs.length > 0 && (
            <div className={styles.controls} style={{ marginTop: 12 }}>
              <button
                className={`${styles.button} ${styles.buttonSecondary}`}
                onClick={downloadOutputsZip}
                disabled={zipBusy}
              >
                {zipBusy ? `Building ZIP ${zipProgress}%` : `Download ZIP (${outputs.length})`}
              </button>
            </div>
          )}
          <div className={styles.outputList} style={{ marginTop: 12 }}>
            {outputs.length === 0 && <div className={styles.dropHint}>No output yet.</div>}
            {outputs.map((output, index) => (
              <div className={styles.outputItem} key={`${output.name}-${output.size}-${index}`}>
                <div>
                  <strong>{output.name}</strong>
                  <div className={styles.label}>{formatBytes(output.size)}</div>
                  <div className={styles.outputMeta}>
                    <span className={styles.outputBadge}>
                      {output.variant === "blend" ? "Blend pass" : "Clean pass"}
                    </span>
                    {output.kind === "mixready" ? (
                      <>
                        <span className={styles.outputBadge}>Mix-ready</span>
                        <span
                          className={styles.outputHint}
                          title={
                            output.variant === "blend"
                              ? "Blend mix-ready: subtle scene glue applied; not loudness-normalized."
                              : "Mix-ready: processed and leveled, but not loudness-normalized. Best for film mix stems."
                          }
                        >
                          What&apos;s this?
                        </span>
                      </>
                    ) : (
                      <>
                        <span className={styles.outputBadge}>Broadcast loudness</span>
                        <span
                          className={styles.outputHint}
                          title={
                            output.variant === "blend"
                              ? "Broadcast loudness + blend: subtle scene glue plus ATSC A/85 or EBU R128 normalization."
                              : "Broadcast loudness: normalized to ATSC A/85 or EBU R128. Use for delivery or QC."
                          }
                        >
                          What&apos;s this?
                        </span>
                      </>
                    )}
                  </div>
                </div>
                <a href={output.url} download={output.name}>
                  Download
                </a>
              </div>
            ))}
          </div>
        </div>
        <div className={styles.card}>
          <h3>Processing Log</h3>
          <div className={styles.log} style={{ marginTop: 12 }}>
            {logs.length === 0 ? "No logs yet." : logs.join("\n")}
          </div>
          <div className={styles.footerNote}>
            If processing feels slow, reduce batch size or disable Smart Voice Match / Room cleanup / Scene blend.
          </div>
        </div>
      </div>
    </div>
  );
}
