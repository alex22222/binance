import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function readApprovalControl(path) {
  try {
    const control = JSON.parse(await readFile(path, "utf8"));
    return {
      enabled: control.enabled === true,
      updatedAt: control.updatedAt || null,
      updatedBy: control.updatedBy || "unknown"
    };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { enabled: false, updatedAt: null, updatedBy: "default" };
  }
}

export async function writeApprovalControl(path, enabled, updatedBy = "dashboard") {
  const control = { enabled: enabled === true, updatedAt: new Date().toISOString(), updatedBy };
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(control, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, path);
  return control;
}
