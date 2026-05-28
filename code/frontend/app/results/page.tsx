'use client';

import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Navbar,
  PageContainer,
  MainContent,
  PageHeader,
  Button,
  SaveSessionModal
} from '../components';
import { API_BASE_URL } from '../utils/config';

interface CompanyDataRecord {
  uuid: string;
  company_name: string | null;
  person_name_th: string | null;
  person_name_en: string | null;
  status: string | null;
  session_id: string;
}

interface FacebookDataRecord {
  uuid: string;
  fb_name: string | null;
  timestamp: string | null;
  upload_person_name: string | null;
  session_id: string;
}

interface PaginationInfo {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

function ResultsContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const sessionId = searchParams.get('sessionId');

  const [showSaveModal, setShowSaveModal] = useState(false);
  const [activeTab, setActiveTab] = useState<'company' | 'facebook'>('company');
  
  // Company data state
  const [companyData, setCompanyData] = useState<CompanyDataRecord[]>([]);
  const [companyPagination, setCompanyPagination] = useState<PaginationInfo>({
    page: 1,
    limit: 20,
    total: 0,
    totalPages: 0
  });
  const [companyLoading, setCompanyLoading] = useState(false);

  // Facebook data state
  const [facebookData, setFacebookData] = useState<FacebookDataRecord[]>([]);
  const [facebookPagination, setFacebookPagination] = useState<PaginationInfo>({
    page: 1,
    limit: 20,
    total: 0,
    totalPages: 0
  });
  const [facebookLoading, setFacebookLoading] = useState(false);

  // Fetch company data
  const fetchCompanyData = async (page: number, limit: number) => {
    if (!sessionId) return;
    setCompanyLoading(true);
    try {
      const response = await fetch(
        `${API_BASE_URL}/comparisons/${sessionId}/company-data?page=${page}&limit=${limit}`
      );
      if (!response.ok) {
        console.error('Error fetching company data:', response.status);
        return;
      }
      const data = await response.json();
      if (data.success) {
        setCompanyData(data.data);
        setCompanyPagination(data.pagination);
      }
    } catch (error) {
      console.error('Error fetching company data:', error);
    } finally {
      setCompanyLoading(false);
    }
  };

  // Fetch facebook data
  const fetchFacebookData = async (page: number, limit: number) => {
    if (!sessionId) return;
    setFacebookLoading(true);
    try {
      const response = await fetch(
        `${API_BASE_URL}/comparisons/${sessionId}/facebook-data?page=${page}&limit=${limit}`
      );
      if (!response.ok) {
        console.error('Error fetching facebook data:', response.status);
        return;
      }
      const data = await response.json();
      if (data.success) {
        setFacebookData(data.data);
        setFacebookPagination(data.pagination);
      }
    } catch (error) {
      console.error('Error fetching facebook data:', error);
    } finally {
      setFacebookLoading(false);
    }
  };

  // Initial fetch
  useEffect(() => {
    if (sessionId) {
      fetchCompanyData(1, 20);
      fetchFacebookData(1, 20);
    }
  }, [sessionId]);

  // Handle page change
  const handlePageChange = (newPage: number) => {
    if (activeTab === 'company') {
      fetchCompanyData(newPage, companyPagination.limit);
    } else {
      fetchFacebookData(newPage, facebookPagination.limit);
    }
  };

  // Handle limit change
  const handleLimitChange = (newLimit: number) => {
    if (activeTab === 'company') {
      fetchCompanyData(1, newLimit);
    } else {
      fetchFacebookData(1, newLimit);
    }
  };

  const currentPagination = activeTab === 'company' ? companyPagination : facebookPagination;
  const currentData = activeTab === 'company' ? companyData : facebookData;
  const isLoading = activeTab === 'company' ? companyLoading : facebookLoading;

  const downloadCSV = () => {
    if (currentData.length === 0) return;

    const escape = (value: unknown): string => {
      const str = value === null || value === undefined ? '' : String(value);
      return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
    };

    let headers: string[];
    let rows: string[][];
    if (activeTab === 'company') {
      headers = ['Company Name', 'Person Name (TH)', 'Person Name (EN)', 'Status'];
      rows = (currentData as CompanyDataRecord[]).map((r) => [
        escape(r.company_name), escape(r.person_name_th), escape(r.person_name_en), escape(r.status)
      ]);
    } else {
      headers = ['Facebook Name', 'Timestamp', 'Upload Person'];
      rows = (currentData as FacebookDataRecord[]).map((r) => [
        escape(r.fb_name), escape(r.timestamp), escape(r.upload_person_name)
      ]);
    }

    const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${activeTab}-data-${sessionId}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  if (!sessionId) {
    return (
      <PageContainer>
        <Navbar />
        <MainContent size="default" className="py-12">
          <div className="text-center">
            <p className="text-slate-600">No session ID provided</p>
            <Button onClick={() => router.push('/')} className="mt-4">
              Go Back
            </Button>
          </div>
        </MainContent>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <Navbar />
      <MainContent size="wide">
        <PageHeader
          title="Upload Results"
          subtitle="View uploaded Company Data and Facebook Data"
          actions={
            <>
              <Button variant="secondary" onClick={downloadCSV}>Download CSV</Button>
              <Button onClick={() => setShowSaveModal(true)}>Save to History</Button>
            </>
          }
        />

        {/* Stats summary */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          <div className="bg-white rounded-lg border border-slate-200 p-4">
            <div className="text-sm text-slate-600">Company Records</div>
            <div className="text-2xl font-semibold text-slate-900">{companyPagination.total.toLocaleString()}</div>
          </div>
          <div className="bg-white rounded-lg border border-slate-200 p-4">
            <div className="text-sm text-slate-600">Facebook Records</div>
            <div className="text-2xl font-semibold text-slate-900">{facebookPagination.total.toLocaleString()}</div>
          </div>
          <div className="bg-white rounded-lg border border-slate-200 p-4">
            <div className="text-sm text-slate-600">Session ID</div>
            <div className="text-sm font-medium text-slate-900 truncate">{sessionId}</div>
          </div>
        </div>

        {/* Tab buttons */}
        <div className="flex gap-2 mb-4">
          <button
            onClick={() => setActiveTab('company')}
            className={`px-4 py-2 rounded-lg font-medium transition-colors ${
              activeTab === 'company'
                ? 'bg-blue-800 text-white'
                : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            }`}
          >
            Company Data ({companyPagination.total.toLocaleString()})
          </button>
          <button
            onClick={() => setActiveTab('facebook')}
            className={`px-4 py-2 rounded-lg font-medium transition-colors ${
              activeTab === 'facebook'
                ? 'bg-blue-800 text-white'
                : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            }`}
          >
            Facebook Data ({facebookPagination.total.toLocaleString()})
          </button>
        </div>

        {/* Limit selector */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <span className="text-sm text-slate-600">Show</span>
            <select
              value={currentPagination.limit}
              onChange={(e) => handleLimitChange(Number(e.target.value))}
              className="px-3 py-1.5 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-800"
            >
              <option value={20}>20</option>
              <option value={100}>100</option>
              <option value={1000}>1000</option>
            </select>
            <span className="text-sm text-slate-600">per page</span>
          </div>
          <div className="text-sm text-slate-600">
            Page {currentPagination.page} of {currentPagination.totalPages}
            {' '}({currentPagination.total.toLocaleString()} total)
          </div>
        </div>

        {/* Data table */}
        <div className="bg-white rounded-lg border border-slate-200 overflow-hidden mb-4">
          {isLoading ? (
            <div className="p-8 text-center">
              <div className="animate-spin h-8 w-8 border-4 border-blue-800 border-t-transparent rounded-full mx-auto"></div>
              <p className="mt-2 text-slate-600">Loading...</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead className="bg-slate-50 text-xs font-medium text-slate-500 uppercase tracking-wide sticky top-0">
                  <tr>
                    {activeTab === 'company' ? (
                      <>
                        <th className="px-6 py-3 border-b border-slate-200">Company Name</th>
                        <th className="px-6 py-3 border-b border-slate-200">Person Name (TH)</th>
                        <th className="px-6 py-3 border-b border-slate-200">Person Name (EN)</th>
                        <th className="px-6 py-3 border-b border-slate-200">Status</th>
                      </>
                    ) : (
                      <>
                        <th className="px-6 py-3 border-b border-slate-200">Facebook Name</th>
                        <th className="px-6 py-3 border-b border-slate-200">Timestamp</th>
                        <th className="px-6 py-3 border-b border-slate-200">Upload Person</th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {currentData.length === 0 ? (
                    <tr>
                      <td colSpan={activeTab === 'company' ? 4 : 3} className="px-6 py-8 text-center text-slate-600">
                        No data available
                      </td>
                    </tr>
                  ) : (
                    currentData.map((record) => (
                      <tr key={record.uuid} className="hover:bg-slate-50 transition-colors">
                        {activeTab === 'company' ? (
                          <>
                            <td className="px-6 py-3 font-medium text-slate-900">
                              {(record as CompanyDataRecord).company_name || '-'}
                            </td>
                            <td className="px-6 py-3 text-slate-600">
                              {(record as CompanyDataRecord).person_name_th || '-'}
                            </td>
                            <td className="px-6 py-3 text-slate-600">
                              {(record as CompanyDataRecord).person_name_en || '-'}
                            </td>
                            <td className="px-6 py-3">
                              <span className={`inline-flex px-2 py-1 text-xs font-medium rounded-full ${
                                (record as CompanyDataRecord).status === 'active'
                                  ? 'bg-green-100 text-green-700'
                                  : 'bg-slate-100 text-slate-600'
                              }`}>
                                {(record as CompanyDataRecord).status || 'N/A'}
                              </span>
                            </td>
                          </>
                        ) : (
                          <>
                            <td className="px-6 py-3 font-medium text-slate-900">
                              {(record as FacebookDataRecord).fb_name || '-'}
                            </td>
                            <td className="px-6 py-3 text-slate-600">
                              {(record as FacebookDataRecord).timestamp 
                                ? new Date((record as FacebookDataRecord).timestamp!).toLocaleString()
                                : '-'
                              }
                            </td>
                            <td className="px-6 py-3 text-slate-600">
                              {(record as FacebookDataRecord).upload_person_name || '-'}
                            </td>
                          </>
                        )}
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Pagination controls */}
        <div className="flex items-center justify-center gap-4">
          <button
            onClick={() => handlePageChange(currentPagination.page - 1)}
            disabled={currentPagination.page <= 1}
            className="px-4 py-2 bg-slate-100 text-slate-600 rounded-lg hover:bg-slate-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Previous
          </button>
          <div className="flex items-center gap-1">
            {Array.from({ length: Math.min(5, currentPagination.totalPages) }, (_, i) => {
              const pageNum = i + 1;
              return (
                <button
                  key={pageNum}
                  onClick={() => handlePageChange(pageNum)}
                  className={`w-8 h-8 rounded-lg text-sm font-medium transition-colors ${
                    currentPagination.page === pageNum
                      ? 'bg-blue-800 text-white'
                      : 'text-slate-600 hover:bg-slate-100'
                  }`}
                >
                  {pageNum}
                </button>
              );
            })}
            {currentPagination.totalPages > 5 && (
              <span className="px-2 text-slate-400">...</span>
            )}
          </div>
          <button
            onClick={() => handlePageChange(currentPagination.page + 1)}
            disabled={currentPagination.page >= currentPagination.totalPages}
            className="px-4 py-2 bg-slate-100 text-slate-600 rounded-lg hover:bg-slate-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Next
          </button>
        </div>
      </MainContent>

      <SaveSessionModal
        isOpen={showSaveModal}
        onClose={() => setShowSaveModal(false)}
        onSave={(name) => {
          console.log('Saving session:', name);
          setShowSaveModal(false);
        }}
        rowCount={companyPagination.total + facebookPagination.total}
      />
    </PageContainer>
  );
}

export default function ResultsPage() {
  return (
    <Suspense fallback={
      <PageContainer>
        <Navbar />
        <MainContent>
          <div className="flex items-center justify-center py-12">
            <div className="animate-spin h-8 w-8 border-4 border-blue-800 border-t-transparent rounded-full"></div>
          </div>
        </MainContent>
      </PageContainer>
    }>
      <ResultsContent />
    </Suspense>
  );
}
