import { ReactNode } from 'react';

interface AlertProps {
  variant: 'success' | 'info' | 'warning' | 'error';
  children: ReactNode;
  onDismiss?: () => void;
  className?: string;
  'data-testid'?: string;
  action?: {
    label: string;
    href?: string;
    onClick?: () => void;
  };
}

export default function Alert({
  variant,
  children,
  onDismiss,
  className = '',
  'data-testid': dataTestId,
  action
}: AlertProps) {
  const styles = {
    success: {
      container: 'bg-green-50 border-green-200',
      icon: 'bg-green-600',
      iconPath: 'M5 13l4 4L19 7'
    },
    info: {
      container: 'bg-blue-50 border-blue-200',
      icon: 'bg-blue-800',
      iconPath: 'M5 13l4 4L19 7'
    },
    warning: {
      container: 'bg-amber-50 border-amber-200',
      icon: 'bg-amber-500',
      iconPath: 'M12 9v2m0 4h.01M12 8v4m0 4h.01'
    },
    error: {
      container: 'bg-red-50 border-red-200',
      icon: 'bg-red-600',
      iconPath: 'M6 18L18 6M6 6l12 12'
    }
  };

  const style = styles[variant];

  return (
    <div className={`rounded-lg border p-4 flex items-start justify-between ${style.container} ${className}`} data-testid={dataTestId}>
      <div className="flex items-start gap-3">
        <div className={`w-5 h-5 rounded-full ${style.icon} flex items-center justify-center flex-shrink-0 mt-0.5`}>
          <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path d={style.iconPath} strokeLinecap="round" strokeLinejoin="round" strokeWidth="3"></path>
          </svg>
        </div>
        <div className="text-sm">{children}</div>
      </div>
      <div className="flex items-center gap-4">
        {action && (
          action.href ? (
            <a 
              href={action.href}
              className="text-sm font-medium text-blue-800 hover:text-blue-900"
            >
              {action.label}
            </a>
          ) : (
            <button 
              onClick={action.onClick}
              className="text-sm font-medium text-blue-800 hover:text-blue-900"
            >
              {action.label}
            </button>
          )
        )}
        {onDismiss && (
          <button 
            onClick={onDismiss}
            className="text-slate-400 hover:text-slate-600 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path d="M6 18L18 6M6 6l12 12" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2"></path>
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
