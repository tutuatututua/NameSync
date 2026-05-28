interface ConfidenceChartProps {
  data: number[];
  labels?: string[];
}

export default function ConfidenceChart({ 
  data, 
  labels = ['0.0', '0.1', '0.2', '0.3', '0.4', '0.5', '0.6', '0.7', '0.8', '0.9']
}: ConfidenceChartProps) {
  const getColor = (index: number) => {
    if (index < 2) return 'bg-red-400';
    if (index < 6) return 'bg-amber-400';
    if (index < 8) return 'bg-lime-500';
    return 'bg-emerald-500';
  };

  // Scale bars to the real max. Use reduce (not spread) to avoid a stack overflow
  // on large arrays, and avoid a fixed floor so small distributions aren't flattened.
  const maxValue = data.reduce((max, v) => (v > max ? v : max), 0) || 1;

  return (
    <div className="bg-white rounded-lg border border-slate-200 p-6 mb-8">
      <h2 className="text-sm font-semibold text-slate-900 mb-6">Confidence Distribution</h2>
      <div className="flex items-end gap-1 h-40">
        {data.map((value, index) => (
          <div key={index} className="flex-1 flex flex-col items-center gap-2 group">
            <div 
              className={`w-full rounded-t transition-all group-hover:opacity-80 ${getColor(index)}`}
              style={{ height: `${(value / maxValue) * 100}%` }}
            ></div>
            <span className="text-xs text-slate-400">{labels[index]}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
