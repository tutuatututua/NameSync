import Button from './Button';

interface DeleteConfirmModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  sessionName: string;
  rowCount: number;
  isDeleting?: boolean;
}

export default function DeleteConfirmModal({
  isOpen,
  onClose,
  onConfirm,
  sessionName,
  rowCount,
  isDeleting = false
}: DeleteConfirmModalProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/95 p-4" data-testid="delete-confirm-modal">
      <div className="bg-white rounded-xl shadow-xl max-w-sm w-full mx-4 p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center flex-shrink-0">
            <svg className="w-5 h-5 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2"></path>
            </svg>
          </div>
          <h3 className="text-lg font-semibold text-slate-900" data-testid="delete-modal-title">Delete Session</h3>
        </div>
        <p className="text-sm text-slate-600 mb-2" data-testid="delete-confirm-message">
          Are you sure you want to delete <span className="font-medium text-slate-900" data-testid="delete-modal-session-name">&quot;{sessionName}&quot;</span>?
        </p>
        <p className="text-xs text-slate-500 mb-6">
          This action cannot be undone. {rowCount.toLocaleString()} rows will be permanently removed.
        </p>
        <div className="flex gap-3 justify-end">
          <Button variant="ghost" onClick={onClose} disabled={isDeleting}>Cancel</Button>
          <Button variant="danger" onClick={onConfirm} isLoading={isDeleting} disabled={isDeleting} data-testid="confirm-delete-btn">Delete Session</Button>
        </div>
      </div>
    </div>
  );
}
