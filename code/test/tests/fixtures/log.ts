import {
  test as base,
  expect,
  PlaywrightTestArgs,
  PlaywrightTestOptions,
} from "@playwright/test";
import path from "path";
import sqlite3 from "sqlite3";
import { open, Database } from "sqlite";
import { JSDOM } from "jsdom";

// Extend the page with a custom method
declare module "@playwright/test" {
  interface Page {
    getLogs(): string[];
  }
}

function shouldLogRequest(request: any) {
  const url = request.url();
  const resourceType = request.resourceType();

  // Skip internal Next.js requests and common asset types
  const skipPatterns = [
    "/_next/", // Next.js internal routes
    "/__next", // Next.js internal routes
    "/__webpack", // Webpack dev server
    "/node_modules/", // Node modules
    "/@", // Vite/other dev server paths
  ];

  // Skip certain resource types that are typically framework-related
  const skipResourceTypes = [
    "stylesheet",
    "font",
    "media",
    "document",
    "websocket",
  ];

  // Check if URL matches any skip patterns
  const isFrameworkUrl = skipPatterns.some((pattern) => url.includes(pattern));

  // Return true if we should log this request
  return !isFrameworkUrl && !skipResourceTypes.includes(resourceType);
}

function truncateHeaderValue(value: unknown): string {
  const stringValue = String(value || "");
  if (stringValue.length <= 20) {
    return stringValue;
  }
  return `${stringValue.slice(0, 20)}...`;
}

function testStringDuplicate(string1: string, string2: string) {
  // check how many percent of the string is the same
  const length = string1.length;
  const same = string1
    .split("")
    .filter((char, index) => char === string2[index]).length;
  return same / length;
}

interface TestFixtures extends PlaywrightTestArgs, PlaywrightTestOptions {
  database: Database;
}

const test = base.extend<TestFixtures>({
  page: async ({ page }, use, testInfo) => {
    var logs = "";
    var duplicateLogs = [] as string[];

    // Set up console listeners
    page.on("console", (msg) => {
      if (["log", "error"].includes(msg.type())) {
        const logMessage = `${msg.type()}: ${
          msg.text().split("\n").length > 10
            ? msg.text().split("\n").splice(0, 3).join("\n")
            : msg.text()
        }`;
        if (
          duplicateLogs.some(
            (log) => testStringDuplicate(log, logMessage) > 0.5
          )
        ) {
          return;
        }
        duplicateLogs.push(logMessage);
        logs += `\n<Browser Console Log> ${logMessage} </Browser Console Log>`;
      }
    });

    // Log uncaught exceptions
    page.on("pageerror", (error) => {
      const errorMessage = `Page Error: ${error.message}`;
      logs += `\n<Page Error From Browser> ${errorMessage}</Page Error From Browser>`;
    });

    // Log failed requests
    page.on("requestfailed", (request) => {
      if (shouldLogRequest(request)) {
        const failureInfo = {
          url: request.url(),
          method: request.method(),
          resourceType: request.resourceType(),
          failure: request.failure()?.errorText || "Unknown failure",
        };

        const logMessage = JSON.stringify(failureInfo, null, 2);
        logs +=
          "\n<Failed API Request From Browser> " +
          logMessage +
          "</Failed API Request From Browser>";
      }
    });

    // Log success requests
    page.on("requestfinished", async (request) => {
      if (shouldLogRequest(request)) {
        const response = await request.response();

        const headers = request.headers();
        const authHeaders = Object.entries(headers)
          .filter(([name]) =>
            ["cookie", "authorization"].includes(name.toLowerCase())
          )
          .reduce(
            (acc, [name, value]) => ({
              ...acc,
              [name]: truncateHeaderValue(value),
            }),
            {}
          );

        const successInfo = {
          url: request.url(),
          method: request.method(),
          resourceType: request.resourceType(),
          requestHeaders: authHeaders,
          status: response?.status(),
          statusText: response?.statusText(),
        };

        const logMessage = JSON.stringify(successInfo, null, 2);
        logs +=
          "\n<Successful API Request From Browser> " +
          logMessage +
          "</Successful API Request From Browser>";
      }
    });

    // Pass the modified page to the test
    await use(page);

    // dump the logs and html on failure
    if (testInfo.status === "failed") {
      console.log(`<Browser Logs> ${logs}</Browser Log>`);
      try{
        const cleanedHTML = await page.evaluate(() => {
          const clone = document.body.cloneNode(true) as HTMLElement;
          clone.querySelectorAll("[class]").forEach(el => el.removeAttribute('class'));
          clone.querySelectorAll('script').forEach(s => s.remove())
  
          return clone.innerHTML
        });
        console.log(`HTML Dump without class attributes: ${cleanedHTML}`);
      } catch (e) {
        console.log("HTML Dump without class attributes:", e instanceof Error ? e.message : e);
      }
    }

    // Take screenshot after test completes
    if (testInfo.status !== "skipped") {
      const ss = await page.screenshot();
      testInfo.attachments.push({
        name: "screenshot",
        body: ss,
        contentType: "image/png",
      });
    }
  },
  database: async ({}, use) => {
    // Set up database connection
    const dbPath = path.resolve(__dirname, "../../../database.sqlite");
    const db = await open({
      filename: dbPath,
      driver: sqlite3.Database,
    });
    await use(db);
    // Clean up database connection
    await db.close();
  },
  browser: async ({ browser }, use, testInfo) => {
    browser.newPage = async () => {
      throw "Please use the 'page' fixture to interact with the page. If multiple pages are needed, simply reuse the 'page' fixture.";
    };
    await use(browser)
  },
});

export { expect, test };
