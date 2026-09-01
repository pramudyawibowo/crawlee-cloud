'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Loader2, ShieldAlert } from 'lucide-react';
import { getApiUrl } from '@/lib/api';
import { prefixPath } from '@/lib/path-prefix';

export default function AuthCallbackPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = searchParams.get('token');
    const err = searchParams.get('error');

    if (err) {
      setError(decodeURIComponent(err));
      return;
    }

    if (!token) {
      setError('No authentication token received');
      return;
    }

    async function finishLogin() {
      try {
        const apiUrl = getApiUrl();
        const res = await fetch(`${apiUrl}/v2/auth/me`, {
          headers: { Authorization: `Bearer ${token}` },
        });

        if (!res.ok) {
          throw new Error('Failed to verify authentication session');
        }

        const data = await res.json();

        localStorage.setItem('token', token!);
        if (data.data) {
          localStorage.setItem('user', JSON.stringify(data.data));
        }

        const secure = window.location.protocol === 'https:' ? '; Secure' : '';
        document.cookie = `token=${token}; path=/; max-age=${7 * 24 * 60 * 60}; SameSite=Lax${secure}`;

        window.location.href = prefixPath('/');
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Authentication session validation failed');
      }
    }

    void finishLogin();
  }, [searchParams, router]);

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-background">
      <div className="w-full max-w-sm p-6 border border-border bg-card text-card-foreground rounded-md text-center space-y-4">
        {error ? (
          <div className="space-y-4">
            <div className="h-10 w-10 mx-auto rounded-full bg-fail/10 border border-fail/20 flex items-center justify-center text-fail">
              <ShieldAlert className="h-5 w-5" />
            </div>
            <div>
              <h2 className="font-mono text-sm tracking-wide text-fail uppercase">
                SSO Login Failed
              </h2>
              <p className="text-xs text-muted-foreground mt-1">{error}</p>
            </div>
            <button
              onClick={() => {
                window.location.href = prefixPath('/login');
              }}
              className="btn btn-secondary w-full justify-center text-xs font-mono"
            >
              Back to Login
            </button>
          </div>
        ) : (
          <div className="space-y-3 py-4">
            <Loader2 className="h-6 w-6 animate-spin mx-auto text-signal" />
            <p className="font-mono text-xs text-muted-foreground tracking-wider uppercase">
              Completing authentication...
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
