const ENABLED_VALUES = new Set(["1", "on", "true"]);

export const isAiAutoPilotEnabled = (value: string | null | undefined) =>
  ENABLED_VALUES.has((value ?? "").trim().toLowerCase());
