import { ReactNode, useState, DragEvent } from 'react';

interface UploadDropzoneProps {
  title: string;
  description: string;
  fileType: string;
  icon: ReactNode;
  onClick?: () => void;
  // Called with the first dropped file when the user drags a file onto the zone.
  onFileDrop?: (file: File) => void;
  isActive?: boolean;
  'data-testid'?: string;
}

export default function UploadDropzone({
  title,
  description,
  fileType,
  icon,
  onClick,
  onFileDrop,
  isActive = false,
  'data-testid': dataTestId
}: UploadDropzoneProps) {
  const [isDragging, setIsDragging] = useState(false);

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!onFileDrop) return;
    e.preventDefault();
    if (!isDragging) setIsDragging(true);
  };

  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    if (!onFileDrop) return;
    e.preventDefault();
    // Ignore leave events fired while moving onto a child element; only clear the
    // highlight when the pointer actually exits the dropzone.
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setIsDragging(false);
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    if (!onFileDrop) return;
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) onFileDrop(file);
  };

  const active = isActive || isDragging;

  return (
    <div
      onClick={onClick}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      data-testid={dataTestId}
      className={`bg-white rounded-lg border-2 border-dashed p-8 text-center transition-all cursor-pointer group ${
        active
          ? 'border-blue-800 bg-blue-50/30'
          : 'border-slate-300 hover:border-blue-800 hover:bg-blue-50/30'
      }`}
    >
      <div className={`w-14 h-14 mx-auto mb-4 rounded-lg flex items-center justify-center transition-colors ${
        active ? 'bg-blue-100' : 'bg-slate-100 group-hover:bg-blue-100'
      }`}>
        <div className={`transition-colors ${active ? 'text-blue-700' : 'text-slate-500 group-hover:text-blue-700'}`}>
          {icon}
        </div>
      </div>
      <h3 className="text-sm font-semibold text-slate-900 mb-1">{title}</h3>
      <p className="text-sm text-slate-500 mb-3">{description}</p>
      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-600">
        {fileType}
      </span>
    </div>
  );
}
