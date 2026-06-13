import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const chainRoot = path.resolve(__dirname, "..");
export const repoRoot = path.resolve(chainRoot, "..");

export type ContractArtifact = {
  abi: readonly unknown[];
  bytecode: `0x${string}`;
};

export function readArtifact(contractName: string): ContractArtifact {
  const artifactsDir = path.join(chainRoot, "artifacts");
  const match = findArtifact(artifactsDir, `${contractName}.json`);
  if (!match) {
    throw new Error(`missing artifact for ${contractName}; run npm --prefix chain run compile`);
  }
  const parsed = JSON.parse(fs.readFileSync(match, "utf8"));
  return {
    abi: parsed.abi,
    bytecode: parsed.bytecode,
  };
}

export function deploymentPath() {
  return path.join(chainRoot, "deployments", "localhost.json");
}

export function sidecarExportPath() {
  return path.join(repoRoot, "sidecar", "src", "generated", "contracts.local.json");
}

function findArtifact(dir: string, filename: string): string | null {
  if (!fs.existsSync(dir)) return null;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = findArtifact(full, filename);
      if (nested) return nested;
    } else if (entry.isFile() && entry.name === filename && !full.endsWith(".dbg.json")) {
      return full;
    }
  }
  return null;
}
