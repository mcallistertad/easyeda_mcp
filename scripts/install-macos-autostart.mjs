import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const LAUNCH_AGENT_LABEL = "io.github.vlab-software.easyeda-mcp-autostart";

const repoRoot = path.resolve(import.meta.dirname, "..");
const sourceWatcherPath = path.join(repoRoot, "scripts", "macos", "easyeda-mcp-autostart.sh");

export function getLaunchAgentPaths(userHomeDir = os.homedir()) {
  const supportDir = path.join(userHomeDir, "Library", "Application Support", "EasyEDA MCP");
  return {
    supportDir,
    watcherPath: path.join(supportDir, "easyeda-mcp-autostart"),
    plistPath: path.join(userHomeDir, "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`),
    stdoutPath: path.join(userHomeDir, "Library", "Logs", "easyeda-mcp-autostart.log"),
    stderrPath: path.join(userHomeDir, "Library", "Logs", "easyeda-mcp-autostart.error.log")
  };
}

export function buildLaunchAgentPlist(paths) {
  const value = (input) => escapeXml(String(input));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${value(LAUNCH_AGENT_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${value(paths.watcherPath)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>EASYEDA_MCP_EDITOR_PROCESS</key>
    <string>EasyEDA-Pro</string>
    <key>EASYEDA_MCP_HOST_PROCESS</key>
    <string>ChatGPT</string>
    <key>EASYEDA_MCP_HOST_BUNDLE_ID</key>
    <string>com.openai.codex</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>5</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>LowPriorityIO</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${value(paths.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${value(paths.stderrPath)}</string>
</dict>
</plist>
`;
}

export function installAutostart(options = {}) {
  assertMacOs();
  assertAppExists("/Applications/EasyEDA-Pro.app", "EasyEDA Pro");
  assertAppExists("/Applications/ChatGPT.app", "ChatGPT");

  const paths = getLaunchAgentPaths(options.userHomeDir);
  const launchDomain = `gui/${process.getuid()}`;
  const serviceTarget = `${launchDomain}/${LAUNCH_AGENT_LABEL}`;
  const temporaryPlistPath = `${paths.plistPath}.tmp-${process.pid}`;

  fs.mkdirSync(paths.supportDir, { recursive: true, mode: 0o755 });
  fs.mkdirSync(path.dirname(paths.plistPath), { recursive: true, mode: 0o755 });
  fs.mkdirSync(path.dirname(paths.stdoutPath), { recursive: true, mode: 0o755 });
  fs.copyFileSync(sourceWatcherPath, paths.watcherPath);
  fs.chmodSync(paths.watcherPath, 0o755);
  fs.writeFileSync(temporaryPlistPath, buildLaunchAgentPlist(paths), { mode: 0o644 });

  run("/usr/bin/plutil", ["-lint", temporaryPlistPath]);
  run("/bin/launchctl", ["bootout", serviceTarget], { allowFailure: true });
  fs.renameSync(temporaryPlistPath, paths.plistPath);
  run("/bin/launchctl", ["bootstrap", launchDomain, paths.plistPath]);
  run("/bin/launchctl", ["kickstart", "-k", serviceTarget]);

  return { ...paths, serviceTarget };
}

export function uninstallAutostart(options = {}) {
  assertMacOs();
  const paths = getLaunchAgentPaths(options.userHomeDir);
  const serviceTarget = `gui/${process.getuid()}/${LAUNCH_AGENT_LABEL}`;

  run("/bin/launchctl", ["bootout", serviceTarget], { allowFailure: true });
  fs.rmSync(paths.plistPath, { force: true });
  fs.rmSync(paths.watcherPath, { force: true });

  return { ...paths, serviceTarget };
}

function escapeXml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function assertMacOs() {
  if (process.platform !== "darwin") {
    throw new Error("EasyEDA MCP automatic startup is currently supported on macOS only.");
  }
}

function assertAppExists(appPath, displayName) {
  if (!fs.existsSync(appPath)) {
    throw new Error(`${displayName} was not found at ${appPath}.`);
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0 && !options.allowFailure) {
    const detail = (result.stderr || result.stdout || "unknown error").trim();
    throw new Error(`${command} ${args.join(" ")} failed: ${detail}`);
  }
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const uninstall = process.argv.includes("--uninstall");
  const result = uninstall ? uninstallAutostart() : installAutostart();
  console.log(uninstall
    ? `Removed ${result.serviceTarget}.`
    : `Installed ${result.serviceTarget}. EasyEDA Pro will now start the ChatGPT MCP host automatically.`);
}
