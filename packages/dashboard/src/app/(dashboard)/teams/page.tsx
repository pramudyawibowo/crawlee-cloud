'use client';

import React, { useState, useEffect, useCallback } from 'react';
import {
  Users,
  Building2,
  Plus,
  Shield,
  Trash2,
  UserPlus,
  Loader2,
  Mail,
  Crown,
  Settings,
} from 'lucide-react';
import { useWorkspace } from '@/lib/workspace-context';
import {
  getOrganization,
  createOrganization,
  updateOrganization,
  deleteOrganization,
  addOrgMember,
  updateOrgMemberRole,
  removeOrgMember,
  type OrganizationDetail,
  type OrganizationMember,
  type OrgRole,
} from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { useConfirm } from '@/components/ui/confirm';

export default function TeamsPage() {
  const { organizations, activeOrgId, setActiveOrgId, refreshOrganizations } = useWorkspace();
  const toast = useToast();
  const confirm = useConfirm();

  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(null);
  const [orgDetail, setOrgDetail] = useState<OrganizationDetail | null>(null);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);

  // Modals
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showInviteModal, setShowInviteModal] = useState(false);

  // Forms
  const [createForm, setCreateForm] = useState({
    name: '',
    slug: '',
    description: '',
    oidcGroup: '',
  });
  const [editForm, setEditForm] = useState({ name: '', slug: '', description: '', oidcGroup: '' });
  const [inviteForm, setInviteForm] = useState({ email: '', role: 'member' as OrgRole });
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Auto-select first org or active org
  useEffect(() => {
    if (activeOrgId && organizations.some((o) => o.id === activeOrgId)) {
      setSelectedOrgId(activeOrgId);
    } else if (organizations.length > 0 && !selectedOrgId) {
      setSelectedOrgId(organizations[0]?.id ?? null);
    }
  }, [activeOrgId, organizations, selectedOrgId]);

  const loadOrgDetail = useCallback(
    async (orgId: string) => {
      setIsLoadingDetail(true);
      try {
        const detail = await getOrganization(orgId);
        setOrgDetail(detail);
        setEditForm({
          name: detail.name,
          slug: detail.slug,
          description: detail.description || '',
          oidcGroup: detail.oidc_group || '',
        });
      } catch (err) {
        toast.error('Failed to load team details', {
          description: err instanceof Error ? err.message : 'Unknown error',
        });
      } finally {
        setIsLoadingDetail(false);
      }
    },
    [toast]
  );

  useEffect(() => {
    if (selectedOrgId) {
      void loadOrgDetail(selectedOrgId);
    } else {
      setOrgDetail(null);
    }
  }, [selectedOrgId, loadOrgDetail]);

  const canManage = orgDetail?.myRole === 'owner' || orgDetail?.myRole === 'admin';
  const isOwner = orgDetail?.myRole === 'owner';

  async function handleCreateTeam(e: React.FormEvent) {
    e.preventDefault();
    if (!createForm.name.trim()) return;

    setIsSubmitting(true);
    try {
      const newOrg = await createOrganization({
        name: createForm.name.trim(),
        slug: createForm.slug.trim() || undefined,
        description: createForm.description.trim() || undefined,
        oidcGroup: createForm.oidcGroup.trim() || undefined,
      });

      await refreshOrganizations();
      setSelectedOrgId(newOrg.id);
      setActiveOrgId(newOrg.id);
      setShowCreateModal(false);
      setCreateForm({ name: '', slug: '', description: '', oidcGroup: '' });
      toast.success('Team created successfully', {
        description: `${newOrg.name} is now your active workspace`,
      });
    } catch (err) {
      toast.error('Failed to create team', {
        description: err instanceof Error ? err.message : 'Unknown error',
      });
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleEditTeam(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedOrgId || !editForm.name.trim()) return;

    setIsSubmitting(true);
    try {
      await updateOrganization(selectedOrgId, {
        name: editForm.name.trim(),
        slug: editForm.slug.trim() || undefined,
        description: editForm.description.trim() || undefined,
        oidcGroup: editForm.oidcGroup.trim() || undefined,
      });

      await refreshOrganizations();
      await loadOrgDetail(selectedOrgId);
      setShowEditModal(false);
      toast.success('Team updated', {
        description: 'Organization settings saved successfully',
      });
    } catch (err) {
      toast.error('Failed to update team', {
        description: err instanceof Error ? err.message : 'Unknown error',
      });
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleDeleteTeam() {
    if (!selectedOrgId || !orgDetail) return;
    const ok = await confirm({
      title: `Delete team "${orgDetail.name}"?`,
      description:
        'This action is irreversible. All team members, shared actors, datasets, and execution runs owned by this team will be permanently deleted.',
      confirmLabel: 'Delete Team',
      tone: 'danger',
    });

    if (!ok) return;

    try {
      await deleteOrganization(selectedOrgId);
      toast.success('Team deleted', {
        description: `Team ${orgDetail.name} has been removed`,
      });
      setSelectedOrgId(null);
      setActiveOrgId(null);
      await refreshOrganizations();
    } catch (err) {
      toast.error('Failed to delete team', {
        description: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }

  async function handleInviteMember(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedOrgId || !inviteForm.email.trim()) return;

    setIsSubmitting(true);
    try {
      await addOrgMember(selectedOrgId, inviteForm.email.trim(), inviteForm.role);
      await loadOrgDetail(selectedOrgId);
      setShowInviteModal(false);
      setInviteForm({ email: '', role: 'member' });
      toast.success('Member added', {
        description: `${inviteForm.email} has been added as ${inviteForm.role}`,
      });
    } catch (err) {
      toast.error('Failed to add member', {
        description: err instanceof Error ? err.message : 'Unknown error',
      });
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleRoleChange(memberUserId: string, newRole: OrgRole) {
    if (!selectedOrgId) return;
    try {
      await updateOrgMemberRole(selectedOrgId, memberUserId, newRole);
      await loadOrgDetail(selectedOrgId);
      toast.success('Role updated', {
        description: `Member role changed to ${newRole}`,
      });
    } catch (err) {
      toast.error('Failed to update role', {
        description: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }

  async function handleRemoveMember(member: OrganizationMember) {
    if (!selectedOrgId) return;
    const ok = await confirm({
      title: `Remove member?`,
      description: `Remove ${member.user_email || 'this member'} from the team?`,
      confirmLabel: 'Remove',
      tone: 'danger',
    });

    if (!ok) return;

    try {
      await removeOrgMember(selectedOrgId, member.user_id);
      await loadOrgDetail(selectedOrgId);
      toast.success('Member removed');
    } catch (err) {
      toast.error('Failed to remove member', {
        description: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }

  return (
    <div className="space-y-6 max-w-6xl">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-border pb-5">
        <div>
          <div className="flex items-center gap-2">
            <Users className="h-5 w-5 text-signal" />
            <h1 className="font-mono text-lg font-bold tracking-tight text-foreground uppercase">
              Teams & Organizations
            </h1>
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            Manage multi-tenant team workspaces, member roles, and OIDC identity group auto-sync.
          </p>
        </div>

        <button
          onClick={() => setShowCreateModal(true)}
          className="flex items-center gap-2 px-3 py-1.5 text-xs bg-signal text-background font-mono font-semibold rounded-sm hover:opacity-90 transition-opacity"
        >
          <Plus className="h-4 w-4" />
          <span>Create Team</span>
        </button>
      </div>

      {organizations.length === 0 ? (
        /* Empty State */
        <div className="border border-dashed border-border bg-card rounded-sm p-12 text-center font-mono space-y-4">
          <div className="h-12 w-12 rounded-full bg-secondary/60 mx-auto flex items-center justify-center text-muted-foreground">
            <Building2 className="h-6 w-6" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-foreground uppercase tracking-wide">
              No Teams Created Yet
            </h3>
            <p className="text-xs text-muted-foreground max-w-md mx-auto mt-1">
              You are currently using your Personal Workspace. Create a team to share Actors,
              Datasets, and automated Schedules with your teammates.
            </p>
          </div>
          <button
            onClick={() => setShowCreateModal(true)}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs bg-signal text-background font-semibold rounded-sm hover:opacity-90 transition-opacity"
          >
            <Plus className="h-4 w-4" />
            <span>Create Your First Team</span>
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 items-start font-mono">
          {/* Team List Navigation */}
          <div className="border border-border bg-card rounded-sm p-3 space-y-2">
            <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">
              Your Teams ({organizations.length})
            </div>
            {organizations.map((org) => {
              const isSelected = selectedOrgId === org.id;
              const isActive = activeOrgId === org.id;
              return (
                <button
                  key={org.id}
                  onClick={() => setSelectedOrgId(org.id)}
                  className={`w-full flex items-center justify-between p-2.5 rounded-sm text-left transition-colors ${
                    isSelected
                      ? 'bg-secondary/80 border border-border text-foreground'
                      : 'hover:bg-secondary/40 text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <div className="min-w-0 flex items-center gap-2">
                    <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0">
                      <p className="text-xs font-semibold truncate leading-none">{org.name}</p>
                      <p className="text-[10px] text-muted-foreground mt-1 capitalize">
                        {org.member_role || 'member'} · {org.member_count || 1} members
                      </p>
                    </div>
                  </div>
                  {isActive && (
                    <span className="text-[9px] px-1.5 py-0.5 rounded-sm bg-signal/10 border border-signal/30 text-signal uppercase tracking-wider shrink-0">
                      Active
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Team Details & Members */}
          <div className="lg:col-span-3 space-y-6">
            {isLoadingDetail || !orgDetail ? (
              <div className="border border-border bg-card rounded-sm p-12 text-center">
                <Loader2 className="h-6 w-6 animate-spin text-signal mx-auto" />
                <p className="text-xs text-muted-foreground mt-2">Loading team details...</p>
              </div>
            ) : (
              <>
                {/* Team Info Card */}
                <div className="border border-border bg-card rounded-sm p-5 space-y-4">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-border pb-4">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="h-10 w-10 rounded-sm bg-secondary/80 border border-border flex items-center justify-center text-signal shrink-0">
                        <Building2 className="h-5 w-5" />
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <h2 className="text-base font-bold text-foreground truncate">
                            {orgDetail.name}
                          </h2>
                          <span className="text-[10px] px-2 py-0.5 rounded-sm bg-secondary border border-border text-foreground uppercase tracking-wider">
                            {orgDetail.slug}
                          </span>
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {orgDetail.description || 'No description provided.'}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      {activeOrgId !== orgDetail.id && (
                        <button
                          onClick={() => {
                            setActiveOrgId(orgDetail.id);
                            toast.info('Switched workspace', {
                              description: `Now working inside ${orgDetail.name}`,
                            });
                          }}
                          className="px-3 py-1 text-xs border border-signal/40 bg-signal/10 hover:bg-signal/20 text-signal rounded-sm transition-colors"
                        >
                          Set as Active Workspace
                        </button>
                      )}
                      {canManage && (
                        <button
                          onClick={() => setShowEditModal(true)}
                          className="p-1.5 border border-border hover:bg-secondary/40 rounded-sm text-muted-foreground hover:text-foreground transition-colors"
                          title="Team Settings"
                        >
                          <Settings className="h-4 w-4" />
                        </button>
                      )}
                      {isOwner && (
                        <button
                          onClick={handleDeleteTeam}
                          className="p-1.5 border border-border hover:bg-fail/10 rounded-sm text-muted-foreground hover:text-fail transition-colors"
                          title="Delete Team"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  </div>

                  {/* OIDC Group Sync Banner */}
                  {orgDetail.oidc_group && (
                    <div className="flex items-center gap-2.5 p-3 rounded-sm bg-signal/5 border border-signal/20 text-xs">
                      <Shield className="h-4 w-4 text-signal shrink-0" />
                      <div className="flex-1 min-w-0">
                        <span className="text-foreground font-semibold">
                          OIDC Group Auto-Sync Enabled:
                        </span>{' '}
                        <span className="text-signal">"{orgDetail.oidc_group}"</span>
                        <p className="text-[10px] text-muted-foreground mt-0.5">
                          Users logging in via SSO with this group are automatically added to this
                          team.
                        </p>
                      </div>
                    </div>
                  )}
                </div>

                {/* Members List Card */}
                <div className="border border-border bg-card rounded-sm p-5 space-y-4">
                  <div className="flex items-center justify-between gap-3 border-b border-border pb-3">
                    <div>
                      <h3 className="text-sm font-semibold uppercase tracking-wider text-foreground">
                        Team Members ({orgDetail.members?.length || 0})
                      </h3>
                      <p className="text-[11px] text-muted-foreground mt-0.5">
                        Manage roles and access permissions for team collaborators.
                      </p>
                    </div>

                    {canManage && (
                      <button
                        onClick={() => setShowInviteModal(true)}
                        className="flex items-center gap-1.5 px-3 py-1 text-xs bg-secondary/80 hover:bg-secondary border border-border text-foreground font-semibold rounded-sm transition-colors"
                      >
                        <UserPlus className="h-3.5 w-3.5" />
                        <span>Add Member</span>
                      </button>
                    )}
                  </div>

                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead>
                        <tr className="border-b border-border text-[10px] text-muted-foreground uppercase tracking-wider">
                          <th className="pb-2 font-medium">User</th>
                          <th className="pb-2 font-medium">Role</th>
                          <th className="pb-2 font-medium">Joined</th>
                          {canManage && <th className="pb-2 font-medium text-right">Actions</th>}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border/50">
                        {orgDetail.members?.map((m) => {
                          const isMemberOwner = m.role === 'owner';
                          return (
                            <tr key={m.id} className="hover:bg-secondary/20 transition-colors">
                              <td className="py-3">
                                <div className="flex items-center gap-2.5 min-w-0">
                                  <div className="h-7 w-7 rounded-full bg-secondary border border-border flex items-center justify-center text-[10px] font-bold text-foreground">
                                    {(m.user_email || 'U').slice(0, 2).toUpperCase()}
                                  </div>
                                  <div className="min-w-0">
                                    <p className="font-semibold text-foreground truncate">
                                      {m.user_name || m.user_email?.split('@')[0]}
                                    </p>
                                    <p className="text-[11px] text-muted-foreground truncate">
                                      {m.user_email}
                                    </p>
                                  </div>
                                </div>
                              </td>

                              <td className="py-3">
                                {canManage && !isMemberOwner ? (
                                  <select
                                    value={m.role}
                                    onChange={(e) =>
                                      handleRoleChange(m.user_id, e.target.value as OrgRole)
                                    }
                                    className="px-2 py-1 text-[11px] bg-secondary/50 border border-border rounded-sm text-foreground focus:outline-none focus:border-signal uppercase tracking-wider"
                                  >
                                    <option value="admin">Admin</option>
                                    <option value="member">Member</option>
                                    <option value="viewer">Viewer</option>
                                  </select>
                                ) : (
                                  <span
                                    className={`inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-sm uppercase tracking-wider ${
                                      isMemberOwner
                                        ? 'bg-signal/15 text-signal border border-signal/30 font-bold'
                                        : 'bg-secondary text-foreground border border-border'
                                    }`}
                                  >
                                    {isMemberOwner && <Crown className="h-3 w-3" />}
                                    {m.role}
                                  </span>
                                )}
                              </td>

                              <td className="py-3 text-[11px] text-muted-foreground">
                                {new Date(m.created_at).toLocaleDateString()}
                              </td>

                              {canManage && (
                                <td className="py-3 text-right">
                                  {!isMemberOwner && (
                                    <button
                                      onClick={() => handleRemoveMember(m)}
                                      className="p-1 text-muted-foreground hover:text-fail transition-colors"
                                      title="Remove member"
                                    >
                                      <Trash2 className="h-3.5 w-3.5" />
                                    </button>
                                  )}
                                </td>
                              )}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Create Team Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-background/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-card text-card-foreground border border-border rounded-sm shadow-2xl p-6 font-mono space-y-4 animate-in fade-in-0 zoom-in-95">
            <div className="flex items-center gap-2.5 text-foreground border-b border-border pb-3">
              <Building2 className="h-5 w-5 text-signal" />
              <div>
                <h3 className="text-sm font-semibold uppercase tracking-wider">Create New Team</h3>
                <p className="text-[11px] text-muted-foreground">
                  Collaborate and share actors, datasets, and runs
                </p>
              </div>
            </div>

            <form onSubmit={handleCreateTeam} className="space-y-4">
              <div>
                <label className="block text-[11px] text-muted-foreground uppercase tracking-wider mb-1">
                  Team / Organization Name *
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Data Scraping Operations"
                  value={createForm.name}
                  onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })}
                  className="w-full h-8 px-2.5 text-xs bg-secondary/50 border border-border rounded-sm text-foreground focus:outline-none focus:border-signal"
                />
              </div>

              <div>
                <label className="block text-[11px] text-muted-foreground uppercase tracking-wider mb-1">
                  URL Slug (Optional)
                </label>
                <input
                  type="text"
                  placeholder="e.g. data-scraping-ops"
                  value={createForm.slug}
                  onChange={(e) => setCreateForm({ ...createForm, slug: e.target.value })}
                  className="w-full h-8 px-2.5 text-xs bg-secondary/50 border border-border rounded-sm text-foreground focus:outline-none focus:border-signal"
                />
              </div>

              <div>
                <label className="block text-[11px] text-muted-foreground uppercase tracking-wider mb-1">
                  Description (Optional)
                </label>
                <input
                  type="text"
                  placeholder="e.g. Shared scrapers for market analytics"
                  value={createForm.description}
                  onChange={(e) => setCreateForm({ ...createForm, description: e.target.value })}
                  className="w-full h-8 px-2.5 text-xs bg-secondary/50 border border-border rounded-sm text-foreground focus:outline-none focus:border-signal"
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
                    placeholder="e.g. scraper-engineers"
                    value={createForm.oidcGroup}
                    onChange={(e) => setCreateForm({ ...createForm, oidcGroup: e.target.value })}
                    className="w-full h-8 px-2.5 text-xs bg-secondary/50 border border-border rounded-sm text-foreground focus:outline-none focus:border-signal"
                  />
                </div>
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
                  disabled={isSubmitting || !createForm.name.trim()}
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

      {/* Edit Team Settings Modal */}
      {showEditModal && (
        <div className="fixed inset-0 bg-background/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-card text-card-foreground border border-border rounded-sm shadow-2xl p-6 font-mono space-y-4 animate-in fade-in-0 zoom-in-95">
            <div className="flex items-center gap-2.5 text-foreground border-b border-border pb-3">
              <Settings className="h-5 w-5 text-signal" />
              <div>
                <h3 className="text-sm font-semibold uppercase tracking-wider">Team Settings</h3>
                <p className="text-[11px] text-muted-foreground">
                  Update team details and OIDC sync
                </p>
              </div>
            </div>

            <form onSubmit={handleEditTeam} className="space-y-4">
              <div>
                <label className="block text-[11px] text-muted-foreground uppercase tracking-wider mb-1">
                  Team Name *
                </label>
                <input
                  type="text"
                  required
                  value={editForm.name}
                  onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                  className="w-full h-8 px-2.5 text-xs bg-secondary/50 border border-border rounded-sm text-foreground focus:outline-none focus:border-signal"
                />
              </div>

              <div>
                <label className="block text-[11px] text-muted-foreground uppercase tracking-wider mb-1">
                  URL Slug
                </label>
                <input
                  type="text"
                  value={editForm.slug}
                  onChange={(e) => setEditForm({ ...editForm, slug: e.target.value })}
                  className="w-full h-8 px-2.5 text-xs bg-secondary/50 border border-border rounded-sm text-foreground focus:outline-none focus:border-signal"
                />
              </div>

              <div>
                <label className="block text-[11px] text-muted-foreground uppercase tracking-wider mb-1">
                  Description
                </label>
                <input
                  type="text"
                  value={editForm.description}
                  onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
                  className="w-full h-8 px-2.5 text-xs bg-secondary/50 border border-border rounded-sm text-foreground focus:outline-none focus:border-signal"
                />
              </div>

              <div>
                <label className="block text-[11px] text-muted-foreground uppercase tracking-wider mb-1">
                  OIDC Group Name Link
                </label>
                <input
                  type="text"
                  placeholder="e.g. devops-team"
                  value={editForm.oidcGroup}
                  onChange={(e) => setEditForm({ ...editForm, oidcGroup: e.target.value })}
                  className="w-full h-8 px-2.5 text-xs bg-secondary/50 border border-border rounded-sm text-foreground focus:outline-none focus:border-signal"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-border">
                <button
                  type="button"
                  onClick={() => setShowEditModal(false)}
                  disabled={isSubmitting}
                  className="px-3 py-1.5 text-xs border border-border hover:bg-secondary/40 rounded-sm text-muted-foreground transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting || !editForm.name.trim()}
                  className="flex items-center gap-2 px-3 py-1.5 text-xs bg-signal text-background font-semibold rounded-sm hover:opacity-90 transition-opacity disabled:opacity-50"
                >
                  {isSubmitting ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      <span>Saving...</span>
                    </>
                  ) : (
                    <span>Save Changes</span>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Invite Member Modal */}
      {showInviteModal && (
        <div className="fixed inset-0 bg-background/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-card text-card-foreground border border-border rounded-sm shadow-2xl p-6 font-mono space-y-4 animate-in fade-in-0 zoom-in-95">
            <div className="flex items-center gap-2.5 text-foreground border-b border-border pb-3">
              <UserPlus className="h-5 w-5 text-signal" />
              <div>
                <h3 className="text-sm font-semibold uppercase tracking-wider">Add Team Member</h3>
                <p className="text-[11px] text-muted-foreground">
                  Grant access to {orgDetail?.name}
                </p>
              </div>
            </div>

            <form onSubmit={handleInviteMember} className="space-y-4">
              <div>
                <label className="block text-[11px] text-muted-foreground uppercase tracking-wider mb-1">
                  User Email Address *
                </label>
                <div className="flex items-center gap-2">
                  <Mail className="h-4 w-4 text-muted-foreground shrink-0" />
                  <input
                    type="email"
                    required
                    placeholder="teammate@company.com"
                    value={inviteForm.email}
                    onChange={(e) => setInviteForm({ ...inviteForm, email: e.target.value })}
                    className="w-full h-8 px-2.5 text-xs bg-secondary/50 border border-border rounded-sm text-foreground focus:outline-none focus:border-signal"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[11px] text-muted-foreground uppercase tracking-wider mb-1">
                  Role
                </label>
                <select
                  value={inviteForm.role}
                  onChange={(e) =>
                    setInviteForm({ ...inviteForm, role: e.target.value as OrgRole })
                  }
                  className="w-full h-8 px-2.5 text-xs bg-secondary/50 border border-border rounded-sm text-foreground focus:outline-none focus:border-signal uppercase tracking-wider"
                >
                  <option value="member">Member (Can create, edit & run actors)</option>
                  <option value="admin">Admin (Can manage members & team settings)</option>
                  <option value="viewer">Viewer (Read-only access to runs and data)</option>
                </select>
              </div>

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-border">
                <button
                  type="button"
                  onClick={() => setShowInviteModal(false)}
                  disabled={isSubmitting}
                  className="px-3 py-1.5 text-xs border border-border hover:bg-secondary/40 rounded-sm text-muted-foreground transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting || !inviteForm.email.trim()}
                  className="flex items-center gap-2 px-3 py-1.5 text-xs bg-signal text-background font-semibold rounded-sm hover:opacity-90 transition-opacity disabled:opacity-50"
                >
                  {isSubmitting ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      <span>Adding...</span>
                    </>
                  ) : (
                    <span>Add Member</span>
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
