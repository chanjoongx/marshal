// Capture live (MOCK=0) product screenshots against a running Marshal, showing the real
// "Nemotron · Xs" chip and a description-only override the model resolves. Defaults to the
// deployed Worker. Run: `SHOT_DIR=. node scripts/shots.mjs` (URL=... to point elsewhere).
import { chromium } from "@playwright/test";

const URL = process.env.URL || "https://marshal.neverboringnow.workers.dev";
const DIR = process.env.SHOT_DIR || ".";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const txt = async (id) => (await page.getByTestId(id).textContent().catch(() => "?"))?.trim();

try {
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.getByTestId("start-s1").click();
  await page.getByTestId("speed-8x").click();
  await page.getByTestId("advisory-card").waitFor({ timeout: 60000 });
  await page.waitForTimeout(1500);
  console.log("advisory origin chip:", await txt("advisory-origin"));
  console.log("advisory action:", await txt("advisory-action"));
  await page.screenshot({ path: DIR + "/live-1-advisory.png" });

  // Override with a description-only note (no rack id) that only the model can resolve.
  await page.getByTestId("btn-override").click();
  await page.getByTestId("override-text").fill("the rack running the checkpoint writer has a firmware update in 10 min");
  await page.screenshot({ path: DIR + "/live-2-override.png" });
  await page.getByTestId("override-submit").click();

  await page.getByTestId("advisory-learned").waitFor({ timeout: 30000 });
  await page.waitForTimeout(1000);
  console.log("learned chip:", await txt("advisory-learned"));
  console.log("re-solve origin chip:", await txt("advisory-origin"));
  console.log("re-solve action:", await txt("advisory-action"));
  await page.screenshot({ path: DIR + "/live-3-resolve.png" });
  console.log("OK");
} catch (e) {
  console.log("ERR", e.message);
  await page.screenshot({ path: DIR + "/live-error.png" }).catch(() => {});
} finally {
  await browser.close();
}
