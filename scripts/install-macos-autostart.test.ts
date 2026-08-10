import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildLaunchAgentPlist,
  getLaunchAgentPaths,
  LAUNCH_AGENT_LABEL
} from "./install-macos-autostart.mjs";

describe("macOS autostart installer", () => {
  it("builds paths beneath the selected user home directory", () => {
    const userHomeDir = path.join(os.tmpdir(), "EasyEDA User");
    const paths = getLaunchAgentPaths(userHomeDir);

    expect(paths.watcherPath).toBe(path.join(
      userHomeDir,
      "Library",
      "Application Support",
      "EasyEDA MCP",
      "easyeda-mcp-autostart"
    ));
    expect(paths.plistPath).toBe(path.join(
      userHomeDir,
      "Library",
      "LaunchAgents",
      `${LAUNCH_AGENT_LABEL}.plist`
    ));
  });

  it("builds a valid launch agent with escaped paths", () => {
    const plist = buildLaunchAgentPlist({
      watcherPath: "/tmp/EasyEDA & MCP/watcher",
      stdoutPath: "/tmp/easyeda.log",
      stderrPath: "/tmp/easyeda.error.log"
    });

    expect(plist).toContain("/tmp/EasyEDA &amp; MCP/watcher");
    expect(plist).toContain("<string>com.openai.codex</string>");
    expect(plist).toContain("<integer>5</integer>");
  });
});
