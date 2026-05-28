interface StatusBadgeProps {
  status: 'new' | 'updated' | 'existing' | 'none';
}

export default function StatusBadge({ status }: StatusBadgeProps) {
  if (status === 'none') {
    return <span className="text-xs text-slate-400">—</span>;
  }

  const styles = {
    new: 'bg-blue-100 text-blue-700',
    updated: 'bg-purple-100 text-purple-700',
    existing: 'bg-slate-100 text-slate-600'
  };

  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${styles[status]}`}>
      {status}
    </span>
  );
}
