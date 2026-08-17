'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, type Member, type CognitoUser, type AdminTier, type BaseRole } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';
import { TierGuard } from '@/components/admin/TierGuard';
import { SkeletonList } from '@/components/ui/Skeleton';
import { Toast } from '@/components/ui/Toast';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Users, UserPlus, Info, ShieldOff } from 'lucide-react';

const TIERS: AdminTier[] = ['VIEWER', 'REVIEWER', 'APPROVER', 'OWNER'];

function TierPill({ tier }: { tier: AdminTier | null }) {
  if (!tier) {
    return (
      <span className="rounded-full border border-border bg-surface px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-text-muted">
        No tier
      </span>
    );
  }
  return (
    <span className="rounded-full border border-accent/25 bg-accent/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-accent">
      {tier}
    </span>
  );
}

function AccessControlContent() {
  const { profile } = useAuth();
  const [members, setMembers] = useState<Member[]>([]);
  const [cognitoUsers, setCognitoUsers] = useState<CognitoUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<{ userId: string; label: string } | null>(null);
  const [tab, setTab] = useState<'members' | 'directory'>('members');

  const load = useCallback(async () => {
    try {
      setError(null);
      const [memberData, cognitoData] = await Promise.all([
        api.adminListMembers(),
        api.adminListCognitoUsers(),
      ]);
      setMembers(memberData.items ?? []);
      setCognitoUsers(cognitoData.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load access data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const runAction = async (userId: string, action: () => Promise<unknown>, successMessage: string) => {
    setBusyUserId(userId);
    try {
      await action();
      setToast({ message: successMessage, type: 'success' });
      await load();
    } catch (err) {
      setToast({ message: err instanceof Error ? err.message : 'Action failed', type: 'error' });
    } finally {
      setBusyUserId(null);
    }
  };

  const handleGrant = (userId: string, tier: AdminTier) =>
    runAction(userId, () => api.adminGrantTier(userId, tier), `Granted ${tier.toLowerCase()} access`);

  const handleBaseRole = (userId: string, baseRole: BaseRole, email?: string) =>
    runAction(
      userId,
      () => api.adminChangeBaseRole(userId, baseRole, email),
      baseRole === 'ADMIN'
        ? 'Admin profile ready. Choose an access tier from Members.'
        : 'Role changed to member',
    );

  const handleRevoke = (userId: string) =>
    runAction(userId, () => api.adminRevokeTier(userId), 'Access tier revoked');

  if (loading) return <SkeletonList rows={5} />;

  if (error) {
    return <div className="rounded-xl border border-danger/25 bg-danger/10 p-4 text-sm text-danger">{error}</div>;
  }

  const selfId = profile?.userId;
  const unregistered = cognitoUsers.filter((u) => !u.has_membership);

  return (
    <div className="space-y-5">
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}

      <p className="flex items-start gap-2 rounded-xl border border-border bg-surface-elevated p-3 text-xs text-text-muted">
        <Info size={14} className="mt-0.5 flex-shrink-0" />
        <span>
          Adding an admin profile does not grant access by itself. The user receives access only after an owner
          assigns a tier from the Members tab. You cannot change your own role or tier.
        </span>
      </p>

      <div className="status-tabs" role="tablist" aria-label="Access control views">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'members'}
          data-active={tab === 'members'}
          onClick={() => setTab('members')}
          className="status-tab"
        >
          <Users size={14} className="mr-1.5 inline" />
          Admin members ({members.length})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'directory'}
          data-active={tab === 'directory'}
          onClick={() => setTab('directory')}
          className="status-tab"
        >
          <UserPlus size={14} className="mr-1.5 inline" />
          Signed-in users ({unregistered.length})
        </button>
      </div>

      {tab === 'members' && (
        <div className="space-y-2">
          {members.length === 0 && (
            <p className="card p-6 text-center text-sm text-text-muted">No members yet.</p>
          )}
          {members.map((member) => {
            const isSelf = member.user_id === selfId;
            const busy = busyUserId === member.user_id;
            return (
              <div
                key={member.user_id}
                className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-surface-elevated p-4"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-text-primary">
                    {member.email}
                    {isSelf && <span className="ml-2 text-xs font-normal text-text-muted">(you)</span>}
                  </p>
                  <p className="mt-0.5 flex items-center gap-2 text-xs text-text-muted">
                    <span className="font-semibold uppercase tracking-wide">{member.base_role}</span>
                    <TierPill tier={member.tier} />
                  </p>
                </div>

                {isSelf ? (
                  <p className="text-xs text-text-muted">Ask another owner to change your access.</p>
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="sr-only" htmlFor={`role-${member.user_id}`}>Base role</label>
                    <select
                      id={`role-${member.user_id}`}
                      value={member.base_role}
                      disabled={busy}
                      onChange={(e) => handleBaseRole(member.user_id, e.target.value as BaseRole)}
                      className="premium-input h-10 min-w-[118px] px-3 pr-8 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-55"
                    >
                      <option value="MEMBER">Member</option>
                      <option value="ADMIN">Admin</option>
                    </select>

                    <label className="sr-only" htmlFor={`tier-${member.user_id}`}>Access tier</label>
                    <select
                      id={`tier-${member.user_id}`}
                      value={member.tier ?? ''}
                      disabled={busy || member.base_role !== 'ADMIN'}
                      onChange={(e) => {
                        const value = e.target.value;
                        if (value) handleGrant(member.user_id, value as AdminTier);
                      }}
                      className="premium-input h-10 min-w-[118px] px-3 pr-8 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-55"
                    >
                      <option value="">No tier</option>
                      {TIERS.map((tier) => (
                        <option key={tier} value={tier}>{tier.charAt(0) + tier.slice(1).toLowerCase()}</option>
                      ))}
                    </select>

                    {member.tier && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setConfirmRevoke({ userId: member.user_id, label: member.email })}
                        className="btn-secondary inline-flex h-10 items-center justify-center gap-1.5 px-3 text-sm font-semibold text-text-muted hover:border-danger/35 hover:bg-danger/10 hover:text-danger disabled:cursor-not-allowed disabled:opacity-55"
                      >
                        <ShieldOff size={13} /> Revoke
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {tab === 'directory' && (
        <div className="space-y-2">
          <p className="text-xs text-text-muted">
            Sign-in accounts that have not been added to admin access yet. Add a profile first, then assign the tier from Members.
          </p>
          {unregistered.length === 0 ? (
            <p className="card p-6 text-center text-sm text-text-muted">Every account already has a membership.</p>
          ) : (
            unregistered.map((user) => {
              const busy = busyUserId === user.user_id;
              return (
                <div
                  key={user.user_id}
                  className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-surface-elevated p-4"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-text-primary">{user.email}</p>
                    <p className="mt-0.5 text-xs text-text-muted">
                      {user.status}
                      {!user.enabled && ' - disabled'}
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => handleBaseRole(user.user_id, 'ADMIN', user.email)}
                    className="btn-secondary inline-flex h-10 min-w-[112px] items-center justify-center px-4 text-sm font-semibold"
                  >
                    {busy ? 'Working...' : 'Add profile'}
                  </button>
                </div>
              );
            })
          )}
        </div>
      )}

      {confirmRevoke && (
        <ConfirmDialog
          isOpen
          title="Revoke access tier"
          description={`${confirmRevoke.label} will keep their admin role but lose all admin access until a new tier is granted.`}
          confirmLabel="Revoke"
          onConfirm={() => {
            const userId = confirmRevoke.userId;
            setConfirmRevoke(null);
            void handleRevoke(userId);
          }}
          onCancel={() => setConfirmRevoke(null)}
        />
      )}
    </div>
  );
}

export default function AdminAccessPage() {
  return (
    <TierGuard minTier="OWNER">
      <AccessControlContent />
    </TierGuard>
  );
}
