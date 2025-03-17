#!/usr/bin/env node
import {
  CodeQualityChecker
} from "./chunk-ZVH7CSIV.mjs";

// cli.ts
import { glob } from "glob";
import { resolve, join } from "path";
var PROJECT_ROOT = resolve(__dirname, "../../../..");
async function findFiles() {
  return new Promise((resolve2, reject) => {
    glob("**/*.{ts,tsx}", {
      ignore: [
        "**/node_modules/**",
        "**/dist/**",
        "**/.next/**",
        "**/*.test.ts",
        "**/*.spec.ts",
        // Ignore the code-quality package itself
        "packages/config/code-quality/**"
      ],
      cwd: PROJECT_ROOT
    }, (err, matches) => {
      if (err) reject(err);
      else resolve2(matches);
    });
  });
}
function processViolation(violation, hasErrors, hasWarnings) {
  if (violation.severity === "error") {
    console.error(`\u274C ${violation.location.file}: ${violation.message}`);
    return [true, hasWarnings];
  } else {
    console.warn(`\u26A0\uFE0F  ${violation.location.file}: ${violation.message}`);
    return [hasErrors, true];
  }
}
async function processFile(checker, file, hasErrors, hasWarnings) {
  const fullPath = join(PROJECT_ROOT, file);
  const violations = await checker.checkFile(fullPath);
  let currentErrors = hasErrors;
  let currentWarnings = hasWarnings;
  for (const violation of violations) {
    [currentErrors, currentWarnings] = processViolation(violation, currentErrors, currentWarnings);
  }
  return [currentErrors, currentWarnings];
}
async function main() {
  console.log("Running code quality checks from:", PROJECT_ROOT);
  const checker = new CodeQualityChecker();
  const files = await findFiles();
  if (files.length === 0) {
    console.warn("No TypeScript files found to check!");
    return;
  }
  console.log(`Found ${files.length} files to check...`);
  let hasErrors = false;
  let hasWarnings = false;
  for (const file of files) {
    [hasErrors, hasWarnings] = await processFile(checker, file, hasErrors, hasWarnings);
  }
  if (hasErrors) {
    process.exit(1);
  } else if (hasWarnings) {
    console.warn("\nWarnings found but passing build...");
  } else {
    console.log("\u2705 Code quality checks passed!");
  }
}
main().catch((error) => {
  console.error("Failed to run code quality checks:", error);
  process.exit(1);
});
