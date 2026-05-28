interface SearchInputProps {
  placeholder?: string;
  value?: string;
  onChange?: (value: string) => void;
  className?: string;
  'data-testid'?: string;
}

export default function SearchInput({
  placeholder = 'Search...',
  value,
  onChange,
  className = '',
  'data-testid': dataTestId
}: SearchInputProps) {
  return (
    <div className={`relative ${className}`}>
      <svg className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2"></path>
      </svg>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
        className="pl-9 pr-4 py-2.5 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-800 focus:border-transparent w-full bg-white"
        placeholder={placeholder}
        data-testid={dataTestId}
      />
    </div>
  );
}
