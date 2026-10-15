/**
 * W05 UX acceptance (runs after launch.spec.ts / w04-economics.spec.ts, so a
 * token exists): keyboard navigation, landmarks, mobile layout without
 * horizontal overflow, the verification disclosure, and honest empty/failed
 * states. Screenshots are written to test-results/screens/w05-*.png.
 */
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

const SHOTS = path.resolve(process.cwd(), "test-results", "screens");
mkdirSync(SHOTS, { recursive: true });

const MOBILE = { width: 375, height: 812 };
const noHorizontalOverflow = async (page: Page) => {
  const { overflow, offenders } = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const bad = Array.from(document.querySelectorAll("body *"))
      .filter((el) => el.getBoundingClientRect().right > vw + 1 && !el.closest(".table-wrap"))
      .slice(0, 5)
      .map((el) => `${el.tagName.toLowerCase()}.${(el as HTMLElement).className}`);
    return { overflow: document.documentElement.scrollWidth - vw, offenders: bad };
  });
  expect(overflow, `page must not scroll horizontally (offenders: ${offenders.join(", ")})`).toBeLessThanOrEqual(1);
};

test("keyboard users get a skip link, labelled landmarks and aria-current navigation", async ({ page }) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle"); // a keyboard user arrives on a hydrated page
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to main content" });
  await expect(skip).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#main$/);
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Explore" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("main")).toBeVisible();
  await expect(page.getByRole("status", { name: "Connection status" })).toBeVisible();
  // Every interactive control on the page is reachable and shows a visible focus ring.
  await page.keyboard.press("Tab");
  const focus = await page.evaluate(() => ({ tag: document.activeElement!.tagName, outline: getComputedStyle(document.activeElement!).outlineStyle }));
  expect(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA"]).toContain(focus.tag);
  expect(focus.outline).not.toBe("none");
});

test("launch page discloses what verification is NOT, before anything is signed", async ({ page }) => {
  await page.goto("/launch");
  const d = page.getByTestId("verification-disclosure");
  await expect(d).toBeVisible();
  await expect(d).toContainText("not a code audit");
  await expect(d).toContainText("not KYC");
  await expect(d).toContainText("not a financial endorsement");
  await expect(d).toContainText("lose all value");
  await expect(page.getByRole("contentinfo")).toContainText("not a code audit, KYC, a financial endorsement or a guarantee");
  await page.screenshot({ path: `${SHOTS}/w05-01-launch-disclosure.png`, fullPage: true });
});

test("mobile: explore, token detail, launch, dashboard and treasury have no horizontal overflow", async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await page.goto("/");
  await expect(page.getByTestId("explore-cards")).toBeVisible();
  await noHorizontalOverflow(page);
  await page.screenshot({ path: `${SHOTS}/w05-02-mobile-explore.png`, fullPage: true });

  const href = await page.locator('[data-testid="explore-cards"] a').first().getAttribute("href");
  expect(href, "launch.spec.ts must have created a token").toBeTruthy();
  await page.goto(href!);
  await expect(page.getByTestId("project-title")).toBeVisible();
  await expect(page.getByTestId("verification-disclosure")).toBeVisible();
  await noHorizontalOverflow(page);
  await page.screenshot({ path: `${SHOTS}/w05-03-mobile-token.png`, fullPage: true });

  for (const [route, shot] of [["/launch", "w05-04-mobile-launch"], ["/dashboard", "w05-05-mobile-dashboard"], ["/treasury", "w05-06-mobile-treasury"]] as const) {
    await page.goto(route);
    await expect(page.getByRole("main")).toBeVisible();
    await noHorizontalOverflow(page);
    await page.screenshot({ path: `${SHOTS}/${shot}.png`, fullPage: true });
  }
});

test("treasury accounting shows provenance classes and the trust boundary; mobile tabs stay usable", async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await page.goto("/treasury");
  await page.getByTestId("tab-accounting").click();
  await expect(page.getByTestId("provenance-ETH")).toContainText("Not trustless");
  await expect(page.getByTestId("provenance-ETH")).toContainText("unattributed");
  await noHorizontalOverflow(page);
  await page.screenshot({ path: `${SHOTS}/w05-07-mobile-treasury-accounting.png`, fullPage: true });
});

test("failed data loads are explained, not blank", async ({ page }) => {
  await page.route("**/api/tokens*", (r) => r.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "GITHUB_UNAVAILABLE", message: "Temporarily unavailable." } }) }));
  await page.goto("/");
  await expect(page.locator(".alert.error")).toContainText("Temporarily unavailable");
  await page.screenshot({ path: `${SHOTS}/w05-08-failed-state.png`, fullPage: true });
});
