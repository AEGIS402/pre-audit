import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SUBMODULE_ROOT = join(HERE, "..", "x402-hook");

export function submodulePath(...segments) {
  return join(SUBMODULE_ROOT, ...segments);
}

export function readSubmoduleFile(relativePath) {
  return readFileSync(submodulePath(relativePath), "utf8");
}

export function loadSubmoduleAddresses() {
  const readme = readSubmoduleFile("README.md");

  const deployer = matchOne(readme, /Deployer:\s*`(0x[0-9a-fA-F]{40})`/);
  const safeHook = matchTableAddress(readme, "Aegis402SafeHook");
  const vulnerableHook = matchTableAddress(readme, "Aegis402VulnerableHook");

  if (!deployer || !safeHook || !vulnerableHook) {
    throw new Error(
      `Could not parse submodule addresses (deployer=${deployer}, safe=${safeHook}, vuln=${vulnerableHook})`,
    );
  }

  return { deployer, safeHook, vulnerableHook };
}

function matchTableAddress(text, contractName) {
  const escaped = contractName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const lineRe = new RegExp(`^\\|\\s*${escaped}\\s*\\|.*$`, "m");
  const line = text.match(lineRe)?.[0];
  if (!line) return null;
  return line.match(/0x[0-9a-fA-F]{40}/)?.[0] ?? null;
}

function matchOne(text, re) {
  const m = text.match(re);
  return m ? m[1] : null;
}
