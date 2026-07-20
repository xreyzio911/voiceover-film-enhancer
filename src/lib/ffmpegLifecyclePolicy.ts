export const shouldPublishGenericFfmpegProgress = (
  activeQueueBase: string | null | undefined,
): activeQueueBase is string =>
  Boolean(activeQueueBase?.trim());

export const shouldRecycleFfmpegBeforeOperation = (
  cumulativeAudioSec: number,
  thresholdSeconds: number,
) =>
  Number.isFinite(cumulativeAudioSec) &&
  Number.isFinite(thresholdSeconds) &&
  thresholdSeconds > 0 &&
  cumulativeAudioSec >= thresholdSeconds;
