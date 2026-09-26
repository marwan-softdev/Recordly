import { expect, test } from "@playwright/test";
import { installDesktopBridge } from "./bridge";

test("banner login animates email expansion, rejects incorrect credentials, and persists the local account until sign-out", async ({
	page,
}) => {
	await installDesktopBridge(page);
	await page.goto("/?windowType=editor");
	await page.getByRole("button", { name: "Home", exact: true }).click();
	await page.getByRole("button", { name: "Sign in", exact: true }).click();
	const login = page.getByRole("dialog", {
		name: "Beautiful, shareable screen recordings",
		exact: true,
	});
	await expect(
		login.getByRole("button", { name: "Continue with Google", exact: true }),
	).toBeVisible();
	await expect(
		login.getByRole("button", { name: "Continue with Microsoft", exact: true }),
	).toBeVisible();
	await expect(login.getByLabel("Password", { exact: true })).toHaveCount(0);
	await expect(login.getByText("Recordly", { exact: true })).toBeVisible();
	await expect(login.getByText("worth sharing.", { exact: false })).toHaveCount(0);
	for (const provider of ["Google", "Microsoft"]) {
		await expect
			.poll(() =>
				login
					.getByRole("button", { name: `Continue with ${provider}`, exact: true })
					.locator("img")
					.evaluate((image: HTMLImageElement) => image.naturalWidth),
			)
			.toBeGreaterThan(0);
	}
	const heading = await login.getByRole("heading").boundingBox();
	const textSize = await login.getByRole("heading").evaluate((element) => ({
		height: element.clientHeight,
		width: element.clientWidth,
		scrollWidth: element.scrollWidth,
		lineHeight: parseFloat(getComputedStyle(element).lineHeight),
	}));
	expect(textSize.height).toBeLessThanOrEqual(textSize.lineHeight + 1);
	expect(textSize.scrollWidth).toBeLessThanOrEqual(textSize.width);
	const artwork = await login.locator('img[src$="login-banner.png"]').boundingBox();
	expect(artwork!.y + artwork!.height).toBeLessThan(heading!.y);
	await page.keyboard.press("Tab");
	await login.evaluate((element: HTMLElement) => element.focus());
	await expect(login).toHaveCSS("outline-style", "none");

	await page.screenshot({ path: "test-results/login.png", animations: "disabled" });
	const collapsed = (await login.boundingBox())!.height;
	await login.getByLabel("Email", { exact: true }).fill("test@email.com");
	await expect
		.poll(async () => (await login.boundingBox())!.height)
		.toBeGreaterThan(collapsed + 80);
	await login.getByLabel("Email", { exact: true }).fill("");
	await expect(login.getByLabel("Password", { exact: true })).toHaveCount(0);
	await expect
		.poll(async () => Math.abs((await login.boundingBox())!.height - collapsed))
		.toBeLessThan(2);
	await login.getByLabel("Email", { exact: true }).fill("test@email.com");
	await login.getByLabel("Password", { exact: true }).fill("incorrect");
	await login.getByRole("button", { name: "Sign in", exact: true }).click();
	await expect(login.getByText("Incorrect email or password.")).toBeVisible();
	await login.getByLabel("Password", { exact: true }).fill("1234");
	await page.screenshot({ path: "test-results/login-expanded.png", animations: "disabled" });
	await page.setViewportSize({ width: 800, height: 600 });
	await login
		.getByRole("heading", { name: "Beautiful, shareable screen recordings", exact: true })
		.scrollIntoViewIfNeeded();
	await expect(
		login.getByRole("heading", { name: "Beautiful, shareable screen recordings", exact: true }),
	).toBeInViewport();
	await login.getByRole("button", { name: "Sign in", exact: true }).scrollIntoViewIfNeeded();
	await expect(login.getByRole("button", { name: "Sign in", exact: true })).toBeInViewport();
	await login.getByRole("button", { name: "Sign in", exact: true }).click();
	await expect(login).not.toBeVisible();
	await expect(page.getByRole("dialog", { name: "Projects dashboard" })).toBeVisible();
	await page.reload();
	await page.getByRole("button", { name: "Home", exact: true }).click();
	await page.getByRole("button", { name: "test@email.com", exact: true }).click();
	const account = page.getByRole("dialog", { name: "Your account", exact: true });
	await expect(account.getByText("test@email.com")).toBeVisible();
	await account.getByRole("button", { name: "Sign out", exact: true }).click();
	await expect(
		page.getByRole("dialog", { name: "Beautiful, shareable screen recordings" }),
	).toBeVisible();
});

test("login banner and email expansion work with reduced motion", async ({ page }) => {
	await page.emulateMedia({ reducedMotion: "reduce" });
	await installDesktopBridge(page);
	await page.goto("/?windowType=editor");
	await page.getByRole("button", { name: "Recordly account", exact: true }).click();
	const login = page.getByRole("dialog", {
		name: "Beautiful, shareable screen recordings",
		exact: true,
	});
	await login.getByLabel("Email", { exact: true }).fill("test@email.com");
	await expect(login.getByLabel("Password", { exact: true })).toBeVisible();
	await login.getByLabel("Email", { exact: true }).fill("");
	await expect(login.getByLabel("Password", { exact: true })).toHaveCount(0);
	await login.getByLabel("Email", { exact: true }).fill("test@email.com");
	await login.getByLabel("Password", { exact: true }).fill("1234");
	await login.getByRole("button", { name: "Sign in", exact: true }).click();
	await expect(login).not.toBeVisible();
});
