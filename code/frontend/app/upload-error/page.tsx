'use client';

import { useRouter } from 'next/navigation';
import {
  Navbar,
  PageContainer,
  MainContent,
  Button,
  Alert
} from '../components';

export default function UploadErrorPage() {
  const router = useRouter();

  return (
    <PageContainer>
      <Navbar activeNav="home" />
      <MainContent size="narrow" className="py-12">
        <div className="text-center mb-8">
          <div className="w-16 h-16 mx-auto mb-6 bg-red-100 rounded-full flex items-center justify-center">
            <svg className="w-8 h-8 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <h1 className="text-2xl font-semibold text-slate-900 mb-3">Upload Failed</h1>
          <p className="text-slate-600">
            We encountered an error while processing your files. Please check your file types and try again.
          </p>
        </div>

        <Alert variant="error" className="mb-8" data-testid="upload-error-alert">
          <div className="font-medium mb-2">Common issues:</div>
          <ul className="list-disc list-inside space-y-1 text-sm">
            <li>Company Data file must be a .csv file</li>
            <li>Facebook file must be a .json file</li>
            <li>Each file must be under 500MB</li>
            <li>Files may be corrupted or improperly exported</li>
          </ul>
        </Alert>

        <div className="flex justify-center gap-4">
          <Button 
            onClick={() => router.push('/')}
            data-testid="try-again-btn"
          >
            Try Again
          </Button>
          <Button 
            variant="secondary"
            onClick={() => router.push('/history')}
          >
            View History
          </Button>
        </div>
      </MainContent>
    </PageContainer>
  );
}
