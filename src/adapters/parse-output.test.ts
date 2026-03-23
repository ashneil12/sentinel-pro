/**
 * Tests for the output parser — finding and fix extraction from CLI output.
 */

import { describe, it, expect } from "vitest";
import { parseFindings, parseFixes, classifySeverity } from "./parse-output.js";

describe("parseFindings", () => {
  it("extracts findings from markdown headings", () => {
    const output = `
## Finding: High error rate in session handler
The session handler has been throwing NullPointerExceptions at a rate of 50/hour.
This is caused by a missing null check on the user profile lookup.

## Finding: Disk space warning
Log directory is at 85% capacity (425MB / 500MB threshold).
    `;

    const findings = parseFindings(output);
    expect(findings).toHaveLength(2);
    expect(findings[0].title).toBe("High error rate in session handler");
    expect(findings[0].severity).toBe("critical"); // "error" keyword
    expect(findings[1].title).toBe("Disk space warning");
    expect(findings[1].severity).toBe("warning");
  });

  it("extracts findings from numbered lists with severity", () => {
    const output = `
1. **[CRITICAL]** Gateway port unreachable after restart
2. **[WARNING]** SearXNG sidecar responding slowly (>2s)
3. **[INFO]** New session locks detected (stale)
    `;

    const findings = parseFindings(output);
    expect(findings).toHaveLength(3);
    expect(findings[0].severity).toBe("critical");
    expect(findings[1].severity).toBe("warning");
    expect(findings[2].severity).toBe("info");
  });

  it("returns empty array for clean output", () => {
    const output = `
Everything looks healthy! No errors or warnings found in the logs.
All channels are connected and responding normally.
    `;

    const findings = parseFindings(output);
    expect(findings).toHaveLength(0);
  });

  it("extracts source file references", () => {
    const output = `
## Finding: Unhandled exception in reply handler
Error thrown at file src/auto-reply/reply/session.ts:142
    `;

    const findings = parseFindings(output);
    expect(findings).toHaveLength(1);
    expect(findings[0].source).toContain("session.ts");
  });

  it("extracts suggested actions", () => {
    const output = `
## Issue: Memory leak in browser pool
The browser pool is not cleaning up after sessions.
Fix: Add a cleanup timer that runs every 5 minutes.
    `;

    const findings = parseFindings(output);
    expect(findings).toHaveLength(1);
    expect(findings[0].action).toBeDefined();
  });
});

describe("parseFixes", () => {
  it("extracts diff blocks with file paths", () => {
    const output = `
### Fix for null check issue

In \`src/auto-reply/reply/session.ts\`:

\`\`\`diff
--- a/src/auto-reply/reply/session.ts
+++ b/src/auto-reply/reply/session.ts
@@ -140,3 +140,5 @@
 function handleReply(user) {
+  if (!user?.profile) {
+    return null;
+  }
   return user.profile.name;
 }
\`\`\`
    `;

    const fixes = parseFixes(output);
    expect(fixes).toHaveLength(1);
    expect(fixes[0].filePath).toBe("src/auto-reply/reply/session.ts");
    expect(fixes[0].diff).toContain("if (!user?.profile)");
  });

  it("returns empty array when no diffs present", () => {
    const output = "Everything looks good, no fixes needed.";
    const fixes = parseFixes(output);
    expect(fixes).toHaveLength(0);
  });

  it("handles multiple diff blocks", () => {
    const output = `
### Fix 1
\`\`\`diff
-old line 1
+new line 1
\`\`\`

### Fix 2
\`\`\`diff
-old line 2
+new line 2
\`\`\`
    `;

    const fixes = parseFixes(output);
    expect(fixes).toHaveLength(2);
  });
});

describe("classifySeverity", () => {
  it("returns healthy for empty findings", () => {
    expect(classifySeverity([])).toBe("healthy");
  });

  it("returns critical when any finding is critical", () => {
    expect(
      classifySeverity([
        { id: "1", severity: "info", title: "x", description: "x" },
        { id: "2", severity: "critical", title: "x", description: "x" },
      ]),
    ).toBe("critical");
  });

  it("returns warning when highest is warning", () => {
    expect(
      classifySeverity([
        { id: "1", severity: "info", title: "x", description: "x" },
        { id: "2", severity: "warning", title: "x", description: "x" },
      ]),
    ).toBe("warning");
  });

  it("returns info when all findings are info", () => {
    expect(
      classifySeverity([
        { id: "1", severity: "info", title: "x", description: "x" },
      ]),
    ).toBe("info");
  });
});
