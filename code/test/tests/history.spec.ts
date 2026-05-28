import { test, expect } from './fixtures/log';
import type { Page } from '@playwright/test';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

// Default test user ID
const DEFAULT_USER_ID = '00000000-0000-0000-0000-000000000000';

test.describe('History Module E2E Tests', () => {
  test.beforeEach(async ({ database }) => {
    // Clean up history sessions for the default user
    await database.run('DELETE FROM history_sessions WHERE user_id = ?', [DEFAULT_USER_ID]);
    
    // Reset the sequence (SQLite specific)
    try {
      await database.run('DELETE FROM sqlite_sequence WHERE name = ?', ['history_sessions']);
    } catch {
      // Sequence table might not exist, that's fine
    }
  });

  test.describe('module: History - Empty State', () => {
    test('displays empty state when user has no saved sessions', async ({ page }) => {
      await page.goto('/history');
      
      // Verify empty state is displayed
      const emptyState = page.locator('[data-testid="empty-state"]');
      await expect(emptyState).toBeVisible();
      
      // Verify empty state content
      await expect(page.locator('text=No saved comparisons yet')).toBeVisible();
      await expect(page.locator('text=Your comparison history will appear here')).toBeVisible();
      
      // Verify CTA button
      const ctaButton = page.locator('text=Start a Comparison');
      await expect(ctaButton).toBeVisible();
      await expect(ctaButton).toHaveAttribute('href', '/');
    });
  });

  test.describe('module: History - List View', () => {
    test.beforeEach(async ({ database }) => {
      // Seed test data
      const sessions = [
        {
          id: 'test-session-1',
          name: 'Q4 Sales Contacts',
          user_id: DEFAULT_USER_ID,
          row_count: 2847,
          mean_confidence: 0.89,
          results: JSON.stringify([
            { companyName: 'John Doe', facebookName: 'John Doe', confidence: 0.95 },
            { companyName: 'Jane Smith', facebookName: 'Jane Smith', confidence: 0.82 }
  ]),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        },
        {
          id: 'test-session-2',
          name: 'Marketing Leads Merge',
          user_id: DEFAULT_USER_ID,
          row_count: 1523,
          mean_confidence: 0.72,
          results: JSON.stringify([
            { companyName: 'Bob Wilson', facebookName: 'Bob W', confidence: 0.65 }
  ]),
          created_at: new Date(Date.now() - 86400000).toISOString(), // 1 day ago
          updated_at: new Date(Date.now() - 86400000).toISOString()
        },
        {
          id: 'test-session-3',
          name: 'Event Attendees Oct',
          user_id: DEFAULT_USER_ID,
          row_count: 892,
          mean_confidence: 0.43,
          results: JSON.stringify([
            { companyName: 'Alice Brown', facebookName: 'Ali Brown', confidence: 0.42 }
  ]),
          created_at: new Date(Date.now() - 172800000).toISOString(), // 2 days ago
          updated_at: new Date(Date.now() - 172800000).toISOString()
        }
      ];

      for (const session of sessions) {
        await database.run(
          `INSERT INTO history_sessions (id, name, user_id, row_count, mean_confidence, results, created_at, updated_at) 
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [session.id, session.name, session.user_id, session.row_count, session.mean_confidence, session.results, session.created_at, session.updated_at]
        );
      }
    });

    test('displays history page with search and session grid', async ({ page }) => {
      await page.goto('/history');
      
      // Verify page header
      await expect(page.locator('text=Saved Comparisons')).toBeVisible();
      await expect(page.locator('text=View and manage your previous name comparisons')).toBeVisible();
      
      // Verify search input
      const searchInput = page.locator('[data-testid="search-input"]');
      await expect(searchInput).toBeVisible();
      await expect(searchInput).toHaveAttribute('placeholder', 'Search by session name or date...');
      
      // Verify new comparison button
      const newComparisonBtn = page.locator('[data-testid="new-comparison-btn"]');
      await expect(newComparisonBtn).toBeVisible();
      
      // Verify session cards are displayed
      await expect(page.locator('[data-testid="session-card-test-session-1"]')).toBeVisible();
      await expect(page.locator('[data-testid="session-card-test-session-2"]')).toBeVisible();
      await expect(page.locator('[data-testid="session-card-test-session-3"]')).toBeVisible();
    });

    test('displays session cards with correct information', async ({ page }) => {
      await page.goto('/history');
      
      // Verify first session card content
      const firstCard = page.locator('[data-testid="session-card-test-session-1"]');
      await expect(firstCard).toContainText('Q4 Sales Contacts');
      await expect(firstCard).toContainText('2,847');
      await expect(firstCard).toContainText('0.89');
      
      // Verify color dot (green for high confidence)
      const greenDot = firstCard.locator('.bg-emerald-500, .bg-lime-500');
      await expect(greenDot).toBeVisible();
      
      // Verify second session (amber for medium confidence)
      const secondCard = page.locator('[data-testid="session-card-test-session-2"]');
      await expect(secondCard).toContainText('Marketing Leads Merge');
      const amberDot = secondCard.locator('.bg-amber-500');
      await expect(amberDot).toBeVisible();
      
      // Verify third session (red for low confidence)
      const thirdCard = page.locator('[data-testid="session-card-test-session-3"]');
      await expect(thirdCard).toContainText('Event Attendees Oct');
      const redDot = thirdCard.locator('.bg-red-500');
      await expect(redDot).toBeVisible();
    });

    test('filters sessions by name search', async ({ page }) => {
      await page.goto('/history');
      
      // Type in search box
      const searchInput = page.locator('[data-testid="search-input"]');
      await searchInput.fill('Sales');
      
      // Wait for filtering
      await page.waitForTimeout(300);
      
      // Verify only matching session is visible
      await expect(page.locator('[data-testid="session-card-test-session-1"]')).toBeVisible();
      await expect(page.locator('[data-testid="session-card-test-session-2"]')).not.toBeVisible();
      await expect(page.locator('[data-testid="session-card-test-session-3"]')).not.toBeVisible();
      
      // Clear search and verify all sessions are shown
      await searchInput.fill('');
      await page.waitForTimeout(300);
      
      await expect(page.locator('[data-testid="session-card-test-session-1"]')).toBeVisible();
      await expect(page.locator('[data-testid="session-card-test-session-2"]')).toBeVisible();
      await expect(page.locator('[data-testid="session-card-test-session-3"]')).toBeVisible();
    });

    test('opens session detail when clicking a session card', async ({ page }) => {
      await page.goto('/history');
      
      // Click on first session card
      await page.locator('[data-testid="session-card-test-session-1"]').click();
      
      // Verify navigation to session detail
      await page.waitForURL('**/session-detail?id=test-session-1');
      
      // Verify detail page content
      await expect(page.locator('text=Q4 Sales Contacts')).toBeVisible();
      await expect(page.locator('[data-testid="back-link"]')).toBeVisible();
    });

    test.skip('opens delete confirmation dialog when clicking delete', async ({ page }) => {
      await page.goto('/history');
      
      // Hover over session card to reveal delete button
      const card = page.locator('[data-testid="session-card-test-session-1"]');
      await card.hover();
      
      // Click delete button
      const deleteBtn = page.locator('[data-testid="delete-btn-test-session-1"]');
      await deleteBtn.click();
      
      // Verify delete confirmation modal
      await expect(page.locator('text=Delete Session')).toBeVisible();
      await expect(page.locator('text=Q4 Sales Contacts')).toBeVisible();
      await expect(page.locator('text=This action cannot be undone')).toBeVisible();
    });

    test.skip('deletes session and returns to history grid after confirmation', async ({ page }) => {
      await page.goto('/history');
      
      // Verify initial state
      await expect(page.locator('[data-testid="session-card-test-session-1"]')).toBeVisible();
      
      // Open delete dialog
      const card = page.locator('[data-testid="session-card-test-session-1"]');
      await card.hover();
      await page.locator('[data-testid="delete-btn-test-session-1"]').click();
      
      // Confirm deletion
      await page.locator('button:has-text("Delete Session")').click();
      
      // Verify session is removed
      await expect(page.locator('[data-testid="session-card-test-session-1"]')).not.toBeVisible();
      
      // Verify other sessions still exist
      await expect(page.locator('[data-testid="session-card-test-session-2"]')).toBeVisible();
      await expect(page.locator('[data-testid="session-card-test-session-3"]')).toBeVisible();
    });
  });

  test.describe('module: History - Session Detail', () => {
    test.beforeEach(async ({ database }) => {
      // Seed test data with detailed results
      const results = Array.from({ length: 100 }, (_, i) => ({
        companyName: `Person ${i}`,
        facebookName: `Person ${i}`,
        confidence: 0.5 + (Math.random() * 0.5)
      }));

      await database.run(
        `INSERT INTO history_sessions (id, name, user_id, row_count, mean_confidence, results, created_at, updated_at) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          'detail-test-session',
          'Q4 Contacts Merge',
          DEFAULT_USER_ID,
          100,
          0.89,
          JSON.stringify(results),
          new Date().toISOString(),
          new Date().toISOString()
        ]
      );
    });

    test.skip('displays session detail with stats, histogram, and results table', async ({ page }) => {
      await page.goto('/session-detail?id=detail-test-session');
      
      // Wait for loading to complete
      await page.waitForSelector('[data-testid="loading-indicator"]', { state: 'detached' });
      
      // Verify page header
      await expect(page.locator('text=Q4 Contacts Merge')).toBeVisible();
      await expect(page.locator('text=Saved')).toBeVisible();
      
      // Verify stats cards
      await expect(page.locator('text=Total Rows')).toBeVisible();
      await expect(page.locator('text=Min Confidence')).toBeVisible();
      await expect(page.locator('text=Max Confidence')).toBeVisible();
      await expect(page.locator('text=Mean')).toBeVisible();
      await expect(page.locator('text=Std Dev')).toBeVisible();
      
      // Verify histogram
      await expect(page.locator('text=Confidence Distribution')).toBeVisible();
      
      // Verify results table
      await expect(page.locator('text=Company Name')).toBeVisible();
      await expect(page.locator('text=Facebook Name')).toBeVisible();
      await expect(page.locator('text=Confidence')).toBeVisible();
    });

    test('displays back button to return to history', async ({ page }) => {
      await page.goto('/session-detail?id=detail-test-session');
      
      // Wait for loading to complete
      await page.waitForSelector('[data-testid="loading-indicator"]', { state: 'detached' });
      
      // Click back link
      await page.locator('[data-testid="back-link"]').click();
      
      // Verify navigation back to history
      await page.waitForURL('**/history');
      await expect(page.locator('text=Saved Comparisons')).toBeVisible();
    });

    test.skip('allows searching within results table', async ({ page }) => {
      await page.goto('/session-detail?id=detail-test-session');
      
      // Wait for loading to complete
      await page.waitForSelector('[data-testid="loading-indicator"]', { state: 'detached' });
      
      // Type in results search
      const searchInput = page.locator('[data-testid="results-search-input"]');
      await searchInput.fill('Person 1');
      
      // Verify filtered results
      await expect(page.locator('text=Person 1')).toBeVisible();
    });

    test('supports pagination in results table', async ({ page }) => {
      await page.goto('/session-detail?id=detail-test-session');
      
      // Wait for loading to complete
      await page.waitForSelector('[data-testid="loading-indicator"]', { state: 'detached' });
      
      // Verify pagination controls exist
      const prevBtn = page.locator('[data-testid="prev-page-btn"]');
      const nextBtn = page.locator('[data-testid="next-page-btn"]');
      
      await expect(prevBtn).toBeVisible();
      await expect(nextBtn).toBeVisible();
      
      // Previous should be disabled on first page
      await expect(prevBtn).toBeDisabled();
      
      // Next should be enabled (if more than 50 results)
      await expect(nextBtn).toBeEnabled();
      
      // Click next
      await nextBtn.click();
      
      // Previous should now be enabled
      await expect(prevBtn).toBeEnabled();
    });

    test('downloads CSV when clicking download button', async ({ page }) => {
      await page.goto('/session-detail?id=detail-test-session');
      
      // Wait for loading to complete
      await page.waitForSelector('[data-testid="loading-indicator"]', { state: 'detached' });
      
      // Setup download listener
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.locator('[data-testid="download-csv-btn"]').click()
      ]);
      
      // Verify download started
      expect(download.suggestedFilename()).toContain('.csv');
      expect(download.suggestedFilename()).toContain('q4_contacts_merge');
    });

    test('navigates to upload page with session pre-selected when clicking use in new merge', async ({ page }) => {
      await page.goto('/session-detail?id=detail-test-session');
      
      // Wait for loading to complete
      await page.waitForSelector('[data-testid="loading-indicator"]', { state: 'detached' });
      
      // Click use in new merge button
      await page.locator('[data-testid="use-in-merge-btn"]').click();
      
      // Verify navigation to upload page with session params
      await page.waitForURL(url => url.pathname === '/' && url.search.includes('mode=continue'));
    });

    test.skip('opens delete confirmation from detail page', async ({ page }) => {
      await page.goto('/session-detail?id=detail-test-session');
      
      // Wait for loading to complete
      await page.waitForSelector('[data-testid="loading-indicator"]', { state: 'detached' });
      
      // Click delete button
      await page.locator('[data-testid="delete-btn"]').click();
      
      // Verify delete confirmation modal
      await expect(page.locator('text=Delete Session')).toBeVisible();
      await expect(page.locator('text=Q4 Contacts Merge')).toBeVisible();
      
      // Cancel and verify modal closes
      await page.locator('button:has-text("Cancel")').click();
      await expect(page.locator('text=Delete Session')).not.toBeVisible();
    });

    test('deletes session and redirects to history after confirmation from detail', async ({ page }) => {
      await page.goto('/session-detail?id=detail-test-session');
      
      // Wait for loading to complete
      await page.waitForSelector('[data-testid="loading-indicator"]', { state: 'detached' });
      
      // Open delete dialog
      await page.locator('[data-testid="delete-btn"]').click();
      
      // Confirm deletion
      await page.locator('button:has-text("Delete Session")').click();
      
      // Verify redirect to history
      await page.waitForURL('**/history');
      await expect(page.locator('text=Saved Comparisons')).toBeVisible();
    });

    test('displays error message for non-existent session', async ({ page }) => {
      await page.goto('/session-detail?id=non-existent-id');
      
      // Verify error message
      await expect(page.locator('[data-testid="error-message"]')).toBeVisible();
    });
  });

  test.describe('module: History - Search Functionality', () => {
    test.beforeEach(async ({ database }) => {
      // Seed test data with various dates
      const sessions = [
        {
          id: 'search-test-1',
          name: 'Alpha Project Contacts',
          user_id: DEFAULT_USER_ID,
          row_count: 100,
          mean_confidence: 0.85,
          results: '[]',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        },
        {
          id: 'search-test-2',
          name: 'Beta Marketing List',
          user_id: DEFAULT_USER_ID,
          row_count: 200,
          mean_confidence: 0.75,
          results: '[]',
          created_at: new Date(Date.now() - 86400000).toISOString(),
          updated_at: new Date(Date.now() - 86400000).toISOString()
        },
        {
          id: 'search-test-3',
          name: 'Gamma Sales Data',
          user_id: DEFAULT_USER_ID,
          row_count: 300,
          mean_confidence: 0.65,
          results: '[]',
          created_at: new Date(Date.now() - 172800000).toISOString(),
          updated_at: new Date(Date.now() - 172800000).toISOString()
        }
      ];

      for (const session of sessions) {
        await database.run(
          `INSERT INTO history_sessions (id, name, user_id, row_count, mean_confidence, results, created_at, updated_at) 
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [session.id, session.name, session.user_id, session.row_count, session.mean_confidence, session.results, session.created_at, session.updated_at]
        );
      }
    });

    test('case-insensitive partial match on session name', async ({ page }) => {
      await page.goto('/history');
      
      // Search with lowercase
      const searchInput = page.locator('[data-testid="search-input"]');
      await searchInput.fill('alpha');
      await page.waitForTimeout(300);
      
      await expect(page.locator('[data-testid="session-card-search-test-1"]')).toBeVisible();
      await expect(page.locator('[data-testid="session-card-search-test-2"]')).not.toBeVisible();
      
      // Search with uppercase
      await searchInput.fill('BETA');
      await page.waitForTimeout(300);
      
      await expect(page.locator('[data-testid="session-card-search-test-2"]')).toBeVisible();
      await expect(page.locator('[data-testid="session-card-search-test-1"]')).not.toBeVisible();
    });

    test('shows no results message when search has no matches', async ({ page }) => {
      await page.goto('/history');
      
      const searchInput = page.locator('[data-testid="search-input"]');
      await searchInput.fill('NonExistentSession');
      await page.waitForTimeout(300);
      
      await expect(page.locator('[data-testid="no-results"]')).toBeVisible();
      await expect(page.locator('text=No sessions found matching')).toBeVisible();
    });
  });
});
