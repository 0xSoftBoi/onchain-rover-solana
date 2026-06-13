import fs from "node:fs";
import path from "node:path";
import { deploymentPath, sidecarExportPath } from "./artifacts.js";

const src = deploymentPath();
if (!fs.existsSync(src)) {
  throw new Error("missing local deployment; run npm --prefix chain run deploy");
}

fs.mkdirSync(path.dirname(sidecarExportPath()), { recursive: true });
fs.copyFileSync(src, sidecarExportPath());
console.log(`Exported local deployment to ${sidecarExportPath()}`);
