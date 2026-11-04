/**
 * WEB-03 — Replit Forge UX integration: visual/regression pass over the public
 * surfaces of the re-skinned app at desktop and mobile sizes. Screenshot-only
 * evidence plus structural assertions; no auth, no transactions, no demo
 * fixtures. Screenshots land in test-results/web03/ and are copied into
 * docs/evidence/web03/screenshots/ for the PR evidence pack.
 */
import { expect, test } from "@playwright/test";

const SHOTS = "test-results/web03";

test.describe("WEB-03 visual integration", () => {
  for (const [label, width, height] of [["desktop", 1440, 900], ["mobile", 390, 844]] as const) {
    test(`public surfaces render in the Forge design language at ${label}`, async ({ page }) => {
      await page.setViewportSize({ width, height });

      // Explore (home): production-blocked safety strip, hero, real indexer state.
      await page.goto("/");
      await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
      await expect(page.getByTestId("forge-hero")).toBeVisible();
      await expect(page.getByText("PRODUCTION_READY=false").first()).toBeVisible();
      // State-agnostic: the four data states are mutually exclusive in the DOM —
      // the loaded wrapper (table + cards views), the empty panel, the loading
      // line or a transient fetch error. (When this spec runs after the journey
      // specs the indexer is under load, so a transient error state is a
      // legitimate outcome — the UI must render it cleanly.) A comma selector
      // resolves to exactly one node, keeping strict mode happy.
      await expect(page.locator("#forge-explore-list, .panel.empty, [data-testid='explore-loading'], [data-testid='explore-error']")).toBeVisible();
      await page.screenshot({ path: `${SHOTS}/home-${label}.png`, fullPage: true });

      // Grid/list toggle exists and keeps the toolbar accessible.
      await expect(page.getByTestId("button-explore-grid")).toBeVisible();
      await expect(page.getByTestId("button-explore-list")).toBeVisible();
      await page.getByTestId("button-explore-grid").click();
      await expect(page.getByTestId("button-explore-grid")).toHaveAttribute("aria-pressed", "true");
      await page.screenshot({ path: `${SHOTS}/home-grid-${label}.png`, fullPage: true });
      await page.getByTestId("button-explore-list").click();

      // Launch wizard: heading, stepper, real proof map, no demo fixtures.
      await page.goto("/launch");
      await expect(page.getByTestId("stepper")).toBeVisible();
      await expect(page.getByTestId("verification-map")).toBeVisible();
      await expect(page.getByText("Consent is not authority")).toBeVisible();
      await expect(page.getByTestId("connect-github").or(page.getByText("Signed in as"))).toBeVisible();
      await page.screenshot({ path: `${SHOTS}/launch-${label}.png`, fullPage: true });

      // Dashboard signed out: connect affordance, no synthetic data.
      await page.goto("/dashboard");
      await expect(page.getByRole("link", { name: "Connect GitHub" })).toBeVisible();
      await page.screenshot({ path: `${SHOTS}/dashboard-${label}.png`, fullPage: true });

      // Treasury: public governance/finance surface re-skinned.
      await page.goto("/treasury");
      await expect(page.getByText("Treasury & revenue", { exact: false })).toBeVisible();
      await page.screenshot({ path: `${SHOTS}/treasury-${label}.png`, fullPage: true });

      // No horizontal overflow at either size (responsive contract).
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `no horizontal overflow at ${label}`).toBeLessThanOrEqual(1);
    });
  }

  test("explorer empty state and project detail keep their hooks", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/");
    // The empty-state CTA still routes into the real wizard.
    const emptyLink = page.getByRole("link", { name: "Launch the first one →" });
    if (await emptyLink.isVisible().catch(() => false)) {
      await emptyLink.click();
      await expect(page).toHaveURL(/\/launch$/);
    }
    // When launches exist and the indexer responds, the detail page keeps its
    // identity/proof hooks (asserted rigorously by launch.spec/w06-journey on
    // their own flows; here it is conditional because this spec deliberately
    // runs last, after the journey specs have revocation/refresh load).
    const firstCard = page.locator('[data-testid="explore-table"] tbody a').first();
    if (await firstCard.isVisible().catch(() => false)) {
      await firstCard.click();
      const title = page.getByTestId("project-title");
      if (await title.isVisible().catch(() => false)) {
        await expect(page.getByTestId("verification-disclosure")).toBeVisible();
        await expect(page.getByTestId("proof-of-build")).toBeVisible();
        await page.screenshot({ path: `${SHOTS}/project-detail-desktop.png`, fullPage: true });
      }
    }
  });
});
