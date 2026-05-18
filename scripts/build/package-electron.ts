#!/usr/bin/env tsx
/**
 * One-click Electron packaging entrypoint.
 *
 * Default behavior:
 *   - verifies Node.js version
 *   - installs root/web/native dependencies
 *   - builds web + backend
 *   - builds native addon
 *   - bundles Electron runtime
 *   - packages the current platform installer
 *
 * Usage:
 *   npm run package:desktop
 *   npm run package:desktop:mac
 *   npm run package:desktop -- --skip-install
 *   npm run package:desktop -- --dry-run
 *   npm run package:desktop -- --platform mac --force-platform
 */

import { spawn } from "child_process";
import { existsSync, readFileSync, rmSync } from "fs";
import { resolve } from "path";

type TargetPlatform = "mac" | "win" | "linux";

interface CliOptions {
  platform: TargetPlatform;
  dryRun: boolean;
  skipInstall: boolean;
  skipBuild: boolean;
  skipNative: boolean;
  skipElectronBuild: boolean;
  cleanRelease: boolean;
  forcePlatform: boolean;
}

const ROOT = resolve(import.meta.dirname, "..", "..");
const WEB_DIR = resolve(ROOT, "web");
const NATIVE_DIR = resolve(ROOT, "native");
const ELECTRON_DIR = resolve(ROOT, "packages", "electron");
const RELEASE_DIR = resolve(ELECTRON_DIR, "release");
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
const CARGO = process.platform === "win32" ? "cargo.exe" : "cargo";

function printHelp(): void {
  console.log(`
Usage:
  npm run package:desktop [-- --platform mac|win|linux] [options]

Options:
  --platform <name>       Package target platform. Defaults to current host.
  --skip-install          Skip dependency installation.
  --skip-build            Skip root build (web + TypeScript).
  --skip-native           Skip native addon build.
  --skip-electron-build   Skip Electron esbuild bundling.
  --no-clean-release      Keep packages/electron/release before packaging.
  --force-platform        Allow packaging a non-host platform target.
  --dry-run               Print commands without executing them.
  --help                  Show this help text.
`);
}

function parsePlatform(value: string): TargetPlatform {
  if (value === "mac" || value === "win" || value === "linux") return value;
  throw new Error(`Unsupported platform "${value}". Expected mac, win, or linux.`);
}

function detectHostPlatform(): TargetPlatform {
  switch (process.platform) {
    case "darwin":
      return "mac";
    case "win32":
      return "win";
    case "linux":
      return "linux";
    default:
      throw new Error(`Unsupported host platform: ${process.platform}`);
  }
}

function parseArgs(argv: string[]): CliOptions {
  let platform = detectHostPlatform();
  let dryRun = false;
  let skipInstall = false;
  let skipBuild = false;
  let skipNative = false;
  let skipElectronBuild = false;
  let cleanRelease = true;
  let forcePlatform = false;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--skip-install") {
      skipInstall = true;
      continue;
    }
    if (arg === "--skip-build") {
      skipBuild = true;
      continue;
    }
    if (arg === "--skip-native") {
      skipNative = true;
      continue;
    }
    if (arg === "--skip-electron-build") {
      skipElectronBuild = true;
      continue;
    }
    if (arg === "--no-clean-release") {
      cleanRelease = false;
      continue;
    }
    if (arg === "--force-platform") {
      forcePlatform = true;
      continue;
    }
    if (arg === "--platform") {
      const next = argv[index + 1];
      if (!next) throw new Error("--platform requires a value");
      platform = parsePlatform(next);
      index++;
      continue;
    }
    if (arg.startsWith("--platform=")) {
      platform = parsePlatform(arg.slice("--platform=".length));
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    platform,
    dryRun,
    skipInstall,
    skipBuild,
    skipNative,
    skipElectronBuild,
    cleanRelease,
    forcePlatform,
  };
}

function ensureNodeVersion(): void {
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  if (major >= 20) return;

  const nvmrcPath = resolve(ROOT, ".nvmrc");
  const expected = existsSync(nvmrcPath) ? readFileSync(nvmrcPath, "utf-8").trim() : ">=20";
  throw new Error(
    `Node.js ${process.versions.node} is too old. Packaging requires Node.js 20+ (repo expects ${expected}).`,
  );
}

function ensurePlatformAllowed(target: TargetPlatform, forcePlatform: boolean): void {
  const host = detectHostPlatform();
  if (host === target) return;
  if (forcePlatform) {
    console.warn(`[package-electron] Cross-platform packaging forced: host=${host}, target=${target}`);
    return;
  }
  throw new Error(
    `Target platform "${target}" does not match host "${host}". ` +
    "Use --force-platform only if you understand the cross-build limitations.",
  );
}

function removeReleaseDir(dryRun: boolean): void {
  if (!existsSync(RELEASE_DIR)) return;
  if (dryRun) {
    console.log(`[package-electron] dry-run: rm -rf ${RELEASE_DIR}`);
    return;
  }
  rmSync(RELEASE_DIR, { recursive: true, force: true });
  console.log(`[package-electron] cleaned ${RELEASE_DIR}`);
}

function platformBinaryName(platform: TargetPlatform): string {
  switch (platform) {
    case "mac":
      return process.arch === "arm64"
        ? "codex-tls.darwin-arm64.node"
        : "codex-tls.darwin-x64.node";
    case "win":
      return "codex-tls.win32-x64-msvc.node";
    case "linux":
      return process.arch === "arm64"
        ? "codex-tls.linux-arm64-gnu.node"
        : "codex-tls.linux-x64-gnu.node";
  }
}

async function commandAvailable(command: string): Promise<boolean> {
  return new Promise((resolveCheck) => {
    const child = spawn(command, ["--version"], {
      cwd: ROOT,
      stdio: "ignore",
      shell: process.platform === "win32",
    });
    child.on("error", () => resolveCheck(false));
    child.on("exit", (code) => resolveCheck(code === 0));
  });
}

function runCommand(label: string, command: string, args: string[], cwd: string, dryRun: boolean): Promise<void> {
  console.log(`[package-electron] ${label}: ${command} ${args.join(" ")}`);
  if (dryRun) return Promise.resolve();

  return new Promise((resolveStep, rejectStep) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      shell: process.platform === "win32",
    });

    child.on("error", rejectStep);
    child.on("exit", (code) => {
      if (code === 0) {
        resolveStep();
      } else {
        rejectStep(new Error(`${label} exited with code ${code ?? "unknown"}`));
      }
    });
  });
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  ensureNodeVersion();
  ensurePlatformAllowed(options.platform, options.forcePlatform);

  console.log(`[package-electron] target=${options.platform}`);
  console.log(`[package-electron] root=${ROOT}`);

  if (options.cleanRelease) {
    removeReleaseDir(options.dryRun);
  }

  if (!options.skipInstall) {
    await runCommand("install root deps", NPM, ["ci", "--ignore-scripts"], ROOT, options.dryRun);
    await runCommand("install web deps", NPM, ["ci"], WEB_DIR, options.dryRun);
    await runCommand("install native deps", NPM, ["ci"], NATIVE_DIR, options.dryRun);
  }

  if (!options.skipBuild) {
    await runCommand("build core", NPM, ["run", "build"], ROOT, options.dryRun);
  }

  if (!options.skipNative) {
    const nativeBinary = resolve(NATIVE_DIR, platformBinaryName(options.platform));
    const hasCargo = options.dryRun ? true : await commandAvailable(CARGO);
    if (!hasCargo && existsSync(nativeBinary)) {
      console.log(
        `[package-electron] cargo not found, using prebuilt native addon: ${nativeBinary}`,
      );
    } else if (!hasCargo) {
      throw new Error(
        `Rust toolchain not found (missing cargo), and no prebuilt native addon for ${options.platform}/${process.arch}.`,
      );
    } else {
      await runCommand("build native addon", NPM, ["run", "build"], NATIVE_DIR, options.dryRun);
    }
  }

  if (!options.skipElectronBuild) {
    await runCommand("bundle electron", NPM, ["run", "build"], ELECTRON_DIR, options.dryRun);
  }

  await runCommand(
    `package ${options.platform}`,
    NPM,
    ["run", `pack:${options.platform}`],
    ELECTRON_DIR,
    options.dryRun,
  );

  console.log(`[package-electron] done`);
  console.log(`[package-electron] artifacts: ${RELEASE_DIR}`);
}

main().catch((error: unknown) => {
  console.error("[package-electron] Fatal:", error instanceof Error ? error.message : error);
  process.exit(1);
});
