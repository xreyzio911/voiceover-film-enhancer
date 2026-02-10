import { copyFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const coreEntry = require.resolve("@ffmpeg/core");

const candidateDirs = [
  path.dirname(coreEntry),
  path.join(path.dirname(coreEntry), "dist"),
  path.join(path.dirname(path.dirname(coreEntry)), "dist"),
];

const findDistDir = async () => {
  for (const dir of candidateDirs) {
    try {
      await stat(path.join(dir, "ffmpeg-core.js"));
      return dir;
    } catch {
      // keep searching
    }
  }
  throw new Error("Unable to locate ffmpeg-core assets in @ffmpeg/core.");
};

const outDir = path.join(process.cwd(), "public", "ffmpeg");

const files = [
  "ffmpeg-core.js",
  "ffmpeg-core.wasm",
  "ffmpeg-core.worker.js",
];

const distDir = await findDistDir();

await mkdir(outDir, { recursive: true });

for (const name of files) {
  const src = path.join(distDir, name);
  const dest = path.join(outDir, name);

  try {
    await stat(src);
  } catch {
    if (name === "ffmpeg-core.worker.js") {
      continue;
    }
    throw new Error(`Missing ${src}. Ensure @ffmpeg/core is installed.`);
  }

  await copyFile(src, dest);
}

console.log("[ffmpeg] core assets copied to public/ffmpeg");
