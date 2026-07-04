import { test, expect } from "@playwright/test";

/**
 * End-to-end of the S1 demo path against the offline MockProvider (MOCK=1). This drives the
 * real Durable Object, WebSocket, and agent loop with no network. It requires the app to
 * expose the data-testid contract in the Cursor handoff (start-s1, speed-8x, advisory-card,
 * advisory-headline, advisory-action, advisory-learned, btn-why/override/approve, why-text,
 * override-target/reason/submit, simulated-badge, and rack-<id> with data-temp / data-projected).
 */
test("S1: warns before throttle, learns the override, bends the curve", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto("/");

  // start scenario S1 and run it fast
  await page.getByTestId("start-s1").click();
  await page.getByTestId("speed-8x").click();

  // the honesty badge is always visible
  await expect(page.getByTestId("simulated-badge")).toBeVisible();

  // an advisory fires BEFORE B7 crosses the 84C throttle line
  const card = page.getByTestId("advisory-card");
  await expect(card).toBeVisible({ timeout: 30_000 });
  const b7 = page.getByTestId("rack-B7");
  const tempAtAdvisory = Number(await b7.getAttribute("data-temp"));
  expect(tempAtAdvisory).toBeLessThan(84);
  await expect(page.getByTestId("advisory-headline")).toContainText("B7");

  // Why cites numbers and adds no new recommendation
  await page.getByTestId("btn-why").click();
  const why = page.getByTestId("why-text");
  await expect(why).toBeVisible();
  await expect(why).toContainText(/\d/);

  // Override: exclude B12 for maintenance (a constraint the telemetry cannot know)
  await page.getByTestId("btn-override").click();
  await page.getByTestId("override-target").fill("B12");
  await page.getByTestId("override-reason").fill("in maintenance");
  await page.getByTestId("override-submit").click();

  // the re-solved advisory shows the learned chip and does NOT target B12
  await expect(page.getByTestId("advisory-learned")).toBeVisible({ timeout: 20_000 });
  const action = page.getByTestId("advisory-action");
  await expect(action).toBeVisible();
  await expect(action).not.toContainText("B12");
  await expect(action).toContainText("B15");

  // Approve bends B7's projected temperature down
  const projBefore = Number(await b7.getAttribute("data-projected"));
  await page.getByTestId("btn-approve").click();
  await expect
    .poll(async () => Number(await b7.getAttribute("data-projected")), { timeout: 20_000 })
    .toBeLessThan(projBefore);
});
