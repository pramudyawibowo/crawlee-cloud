'use client';

import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { getOrganizations, type Organization } from '@/lib/api';

interface WorkspaceContextType {
  activeOrgId: string | null;
  activeOrg: Organization | null;
  organizations: Organization[];
  isLoading: boolean;
  setActiveOrgId: (orgId: string | null) => void;
  refreshOrganizations: () => Promise<void>;
}

const WorkspaceContext = createContext<WorkspaceContextType | undefined>(undefined);

export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  const [activeOrgId, setActiveOrgIdState] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    const stored = localStorage.getItem('active_org_id');
    return stored && stored !== 'personal' ? stored : null;
  });

  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);

  const refreshOrganizations = useCallback(async () => {
    try {
      const data = await getOrganizations();
      setOrganizations(data.items || []);
    } catch {
      // Not logged in or fetch error
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshOrganizations();
  }, [refreshOrganizations]);

  const setActiveOrgId = useCallback((id: string | null) => {
    const val = id && id !== 'personal' ? id : null;
    setActiveOrgIdState(val);
    if (typeof window !== 'undefined') {
      if (val) {
        localStorage.setItem('active_org_id', val);
      } else {
        localStorage.setItem('active_org_id', 'personal');
      }
      // Trigger a soft reload / state update
      window.dispatchEvent(new Event('workspace-changed'));
    }
  }, []);

  const activeOrg = activeOrgId ? organizations.find((o) => o.id === activeOrgId) || null : null;

  return (
    <WorkspaceContext.Provider
      value={{
        activeOrgId,
        activeOrg,
        organizations,
        isLoading,
        setActiveOrgId,
        refreshOrganizations,
      }}
    >
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace() {
  const context = useContext(WorkspaceContext);
  if (!context) {
    throw new Error('useWorkspace must be used within a WorkspaceProvider');
  }
  return context;
}
