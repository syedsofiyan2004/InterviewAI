'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { api, type QuestionBankItem, type QuestionBankRole } from '@/lib/api';
import { TierGuard } from '@/components/admin/TierGuard';
import { SkeletonList } from '@/components/ui/Skeleton';
import { ArrowLeft, Plus, RefreshCw, Save, Trash2 } from 'lucide-react';

type QuestionDraft = {
  category: string;
  topic_tag: string;
  competency: string;
  question: string;
  follow_ups: string;
  strong_signals: string;
  red_flags: string;
  active: boolean;
};

function lines(value: string): string[] {
  return value
    .split('\n')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function itemToDraft(item?: QuestionBankItem): QuestionDraft {
  return {
    category: item?.category || 'Core Technical/Functional Skills',
    topic_tag: item?.topic_tag || '',
    competency: item?.competency || '',
    question: item?.question || '',
    follow_ups: (item?.follow_ups || []).join('\n'),
    strong_signals: (item?.strong_signals || []).join('\n'),
    red_flags: (item?.red_flags || []).join('\n'),
    active: item?.active ?? true,
  };
}

function draftPayload(draft: QuestionDraft) {
  return {
    category: draft.category.trim(),
    topic_tag: draft.topic_tag.trim() || undefined,
    competency: draft.competency.trim() || undefined,
    question: draft.question.trim(),
    follow_ups: lines(draft.follow_ups),
    strong_signals: lines(draft.strong_signals),
    red_flags: lines(draft.red_flags),
    active: draft.active,
  };
}

function QuestionBankEditor() {
  const searchParams = useSearchParams();
  const roleKey = searchParams.get('id') || '';
  const [role, setRole] = useState<QuestionBankRole | null>(null);
  const [items, setItems] = useState<QuestionBankItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [metaDraft, setMetaDraft] = useState({
    role_title: '',
    department: '',
    experience: '',
    competencies: '',
  });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<QuestionDraft>(itemToDraft());
  const [newDraft, setNewDraft] = useState<QuestionDraft>(itemToDraft());

  const load = useCallback(async () => {
    if (!roleKey) {
      setError('Missing role id.');
      setLoading(false);
      return;
    }
    try {
      setError(null);
      const data = await api.adminGetQuestionBankRole(roleKey);
      setRole(data.role);
      setItems(data.items ?? []);
      setMetaDraft({
        role_title: data.role?.role_title || roleKey,
        department: data.role?.department || '',
        experience: data.role?.experience || '',
        competencies: (data.role?.competencies || []).join('\n'),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load role question bank');
    } finally {
      setLoading(false);
    }
  }, [roleKey]);

  useEffect(() => {
    void load();
  }, [load]);

  const saveMeta = async () => {
    setBusy('meta');
    setError(null);
    setMessage(null);
    try {
      const result = await api.adminUpdateQuestionBankRole(roleKey, {
        role_title: metaDraft.role_title.trim(),
        department: metaDraft.department.trim() || undefined,
        experience: metaDraft.experience.trim() || undefined,
        competencies: lines(metaDraft.competencies),
      });
      setRole(result.role);
      setMessage('Role metadata saved.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save role metadata');
    } finally {
      setBusy(null);
    }
  };

  const addQuestion = async () => {
    setBusy('new');
    setError(null);
    setMessage(null);
    try {
      await api.adminCreateQuestionBankItem(roleKey, draftPayload(newDraft));
      setNewDraft(itemToDraft());
      setMessage('Question added.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add question');
    } finally {
      setBusy(null);
    }
  };

  const saveQuestion = async (questionId: string) => {
    setBusy(questionId);
    setError(null);
    setMessage(null);
    try {
      await api.adminUpdateQuestionBankItem(roleKey, questionId, draftPayload(editDraft));
      setEditingId(null);
      setMessage('Question saved.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save question');
    } finally {
      setBusy(null);
    }
  };

  const toggleQuestion = async (item: QuestionBankItem, active: boolean) => {
    setBusy(item.question_id);
    setError(null);
    setMessage(null);
    try {
      if (!active) {
        await api.adminDeleteQuestionBankItem(roleKey, item.question_id);
        setMessage('Question deactivated.');
      } else {
        await api.adminUpdateQuestionBankItem(roleKey, item.question_id, { active: true });
        setMessage('Question reactivated.');
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Question update failed');
    } finally {
      setBusy(null);
    }
  };

  if (loading) return <SkeletonList rows={5} />;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <Link href="/admin/question-bank" className="btn-secondary inline-flex items-center gap-2 px-3 py-2 text-sm">
          <ArrowLeft size={16} />
          Question Bank
        </Link>
      </div>

      <div className="card p-5">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-accent">Owner configuration</p>
        <h1 className="mt-2 text-xl font-semibold text-text-primary">{role?.role_title || roleKey}</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-text-secondary">
          Edit the visible competency override and the role-specific question pool used by future guide generation.
        </p>
      </div>

      {error && <div className="rounded-xl border border-danger/25 bg-danger/10 p-4 text-sm text-danger">{error}</div>}
      {message && <div className="rounded-xl border border-success/25 bg-success/10 p-4 text-sm text-success">{message}</div>}

      <section className="rounded-xl border border-border bg-surface-elevated p-5">
        <div className="grid gap-4 md:grid-cols-3">
          <label className="text-sm font-medium text-text-primary">
            Role title
            <input
              value={metaDraft.role_title}
              onChange={(event) => setMetaDraft((current) => ({ ...current, role_title: event.target.value }))}
              className="premium-input mt-2 w-full"
            />
          </label>
          <label className="text-sm font-medium text-text-primary">
            Department
            <input
              value={metaDraft.department}
              onChange={(event) => setMetaDraft((current) => ({ ...current, department: event.target.value }))}
              className="premium-input mt-2 w-full"
            />
          </label>
          <label className="text-sm font-medium text-text-primary">
            Experience
            <input
              value={metaDraft.experience}
              onChange={(event) => setMetaDraft((current) => ({ ...current, experience: event.target.value }))}
              className="premium-input mt-2 w-full"
            />
          </label>
        </div>
        <label className="mt-4 block text-sm font-medium text-text-primary">
          Competency override
          <textarea
            value={metaDraft.competencies}
            onChange={(event) => setMetaDraft((current) => ({ ...current, competencies: event.target.value }))}
            rows={5}
            className="premium-input mt-2 w-full resize-y"
            placeholder="One competency per line"
          />
        </label>
        <button
          type="button"
          onClick={() => void saveMeta()}
          disabled={busy === 'meta'}
          className="btn-primary mt-4 inline-flex items-center gap-2 px-3 py-2 text-sm"
        >
          {busy === 'meta' ? <RefreshCw size={16} className="animate-spin" /> : <Save size={16} />}
          Save role
        </button>
      </section>

      <section className="rounded-xl border border-border bg-surface-elevated p-5">
        <h2 className="text-sm font-semibold text-text-primary">Add question</h2>
        <QuestionForm draft={newDraft} onChange={setNewDraft} />
        <button
          type="button"
          onClick={() => void addQuestion()}
          disabled={busy === 'new' || !newDraft.question.trim()}
          className="btn-primary mt-4 inline-flex items-center gap-2 px-3 py-2 text-sm"
        >
          {busy === 'new' ? <RefreshCw size={16} className="animate-spin" /> : <Plus size={16} />}
          Add question
        </button>
      </section>

      <section className="space-y-3">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-text-muted">{items.length} questions</p>
        {items.map((item) => {
          const editing = editingId === item.question_id;
          return (
            <div key={item.question_id} className="rounded-xl border border-border bg-surface-elevated p-4">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-full border border-border bg-surface px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-text-muted">
                      {item.active ? 'Active' : 'Inactive'}
                    </span>
                    <span className="text-xs text-text-muted">{item.category}</span>
                    {item.competency && <span className="text-xs text-accent">{item.competency}</span>}
                  </div>
                  {!editing && <p className="mt-3 text-sm leading-6 text-text-primary">{item.question}</p>}
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setEditingId(editing ? null : item.question_id);
                      setEditDraft(itemToDraft(item));
                    }}
                    className="btn-secondary px-3 py-1.5 text-xs"
                  >
                    {editing ? 'Cancel' : 'Edit'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void toggleQuestion(item, !item.active)}
                    disabled={busy === item.question_id}
                    className="btn-secondary inline-flex items-center gap-1.5 px-3 py-1.5 text-xs"
                  >
                    <Trash2 size={14} />
                    {item.active ? 'Deactivate' : 'Reactivate'}
                  </button>
                </div>
              </div>

              {editing && (
                <div className="mt-4 border-t border-border pt-4">
                  <QuestionForm draft={editDraft} onChange={setEditDraft} includeActive />
                  <button
                    type="button"
                    onClick={() => void saveQuestion(item.question_id)}
                    disabled={busy === item.question_id || !editDraft.question.trim()}
                    className="btn-primary mt-4 inline-flex items-center gap-2 px-3 py-2 text-sm"
                  >
                    {busy === item.question_id ? <RefreshCw size={16} className="animate-spin" /> : <Save size={16} />}
                    Save question
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </section>
    </div>
  );
}

function QuestionForm({
  draft,
  onChange,
  includeActive = false,
}: {
  draft: QuestionDraft;
  onChange: (draft: QuestionDraft) => void;
  includeActive?: boolean;
}) {
  const update = (patch: Partial<QuestionDraft>) => onChange({ ...draft, ...patch });

  return (
    <div className="mt-4 grid gap-4">
      <div className="grid gap-4 md:grid-cols-3">
        <label className="text-sm font-medium text-text-primary">
          Category
          <input value={draft.category} onChange={(event) => update({ category: event.target.value })} className="premium-input mt-2 w-full" />
        </label>
        <label className="text-sm font-medium text-text-primary">
          Topic tag
          <input value={draft.topic_tag} onChange={(event) => update({ topic_tag: event.target.value })} className="premium-input mt-2 w-full" />
        </label>
        <label className="text-sm font-medium text-text-primary">
          Competency
          <input value={draft.competency} onChange={(event) => update({ competency: event.target.value })} className="premium-input mt-2 w-full" />
        </label>
      </div>
      <label className="text-sm font-medium text-text-primary">
        Question
        <textarea value={draft.question} onChange={(event) => update({ question: event.target.value })} rows={4} className="premium-input mt-2 w-full resize-y" />
      </label>
      <div className="grid gap-4 md:grid-cols-3">
        <label className="text-sm font-medium text-text-primary">
          Follow-ups
          <textarea value={draft.follow_ups} onChange={(event) => update({ follow_ups: event.target.value })} rows={5} className="premium-input mt-2 w-full resize-y" />
        </label>
        <label className="text-sm font-medium text-text-primary">
          Strong signals
          <textarea value={draft.strong_signals} onChange={(event) => update({ strong_signals: event.target.value })} rows={5} className="premium-input mt-2 w-full resize-y" />
        </label>
        <label className="text-sm font-medium text-text-primary">
          Red flags
          <textarea value={draft.red_flags} onChange={(event) => update({ red_flags: event.target.value })} rows={5} className="premium-input mt-2 w-full resize-y" />
        </label>
      </div>
      {includeActive && (
        <label className="inline-flex items-center gap-2 text-sm font-medium text-text-primary">
          <input type="checkbox" checked={draft.active} onChange={(event) => update({ active: event.target.checked })} className="h-4 w-4 rounded border-border" />
          Active
        </label>
      )}
    </div>
  );
}

export default function AdminQuestionBankViewPage() {
  return (
    <TierGuard minTier="OWNER">
      <QuestionBankEditor />
    </TierGuard>
  );
}
