import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { hashText } from "./utils.js";

export interface ProjectMetadata {
  packageName?: string;
  packageVersion?: string;
  packageJsonHash?: string;
  lockfile?: string;
  lockfileHash?: string;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  resolvedVersions: Record<string, string>;
}

const TRACKED_PACKAGES = ["next", "react", "react-dom", "prisma", "@prisma/client", "zod", "vitest", "jest", "typescript", "eslint"];

export async function captureProjectMetadata(projectDir: string): Promise<ProjectMetadata> {
  const result: ProjectMetadata = { dependencies: {}, devDependencies: {}, resolvedVersions: {} };
  try {
    const raw = await readFile(join(projectDir, "package.json"), "utf-8");
    const pkg = JSON.parse(raw) as { name?: string; version?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    result.packageName = pkg.name;
    result.packageVersion = pkg.version;
    result.packageJsonHash = hashText(raw);
    result.dependencies = pkg.dependencies ?? {};
    result.devDependencies = pkg.devDependencies ?? {};
  } catch {
    // package.json missing/invalid is captured by validation
  }

  for (const name of ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb"]) {
    const path = join(projectDir, name);
    if (!existsSync(path)) continue;
    try {
      const raw = await readFile(path, "utf-8");
      result.lockfile = name;
      result.lockfileHash = hashText(raw);
      if (name === "package-lock.json") {
        const lock = JSON.parse(raw) as { packages?: Record<string, { version?: string }> };
        for (const packageName of TRACKED_PACKAGES) {
          const version = lock.packages?.[`node_modules/${packageName}`]?.version;
          if (version) result.resolvedVersions[packageName] = version;
        }
      }
      break;
    } catch {
      // binary/invalid lockfile - keep looking
    }
  }
  return result;
}
