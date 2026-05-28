interface FileCardProps {
  fileName: string;
  fileSize: string;
  rowsDetected?: string;
  status: 'valid' | 'invalid' | 'error';
  statusLabel: string;
  errorMessage?: string;
  onRemove?: () => void;
  'data-testid'?: string;
}

export default function FileCard({
  fileName,
  fileSize,
  rowsDetected,
  status,
  statusLabel,
  errorMessage,
  onRemove,
  'data-testid': dataTestId
}: FileCardProps) {
  const isValid = status === 'valid';
  const borderColor = isValid ? 'border-blue-800' : 'border-red-400';
  const iconBg = isValid ? 'bg-blue-100' : 'bg-red-100';
  const iconColor = isValid ? 'text-blue-700' : 'text-red-600';
  const statusBg = isValid ? 'bg-green-100' : 'bg-red-100';
  const statusText = isValid ? 'text-green-700' : 'text-red-700';

  return (
    <div className={`bg-white rounded-lg border-2 ${borderColor} p-6`} data-testid={dataTestId}>
      <div className="flex items-start gap-4">
        <div className={`w-12 h-12 rounded-lg ${iconBg} flex items-center justify-center flex-shrink-0`}>
          {isValid ? (
            <svg className={`w-6 h-6 ${iconColor}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2"></path>
            </svg>
          ) : (
            <svg className={`w-6 h-6 ${iconColor}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2"></path>
            </svg>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-slate-900 mb-1 truncate">{fileName}</h3>
          <p className="text-xs text-slate-500 mb-2">
            {fileSize}{rowsDetected ? ` • ${rowsDetected}` : ''}
          </p>
          <div className="flex items-center gap-3">
            <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${statusBg} ${statusText}`}>
              {statusLabel}
            </span>
            {onRemove && (
              <button 
                onClick={onRemove}
                className="text-xs text-slate-500 hover:text-red-600 underline"
              >
                Remove file
              </button>
            )}
          </div>
          {errorMessage && (
            <p className="text-xs text-red-600 mt-2">{errorMessage}</p>
          )}
        </div>
      </div>
    </div>
  );
}
