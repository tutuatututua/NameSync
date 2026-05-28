import { ReactNode } from 'react';

interface UploadDropzoneProps {
  title: string;
  description: string;
  fileType: string;
  icon: ReactNode;
  onClick?: () => void;
  isActive?: boolean;
}

export default function UploadDropzone({
  title,
  description,
  fileType,
  icon,
  onClick,
  isActive = false
}: UploadDropzoneProps) {
  return (
    <div
      onClick={onClick}
      className={`bg-white rounded-lg border-2 border-dashed p-8 text-center transition-all cursor-pointer group ${
        isActive
          ? 'border-blue-800 bg-blue-50/30'
          : 'border-slate-300 hover:border-blue-800 hover:bg-blue-50/30'
      }`}
    >
      <div className={`w-14 h-14 mx-auto mb-4 rounded-lg flex items-center justify-center transition-colors ${
        isActive ? 'bg-blue-100' : 'bg-slate-100 group-hover:bg-blue-100'
      }`}>
        <div className={`transition-colors ${isActive ? 'text-blue-700' : 'text-slate-500 group-hover:text-blue-700'}`}>
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
