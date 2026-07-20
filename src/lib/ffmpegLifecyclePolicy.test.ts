import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  shouldPublishGenericFfmpegProgress,
  shouldRecycleFfmpegBeforeOperation,
} from "./ffmpegLifecyclePolicy.ts";

test("generic FFmpeg progress only updates an active file queue item", () => {
  assert.equal(shouldPublishGenericFfmpegProgress("episode-01"), true);
  assert.equal(shouldPublishGenericFfmpegProgress(""), false);
  assert.equal(shouldPublishGenericFfmpegProgress(null), false);
});

test("FFmpeg recycling is decided before pending work, never after the final operation", () => {
  assert.equal(shouldRecycleFfmpegBeforeOperation(2399, 2400), false);
  assert.equal(shouldRecycleFfmpegBeforeOperation(2400, 2400), true);
  assert.equal(shouldRecycleFfmpegBeforeOperation(2767, 2400), true);
  assert.equal(shouldRecycleFfmpegBeforeOperation(Number.NaN, 2400), false);
  assert.equal(shouldRecycleFfmpegBeforeOperation(2767, 0), false);
});

test("VoLeveler applies lifecycle policies at the listener and before alignment operations", () => {
  const source = readFileSync(new URL("../components/VoLeveler.tsx", import.meta.url), "utf8");
  const alignmentStart = source.indexOf("const alignBatchMixReadyOutputs");
  const alignmentEnd = source.indexOf("const processFiles", alignmentStart);
  const alignmentSource = source.slice(alignmentStart, alignmentEnd);

  assert.match(source, /shouldPublishGenericFfmpegProgress\(activeBase\)/);
  assert.match(alignmentSource, /await recycleBeforeOperation\("measure"\)[\s\S]*?writeFile\(inputName/);
  assert.match(alignmentSource, /await recycleBeforeOperation\("render"\)[\s\S]*?writeFile\(inputName/);
  assert.doesNotMatch(alignmentSource, /await noteProcessedAudio/);
});
