#!/usr/bin/env node
// Patch Electron.app's Info.plist + icon so dev mode shows "My Harness Desktop" instead of "Electron".
// Called by postinstall — safe to re-run, no-ops if Electron.app not found.
const { execSync } = require("node:child_process");
const { existsSync, copyFileSync } = require("node:fs");
const { resolve } = require("node:path");

const root = resolve(__dirname, "../..");
const appBundle = resolve(root, "node_modules/electron/dist/Electron.app");
const appPlist = resolve(appBundle, "Contents/Info.plist");
const appIcon = resolve(appBundle, "Contents/Resources/electron.icns");
const ourIcon = resolve(root, "assets/icons/icon.icns");
const lsregister =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

if (!existsSync(appPlist)) {
  console.log("[patch:electron] Electron.app not found, skipping");
  process.exit(0);
}

try {
  execSync(`/usr/libexec/PlistBuddy -c "Set :CFBundleName My Harness Desktop" "${appPlist}"`, { stdio: "pipe" });
  execSync(`/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName My Harness Desktop" "${appPlist}"`, { stdio: "pipe" });
  if (existsSync(ourIcon)) {
    copyFileSync(ourIcon, appIcon);
  }
  // bundle 改完后必须失效 LaunchServices 缓存,否则 dock 仍显示缓存里的旧(默认)
  // 图标——dock 先从 LaunchServices 取 bundle 图标,app.dock.setIcon 只是运行时
  // 覆盖,进程退出即回落到 bundle 图标。缓存不刷 → 启动/退出两头图标跳变(§3.7 根因)。
  execSync(`touch "${appBundle}"`, { stdio: "pipe" });
  execSync(`"${lsregister}" -f "${appBundle}"`, { stdio: "pipe" });
  console.log("[patch:electron] Patched Electron.app -> My Harness Desktop (LaunchServices cache refreshed)");
} catch (e) {
  console.warn("[patch:electron] Failed to patch:", e.message);
}
