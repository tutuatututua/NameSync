'use client';

import { useState } from 'react';
import Button from './Button';

interface SaveSessionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (name: string) => void;
  rowCount: number;
  defaultName?: string;
}

export default function SaveSessionModal({
  isOpen,
  onClose,
  onSave,
  rowCount,
  defaultName = ''
}: SaveSessionModalProps) {
  const [sessionName, setSessionName] = useState(defaultName);

  if (!isOpen) return null;

  const handleSave = () => {
    if (sessionName.trim()) {
      onSave(sessionName.trim());
      setSessionName('');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-xl shadow-xl max-w-md w-full mx-4 p-6">
        <h3 className="text-lg font-semibold text-slate-900 mb-2">Save to History</h3>
        <p className="text-sm text-slate-500 mb-4">Give this comparison a name so you can find it later.</p>
        <div className="mb-6">
          <label className="block text-sm font-medium text-slate-700 mb-2">Session name</label>
          <input
            type="text"
            value={sessionName}
            onChange={(e) => setSessionName(e.target.value)}
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-800 focus:border-transparent"
            placeholder="e.g., Q4 Sales Contacts"
          />
          <p className="text-xs text-slate-400 mt-1">{rowCount.toLocaleString()} rows will be saved</p>
        </div>
        <div className="flex gap-3 justify-end">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSave} disabled={!sessionName.trim()}>
            Save Session
          </Button>
        </div>
      </div>
    </div>
  );
}
