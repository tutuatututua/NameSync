import { API_BASE_URL } from './config';

// Database schema types (matching SQLite tables)
export interface CompanyDataRecord {
  uuid: string;
  company_name: string | null;
  person_name_th: string | null;
  person_name_en: string | null;
  status: string | null;
  session_id: string | null;
}

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

export interface PaginatedCompanyDataResponse {
  success: boolean;
  data: CompanyDataRecord[];
  pagination: PaginationInfo;
}

export interface PaginatedFacebookDataResponse {
  success: boolean;
  data: FacebookDataRecord[];
  pagination: PaginationInfo;
}

/**
 * Fetch paginated company data for a session
 */
export async function fetchCompanyData(
  sessionId: string,
  page: number = 1,
  limit: number = 20
): Promise<PaginatedCompanyDataResponse> {
  const response = await fetch(
    `${API_BASE_URL}/comparisons/${sessionId}/company-data?page=${page}&limit=${limit}`
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch company data: ${response.statusText}`);
  }

  return response.json();
}

/**
 * Fetch all company data across all sessions
 */
export async function fetchAllCompanyData(
  page: number = 1,
  limit: number = 20
): Promise<PaginatedCompanyDataResponse> {
  const response = await fetch(
    `${API_BASE_URL}/comparisons/company-data/all?page=${page}&limit=${limit}`
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch company data: ${response.statusText}`);
  }

  return response.json();
}
