import Button from './Button';

interface ProgressCardProps {
  title: string;
  subtitle: string;
  current: number;
  total: number;
  percent: number;
  onCancel?: () => void;
}

export default function ProgressCard({
  title,
  subtitle,
  current,
  total,
  percent,
  onCancel
}: ProgressCardProps) {
  return (
    <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-10 max-w-md w-full text-center">
      <div className="relative w-16 h-16 mx-auto mb-6">
        <div className="absolute inset-0 rounded-full border-4 border-slate-100"></div>
        <div className="absolute inset-0 rounded-full border-4 border-blue-800 border-t-transparent animate-spin"></div>
      </div>
      <h2 className="text-lg font-semibold text-slate-900 mb-2">{title}</h2>
      <p className="text-sm text-slate-500 mb-6">{subtitle}</p>
      <div className="mb-4">
        <div className="flex justify-between text-sm mb-2">
          <span className="font-medium text-slate-700">Processing</span>
          <span className="text-slate-500">{current.toLocaleString()} / {total.toLocaleString()} rows</span>
        </div>
        <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
          <div 
            className="h-full bg-blue-800 rounded-full transition-all duration-300" 
            style={{ width: `${percent}%` }}
          ></div>
        </div>
        <p className="text-xs text-slate-400 mt-2">{percent}% complete</p>
      </div>
      {onCancel && (
        <button 
          onClick={onCancel}
          className="text-sm text-slate-500 hover:text-red-600 transition-colors underline"
        >
          Cancel comparison
        </button>
      )}
    </div>
  );
}
