'use client';

import { useState, useEffect, useCallback } from 'react';
import { fetchAllCompanyData, fetchCompanyData, deleteCompanyRecord, CompanyDataRecord, PaginationInfo } from '../../utils/fileParser';
import { ConfirmModal } from '../../components';

interface CompanyDataTableProps {
  sessionId: string | null;
  // Bump this to force a refetch (e.g. after "Clear All" on the parent page).
  reloadToken?: number;
  // Called after the table's data changes (row delete) so the parent can refresh counts.
  onDataChanged?: () => void;
}

export default function CompanyDataTable({ sessionId, reloadToken = 0, onDataChanged }: CompanyDataTableProps) {
  const [data, setData] = useState<CompanyDataRecord[]>([]);
  const [pagination, setPagination] = useState<PaginationInfo>({
    page: 1,
    limit: 20,
    total: 0,
    totalPages: 0
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rowToDelete, setRowToDelete] = useState<CompanyDataRecord | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  // Default to showing all data when no specific session is selected
  const [showAllData, setShowAllData] = useState(!sessionId);

  const fetchData = useCallback(async (page: number, limit: number, all = false) => {
    setLoading(true);
    setError(null);
    try {
      // "Show All Data" (or no session selected) lists every record; otherwise show
      // just the rows from the active upload session.
      const result = all || !sessionId
        ? await fetchAllCompanyData(page, limit)
        : await fetchCompanyData(sessionId, page, limit);
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

  // Load data on mount, when session changes, and when the parent forces a reload.
  useEffect(() => {
    // Show all data by default when no session is selected, otherwise use toggle state
    const shouldFetchAll = !sessionId || showAllData;
    fetchData(1, 20, shouldFetchAll);
  }, [sessionId, showAllData, fetchData, reloadToken]);

  const handleConfirmDelete = async () => {
    if (!rowToDelete) return;
    setIsDeleting(true);
    setError(null);
    try {
      await deleteCompanyRecord(rowToDelete.uuid);
      // If we just removed the only row on a non-first page, step back a page.
      const targetPage = data.length === 1 && pagination.page > 1 ? pagination.page - 1 : pagination.page;
      setRowToDelete(null);
      await fetchData(targetPage, pagination.limit, showAllData);
      onDataChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete record');
    } finally {
      setIsDeleting(false);
    }
  };

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
    <div className="bg-white rounded-lg border border-slate-200 overflow-hidden" data-testid="company-data-table">
      {/* Header */}
      <div className="px-4 py-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h4 className="text-sm font-semibold text-slate-700">
            Merged Company Data
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
                <th className="px-4 py-3 border-b border-slate-200 font-mono text-slate-400">company_name</th>
                <th className="px-4 py-3 border-b border-slate-200 font-mono text-slate-400">person_name_th</th>
                <th className="px-4 py-3 border-b border-slate-200 font-mono text-slate-400">person_name_en</th>
                <th className="px-4 py-3 border-b border-slate-200 font-mono text-slate-400">session_id</th>
                <th className="px-4 py-3 border-b border-slate-200 text-right">actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {data.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-slate-500">
                    {showAllData
                      ? 'No company data in the database. Upload a file to get started.'
                      : 'No data for the current session. Switch to "Show All Data" to see all records.'}
                  </td>
                </tr>
              ) : (
                data.map((item, index) => (
                  <tr key={item.uuid || index} className="hover:bg-slate-50 transition-colors">
                    <td className="px-4 py-3 text-slate-400 font-mono text-xs truncate max-w-[100px]" title={item.uuid}>
                      {item.uuid}
                    </td>
                    <td className="px-4 py-3 font-medium text-slate-900 truncate max-w-[150px]" title={item.company_name || '-'}>
                      {item.company_name || '-'}
                    </td>
                    <td className="px-4 py-3 text-slate-600 truncate max-w-[150px]" title={item.person_name_th || '-'}>
                      {item.person_name_th || '-'}
                    </td>
                    <td className="px-4 py-3 text-slate-600 truncate max-w-[150px]" title={item.person_name_en || '-'}>
                      {item.person_name_en || '-'}
                    </td>
                    <td className="px-4 py-3 text-slate-400 font-mono text-xs truncate max-w-[80px]" title={item.session_id || '-'}>
                      {item.session_id ? item.session_id.substring(0, 8) + '...' : '-'}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => setRowToDelete(item)}
                        className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
                        aria-label="Delete row"
                        title="Delete row"
                        data-testid="delete-row-btn"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
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

      <ConfirmModal
        isOpen={!!rowToDelete}
        title="Delete row"
        message={
          <>
            Delete this company record
            {rowToDelete?.company_name ? <> for <span className="font-medium text-slate-900">&quot;{rowToDelete.company_name}&quot;</span></> : null}?
            This action cannot be undone.
          </>
        }
        confirmLabel="Delete"
        isProcessing={isDeleting}
        onClose={() => setRowToDelete(null)}
        onConfirm={handleConfirmDelete}
      />
    </div>
  );
}
