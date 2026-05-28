'use client';

import { UploadHistoryRecord } from '../../utils/facebookData';
import { formatRelativeTime, formatNumber } from '../../utils/facebookData';

interface FacebookUploadHistoryProps {
  history: UploadHistoryRecord[];
  onRefresh: () => void;
}

export default function FacebookUploadHistory({ history, onRefresh }: FacebookUploadHistoryProps) {
  if (history.length === 0) {
    return (
      <div className="bg-white rounded-lg border border-slate-200 p-6" data-testid="facebook-upload-history">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-slate-900">
            Upload History
          </h3>
          <button
            onClick={onRefresh}
            className="text-xs text-blue-800 hover:text-blue-900 flex items-center gap-1"
            data-testid="refresh-history"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            Refresh
          </button>
        </div>
        <div className="text-center py-8 text-slate-500">
          <svg className="w-12 h-12 mx-auto mb-3 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <p className="text-sm">No upload history yet</p>
          <p className="text-xs text-slate-400 mt-1">Upload your first Facebook JSON file</p>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg border border-slate-200 overflow-hidden" data-testid="facebook-upload-history">
      <div className="px-4 py-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-700">
          Upload History
        </h3>
        <button
          onClick={onRefresh}
          className="text-xs text-blue-800 hover:text-blue-900 flex items-center gap-1"
          data-testid="refresh-history"
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          Refresh
        </button>
      </div>

      <div className="max-h-[300px] overflow-y-auto">
        <table className="w-full text-sm text-left">
          <thead className="bg-slate-50 text-xs font-medium text-slate-500 uppercase tracking-wide sticky top-0 z-10">
            <tr>
              <th className="px-3 py-2 border-b border-slate-200">User</th>
              <th className="px-3 py-2 border-b border-slate-200 text-right">Rows</th>
              <th className="px-3 py-2 border-b border-slate-200 text-right">Dup</th>
              <th className="px-3 py-2 border-b border-slate-200">Time</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200">
            {history.map((item) => (
              <tr key={item.id} className="hover:bg-slate-50 transition-colors">
                <td className="px-3 py-2">
                  <span className="font-medium text-slate-900 text-xs truncate max-w-[80px] block" title={item.user_upload}>
                    {item.user_upload}
                  </span>
                </td>
                <td className="px-3 py-2 text-right text-slate-600 text-xs">
                  {formatNumber(item.rows_processed)}
                </td>
                <td className="px-3 py-2 text-right">
                  {item.duplicate_rows > 0 ? (
                    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-800">
                      {formatNumber(item.duplicate_rows)}
                    </span>
                  ) : (
                    <span className="text-slate-400 text-xs">-</span>
                  )}
                </td>
                <td className="px-3 py-2 text-slate-500 text-xs whitespace-nowrap">
                  {formatRelativeTime(item.timestamp)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="px-3 py-2 border-t border-slate-200 bg-slate-50">
        <p className="text-xs text-slate-500 text-center">
          Showing last {history.length} uploads
        </p>
      </div>
    </div>
  );
}
