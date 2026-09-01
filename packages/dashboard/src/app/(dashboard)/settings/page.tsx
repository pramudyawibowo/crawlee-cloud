'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Copy,
  Eye,
  EyeOff,
  Globe,
  HardDrive,
  KeyRound,
  Loader2,
  Plus,
  Save,
  Server,
  Settings2,
  Shield,
  Trash2,
  X,
} from 'lucide-react';
import { useConfirm } from '@/components/ui/confirm';
import { useToast } from '@/components/ui/toast';
import { Badge } from '@/components/ui/badge';
import { useAuth } from '@/lib/auth';
import {
  createApiKey,
  getMyApifyProfile,
  getApiKeys,
  getApiUrl,
  getSystemInfo,
  getSystemSettings,
  revokeApiKey,
  setMyProxyPassword,
  testOidcConnection,
  updateExecutionSettings,
  updateOidcSettings,
  type ApiKey,
  type ExecutionSettings,
  type OidcSettings,
  type SystemInfo,
  type User,
} from '@/lib/api';
import { cn } from '@/lib/utils';

export default function SettingsPage() {
  const confirm = useConfirm();
  const toast = useToast();
  const { user: authUser } = useAuth();
  const API_BASE = getApiUrl();

  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [newlyCreatedKey, setNewlyCreatedKey] = useState<string | null>(null);
  const [showNewKey, setShowNewKey] = useState(false);
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  const [systemError, setSystemError] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [proxyInput, setProxyInput] = useState('');
  const [proxyBusy, setProxyBusy] = useState(false);
  const [proxyReplaceMode, setProxyReplaceMode] = useState(false);

  const isAdmin = authUser?.role === 'admin' || user?.role === 'admin';

  // OIDC & Dynamic Settings state
  const [oidcForm, setOidcForm] = useState<OidcSettings>({
    enabled: false,
    providerName: 'SSO',
    issuerUrl: '',
    clientId: '',
    clientSecret: '',
    scopes: 'openid email profile groups',
    redirectUri: '',
    rolesClaim: 'roles',
    adminRoles: ['admin', 'crawlee-admins', 'devops'],
    defaultRole: 'user',
    autoRegister: true,
  });
  const [adminRolesInput, setAdminRolesInput] = useState('admin, crawlee-admins, devops');
  const [showOidcSecret, setShowOidcSecret] = useState(false);
  const [oidcTesting, setOidcTesting] = useState(false);
  const [oidcTestResult, setOidcTestResult] = useState<{
    success: boolean;
    message?: string;
  } | null>(null);
  const [oidcSaving, setOidcSaving] = useState(false);

  // Execution settings state
  const [executionForm, setExecutionForm] = useState<ExecutionSettings>({
    maxConcurrentRuns: 10,
    defaultMemoryMb: 1024,
    defaultTimeoutSecs: 3600,
    apifyCuPrice: 0.4,
  });
  const [executionSaving, setExecutionSaving] = useState(false);

  const loadKeys = useCallback(async () => {
    try {
      const keys = await getApiKeys();
      setApiKeys(keys);
    } catch {
      // Empty list on failure; the API may simply be unreachable.
    } finally {
      setLoading(false);
    }
  }, []);

  const loadUser = useCallback(async () => {
    try {
      const u = await getMyApifyProfile();
      setUser(u);
    } catch {
      /* silent — surfaced as no panel data */
    }
  }, []);

  const loadSystem = useCallback(async () => {
    try {
      const info = await getSystemInfo();
      setSystemInfo(info);
      setSystemError(null);
    } catch (err) {
      setSystemError((err as Error).message);
    }
  }, []);

  const loadSettings = useCallback(async () => {
    try {
      const settings = await getSystemSettings();
      if (settings?.oidc) {
        setOidcForm(settings.oidc);
        setAdminRolesInput(
          Array.isArray(settings.oidc.adminRoles)
            ? settings.oidc.adminRoles.join(', ')
            : 'admin, crawlee-admins, devops'
        );
      }
      if (settings?.execution) {
        setExecutionForm(settings.execution);
      }
    } catch {
      // Non-admins cannot read full system settings
    }
  }, []);

  useEffect(() => {
    void loadKeys();
    void loadUser();
    if (isAdmin) {
      void loadSystem();
      void loadSettings();
    }
  }, [loadKeys, loadSystem, loadUser, loadSettings, isAdmin]);

  async function handleCreate() {
    if (!newKeyName.trim()) return;
    setCreating(true);
    try {
      const { key } = await createApiKey(newKeyName.trim());
      setNewlyCreatedKey(key);
      setNewKeyName('');
      await loadKeys();
      toast.success('API key created', { description: 'Copy it now — visible only once.' });
    } catch (err) {
      toast.error('Failed to create key', { description: (err as Error).message });
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(key: ApiKey) {
    const ok = await confirm({
      tone: 'danger',
      title: `Revoke "${key.name}"?`,
      description: 'Anything using this key — CLI, SDKs, scripts — will stop working immediately.',
      confirmLabel: 'revoke key',
    });
    if (!ok) return;
    try {
      await revokeApiKey(key.id);
      await loadKeys();
      toast.success('Key revoked');
    } catch (err) {
      toast.error('Failed to revoke key', { description: (err as Error).message });
    }
  }

  async function handleSaveProxy() {
    if (!proxyInput.trim()) return;
    setProxyBusy(true);
    try {
      await setMyProxyPassword(proxyInput.trim());
      setProxyInput('');
      setProxyReplaceMode(false);
      await loadUser();
      toast.success('Proxy password saved');
    } catch (err) {
      toast.error('Failed to save', { description: (err as Error).message });
    } finally {
      setProxyBusy(false);
    }
  }

  async function handleClearProxy() {
    const ok = await confirm({
      tone: 'danger',
      title: 'Revoke proxy password?',
      description:
        'Actors using useApifyProxy=true will fall back to actor or platform defaults — or fail if none.',
      confirmLabel: 'revoke',
    });
    if (!ok) return;
    setProxyBusy(true);
    try {
      await setMyProxyPassword(null);
      await loadUser();
      toast.success('Proxy password cleared');
    } catch (err) {
      toast.error('Failed to clear', { description: (err as Error).message });
    } finally {
      setProxyBusy(false);
    }
  }

  function cleanIssuerUrl(url: string): string {
    let clean = (url || '').trim().replace(/\/+$/, '');
    if (clean.endsWith('/.well-known/openid-configuration')) {
      clean = clean.slice(0, -'/.well-known/openid-configuration'.length).replace(/\/+$/, '');
    }
    return clean;
  }

  async function handleTestOidc() {
    const targetUrl = cleanIssuerUrl(oidcForm.issuerUrl);
    if (!targetUrl) {
      toast.error('Please enter an OIDC Issuer URL first');
      return;
    }

    setOidcForm((prev) => ({ ...prev, issuerUrl: targetUrl }));
    setOidcTesting(true);
    setOidcTestResult(null);

    try {
      const res = await testOidcConnection(targetUrl);
      if (res.success) {
        setOidcTestResult({
          success: true,
          message: 'Connected successfully to OIDC discovery endpoint.',
        });
        toast.success('OIDC Connection Test Passed');
      } else {
        setOidcTestResult({
          success: false,
          message: res.error || 'Failed to reach discovery endpoint',
        });
        toast.error('OIDC Connection Test Failed');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Connection test failed';
      setOidcTestResult({ success: false, message: msg });
      toast.error('Connection Test Failed', { description: msg });
    } finally {
      setOidcTesting(false);
    }
  }

  async function handleSaveOidc() {
    setOidcSaving(true);
    try {
      const targetUrl = cleanIssuerUrl(oidcForm.issuerUrl);
      const adminRoles = adminRolesInput
        .split(',')
        .map((r) => r.trim())
        .filter(Boolean);

      const payload: Partial<OidcSettings> = {
        ...oidcForm,
        issuerUrl: targetUrl,
        adminRoles,
      };

      const updated = await updateOidcSettings(payload);
      setOidcForm(updated);
      toast.success('OIDC settings saved successfully');
    } catch (err) {
      toast.error('Failed to save OIDC settings', {
        description: err instanceof Error ? err.message : 'Unknown error',
      });
    } finally {
      setOidcSaving(false);
    }
  }

  async function handleSaveExecution() {
    setExecutionSaving(true);
    try {
      const updated = await updateExecutionSettings(executionForm);
      setExecutionForm(updated);
      await loadSystem();
      toast.success('Execution settings saved successfully');
    } catch (err) {
      toast.error('Failed to save execution settings', {
        description: err instanceof Error ? err.message : 'Unknown error',
      });
    } finally {
      setExecutionSaving(false);
    }
  }

  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${label} copied`);
    } catch {
      toast.error('Copy failed');
    }
  }

  const defaultRedirectUri =
    typeof window !== 'undefined' ? `${window.location.origin}/api/v2/auth/oidc/callback` : '';

  return (
    <div className="space-y-8 max-w-4xl">
      <header className="pb-4 border-b border-border">
        <p className="eyebrow mb-2">{isAdmin ? 'SYSTEM · SETTINGS' : 'ACCOUNT · SETTINGS'}</p>
        <h1 className="text-[28px] leading-none font-medium tracking-tight">
          {isAdmin ? 'Platform & Account Settings' : 'Account Settings'}
        </h1>
        <p className="text-muted-foreground mt-2 text-[13px]">
          {isAdmin
            ? 'Single Sign-On (OIDC), API access, execution defaults, and infrastructure probes.'
            : 'Personal API access tokens and proxy password configuration.'}
        </p>
      </header>

      {isAdmin && (
        <>
          {/* ===========================================
              OIDC / SSO AUTHENTICATION & ROLE MAPPING
              =========================================== */}
          <section className="panel">
            <header className="px-5 py-4 border-b border-border flex items-center justify-between">
              <div className="flex items-center gap-3">
                <KeyRound className="h-4 w-4 text-signal" />
                <div>
                  <p className="eyebrow">AUTH · SSO &amp; OIDC</p>
                  <h2 className="text-[15px] mt-1">Generic OpenID Connect &amp; Role Mapping</h2>
                </div>
              </div>
              <Badge
                variant={oidcForm.enabled ? 'success' : 'outline'}
                shape="chip"
                className="px-2 font-mono text-[10px] tracking-wider uppercase"
              >
                {oidcForm.enabled ? 'enabled' : 'disabled'}
              </Badge>
            </header>

            <div className="p-5 space-y-6">
              {/* Toggle Switch */}
              <div className="flex items-center justify-between p-3 rounded-sm border border-border bg-secondary/20">
                <div>
                  <p className="text-[13px] font-medium text-foreground">
                    Enable OIDC Single Sign-On
                  </p>
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    Enables SSO login button on the login screen for Keycloak, Authentik, Okta,
                    Google, etc.
                  </p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={oidcForm.enabled}
                    onChange={(e) => setOidcForm({ ...oidcForm, enabled: e.target.checked })}
                    className="sr-only peer"
                  />
                  <div className="w-10 h-5 bg-border peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-background peer-checked:after:bg-background after:border-border after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-signal"></div>
                </label>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Field
                  label="Provider Name"
                  hint="Display label for the login button (e.g. Keycloak, Google, SSO)"
                >
                  <input
                    type="text"
                    value={oidcForm.providerName}
                    onChange={(e) => setOidcForm({ ...oidcForm, providerName: e.target.value })}
                    placeholder="Keycloak"
                    className={INPUT_CLASS}
                  />
                </Field>

                <Field label="OIDC Scopes" hint="Space-separated scopes requested from IdP">
                  <input
                    type="text"
                    value={oidcForm.scopes}
                    onChange={(e) => setOidcForm({ ...oidcForm, scopes: e.target.value })}
                    placeholder="openid email profile groups"
                    className={INPUT_CLASS}
                  />
                </Field>
              </div>

              {/* Issuer URL & Live Test */}
              <Field
                label="OIDC Issuer URL"
                hint="Base domain or discovery URL (e.g. https://src.adsdigitalpartner.co.id)"
              >
                <div className="flex gap-2">
                  <input
                    type="url"
                    value={oidcForm.issuerUrl}
                    onChange={(e) => {
                      setOidcForm({ ...oidcForm, issuerUrl: e.target.value });
                      setOidcTestResult(null);
                    }}
                    placeholder="https://src.adsdigitalpartner.co.id"
                    className={INPUT_CLASS}
                  />
                  <button
                    type="button"
                    onClick={() => void handleTestOidc()}
                    disabled={oidcTesting || !oidcForm.issuerUrl.trim()}
                    className="h-9 px-3 inline-flex items-center gap-1.5 text-[11px] font-mono uppercase tracking-wider border border-border rounded-sm text-foreground hover:bg-secondary/40 disabled:opacity-50 transition-colors whitespace-nowrap"
                  >
                    {oidcTesting ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-signal" />
                    ) : (
                      <Globe className="h-3.5 w-3.5 text-signal" />
                    )}
                    test discovery
                  </button>
                </div>
              </Field>

              {/* Test connection alert */}
              {oidcTestResult && (
                <div
                  className={cn(
                    'p-3 border rounded-sm text-[12px] flex items-start gap-2.5',
                    oidcTestResult.success
                      ? 'border-signal/40 bg-signal/10 text-foreground'
                      : 'border-fail/40 bg-fail/10 text-fail'
                  )}
                >
                  {oidcTestResult.success ? (
                    <CheckCircle2 className="h-4 w-4 text-signal shrink-0 mt-0.5" />
                  ) : (
                    <AlertCircle className="h-4 w-4 text-fail shrink-0 mt-0.5" />
                  )}
                  <div className="min-w-0">
                    <p className="font-mono text-[10px] uppercase tracking-wider font-semibold">
                      {oidcTestResult.success ? 'DISCOVERY VERIFIED' : 'DISCOVERY FAILED'}
                    </p>
                    <p className="mt-0.5">{oidcTestResult.message}</p>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Field label="Client ID" hint="Registered OIDC Client ID">
                  <input
                    type="text"
                    value={oidcForm.clientId}
                    onChange={(e) => setOidcForm({ ...oidcForm, clientId: e.target.value })}
                    placeholder="crawlee-cloud"
                    className={INPUT_CLASS}
                  />
                </Field>

                <Field label="Client Secret" hint="OAuth2 client secret key">
                  <div className="flex gap-2">
                    <input
                      type={showOidcSecret ? 'text' : 'password'}
                      value={oidcForm.clientSecret}
                      onChange={(e) => setOidcForm({ ...oidcForm, clientSecret: e.target.value })}
                      placeholder={oidcForm.isSecretSet ? '••••••••' : 'enter client secret'}
                      className={INPUT_CLASS}
                    />
                    <button
                      type="button"
                      onClick={() => setShowOidcSecret((s) => !s)}
                      className="h-9 w-9 grid place-items-center border border-border rounded-sm text-muted-foreground hover:text-foreground"
                    >
                      {showOidcSecret ? (
                        <EyeOff className="h-3.5 w-3.5" />
                      ) : (
                        <Eye className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </div>
                </Field>
              </div>

              <Field
                label="Redirect URI (Callback URL)"
                hint="Set this URI in your OIDC Identity Provider client settings"
              >
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={oidcForm.redirectUri || defaultRedirectUri}
                    onChange={(e) => setOidcForm({ ...oidcForm, redirectUri: e.target.value })}
                    placeholder={defaultRedirectUri}
                    className={INPUT_CLASS}
                  />
                  <button
                    type="button"
                    onClick={() =>
                      void copy(oidcForm.redirectUri || defaultRedirectUri, 'Redirect URI')
                    }
                    className="h-9 w-9 grid place-items-center border border-border rounded-sm text-muted-foreground hover:text-foreground"
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </button>
                </div>
              </Field>

              {/* Role & Team Mapping Sub-section */}
              <div className="pt-4 border-t border-border space-y-4">
                <p className="eyebrow">ROLE &amp; TEAM MAPPING</p>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <Field
                    label="Roles / Groups Claim Path"
                    hint="Claim key in ID token/userinfo (e.g. roles, realm_access.roles, groups)"
                  >
                    <input
                      type="text"
                      value={oidcForm.rolesClaim}
                      onChange={(e) => setOidcForm({ ...oidcForm, rolesClaim: e.target.value })}
                      placeholder="realm_access.roles"
                      className={INPUT_CLASS}
                    />
                  </Field>

                  <Field
                    label="Default Role for New Users"
                    hint="Role assigned if user roles don't match Admin Roles"
                  >
                    <select
                      value={oidcForm.defaultRole}
                      onChange={(e) =>
                        setOidcForm({
                          ...oidcForm,
                          defaultRole: e.target.value as 'admin' | 'user',
                        })
                      }
                      className={cn(INPUT_CLASS, 'cursor-pointer')}
                    >
                      <option value="user">User (Standard Access)</option>
                      <option value="admin">Admin (Full Console Access)</option>
                    </select>
                  </Field>
                </div>

                <Field
                  label="Admin Roles / Teams (Comma-Separated)"
                  hint="Users possessing any of these OIDC roles/groups will automatically receive 'admin' role"
                >
                  <input
                    type="text"
                    value={adminRolesInput}
                    onChange={(e) => setAdminRolesInput(e.target.value)}
                    placeholder="admin, crawlee-admins, DevOps, Platform-Team"
                    className={INPUT_CLASS}
                  />
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {adminRolesInput
                      .split(',')
                      .map((r) => r.trim())
                      .filter(Boolean)
                      .map((role) => (
                        <Badge
                          key={role}
                          variant="outline"
                          shape="chip"
                          className="font-mono text-[10px] bg-secondary/30"
                        >
                          {role} → admin
                        </Badge>
                      ))}
                  </div>
                </Field>

                <div className="flex items-center justify-between p-3 rounded-sm border border-border bg-secondary/10">
                  <div>
                    <p className="text-[13px] font-medium text-foreground">
                      Auto-Register New Users
                    </p>
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      Automatically create an account in the database on first successful SSO login.
                    </p>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      checked={oidcForm.autoRegister}
                      onChange={(e) => setOidcForm({ ...oidcForm, autoRegister: e.target.checked })}
                      className="sr-only peer"
                    />
                    <div className="w-10 h-5 bg-border peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-background peer-checked:after:bg-background after:border-border after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-signal"></div>
                  </label>
                </div>
              </div>

              <div className="pt-2 flex justify-end">
                <button
                  type="button"
                  onClick={() => void handleSaveOidc()}
                  disabled={oidcSaving}
                  className="h-9 px-4 inline-flex items-center gap-2 text-[12px] font-mono uppercase tracking-wider bg-signal text-background hover:brightness-110 rounded-sm disabled:opacity-50 transition-colors"
                >
                  {oidcSaving ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Save className="h-3.5 w-3.5" />
                  )}
                  save oidc settings
                </button>
              </div>
            </div>
          </section>

          {/* ===========================================
          EXECUTION DEFAULTS & LIMITS
          =========================================== */}
          <section className="panel">
            <header className="px-5 py-4 border-b border-border flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Settings2 className="h-4 w-4 text-signal" />
                <div>
                  <p className="eyebrow">SYSTEM · EXECUTION DEFAULTS</p>
                  <h2 className="text-[15px] mt-1">Runtime limits &amp; compute pricing</h2>
                </div>
              </div>
            </header>

            <div className="p-5 space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Field
                  label="Max Concurrent Runs"
                  hint="Max simultaneous actor containers per runner"
                >
                  <input
                    type="number"
                    min="1"
                    max="100"
                    value={executionForm.maxConcurrentRuns}
                    onChange={(e) =>
                      setExecutionForm({
                        ...executionForm,
                        maxConcurrentRuns: parseInt(e.target.value, 10) || 1,
                      })
                    }
                    className={INPUT_CLASS}
                  />
                </Field>

                <Field label="Default Memory Limit (MB)" hint="Default container RAM allocation">
                  <input
                    type="number"
                    min="128"
                    step="128"
                    value={executionForm.defaultMemoryMb}
                    onChange={(e) =>
                      setExecutionForm({
                        ...executionForm,
                        defaultMemoryMb: parseInt(e.target.value, 10) || 512,
                      })
                    }
                    className={INPUT_CLASS}
                  />
                </Field>

                <Field label="Default Timeout (Seconds)" hint="Hard execution limit per actor run">
                  <input
                    type="number"
                    min="10"
                    step="60"
                    value={executionForm.defaultTimeoutSecs}
                    onChange={(e) =>
                      setExecutionForm({
                        ...executionForm,
                        defaultTimeoutSecs: parseInt(e.target.value, 10) || 60,
                      })
                    }
                    className={INPUT_CLASS}
                  />
                </Field>

                <Field label="Apify Compute Unit Price ($/CU)" hint="Used for run cost calculation">
                  <input
                    type="number"
                    min="0"
                    step="0.05"
                    value={executionForm.apifyCuPrice}
                    onChange={(e) =>
                      setExecutionForm({
                        ...executionForm,
                        apifyCuPrice: parseFloat(e.target.value) || 0,
                      })
                    }
                    className={INPUT_CLASS}
                  />
                </Field>
              </div>

              <div className="pt-2 flex justify-end">
                <button
                  type="button"
                  onClick={() => void handleSaveExecution()}
                  disabled={executionSaving}
                  className="h-9 px-4 inline-flex items-center gap-2 text-[12px] font-mono uppercase tracking-wider bg-signal text-background hover:brightness-110 rounded-sm disabled:opacity-50 transition-colors"
                >
                  {executionSaving ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Save className="h-3.5 w-3.5" />
                  )}
                  save execution defaults
                </button>
              </div>
            </div>
          </section>

          {/* ===========================================
          SERVER & INFRASTRUCTURE STATE
          =========================================== */}
          <section className="panel">
            <header className="px-5 py-4 border-b border-border flex items-center gap-3">
              <Server className="h-4 w-4 text-signal" />
              <div>
                <p className="eyebrow">SYSTEM · SERVER</p>
                <h2 className="text-[15px] mt-1">Live state from the API process</h2>
              </div>
            </header>
            {systemError ? (
              <div className="px-5 py-3 text-[12px] text-fail flex items-center gap-2">
                <AlertCircle className="h-3.5 w-3.5" />
                <span>Failed to load: {systemError}</span>
              </div>
            ) : !systemInfo ? (
              <p className="px-5 py-3 text-[12px] text-muted-foreground font-mono">
                [ loading · · · ]
              </p>
            ) : (
              <dl className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-2 px-5 py-4 text-[12px]">
                <ServerStat label="version" value={`v${systemInfo.version}`} />
                <ServerStat label="node" value={systemInfo.nodeVersion} />
                <ServerStat
                  label="scaler"
                  value={
                    systemInfo.scaler.enabled
                      ? `${systemInfo.scaler.provider} · ${systemInfo.scaler.minRunners}–${systemInfo.scaler.maxRunners}`
                      : 'disabled'
                  }
                  tone={systemInfo.scaler.enabled ? 'signal' : 'muted'}
                />
                <ServerStat
                  label="queue"
                  value={`max ${systemInfo.executionDefaults.maxConcurrentRuns} concurrent`}
                />
              </dl>
            )}
          </section>
        </>
      )}

      {/* ===========================================
          API ACCESS TOKENS
          =========================================== */}
      <section className="panel">
        <header className="px-5 py-4 border-b border-border flex items-center gap-3">
          <Shield className="h-4 w-4 text-signal" />
          <div>
            <p className="eyebrow">AUTH · API ACCESS</p>
            <h2 className="text-[15px] mt-1">Connection details &amp; tokens</h2>
          </div>
        </header>

        <div className="p-5 space-y-5">
          {/* Base URL */}
          <Field label="API base URL">
            <div className="flex gap-2">
              <input
                value={API_BASE}
                readOnly
                onClick={(e) => e.currentTarget.select()}
                className="flex-1 h-9 px-3 rounded-sm border border-border bg-input font-mono text-[12px] text-foreground"
              />
              <button
                type="button"
                onClick={() => void copy(API_BASE, 'Base URL')}
                title="Copy"
                className="h-9 w-9 grid place-items-center border border-border rounded-sm text-muted-foreground hover:text-foreground hover:border-signal/40"
              >
                <Copy className="h-3.5 w-3.5" />
              </button>
            </div>
          </Field>

          {/* Newly created key */}
          {newlyCreatedKey && (
            <div className="panel border-l-2 border-l-signal p-4 space-y-3 bg-signal/5">
              <div className="flex items-center justify-between">
                <p className="font-mono text-[10px] tracking-widest text-signal uppercase">
                  [ NEW KEY · COPY NOW ]
                </p>
                <button
                  type="button"
                  onClick={() => setNewlyCreatedKey(null)}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
              <p className="text-[12px] text-muted-foreground">
                This is the only time the key will be shown — store it somewhere safe.
              </p>
              <div className="flex gap-2">
                <input
                  type={showNewKey ? 'text' : 'password'}
                  value={newlyCreatedKey}
                  readOnly
                  onClick={(e) => (e.target as HTMLInputElement).select()}
                  className="flex-1 h-9 px-3 rounded-sm border border-border bg-background font-mono text-[12px] text-foreground"
                />
                <button
                  type="button"
                  title={showNewKey ? 'Hide' : 'Reveal'}
                  onClick={() => setShowNewKey((s) => !s)}
                  className="h-9 w-9 grid place-items-center border border-border rounded-sm text-muted-foreground hover:text-foreground"
                >
                  {showNewKey ? (
                    <EyeOff className="h-3.5 w-3.5" />
                  ) : (
                    <Eye className="h-3.5 w-3.5" />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => void copy(newlyCreatedKey, 'API key')}
                  className="h-9 px-3 inline-flex items-center gap-1.5 text-[11px] font-mono uppercase tracking-wider border border-border rounded-sm text-muted-foreground hover:text-foreground hover:border-signal/40"
                >
                  <Copy className="h-3.5 w-3.5" /> copy
                </button>
              </div>
            </div>
          )}

          {/* Create new key */}
          <Field label="Generate new API key">
            <div className="flex gap-2">
              <input
                value={newKeyName}
                onChange={(e) => setNewKeyName(e.target.value)}
                placeholder="key name (e.g. CLI access)"
                className="flex-1 h-9 px-3 rounded-sm border border-border bg-input text-[13px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-signal/50"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newKeyName.trim()) {
                    e.preventDefault();
                    void handleCreate();
                  }
                }}
              />
              <button
                type="button"
                onClick={() => void handleCreate()}
                disabled={creating || !newKeyName.trim()}
                className="h-9 px-3 inline-flex items-center gap-1.5 text-[12px] font-mono uppercase tracking-wider bg-signal text-background hover:brightness-110 rounded-sm disabled:opacity-50"
              >
                {creating ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Plus className="h-3.5 w-3.5" />
                )}
                generate
              </button>
            </div>
          </Field>

          {/* Existing keys */}
          <div className="space-y-2">
            <p className="font-mono text-[10px] tracking-widest text-muted-foreground uppercase">
              Active keys
            </p>
            {loading ? (
              <p className="text-[12px] text-muted-foreground font-mono">[ loading · · · ]</p>
            ) : apiKeys.filter((k) => k.isActive).length === 0 ? (
              <div className="grid-bg p-8 text-center border border-border rounded-sm">
                <p className="font-mono text-[11px] tracking-widest text-muted-foreground">
                  [ NO API KEYS ]
                </p>
                <p className="text-[12px] text-muted-foreground mt-1">
                  Generate one above to use the CLI or SDKs.
                </p>
              </div>
            ) : (
              <ul className="space-y-1.5">
                {apiKeys
                  .filter((k) => k.isActive)
                  .map((key) => (
                    <li
                      key={key.id}
                      className="flex items-center justify-between p-3 panel hover:bg-secondary/30 transition-colors"
                    >
                      <div className="min-w-0">
                        <p className="text-foreground text-[13px]">{key.name}</p>
                        <p className="font-mono text-[11px] text-muted-foreground mt-0.5">
                          {key.keyPreview}
                          {key.lastUsedAt && (
                            <>
                              <span className="mx-2">·</span>
                              last used {timeAgo(key.lastUsedAt)}
                            </>
                          )}
                        </p>
                      </div>
                      <button
                        type="button"
                        title="Revoke"
                        onClick={() => void handleRevoke(key)}
                        className="h-7 w-7 grid place-items-center text-muted-foreground hover:text-fail border border-transparent hover:border-border rounded-sm"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </li>
                  ))}
              </ul>
            )}
          </div>
        </div>
      </section>

      {/* ===========================================
          APIFY PROXY CREDENTIALS
          =========================================== */}
      <section className="panel">
        <header className="px-5 py-4 border-b border-border flex items-center gap-3">
          <Globe className="h-4 w-4 text-signal" />
          <div>
            <p className="eyebrow">AUTH · APIFY PROXY</p>
            <h2 className="text-[15px] mt-1">Your Apify Proxy password</h2>
          </div>
        </header>

        <div className="p-5 space-y-4">
          {user?.proxy?.password && !proxyReplaceMode ? (
            <div className="flex items-center justify-between">
              <div>
                <Badge variant="success" shape="chip" className="px-2">
                  <CheckCircle2 className="h-3 w-3 mr-1" />
                  <span>set</span>
                </Badge>
                <p className="text-[12px] text-muted-foreground mt-2">
                  Actors using <code>useApifyProxy=true</code> will use this password unless an
                  actor-level override is set.
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setProxyReplaceMode(true)}
                  className="h-9 px-3 inline-flex items-center text-[12px] font-mono uppercase tracking-wider border border-border rounded-sm text-muted-foreground hover:text-foreground hover:border-signal/40"
                >
                  replace
                </button>
                <button
                  type="button"
                  onClick={() => void handleClearProxy()}
                  disabled={proxyBusy}
                  className="h-9 px-3 inline-flex items-center text-[12px] font-mono uppercase tracking-wider border border-border rounded-sm text-fail hover:bg-fail/10 disabled:opacity-50"
                >
                  revoke
                </button>
              </div>
            </div>
          ) : (
            <div>
              {!user?.proxy?.password && (
                <p className="text-[12px] text-muted-foreground mb-3">
                  <span className="font-mono text-[10px] tracking-widest text-fail uppercase">
                    [ not configured ]
                  </span>{' '}
                  Actors with <code>useApifyProxy=true</code> in their input will fail at runtime
                  unless a platform default is set.
                </p>
              )}
              <div className="flex gap-2">
                <input
                  type="password"
                  value={proxyInput}
                  onChange={(e) => setProxyInput(e.target.value)}
                  placeholder="apify proxy password"
                  className={cn(INPUT_CLASS, 'font-mono')}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && proxyInput.trim()) {
                      e.preventDefault();
                      void handleSaveProxy();
                    }
                  }}
                />
                <button
                  type="button"
                  onClick={() => void handleSaveProxy()}
                  disabled={proxyBusy || !proxyInput.trim()}
                  className="h-9 px-3 inline-flex items-center gap-1.5 text-[12px] font-mono uppercase tracking-wider bg-signal text-background hover:brightness-110 rounded-sm disabled:opacity-50"
                >
                  {proxyBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                  save
                </button>
                {proxyReplaceMode && (
                  <button
                    type="button"
                    onClick={() => {
                      setProxyReplaceMode(false);
                      setProxyInput('');
                    }}
                    className="h-9 px-3 inline-flex items-center text-[12px] font-mono uppercase tracking-wider border border-border rounded-sm text-muted-foreground hover:text-foreground"
                  >
                    cancel
                  </button>
                )}
              </div>
              <p className="text-[11px] text-muted-foreground mt-2">
                From Apify Console → Proxy → HTTP settings → password.
              </p>
            </div>
          )}
        </div>
      </section>

      {/* ===========================================
          STORAGE BACKENDS PROBES
          =========================================== */}
      <section className="panel">
        <header className="px-5 py-4 border-b border-border flex items-center gap-3">
          <HardDrive className="h-4 w-4 text-signal" />
          <div>
            <p className="eyebrow">SYSTEM · STORAGE</p>
            <h2 className="text-[15px] mt-1">Live connectivity probes</h2>
          </div>
        </header>
        <ul className="divide-y divide-border">
          {STORAGE_BACKENDS.map((b) => {
            const check = systemInfo?.storage[b.key];
            return (
              <li key={b.label} className="flex items-center justify-between px-5 py-3">
                <div className="min-w-0">
                  <p className="text-foreground text-[13px]">{b.label}</p>
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    {b.description}
                    {check?.latencyMs !== undefined && (
                      <>
                        <span className="mx-2">·</span>
                        <span className="font-mono">{check.latencyMs}ms</span>
                      </>
                    )}
                  </p>
                </div>
                {!systemInfo ? (
                  <Badge variant="outline" shape="chip" className="px-2">
                    <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                    <span>checking</span>
                  </Badge>
                ) : check?.status === 'ok' ? (
                  <Badge variant="success" shape="chip" className="px-2">
                    <CheckCircle2 className="h-3 w-3 mr-1" />
                    <span>connected</span>
                  </Badge>
                ) : (
                  <Badge variant="destructive" shape="chip" className="px-2" title={check?.error}>
                    <AlertCircle className="h-3 w-3 mr-1" />
                    <span>down</span>
                  </Badge>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}

const INPUT_CLASS = cn(
  'w-full h-9 px-3 rounded-sm border border-border bg-input font-mono text-[12px] text-foreground focus:outline-none focus:border-signal/50'
);

const STORAGE_BACKENDS: { key: keyof SystemInfo['storage']; label: string; description: string }[] =
  [
    { key: 'db', label: 'PostgreSQL', description: 'Primary metadata store' },
    { key: 'redis', label: 'Redis', description: 'Job queue · log buffer · cache' },
    { key: 's3', label: 'MinIO / S3', description: 'Dataset items + KV store records' },
  ];

function ServerStat({
  label,
  value,
  tone = 'signal',
}: {
  label: string;
  value: string;
  tone?: 'signal' | 'muted';
}) {
  return (
    <div>
      <dt className="font-mono text-[10px] tracking-widest text-muted-foreground uppercase">
        {label}
      </dt>
      <dd
        className={cn(
          'mt-1 font-mono text-[12px]',
          tone === 'signal' ? 'text-signal' : 'text-muted-foreground'
        )}
      >
        {value}
      </dd>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label className="block font-mono text-[10px] tracking-widest text-muted-foreground uppercase">
        {label}
      </label>
      {children}
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

function timeAgo(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
