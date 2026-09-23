// @vitest-environment node
/**
 * Guard: the editor-only asset layout must reach the *whole* App, including
 * every full-screen workspace branch.
 *
 * `AssetChooser` reads the layout from `AssetLayoutProvider`.  A regression
 * once wrapped only the main editor return, so LongText / map / Button /
 * Action / UI-motion / Timeline choosers silently fell back to "no metadata"
 * and leaked hidden assets.  This test pins the wiring at its source so the
 * fix cannot be undone without a failing test; workspace-level behavior is
 * covered by the component tests that render the real provider.
 */
import { describe, expect, it } from "vitest";

import appSource from "./App.tsx?raw";

describe("App asset-layout provider wiring", () => {
  it("wraps every full-screen workspace branch, not only the main editor", () => {
    expect(appSource).toContain("const withAssetLayout");
    // Long-text, chapter map, Button, Action, UI motion, gameplay preview and
    // Timeline each have an early return; every one must go through the helper.
    expect(appSource.match(/return withAssetLayout\(/g) ?? []).toHaveLength(7);
    // One provider inside the helper and one around the main editor shell.
    expect(
      appSource.match(/<AssetLayoutProvider layout=\{project\.layout\}>/g) ??
        [],
    ).toHaveLength(2);
  });
});
