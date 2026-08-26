import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const argumentsList = process.argv.slice(2);
const directoryIndex = argumentsList.indexOf("--dir");
const directory = directoryIndex >= 0 ? argumentsList[directoryIndex + 1] : undefined;
const requiredFiles = [
  "analysis-input.json",
  "opportunity-entry-report.md",
  "evidence-map.json",
  "manifest.json",
];

if (!directory) {
  console.error("usage: node scripts/validate-delivery.mjs --dir <report-directory>");
  process.exit(1);
}

const missingFiles = requiredFiles.filter((file) => !existsSync(path.join(directory, file)));
if (missingFiles.length > 0) {
  console.error(`missing required files: ${missingFiles.join(", ")}`);
  process.exit(1);
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(path.join(directory, "manifest.json"), "utf8"));
} catch {
  console.error("manifest.json must be valid JSON");
  process.exit(1);
}

if (Number.isNaN(Date.parse(manifest.generatedAt))) {
  console.error("manifest.generatedAt must be a valid ISO timestamp");
  process.exit(1);
}

if (!Array.isArray(manifest.files)
  || manifest.files.length !== requiredFiles.length
  || requiredFiles.some((file) => !manifest.files.includes(file))) {
  console.error("manifest.files must contain exactly the required attachments and one opportunity-entry-report.md");
  process.exit(1);
}

const legacyReports = [
  "customer-business-baseline.md",
  "business-fit-diagnosis.md",
  "sales-entry-opportunity-report.md",
];
const legacyPresent = legacyReports.filter((file) => existsSync(path.join(directory, file)) || manifest.files.includes(file));
if (legacyPresent.length > 0) {
  console.error(`delivery must contain only opportunity-entry-report.md; legacy reports found: ${legacyPresent.join(", ")}`);
  process.exit(1);
}

const report = readFileSync(path.join(directory, "opportunity-entry-report.md"), "utf8");
if (!/```mermaid\s*\r?\n\s*mindmap/.test(report)) {
  console.error("opportunity-entry-report.md must contain a Mermaid mindmap section");
  process.exit(1);
}
if (manifest.generation?.branch !== "opportunity-entry") {
  console.error("manifest.generation.branch must be opportunity-entry");
  process.exit(1);
}

console.log("opportunity-entry delivery contract passed");
