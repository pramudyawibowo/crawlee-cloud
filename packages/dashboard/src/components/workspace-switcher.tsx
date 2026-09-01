'use client';

import React, { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  Building2,
  User,
  Check,
  ChevronsUpDown,
  Plus,
  Settings2,
  Loader2,
  Shield,
} from 'lucide-react';
import { useWorkspace } from '@/lib/workspace-context';
import { createOrganization } from '@/lib/api';
import { prefixPath } from '@/lib/path-prefix';
import { useToast } from '@/components/ui/toast';

export function WorkspaceSwitcher() {
  const { activeOrgId, activeOrg, organizations, setActiveOrgId, refreshOrganizations } =
    useWorkspace();
  const router = useRouter();
  const toast = useToast();

  const [isOpen, setIsOpen] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [oidcGroup, setOidcGroup] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;

    setIsSubmitting(true);
    try {
      const newOrg = await createOrganization({
        name: name.trim(),
        description: description.trim() || undefined,
        oidcGroup: oidcGroup.trim() || undefined,
      });

      await refreshOrganizations();
      setActiveOrgId(newOrg.id);
      setShowCreateModal(false);
      setName('');
      setDescription('');
      setOidcGroup('');
      toast.success('Team created', {
        description: `Switched to ${newOrg.name}`,
      });
      // Soft refresh
      router.refresh();
    } catch (err) {
      toast.error('Failed to create team', {
        description: err instanceof Error ? err.message : 'Unknown error',
      });
    } finally {
      setIsSubmitting(false);
    }
  }

  function handleSwitch(orgId: string | null) {
    setActiveOrgId(orgId);
    setIsOpen(false);
    toast.info('Workspace switched', {
      description: orgId
        ? `Switched to ${organizations.find((o) => o.id === orgId)?.name}`
        : 'Switched to Personal Workspace',
    });
    router.refresh();
  }

  return (
    <div className="relative px-3 py-2 border-b border-border" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between gap-2 p-2 rounded-sm border border-border bg-surface-1 hover:bg-surface-2 transition-colors text-left font-mono"
        aria-label="Select workspace"
      >
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="h-6 w-6 rounded-sm bg-secondary/80 flex items-center justify-center shrink-0 text-foreground">
            {activeOrg ? <Building2 className="h-3.5 w-3.5" /> : <User className="h-3.5 w-3.5" />}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[12px] font-semibold text-foreground truncate leading-none">
              {activeOrg ? activeOrg.name : 'Personal Workspace'}
            </p>
            <p className="text-[10px] text-muted-foreground mt-0.5 truncate uppercase tracking-wider">
              {activeOrg ? `${activeOrg.member_role || 'member'} · team` : 'Personal Account'}
            </p>
          </div>
        </div>
        <ChevronsUpDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
      </button>

      {isOpen && (
        <div className="absolute left-3 right-3 top-full mt-1 z-50 rounded-sm border border-border bg-surface-1 shadow-lg py-1 font-mono text-[12px] animate-in fade-in-0 zoom-in-95">
          <div className="px-2.5 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">
            Personal
          </div>
          <button
            onClick={() => handleSwitch(null)}
            className="w-full flex items-center justify-between px-2.5 py-1.5 hover:bg-secondary/40 text-foreground text-left transition-colors"
          >
            <div className="flex items-center gap-2 min-w-0">
              <User className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="truncate">Personal Workspace</span>
            </div>
            {!activeOrgId && <Check className="h-3.5 w-3.5 text-signal shrink-0" />}
          </button>

          {organizations.length > 0 && (
            <>
              <div className="my-1 border-t border-border" />
              <div className="px-2.5 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                Teams & Organizations
              </div>
              {organizations.map((org) => (
                <button
                  key={org.id}
                  onClick={() => handleSwitch(org.id)}
                  className="w-full flex items-center justify-between px-2.5 py-1.5 hover:bg-secondary/40 text-foreground text-left transition-colors"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <Building2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <div className="min-w-0">
                      <p className="truncate leading-none">{org.name}</p>
                      <span className="text-[9px] text-muted-foreground capitalize">
                        {org.member_role || 'member'}
                      </span>
                    </div>
                  </div>
                  {activeOrgId === org.id && <Check className="h-3.5 w-3.5 text-signal shrink-0" />}
                </button>
              ))}
            </>
          )}

          <div className="my-1 border-t border-border" />

          <button
            onClick={() => {
              setIsOpen(false);
              setShowCreateModal(true);
            }}
            className="w-full flex items-center gap-2 px-2.5 py-1.5 hover:bg-secondary/40 text-signal text-left transition-colors"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>Create New Team</span>
          </button>

          <button
            onClick={() => {
              setIsOpen(false);
              router.push(prefixPath('/teams'));
            }}
            className="w-full flex items-center gap-2 px-2.5 py-1.5 hover:bg-secondary/40 text-muted-foreground hover:text-foreground text-left transition-colors"
          >
            <Settings2 className="h-3.5 w-3.5" />
            <span>Manage Teams</span>
          </button>
        </div>
      )}

      {/* Create Team Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-background/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-surface-1 border border-border rounded-sm shadow-xl p-6 font-mono space-y-4 animate-in fade-in-0 zoom-in-95">
            <div className="flex items-center gap-2.5 text-foreground border-b border-border pb-3">
              <Building2 className="h-5 w-5 text-signal" />
              <div>
                <h3 className="text-sm font-semibold uppercase tracking-wider">Create New Team</h3>
                <p className="text-[11px] text-muted-foreground">
                  Collaborate and share actors, datasets, and runs
                </p>
              </div>
            </div>

            <form onSubmit={handleCreate} className="space-y-4">
              <div>
                <label className="block text-[11px] text-muted-foreground uppercase tracking-wider mb-1">
                  Team / Organization Name *
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Scraper Engineering"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full h-8 px-2.5 text-xs bg-surface-2 border border-border rounded-sm text-foreground focus:outline-none focus:border-signal"
                />
              </div>

              <div>
                <label className="block text-[11px] text-muted-foreground uppercase tracking-wider mb-1">
                  Description (Optional)
                </label>
                <input
                  type="text"
                  placeholder="e.g. Shared workspace for automated crawlers"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="w-full h-8 px-2.5 text-xs bg-surface-2 border border-border rounded-sm text-foreground focus:outline-none focus:border-signal"
                />
              </div>

              <div>
                <label className="block text-[11px] text-muted-foreground uppercase tracking-wider mb-1">
                  OIDC Group Name (Optional Auto-Sync)
                </label>
                <div className="flex items-center gap-2">
                  <Shield className="h-4 w-4 text-muted-foreground shrink-0" />
                  <input
                    type="text"
                    placeholder="e.g. ads-scrapers"
                    value={oidcGroup}
                    onChange={(e) => setOidcGroup(e.target.value)}
                    className="w-full h-8 px-2.5 text-xs bg-surface-2 border border-border rounded-sm text-foreground focus:outline-none focus:border-signal"
                  />
                </div>
                <p className="text-[10px] text-muted-foreground/70 mt-1">
                  Users with this claim group on SSO login will automatically join this team.
                </p>
              </div>

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-border">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  disabled={isSubmitting}
                  className="px-3 py-1.5 text-xs border border-border hover:bg-secondary/40 rounded-sm text-muted-foreground transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting || !name.trim()}
                  className="flex items-center gap-2 px-3 py-1.5 text-xs bg-signal text-background font-semibold rounded-sm hover:opacity-90 transition-opacity disabled:opacity-50"
                >
                  {isSubmitting ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      <span>Creating...</span>
                    </>
                  ) : (
                    <span>Create Team</span>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
