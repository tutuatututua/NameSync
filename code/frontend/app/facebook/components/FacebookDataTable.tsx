'use client';

import { useState, useEffect, useCallback } from 'react';
import { fetchAllFacebookData, fetchFacebookData, FacebookDataRecord, PaginationInfo } from '../../utils/facebookData';

interface FacebookDataTableProps {
  sessionId: string | null;
  totalRecords: number;
}

export default function FacebookDataTable({ sessionId, totalRecords: _totalRecords }: FacebookDataTableProps) {
  const [data, setData] = useState<FacebookDataRecord[]>([]);
  const [pagination, setPagination] = useState<PaginationInfo>({
    page: 1,
    limit: 20,
    total: 0,
    totalPages: 0
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Default to showing all data when no specific session is selected
  const [showAllData, setShowAllData] = useState(!sessionId);

  const fetchData = useCallback(async (page: number, limit: number, all = false) => {
    setLoading(true);
    setError(null);
    try {
      // "Show All Data" (or no session selected) lists every record; otherwise show
      // just the rows from the active upload session.
      const result = all || !sessionId
        ? await fetchAllFacebookData(page, limit, true)
        : await fetchFacebookData(sessionId, page, limit);
      if (result.success) {
        setData(result.data);
        setPagination(result.pagination);
      } else {
        setError('Failed to fetch data');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  // Load data on mount and when session changes
  useEffect(() => {
    // Show all data by default when no session is selected, otherwise use toggle state
    const shouldFetchAll = !sessionId || showAllData;
    fetchData(1, 20, shouldFetchAll);
  }, [sessionId, showAllData, fetchData]);

  const handlePrevPage = () => {
    if (pagination.page > 1) {
      fetchData(pagination.page - 1, pagination.limit, showAllData);
    }
  };

  const handleNextPage = () => {
    if (pagination.page < pagination.totalPages) {
      fetchData(pagination.page + 1, pagination.limit, showAllData);
    }
  };

  const handleLimitChange = (newLimit: number) => {
    fetchData(1, newLimit, showAllData);
  };

  const toggleShowAll = () => {
    setShowAllData(!showAllData);
  };

  const startItem = pagination.total > 0 ? (pagination.page - 1) * pagination.limit + 1 : 0;
  const endItem = Math.min(pagination.page * pagination.limit, pagination.total);

  return (
    <div className="bg-white rounded-lg border border-slate-200 overflow-hidden" data-testid="facebook-data-table">
      {/* Header */}
      <div className="px-4 py-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h4 className="text-sm font-semibold text-slate-700">
            Merged Facebook Data
          </h4>
          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800">
            <svg className="w-3 h-3 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
            </svg>
            Merged Dataset
          </span>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={toggleShowAll}
            className={`text-xs px-3 py-1 rounded-full transition-colors ${
              showAllData 
                ? 'bg-blue-800 text-white' 
                : 'bg-slate-200 text-slate-700 hover:bg-slate-300'
            }`}
            data-testid="toggle-all-data"
          >
            {showAllData ? 'Show Current Session' : 'Show All Data'}
          </button>
          <span className="text-xs text-slate-500">
            {pagination.total.toLocaleString()} total rows
          </span>
        </div>
      </div>

      {/* Controls */}
      <div className="px-4 py-2 border-b border-slate-200 bg-white flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-600">Show</span>
          <select
            value={pagination.limit}
            onChange={(e) => handleLimitChange(Number(e.target.value))}
            className="px-2 py-1 border border-slate-300 rounded text-xs focus:outline-none focus:ring-2 focus:ring-blue-800"
            data-testid="limit-selector"
          >
            <option value={10}>10</option>
            <option value={20}>20</option>
            <option value={50}>50</option>
            <option value={100}>100</option>
          </select>
          <span className="text-xs text-slate-600">per page</span>
        </div>
        <span className="text-xs text-slate-500">
          Page {pagination.page} of {pagination.totalPages}
        </span>
      </div>

      {/* Table */}
      <div className="overflow-x-auto max-h-[400px] overflow-y-auto">
        {loading ? (
          <div className="p-8 text-center">
            <div className="animate-spin h-8 w-8 border-4 border-blue-800 border-t-transparent rounded-full mx-auto"></div>
            <p className="mt-2 text-sm text-slate-600">Loading...</p>
          </div>
        ) : error ? (
          <div className="p-8 text-center">
            <p className="text-sm text-red-600">{error}</p>
          </div>
        ) : (
          <table className="w-full text-sm text-left">
            <thead className="bg-slate-50 text-xs font-medium text-slate-500 uppercase tracking-wide sticky top-0 z-10">
              <tr>
                <th className="px-4 py-3 border-b border-slate-200 font-mono text-slate-400">uuid</th>
                <th className="px-4 py-3 border-b border-slate-200 font-mono text-slate-400">fb_name</th>
                <th className="px-4 py-3 border-b border-slate-200 font-mono text-slate-400">timestamp</th>
                <th className="px-4 py-3 border-b border-slate-200 font-mono text-slate-400">upload_person_name</th>
                <th className="px-4 py-3 border-b border-slate-200 font-mono text-slate-400">session_id</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {data.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-slate-500">
                    {showAllData 
                      ? 'No Facebook data in the database. Upload a file to get started.'
                      : 'No data for the current session. Switch to "Show All Data" to see all records.'}
                  </td>
                </tr>
              ) : (
                data.map((item, index) => (
                  <tr key={item.uuid || index} className="hover:bg-slate-50 transition-colors">
                    <td className="px-4 py-3 text-slate-400 font-mono text-xs truncate max-w-[100px]" title={item.uuid}>
                      {item.uuid}
                    </td>
                    <td className="px-4 py-3 font-medium text-slate-900 truncate max-w-[150px]" title={item.fb_name || '-'}>
                      {item.fb_name || '-'}
                    </td>
                    <td className="px-4 py-3 text-slate-600 whitespace-nowrap">
                      {item.timestamp ? new Date(item.timestamp).toLocaleString() : '-'}
                    </td>
                    <td className="px-4 py-3 text-slate-600 truncate max-w-[120px]" title={item.upload_person_name || '-'}>
                      {item.upload_person_name || '-'}
                    </td>
                    <td className="px-4 py-3 text-slate-400 font-mono text-xs truncate max-w-[80px]" title={item.session_id || '-'}>
                      {item.session_id ? item.session_id.substring(0, 8) + '...' : '-'}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      {pagination.totalPages > 1 && (
        <div className="px-4 py-3 border-t border-slate-200 flex items-center justify-between bg-white">
          <span className="text-xs text-slate-500">
            {startItem.toLocaleString()}-{endItem.toLocaleString()} of {pagination.total.toLocaleString()}
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={handlePrevPage}
              disabled={pagination.page === 1 || loading}
              className="p-1.5 hover:bg-slate-100 rounded disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              aria-label="Previous page"
              data-testid="prev-page-btn"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <span className="text-xs text-slate-600 px-2">
              Page {pagination.page} of {pagination.totalPages}
            </span>
            <button
              onClick={handleNextPage}
              disabled={pagination.page === pagination.totalPages || loading}
              className="p-1.5 hover:bg-slate-100 rounded disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              aria-label="Next page"
              data-testid="next-page-btn"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7" />
              </svg>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
