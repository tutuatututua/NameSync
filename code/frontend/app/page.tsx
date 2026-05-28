'use client';

import Link from 'next/link';
import {
  Navbar,
  PageContainer,
  MainContent
} from './components';

export default function HomePage() {
  return (
    <PageContainer>
      <Navbar activeNav="home" />
      <MainContent size="default" className="py-12">
        <div className="text-center max-w-2xl mx-auto">
          <h1 className="text-4xl font-semibold text-slate-900 mb-4">
            NameSync
          </h1>
          <p className="text-lg text-slate-600 mb-8">
            Sync and compare your Company Data with Facebook data. 
            Upload, manage, and analyze records with ease.
          </p>
          
          <div className="grid md:grid-cols-2 gap-4 max-w-lg mx-auto">
            <Link
              href="/facebook"
              className="group bg-white rounded-lg border border-slate-200 p-6 hover:border-blue-800 hover:shadow-md transition-all"
              data-testid="home-facebook-link"
            >
              <div className="w-12 h-12 mx-auto mb-4 rounded-lg bg-blue-100 flex items-center justify-center group-hover:bg-blue-800 transition-colors">
                <svg className="w-6 h-6 text-blue-700 group-hover:text-white transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path d="M4 6h16M4 12h16M4 18h7" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2"></path>
                </svg>
              </div>
              <h2 className="text-lg font-semibold text-slate-900 mb-2">
                Facebook Data
              </h2>
              <p className="text-sm text-slate-500">
                Upload and manage Facebook data records with comparison features
              </p>
            </Link>

            <Link
              href="/company"
              className="group bg-white rounded-lg border border-slate-200 p-6 hover:border-blue-800 hover:shadow-md transition-all"
              data-testid="home-company-link"
            >
              <div className="w-12 h-12 mx-auto mb-4 rounded-lg bg-blue-100 flex items-center justify-center group-hover:bg-blue-800 transition-colors">
                <svg className="w-6 h-6 text-blue-700 group-hover:text-white transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2"></path>
                </svg>
              </div>
              <h2 className="text-lg font-semibold text-slate-900 mb-2">
                Company Data
              </h2>
              <p className="text-sm text-slate-500">
                Upload and manage Company data records
              </p>
            </Link>
          </div>

          <div className="mt-8 pt-8 border-t border-slate-200">
            <Link
              href="/history"
              className="inline-flex items-center gap-2 text-blue-800 hover:text-blue-900 font-medium"
              data-testid="home-history-link"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2"></path>
              </svg>
              View Saved Comparisons
            </Link>
          </div>
        </div>
      </MainContent>
    </PageContainer>
  );
}
