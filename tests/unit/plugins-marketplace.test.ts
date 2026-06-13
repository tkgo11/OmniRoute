import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Test marketplace route module existence and type contracts.
// Full HTTP integration tests require the Next.js test harness.

describe("plugin marketplace", () => {
  describe("route module exists", () => {
    it("marketplace route exports GET and OPTIONS", async () => {
      const mod = await import("../../src/app/api/plugins/marketplace/route.ts");
      assert.equal(typeof mod.GET, "function");
      assert.equal(typeof mod.OPTIONS, "function");
    });
  });

  describe("listMarketplacePlugins", () => {
    it("returns an array of plugins with seed data", async () => {
      const { listMarketplacePlugins } = await import("../../src/lib/plugins/marketplace.ts");
      const plugins = await listMarketplacePlugins();
      assert.ok(Array.isArray(plugins));
      assert.ok(plugins.length > 0);
      // Each entry should have a name
      for (const p of plugins) {
        assert.equal(typeof p.name, "string");
        assert.ok(p.name.length > 0);
      }
    });
  });

  describe("isMarketplaceAvailable", () => {
    it("returns true (always available, falls back to seed)", async () => {
      const { isMarketplaceAvailable } = await import("../../src/lib/plugins/marketplace.ts");
      const result = isMarketplaceAvailable();
      assert.equal(result, true);
    });
  });

  describe("searchMarketplace", () => {
    it("filters plugins by name", async () => {
      const { searchMarketplace } = await import("../../src/lib/plugins/marketplace.ts");
      const results = await searchMarketplace("logger");
      assert.ok(Array.isArray(results));
      assert.ok(results.length > 0);
      assert.ok(results.every((p: { name: string }) => p.name.includes("logger")));
    });

    it("returns empty array for non-matching query", async () => {
      const { searchMarketplace } = await import("../../src/lib/plugins/marketplace.ts");
      const results = await searchMarketplace("zzz_nonexistent_zzz");
      assert.ok(Array.isArray(results));
      assert.equal(results.length, 0);
    });
  });

  describe("getMarketplaceEntry", () => {
    it("finds a plugin by name", async () => {
      const { getMarketplaceEntry } = await import("../../src/lib/plugins/marketplace.ts");
      const entry = await getMarketplaceEntry("request-logger");
      assert.ok(entry);
      assert.equal(entry.name, "request-logger");
    });

    it("returns undefined for unknown name", async () => {
      const { getMarketplaceEntry } = await import("../../src/lib/plugins/marketplace.ts");
      const entry = await getMarketplaceEntry("nonexistent-plugin");
      assert.equal(entry, undefined);
    });
  });
});
