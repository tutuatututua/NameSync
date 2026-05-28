import { test, expect } from './fixtures/log';
import type { Page } from '@playwright/test';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

test.describe('Critical Path E2E Tests', () => {
  test.beforeEach(async ({ page, database }) => {
    // Add any data seeding here
    database.exec("DELETE FROM users");
  });
  test.skip("Example test", ({page, database}) => {
    // Test code here: It is important to use fixture page as it is integrated with logging.
    // database.exec("SELECT * FROM users");
    // page.goto("https://example.com");
    expect(true).toBeTruthy();
  })
  // add tests here
});
