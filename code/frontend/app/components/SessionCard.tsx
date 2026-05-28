import { getConfidenceTier } from '../utils/confidence';

interface SessionCardProps {
  title: string;
  date: string;
  rowCount: number;
  averageConfidence: number;
  onClick?: () => void;
  'data-testid'?: string;
}

export default function SessionCard({
  title,
  date,
  rowCount,
  averageConfidence,
  onClick,
  'data-testid': dataTestId
}: SessionCardProps) {
  const getConfidenceColor = (score: number) => {
    const tier = getConfidenceTier(score);
    if (tier === 'high' || tier === 'good') return 'bg-emerald-500';
    if (tier === 'medium') return 'bg-amber-500';
    return 'bg-red-500';
  };

  return (
    <div
      onClick={onClick}
      className="bg-white rounded-lg border border-slate-200 p-5 hover:shadow-md hover:border-slate-300 transition-all cursor-pointer group"
      data-testid={dataTestId}
    >
      <div className="flex items-start justify-between mb-3">
        <h3 className="font-medium text-slate-900 group-hover:text-blue-800 transition-colors">{title}</h3>
        <div 
          className={`w-2.5 h-2.5 rounded-full ${getConfidenceColor(averageConfidence)}`}
          title={`Mean confidence: ${averageConfidence.toFixed(2)}`}
        ></div>
      </div>
      <p className="text-xs text-slate-500 mb-4">{date}</p>
      <div className="flex items-center justify-between text-sm">
        <span className="text-slate-600">
          <span className="font-medium text-slate-900">{rowCount.toLocaleString()}</span> rows
        </span>
        <span className="text-slate-600">
          Avg: <span className="font-medium text-slate-900">{averageConfidence.toFixed(2)}</span>
        </span>
      </div>
    </div>
  );
}
