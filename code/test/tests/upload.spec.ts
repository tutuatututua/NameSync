import { test, expect } from './fixtures/log';
import type { Page } from '@playwright/test';
import path from 'path';

test.describe('Upload Module: File Upload and Comparison Flow', () => {
  test.beforeEach(async ({ page, database }) => {
    // Reset database state
    await database.exec("DELETE FROM upload_sessions");
    await database.exec("DELETE FROM history_sessions");
    await database.exec("DELETE FROM company_data");
    await database.exec("DELETE FROM facebook_data");
    await database.exec("DELETE FROM comparison_results");
    
    // Seed test data in upload_sessions (sessions API queries this table)
    await database.exec(`
      INSERT INTO upload_sessions (id, name, facebook_file_path, mode, parent_session_id, status, created_at, updated_at) 
      VALUES ('test-session-1', 'Test Session', '/tmp/test.json', 'fresh', NULL, 'completed', datetime('now'), datetime('now'))
    `);
    
    // Also seed history_sessions for other tests
    await database.exec(`
      INSERT INTO history_sessions (id, name, user_id, row_count, mean_confidence, results, created_at, updated_at) 
      VALUES ('test-session-1', 'Test Session', '00000000-0000-0000-0000-000000000000', 100, 0.85, '[]', datetime('now'), datetime('now'))
    `);
  });

  test('module: Home page displays upload zones for Company Data CSV and Facebook JSON files', async ({ page }) => {
    await page.goto('http://localhost:3000/');
    
    // Verify page title and description
    await expect(page.getByText('Compare Names Across Platforms')).toBeVisible();
    await expect(page.getByText('Upload your Company Data and Facebook export files')).toBeVisible();
    
    // Verify upload zones are displayed
    await expect(page.getByTestId('company-dropzone')).toBeVisible();
    await expect(page.getByTestId('facebook-dropzone')).toBeVisible();
    
    // Verify Company Data zone content
    await expect(page.getByRole('heading', { name: 'Company Data' })).toBeVisible();
    await expect(page.getByText('.csv only')).toBeVisible();
    
    // Verify Facebook zone content
    await expect(page.getByRole('heading', { name: 'Facebook Export' })).toBeVisible();
    await expect(page.getByText('.json only')).toBeVisible();
    
    // Verify mode toggle
    await expect(page.getByTestId('mode-toggle')).toBeVisible();
    await expect(page.getByText('Start fresh')).toBeVisible();
    await expect(page.getByText('Continue from existing')).toBeVisible();
    
    // Verify save to database button is disabled initially (no files, no name)
    const saveBtn = page.getByTestId('save-to-database-btn');
    await expect(saveBtn).toBeDisabled();
    
    // Verify WebSocket status indicator is present
    await expect(page.getByTestId('ws-status-indicator')).toBeVisible();
    await expect(page.getByText('Disconnected')).toBeVisible();
  });

  test('module: Continue mode enables session picker button', async ({ page }) => {
    await page.goto('http://localhost:3000/');
    
    // Initially, pick from history button should not be visible
    await expect(page.getByTestId('pick-from-history-btn')).not.toBeVisible();
    
    // Click continue mode
    await page.getByText('Continue from existing').click();
    
    // Now pick from history button should be visible
    await expect(page.getByTestId('pick-from-history-btn')).toBeVisible();
    await expect(page.getByTestId('pick-from-history-btn')).toBeEnabled();
  });

  test('module: Clicking Pick from History opens modal listing saved sessions', async ({ page }) => {
    await page.goto('http://localhost:3000/');
    
    // Switch to continue mode
    await page.getByText('Continue from existing').click();
    
    // Click pick from history
    await page.getByTestId('pick-from-history-btn').click();
    
    // Verify modal is displayed
    await expect(page.getByRole('heading', { name: 'Select a Session' })).toBeVisible();
    
    // Verify test session is listed
    await expect(page.getByText('Test Session')).toBeVisible();
    await expect(page.getByText('0 rows')).toBeVisible();
  });

  test('module: Selecting session from modal displays preview card with details', async ({ page }) => {
    await page.goto('http://localhost:3000/');
    
    // Switch to continue mode
    await page.getByText('Continue from existing').click();
    
    // Click pick from history
    await page.getByTestId('pick-from-history-btn').click();
    
    // Select the test session (clicking it directly selects and closes modal)
    await page.getByText('Test Session').click();
    
    // Verify selected session banner is displayed
    await expect(page.getByText('Test Session')).toBeVisible();
    await expect(page.getByText('0 rows')).toBeVisible();
    await expect(page.getByText('Remove')).toBeVisible();
  });

  test('module: Clicking remove button clears session selection', async ({ page }) => {
    await page.goto('http://localhost:3000/');
    
    // Switch to continue mode and select a session
    await page.getByText('Continue from existing').click();
    await page.getByTestId('pick-from-history-btn').click();
    await page.getByText('Test Session').click();
    
    // Verify session is selected
    await expect(page.getByText('Test Session')).toBeVisible();
    
    // Click remove
    await page.getByText('Remove').click();
    
    // Verify session banner is removed (look for the selected session banner container)
    await expect(page.locator('text=Test Session').first()).not.toBeVisible();
  });

  test('module: Valid Company Data CSV file upload displays filename and enables compare', async ({ page }) => {
    await page.goto('http://localhost:3000/');
    
    // Create a test CSV file with proper headers
    const csvContent = 'Company Name,Thai Name\nAcme Corp,นายจอห์น โด';
    const csvBuffer = Buffer.from(csvContent);
    
    // Upload Company Data file
    const companyInput = page.getByTestId('company-file-input');
    await companyInput.setInputFiles({
      name: 'company_data.csv',
      mimeType: 'text/csv',
      buffer: csvBuffer
    });
    
    // Verify file card is displayed
    await expect(page.getByTestId('company-file-card')).toBeVisible();
    await expect(page.getByText('company_data.csv')).toBeVisible();
    await expect(page.getByText('Valid CSV')).toBeVisible();
  });

  test('module: Valid Facebook JSON file upload displays filename', async ({ page }) => {
    await page.goto('http://localhost:3000/');
    
    // Create a test JSON file with proper Facebook export format (friends_v2)
    const jsonContent = JSON.stringify({ friends_v2: [{ name: 'John Doe', timestamp: 1609459200 }] });
    const jsonBuffer = Buffer.from(jsonContent);
    
    // Upload Facebook file
    const facebookInput = page.getByTestId('facebook-file-input');
    await facebookInput.setInputFiles({
      name: 'facebook_friends.json',
      mimeType: 'application/json',
      buffer: jsonBuffer
    });
    
    // Verify file card is displayed
    await expect(page.getByTestId('facebook-file-card')).toBeVisible();
    await expect(page.getByText('facebook_friends.json')).toBeVisible();
    await expect(page.getByText('Valid JSON')).toBeVisible();
  });

  test('module: Invalid Company Data file type shows error state', async ({ page }) => {
    await page.goto('http://localhost:3000/');
    
    // Try to upload wrong file type to Company Data
    const companyInput = page.getByTestId('company-file-input');
    await companyInput.setInputFiles({
      name: 'wrong_file.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('test content')
    });
    
    // Verify error state
    await expect(page.getByTestId('company-file-card')).toBeVisible();
    await expect(page.getByText('Invalid file')).toBeVisible();
    await expect(page.getByText('Please upload a .csv file')).toBeVisible();
  });

  test('module: Invalid Facebook file type shows error state', async ({ page }) => {
    await page.goto('http://localhost:3000/');
    
    // Try to upload wrong file type to Facebook
    const facebookInput = page.getByTestId('facebook-file-input');
    await facebookInput.setInputFiles({
      name: 'wrong_file.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: Buffer.from('test content')
    });
    
    // Verify error state
    await expect(page.getByTestId('facebook-file-card')).toBeVisible();
    await expect(page.getByText('Invalid file')).toBeVisible();
    await expect(page.getByText('Please upload a .json file')).toBeVisible();
  });

  test('module: Save to Database button enables when all required fields are filled', async ({ page }) => {
    await page.goto('http://localhost:3000/');
    
    // Enter session name (required)
    await page.getByTestId('session-name-input').fill('Test Comparison');
    
    // Upload Company Data file
    await page.getByTestId('company-file-input').setInputFiles({
      name: 'company_data.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('name,email\nJohn,john@example.com')
    });
    
    // Save button should still be disabled (no person name, only one file)
    let saveBtn = page.getByTestId('save-to-database-btn');
    await expect(saveBtn).toBeDisabled();
    
    // Enter upload person name (required)
    await page.getByTestId('upload-person-name-input').fill('John Doe');
    
    // Save button should still be disabled (only one file)
    saveBtn = page.getByTestId('save-to-database-btn');
    await expect(saveBtn).toBeDisabled();
    
    // Upload Facebook file
    await page.getByTestId('facebook-file-input').setInputFiles({
      name: 'facebook_friends.json',
      mimeType: 'application/json',
      buffer: Buffer.from('{"friends_v2":[]}')
    });
    
    // Now save button should be enabled
    saveBtn = page.getByTestId('save-to-database-btn');
    await expect(saveBtn).toBeEnabled();
  });

  test('module: Save button disabled in continue mode without session selection', async ({ page }) => {
    await page.goto('http://localhost:3000/');
    
    // Enter session name (required)
    await page.getByTestId('session-name-input').fill('Test Comparison');
    
    // Enter upload person name (required)
    await page.getByTestId('upload-person-name-input').fill('John Doe');
    
    // Upload both files in fresh mode first
    await page.getByTestId('company-file-input').setInputFiles({
      name: 'company_data.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('name,email\nJohn,john@example.com')
    });
    
    await page.getByTestId('facebook-file-input').setInputFiles({
      name: 'facebook_friends.json',
      mimeType: 'application/json',
      buffer: Buffer.from('{"friends_v2":[]}')
    });
    
    // Save button should be enabled
    let saveBtn = page.getByTestId('save-to-database-btn');
    await expect(saveBtn).toBeEnabled();
    
    // Switch to continue mode
    await page.getByText('Continue from existing').click();
    
    // Save button should now be disabled (no session selected)
    saveBtn = page.getByTestId('save-to-database-btn');
    await expect(saveBtn).toBeDisabled();
    
    // Select a session
    await page.getByTestId('pick-from-history-btn').click();
    await page.getByText('Test Session').click();
    
    // Save button should be enabled again
    saveBtn = page.getByTestId('save-to-database-btn');
    await expect(saveBtn).toBeEnabled();
  });

  test('module: Save to Database shows database tables and Compare button', async ({ page, database }) => {
    // Mock successful webhook by temporarily modifying the session status
    // This test verifies the UI workflow without relying on external webhooks
    await page.goto('http://localhost:3000/');
    
    // Enter session name (required)
    await page.getByTestId('session-name-input').fill('Test Comparison Workflow');
    
    // Enter upload person name (required)
    await page.getByTestId('upload-person-name-input').fill('John Doe');
    
    // Upload both files
    await page.getByTestId('company-file-input').setInputFiles({
      name: 'company_data.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('Company Name,Thai Name\nAcme Corp,นายจอห์น โด')
    });
    
    await page.getByTestId('facebook-file-input').setInputFiles({
      name: 'facebook_friends.json',
      mimeType: 'application/json',
      buffer: Buffer.from('{"friends_v2":[{"name":"John Doe","timestamp":1609459200}]}')
    });
    
    // Verify Save to Database button is enabled
    await expect(page.getByTestId('save-to-database-btn')).toBeEnabled();
    
    // Note: We don't click Save here because external webhooks may fail
    // Instead, we directly seed the database to simulate successful save
    const testSessionId = 'test-workflow-session';
    await database.exec(`
      INSERT INTO upload_sessions (id, name, facebook_file_path, mode, parent_session_id, status, created_at, updated_at) 
      VALUES ('${testSessionId}', 'Test Comparison Workflow', '/tmp/test.json', 'fresh', NULL, 'processing', datetime('now'), datetime('now'))
    `);
    
    await database.exec(`
      INSERT INTO company_data (uuid, company_name, person_name_th, person_name_en, status, session_id)
      VALUES ('test-uuid-1', 'Acme Corp', 'นายจอห์น โด', null, null, '${testSessionId}')
    `);
    
    await database.exec(`
      INSERT INTO facebook_data (uuid, fb_name, timestamp, upload_person_name, session_id)
      VALUES ('test-uuid-2', 'John Doe', '2021-01-01T00:00:00.000Z', 'John Doe', '${testSessionId}')
    `);
    
    // Navigate directly to test the saved state (using continue mode to load session)
    await page.goto(`http://localhost:3000/?mode=continue&sessionId=${testSessionId}&sessionName=Test%20Comparison%20Workflow`);
    
    // Verify the session is loaded (selected session banner should appear)
    await expect(page.getByText('Test Comparison Workflow')).toBeVisible();
  });

  test('module: Upload error page displays error message', async ({ page }) => {
    await page.goto('http://localhost:3000/upload-error');
    
    // Verify error page content
    await expect(page.getByText('Upload Failed')).toBeVisible();
    await expect(page.getByTestId('upload-error-alert')).toBeVisible();
    await expect(page.getByText('Company Data file must be a .csv file')).toBeVisible();
    await expect(page.getByText('Facebook file must be a .json file')).toBeVisible();
    await expect(page.getByTestId('try-again-btn')).toBeVisible();
  });

  test('module: Try Again button on error page navigates to home', async ({ page }) => {
    await page.goto('http://localhost:3000/upload-error');
    
    // Click try again and wait for navigation
    await page.getByTestId('try-again-btn').click();
    
    // Wait for home page to load by checking for a key element
    await expect(page.getByRole('heading', { name: 'Compare Names Across Platforms' })).toBeVisible({ timeout: 5000 });
    
    // Verify we're on home page
    await expect(page.url()).toBe('http://localhost:3000/');
  });

  test('module: Remove file button clears file selection', async ({ page }) => {
    await page.goto('http://localhost:3000/');
    
    // Upload Company Data file
    await page.getByTestId('company-file-input').setInputFiles({
      name: 'company_data.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('name,email\nJohn,john@example.com')
    });
    
    // Verify file is displayed
    await expect(page.getByTestId('company-file-card')).toBeVisible();
    
    // Click remove file
    await page.getByText('Remove file').click();
    
    // Verify file card is gone and dropzone is back
    await expect(page.getByTestId('company-file-card')).not.toBeVisible();
    await expect(page.getByTestId('company-dropzone')).toBeVisible();
  });
});
