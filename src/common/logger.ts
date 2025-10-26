import fs from "node:fs";
import path from "node:path";

export function ensureLogsDir() {
  const dir = path.resolve("logs");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function jsonlWriter(filename: string) {
  ensureLogsDir();
  const fp = path.resolve("logs", filename);
  const stream = fs.createWriteStream(fp, { flags: "a" });
  return {
    write: (obj: unknown) => stream.write(JSON.stringify(obj) + "\n"),
    close: () => stream.close(),
    path: fp,
  };
}
