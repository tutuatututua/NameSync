'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

interface NavbarProps {
  activeNav?: 'home' | 'facebook' | 'company';
}

export default function Navbar({ activeNav }: NavbarProps) {
  const pathname = usePathname() ?? '';
  const isFacebookActive = activeNav === 'facebook' || pathname === '/facebook' || pathname.startsWith('/facebook/');
  const isCompanyActive = activeNav === 'company' || pathname === '/company' || pathname.startsWith('/company/');

  return (
    <nav className="sticky top-0 z-50 bg-white border-b border-slate-200">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex h-16 items-center gap-8">
          <Link 
            href="/" 
            className="text-xl font-semibold text-slate-900 tracking-tight"
          >
            NameSync
          </Link>
          <Link 
            href="/facebook" 
            className={`text-sm font-medium transition-colors ${
              isFacebookActive 
                ? 'text-slate-900' 
                : 'text-slate-600 hover:text-slate-900'
            }`}
            data-testid="nav-facebook"
          >
            Facebook Data
          </Link>
          <Link 
            href="/company" 
            className={`text-sm font-medium transition-colors ${
              isCompanyActive 
                ? 'text-slate-900' 
                : 'text-slate-600 hover:text-slate-900'
            }`}
            data-testid="nav-company"
          >
            Company Data
          </Link>
        </div>
      </div>
    </nav>
  );
}
