import { API_BASE_URL } from './config';

// Database schema types (matching SQLite tables)
export interface FacebookDataRecord {
  uuid: string;
  fb_name: string | null;
  timestamp: string | null;
  upload_person_name: string | null;
  session_id: string | null;
}

export interface PaginationInfo {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface PaginatedFacebookDataResponse {
  success: boolean;
  data: FacebookDataRecord[];
  pagination: PaginationInfo;
}

export interface UploadHistoryRecord {
  id: string;
  source_type: string;
  user_upload: string;
  timestamp: string;
  rows_processed: number;
  duplicate_rows: number;
  session_id: string | null;
  created_at: string | null;
}

export interface UploadHistoryResponse {
  success: boolean;
  data: UploadHistoryRecord[];
  pagination: PaginationInfo;
}

/**
 * Fetch paginated Facebook data from the database
 * Can fetch all Facebook data across sessions or session-specific
 * @param page - Page number (1-based)
 * @param limit - Number of items per page
 * @param all - If true, fetch all Facebook data across all sessions
 * @returns Promise with paginated Facebook data response
 */
export async function fetchAllFacebookData(
  page = 1,
  limit = 20,
  all = false
): Promise<PaginatedFacebookDataResponse> {
  if (all) {
    // Fetch all Facebook data across all sessions
    const response = await fetch(
      `${API_BASE_URL}/comparisons/facebook-data/all?page=${page}&limit=${limit}`
    );
    
    if (!response.ok) {
      throw new Error(`Failed to fetch Facebook data: ${response.statusText}`);
    }
    
    return response.json();
  }
  
  // For session-specific data without a sessionId, return empty result
  // This is a placeholder - the component will update when a session is created
  return {
    success: true,
    data: [],
    pagination: {
      page: 1,
      limit: 20,
      total: 0,
      totalPages: 0
    }
  };
}

/**
 * Fetch paginated Facebook data for a single upload session.
 */
export async function fetchFacebookData(
  sessionId: string,
  page = 1,
  limit = 20
): Promise<PaginatedFacebookDataResponse> {
  const response = await fetch(
    `${API_BASE_URL}/comparisons/${sessionId}/facebook-data?page=${page}&limit=${limit}`
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch Facebook data: ${response.statusText}`);
  }

  return response.json();
}

/**
 * Fetch upload history for Facebook data
 * @param page - Page number (1-based)
 * @param limit - Number of items per page
 * @returns Promise with upload history response
 */
export async function fetchFacebookUploadHistory(
  page = 1,
  limit = 10
): Promise<UploadHistoryResponse> {
  const response = await fetch(
    `${API_BASE_URL}/upload-history/by-source/facebook?page=${page}&limit=${limit}`
  );
  
  if (!response.ok) {
    throw new Error(`Failed to fetch upload history: ${response.statusText}`);
  }
  
  return response.json();
}

/**
 * Total number of Facebook rows in the database.
 */
export async function fetchFacebookCount(): Promise<number> {
  const response = await fetch(
    `${API_BASE_URL}/comparisons/facebook-data/all?page=1&limit=1`
  );
  if (!response.ok) return 0;
  const data = await response.json();
  return data?.pagination?.total ?? 0;
}

/**
 * Delete every Facebook row (and its upload history). "Clear all Facebook data".
 */
export async function deleteAllFacebookData(): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/comparisons/facebook-data/all`, {
    method: 'DELETE'
  });
  if (!response.ok) {
    throw new Error(`Failed to clear Facebook data: ${response.statusText}`);
  }
}

/**
 * Delete a single Facebook row by uuid.
 */
export async function deleteFacebookRecord(uuid: string): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/comparisons/facebook-data/${uuid}`, {
    method: 'DELETE'
  });
  if (!response.ok) {
    throw new Error(`Failed to delete record: ${response.statusText}`);
  }
}

/**
 * Id of the most recent session eligible to (re)trigger a comparison, or null if
 * none exists. Used to run "Compare" against existing data without a fresh upload.
 */
export async function fetchLatestSessionId(): Promise<string | null> {
  const response = await fetch(`${API_BASE_URL}/sessions/latest`);
  if (!response.ok) return null;
  const data = await response.json();
  return data?.data?.id ?? null;
}

/**
 * Trigger comparison for a session
 * @param sessionId - The upload session ID
 * @returns Promise with comparison result
 */
export async function triggerComparison(sessionId: string): Promise<{
  success: boolean;
  message: string;
  data?: {
    sessionId: string;
    status: string;
  };
}> {
  const response = await fetch(`${API_BASE_URL}/comparisons/${sessionId}/compare`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    }
  });
  
  if (!response.ok) {
    throw new Error(`Failed to trigger comparison: ${response.statusText}`);
  }
  
  return response.json();
}

/**
 * Format relative time from timestamp
 */
export function formatRelativeTime(timestamp: string): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffTime = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
  const diffHours = Math.floor(diffTime / (1000 * 60 * 60));
  const diffMinutes = Math.floor(diffTime / (1000 * 60));

  if (diffMinutes < 1) {
    return 'Just now';
  } else if (diffMinutes < 60) {
    return `${diffMinutes} minute${diffMinutes > 1 ? 's' : ''} ago`;
  } else if (diffHours < 24) {
    return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
  } else if (diffDays === 1) {
    return 'Yesterday';
  } else if (diffDays < 7) {
    return `${diffDays} days ago`;
  } else {
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
  }
}

/**
 * Format number with commas
 */
export function formatNumber(num: number): string {
  return num.toLocaleString();
}
