import { expect, test } from "@playwright/test";

test.describe("login flow", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.clear();
    });
  });

  test("logs in and redirects to the home chat page", async ({ page }) => {
    await page.route("**/auth/login", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            accessToken: "token-abc",
            expiresIn: 7200,
          },
        }),
      });
    });

    await page.route("**/auth/me", async (route) => {
      const authHeader = route.request().headers().authorization;

      if (authHeader !== "Bearer token-abc") {
        await route.fulfill({
          status: 401,
          contentType: "application/json",
          body: JSON.stringify({
            success: false,
            data: null,
            error: { code: "UNAUTHORIZED", message: "Unauthorized" },
            requestId: "req-1",
          }),
        });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            id: "user-1",
            email: "user@example.com",
            name: "Demo User",
          },
        }),
      });
    });

    await page.goto("/login");

    await expect(page.locator("article.login-copy h2")).toBeVisible();

    await page.locator("#username").fill("user@example.com");
    await page.locator("#password").fill("secret123");
    await page.locator('form.login-card button[type="submit"]').click();

    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator(".chat-panel")).toBeVisible();
    await expect(page.locator(".sidebar-create-button")).toBeVisible();
    await expect(page.locator("body")).toContainText("Demo User");
    await expect(page.locator("body")).toContainText("user@example.com");

    const storedToken = await page.evaluate(() =>
      localStorage.getItem("aitext_access_token"),
    );
    expect(storedToken).toBe("token-abc");
  });

  test("shows an error when login fails", async ({ page }) => {
    await page.route("**/auth/login", async (route) => {
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({
          success: false,
          data: null,
          error: {
            code: "INVALID_CREDENTIALS",
            message: "Invalid credentials",
          },
          requestId: "req-2",
        }),
      });
    });

    await page.goto("/login");
    await page.locator("#username").fill("bad@example.com");
    await page.locator("#password").fill("wrong-password");
    await page.locator('form.login-card button[type="submit"]').click();

    await expect(page.locator("p.error-text")).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
    const storedToken = await page.evaluate(() =>
      localStorage.getItem("aitext_access_token"),
    );
    expect(storedToken).toBeNull();
  });
});
