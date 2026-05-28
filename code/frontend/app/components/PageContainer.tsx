import { ReactNode } from 'react';

interface PageContainerProps {
  children: ReactNode;
  className?: string;
  fullWidth?: boolean;
}

export default function PageContainer({ 
  children, 
  className = '',
  fullWidth = false 
}: PageContainerProps) {
  return (
    <div className={`page-root bg-slate-50 text-slate-900 min-h-screen ${className}`}>
      {children}
    </div>
  );
}

export function MainContent({ 
  children, 
  className = '',
  size = 'default'
}: { 
  children: ReactNode; 
  className?: string;
  size?: 'default' | 'wide' | 'narrow' | 'full';
}) {
  const sizeClasses = {
    default: 'max-w-4xl',
    wide: 'max-w-7xl',
    narrow: 'max-w-md',
    full: ''
  };

  return (
    <main className={`${sizeClasses[size]} mx-auto px-4 sm:px-6 lg:px-8 py-8 ${className}`}>
      {children}
    </main>
  );
}
