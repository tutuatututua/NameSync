import ConfidenceBadge from './ConfidenceBadge';
import StatusBadge from './StatusBadge';

export interface ResultRow {
  companyName: string;
  facebookName: string;
  confidence: number;
  status?: 'new' | 'updated' | 'existing' | 'none';
}

interface ResultsTableProps {
  rows: ResultRow[];
  showStatus?: boolean;
  currentPage?: number;
  totalItems?: number;
  itemsPerPage?: number;
  onPrevPage?: () => void;
  onNextPage?: () => void;
}

export default function ResultsTable({
  rows,
  showStatus = false,
  currentPage = 1,
  totalItems = 0,
  itemsPerPage = 50,
  onPrevPage,
  onNextPage
}: ResultsTableProps) {
  const startItem = (currentPage - 1) * itemsPerPage + 1;
  const endItem = Math.min(currentPage * itemsPerPage, totalItems);
  const hasPrev = currentPage > 1;
  const hasNext = endItem < totalItems;

  return (
    <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
      {(totalItems > 0 || onPrevPage || onNextPage) && (
        <div className="p-4 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="relative max-w-sm">
            {/* Search placeholder for layout consistency */}
          </div>
          {totalItems > 0 && (
            <div className="flex items-center gap-2 text-sm text-slate-600">
              <span>{startItem}-{endItem} of {totalItems.toLocaleString()}</span>
              <div className="flex items-center gap-1 ml-2">
                <button 
                  onClick={onPrevPage}
                  disabled={!hasPrev}
                  className="p-1 hover:bg-slate-100 rounded disabled:opacity-40"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path d="M15 19l-7-7 7-7" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2"></path>
                  </svg>
                </button>
                <button 
                  onClick={onNextPage}
                  disabled={!hasNext}
                  className="p-1 hover:bg-slate-100 rounded disabled:opacity-40"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path d="M9 5l7 7-7 7" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2"></path>
                  </svg>
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm text-left">
          <thead className="bg-slate-50 text-xs font-medium text-slate-500 uppercase tracking-wide sticky top-0">
            <tr>
              <th className="px-6 py-3 border-b border-slate-200 cursor-pointer hover:bg-slate-100">
                <div className="flex items-center gap-1">
                  Company Name
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2"></path>
                  </svg>
                </div>
              </th>
              <th className="px-6 py-3 border-b border-slate-200 cursor-pointer hover:bg-slate-100">
                <div className="flex items-center gap-1">
                  Facebook Name
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2"></path>
                  </svg>
                </div>
              </th>
              <th className="px-6 py-3 border-b border-slate-200 cursor-pointer hover:bg-slate-100">
                <div className="flex items-center gap-1">
                  Confidence
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2"></path>
                  </svg>
                </div>
              </th>
              {showStatus && (
                <th className="px-6 py-3 border-b border-slate-200">Status</th>
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200">
            {rows.map((row, index) => (
              <tr key={`${row.companyName}-${row.facebookName}-${row.confidence}-${index}`} className="hover:bg-slate-50 transition-colors">
                <td className="px-6 py-3 font-medium text-slate-900">{row.companyName}</td>
                <td className="px-6 py-3 text-slate-600">{row.facebookName}</td>
                <td className="px-6 py-3">
                  <ConfidenceBadge score={row.confidence} />
                </td>
                {showStatus && (
                  <td className="px-6 py-3">
                    <StatusBadge status={row.status || 'none'} />
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
