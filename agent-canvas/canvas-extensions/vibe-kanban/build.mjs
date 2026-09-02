import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const extensionPath = join(here, "extension.js");
const automationPath = join(here, "automation", "main.py");

const automation = readFileSync(automationPath, "utf8");
const extension = readFileSync(extensionPath, "utf8");
const declarationPattern = /^const AUTOMATION_MAIN = .*?;\n/s;
if (!declarationPattern.test(extension)) {
  throw new Error("Could not find AUTOMATION_MAIN declaration in extension.js");
}

const next = extension.replace(
  declarationPattern,
  `const AUTOMATION_MAIN = ${JSON.stringify(automation)};\n`,
);

writeFileSync(extensionPath, next);
console.log("Embedded automation/main.py into extension.js");
