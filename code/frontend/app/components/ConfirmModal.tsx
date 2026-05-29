import { ReactNode } from 'react';
import Button from './Button';

interface ConfirmModalProps {
  isOpen: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  isProcessing?: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

export default function ConfirmModal({
  isOpen,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  isProcessing = false,
  onClose,
  onConfirm
}: ConfirmModalProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/95 p-4" data-testid="confirm-modal">
      <div className="bg-white rounded-xl shadow-xl max-w-sm w-full mx-4 p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center flex-shrink-0">
            <svg className="w-5 h-5 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2"></path>
            </svg>
          </div>
          <h3 className="text-lg font-semibold text-slate-900" data-testid="confirm-modal-title">{title}</h3>
        </div>
        <div className="text-sm text-slate-600 mb-6" data-testid="confirm-modal-message">
          {message}
        </div>
        <div className="flex gap-3 justify-end">
          <Button variant="ghost" onClick={onClose} disabled={isProcessing}>{cancelLabel}</Button>
          <Button
            variant="danger"
            onClick={onConfirm}
            isLoading={isProcessing}
            disabled={isProcessing}
            data-testid="confirm-modal-confirm-btn"
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
