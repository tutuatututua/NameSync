import { ReactNode } from 'react';
import Button from './Button';

interface EmptyStateProps {
  icon: ReactNode;
  title: string;
  description: string;
  action?: {
    label: string;
    href?: string;
    onClick?: () => void;
  };
  'data-testid'?: string;
}

export default function EmptyState({
  icon,
  title,
  description,
  action,
  'data-testid': dataTestId
}: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center text-center max-w-md mx-auto py-16" data-testid={dataTestId}>
      <div className="w-16 h-16 rounded-full bg-slate-100 flex items-center justify-center mb-6">
        <div className="w-8 h-8 text-slate-400">
          {icon}
        </div>
      </div>
      <h2 className="text-xl font-semibold text-slate-900 mb-2">{title}</h2>
      <p className="text-sm text-slate-500 mb-6">{description}</p>
      {action && (
        action.href ? (
          <Button href={action.href}>{action.label}</Button>
        ) : (
          <Button onClick={action.onClick}>{action.label}</Button>
        )
      )}
    </div>
  );
}
