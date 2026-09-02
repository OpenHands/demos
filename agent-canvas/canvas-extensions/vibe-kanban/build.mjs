import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const extensionPath = join(here, "extension.js");
const automationDir = join(here, "automation");
const automationFiles = Object.fromEntries(
  ["main.py", "vibestore.py", "vibectl.py"].map((name) => [
    name,
    readFileSync(join(automationDir, name), "utf8"),
  ]),
);

const extension = readFileSync(extensionPath, "utf8");
const declarationPattern = /^const AUTOMATION_FILES = .*?;\n/s;
if (!declarationPattern.test(extension)) {
  throw new Error("Could not find AUTOMATION_FILES declaration in extension.js");
}

const next = extension.replace(
  declarationPattern,
  `const AUTOMATION_FILES = ${JSON.stringify(automationFiles)};\n`,
);

writeFileSync(extensionPath, next);
console.log("Embedded automation/*.py into extension.js");
