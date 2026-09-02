'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { format } from 'date-fns';
import { useSearchParams } from 'next/navigation';
import { api, type QuestionBankItem, type QuestionBankRole } from '@/lib/api';
import { TierGuard } from '@/components/admin/TierGuard';
import { SkeletonList } from '@/components/ui/Skeleton';
import { ArrowLeft, Plus, RefreshCw, Save, Search, Sparkles, Trash2 } from 'lucide-react';

/**
 * Owner-facing editor for one role's question pool.
 *
 * The pool is reference material, not a finished guide. Follow-ups, what to listen
 * for and red flags are authored by the model per candidate at generation time, so
 * this form deliberately does not collect them -- asking a curator to hand-write
 * three lists per question was work the platform then overwrote. draftPayload
 * therefore OMITS those keys rather than sending empty arrays: PATCH falls back to
 * the stored value only when a key is absent, so sending [] would erase the seeded
 * bank's own follow-ups on the first edit of a seeded question.
 */

/**
 * The four categories the seeded bank actually uses across all 247 questions.
 * Fixed rather than free text because the selector admits at most THREE questions
 * per category into a single guide -- a typo or a bespoke label silently creates
 * its own bucket and changes how many questions the role contributes.
 */
const QUESTION_CATEGORIES = [
  'Core Technical/Functional Skills',
  'Experience & Project Depth',
  'Scenario / Problem-Solving',
  'Behavioral & Collaboration',
] as const;

const DEFAULT_CATEGORY: string = QUESTION_CATEGORIES[0];

// Mirrors the zod limits in schema/admin.ts so a curator sees the ceiling while
// typing instead of losing a long entry to a 400 on save.
const LIMITS = {
  roleTitle: 200,
  department: 200,
  experience: 100,
  competency: 120,
  topicTag: 120,
  question: 4000,
  competencyLines: 30,
} as const;

// Padding lives here because .premium-input sets only height, border and colour.
// Every other page in the app adds its own px/py; this one did not, which is why
// its labels and values read as one cramped block.
const INPUT = 'premium-input w-full px-3.5 py-2.5 text-sm';
const TEXTAREA = 'premium-input w-full resize-y px-3.5 py-3 text-sm leading-6';
const SELECT = 'premium-input w-full px-3.5 py-2.5 pr-9 text-sm';

type QuestionDraft = {
  category: string;
  topic_tag: string;
  competency: string;
  question: string;
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
    category: item?.category || DEFAULT_CATEGORY,
    topic_tag: item?.topic_tag || '',
    competency: item?.competency || '',
    question: item?.question || '',
    active: item?.active ?? true,
  };
}

/**
 * Only the fields this form owns.
 *
 * The optional ones are sent as empty strings, not omitted. PATCH resolves each
 * field as `parsed.data.x ?? prev.x`, so an absent key means "keep what is stored"
 * -- clearing a topic tag by emptying the box would have silently restored the old
 * value on the next load. An empty string is what actually clears it.
 */
function draftPayload(draft: QuestionDraft, options: { includeActive?: boolean } = {}) {
  return {
    category: draft.category.trim() || DEFAULT_CATEGORY,
    topic_tag: draft.topic_tag.trim(),
    competency: draft.competency.trim(),
    question: draft.question.trim(),
    ...(options.includeActive ? { active: draft.active } : {}),
  };
}

// ---------------------------------------------------------------------------
// Layout primitives. Every control goes through Field, so label, box and hint
// share one vertical rhythm and grid columns line up without per-field tweaking.
// ---------------------------------------------------------------------------

function Section({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-surface-elevated">
      <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 border-b border-border px-5 py-4 md:px-6">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
          <p className="mt-1 max-w-3xl text-xs leading-5 text-text-muted">{description}</p>
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </header>
      <div className="px-5 py-5 md:px-6 md:py-6">{children}</div>
    </section>
  );
}

function Field({
  id,
  label,
  hint,
  required = false,
  counter,
  children,
}: {
  id: string;
  label: string;
  hint: string;
  required?: boolean;
  counter?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-[11px] font-semibold uppercase tracking-[0.09em] text-text-secondary">
          {label}
          {required ? (
            <span className="ml-1 text-accent" title="Required">*</span>
          ) : (
            <span className="ml-2 text-[10px] font-medium normal-case tracking-normal text-text-muted">optional</span>
          )}
        </label>
        {counter && <span className="shrink-0 text-[11px] tabular-nums text-text-muted">{counter}</span>}
      </div>
      {children}
      <p id={`${id}-hint`} className="mt-2 text-xs leading-5 text-text-muted">{hint}</p>
    </div>
  );
}

function Chip({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'accent' | 'warning' }) {
  const tones = {
    muted: 'border-border bg-surface text-text-muted',
    accent: 'border-accent/30 bg-accent/10 text-accent',
    warning: 'border-warning/30 bg-warning/10 text-warning',
  } as const;
  return (
    <span className={`inline-flex max-w-full items-center truncate rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
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
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [showInactive, setShowInactive] = useState(false);

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
      // Empty strings rather than undefined, for the same reason as draftPayload:
      // the role PATCH also resolves each field as `parsed.data.x ?? prev.x`, so an
      // omitted key would make Department and Experience impossible to clear.
      const result = await api.adminUpdateQuestionBankRole(roleKey, {
        role_title: metaDraft.role_title.trim(),
        department: metaDraft.department.trim(),
        experience: metaDraft.experience.trim(),
        competencies: lines(metaDraft.competencies),
      });
      setRole(result.role);
      setMessage('Role details saved.');
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
      setMessage('Question added to the pool.');
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
      await api.adminUpdateQuestionBankItem(roleKey, questionId, draftPayload(editDraft, { includeActive: true }));
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
        setMessage('Question deactivated. It stays here for reference but is never selected.');
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

  const activeCount = useMemo(() => items.filter((item) => item.active).length, [items]);
  const competencyCount = useMemo(() => lines(metaDraft.competencies).length, [metaDraft.competencies]);

  const metaDirty = useMemo(() => {
    if (!role) return true;
    return (
      metaDraft.role_title.trim() !== (role.role_title || '')
      || metaDraft.department.trim() !== (role.department || '')
      || metaDraft.experience.trim() !== (role.experience || '')
      || lines(metaDraft.competencies).join('\n') !== (role.competencies || []).join('\n')
    );
  }, [metaDraft, role]);

  // Any stored category that is off the canonical list stays selectable, so opening
  // a legacy question never silently rewrites its category on save.
  const categoryOptions = useMemo(() => {
    const stored = items.map((item) => item.category).filter(Boolean);
    return Array.from(new Set([...QUESTION_CATEGORIES, ...stored, newDraft.category, editDraft.category].filter(Boolean)));
  }, [items, newDraft.category, editDraft.category]);

  const visibleItems = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return items.filter((item) => {
      if (!showInactive && !item.active) return false;
      if (categoryFilter && item.category !== categoryFilter) return false;
      if (!needle) return true;
      return [item.question, item.competency, item.topic_tag, item.category]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(needle));
    });
  }, [items, search, categoryFilter, showInactive]);

  const metaInvalid = !metaDraft.role_title.trim();
  const newQuestionInvalid = !newDraft.question.trim();

  if (loading) return <SkeletonList rows={5} />;

  return (
    <div className="space-y-6 pb-4">
      <div className="flex items-center justify-between gap-3">
        <Link href="/admin/question-bank" className="btn-secondary inline-flex items-center gap-2 px-3 py-2 text-sm">
          <ArrowLeft size={16} />
          Question Bank
        </Link>
      </div>

      <div className="card p-5 md:p-6">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-accent">Owner configuration</p>
        <h1 className="mt-2 text-xl font-semibold text-text-primary md:text-2xl">{role?.role_title || roleKey}</h1>
        <p className="mt-2.5 max-w-3xl text-sm leading-6 text-text-secondary">
          A reference pool of questions for this role, plus the competency list that overrides what the model
          extracts from a job description. Nothing here reaches a candidate as-is: each generated guide draws from
          this pool and rewrites it for the person being interviewed.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Chip tone="accent">{activeCount} active {activeCount === 1 ? 'question' : 'questions'}</Chip>
          {items.length !== activeCount && <Chip>{items.length - activeCount} inactive</Chip>}
          <Chip>
            {competencyCount
              ? `${competencyCount} competency override${competencyCount === 1 ? '' : 's'}`
              : 'Competencies from AI'}
          </Chip>
          {role?.updated_at ? <Chip>Updated {format(new Date(role.updated_at), 'dd-MM-yyyy')}</Chip> : null}
        </div>
      </div>

      {error && <div className="rounded-xl border border-danger/25 bg-danger/10 p-4 text-sm text-danger">{error}</div>}
      {message && <div className="rounded-xl border border-success/25 bg-success/10 p-4 text-sm text-success">{message}</div>}

      <Section
        title="Role details"
        description="How this pool is identified, and optionally the competencies a panel should probe for this role."
        action={
          <button
            type="button"
            onClick={() => void saveMeta()}
            disabled={busy === 'meta' || metaInvalid || !metaDirty}
            className="btn-primary inline-flex items-center gap-2 px-4 py-2.5 text-sm disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy === 'meta' ? <RefreshCw size={16} className="animate-spin" /> : <Save size={16} />}
            {metaDirty ? 'Save role' : 'Saved'}
          </button>
        }
      >
        <div className="grid gap-x-6 gap-y-5 md:grid-cols-2 xl:grid-cols-3">
          <Field
            id="role-title"
            label="Role title"
            required
            counter={`${metaDraft.role_title.length}/${LIMITS.roleTitle}`}
            hint="Must read the way the job description names this role. Questions are matched to an interview by title, so a retitled role stops contributing its own questions."
          >
            <input
              id="role-title"
              aria-describedby="role-title-hint"
              value={metaDraft.role_title}
              maxLength={LIMITS.roleTitle}
              onChange={(event) => setMetaDraft((current) => ({ ...current, role_title: event.target.value }))}
              className={INPUT}
              placeholder="e.g. Principal Architect"
            />
          </Field>
          <Field
            id="role-department"
            label="Department"
            counter={`${metaDraft.department.length}/${LIMITS.department}`}
            hint="A grouping label, shown on the Question Bank list. It has no effect on which questions get picked."
          >
            <input
              id="role-department"
              aria-describedby="role-department-hint"
              value={metaDraft.department}
              maxLength={LIMITS.department}
              onChange={(event) => setMetaDraft((current) => ({ ...current, department: event.target.value }))}
              className={INPUT}
              placeholder="e.g. Cloud Engineering"
            />
          </Field>
          <Field
            id="role-experience"
            label="Experience"
            counter={`${metaDraft.experience.length}/${LIMITS.experience}`}
            hint="Free text for your own reference, e.g. 15-20 Years. Also display-only."
          >
            <input
              id="role-experience"
              aria-describedby="role-experience-hint"
              value={metaDraft.experience}
              maxLength={LIMITS.experience}
              onChange={(event) => setMetaDraft((current) => ({ ...current, experience: event.target.value }))}
              className={INPUT}
              placeholder="e.g. 15-20 Years"
            />
          </Field>
        </div>

        <div className="mt-6 max-w-4xl">
          <Field
            id="role-competencies"
            label="Competency override"
            counter={`${competencyCount}/${LIMITS.competencyLines} lines`}
            hint="One competency per line. Leave it empty and the model extracts competencies from the job description; add any and yours win for every guide generated against this role. Write capabilities a panel can probe in conversation, 3-60 characters each -- 'Distributed systems design', not a metric or a tool version like '1500+ VM migrations'."
          >
            <textarea
              id="role-competencies"
              aria-describedby="role-competencies-hint"
              value={metaDraft.competencies}
              onChange={(event) => setMetaDraft((current) => ({ ...current, competencies: event.target.value }))}
              rows={6}
              className={TEXTAREA}
              placeholder={'Distributed systems design\nCloud cost governance\nStakeholder influence'}
            />
          </Field>
          {competencyCount > LIMITS.competencyLines && (
            <p className="mt-2 text-xs font-medium text-warning">
              {competencyCount} lines entered. Only {LIMITS.competencyLines} are accepted — remove{' '}
              {competencyCount - LIMITS.competencyLines} before saving.
            </p>
          )}
        </div>

        {metaInvalid && (
          <p className="mt-4 text-xs font-medium text-warning">A role title is required before this can be saved.</p>
        )}
      </Section>

      <Section
        title="Add a question"
        description="Two fields are required: the question itself and its category. The rest sharpens how well the question gets matched to a role."
      >
        <QuestionForm idPrefix="new" draft={newDraft} onChange={setNewDraft} categoryOptions={categoryOptions} />
        <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-5">
          <p className="text-xs text-text-muted">
            {newQuestionInvalid ? 'Enter the question text to enable Add question.' : 'Ready to add.'}
          </p>
          <button
            type="button"
            onClick={() => void addQuestion()}
            disabled={busy === 'new' || newQuestionInvalid}
            className="btn-primary inline-flex items-center gap-2 px-4 py-2.5 text-sm disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy === 'new' ? <RefreshCw size={16} className="animate-spin" /> : <Plus size={16} />}
            Add question
          </button>
        </div>
      </Section>

      <Section
        title={`Questions in this pool (${items.length})`}
        description="Deactivating keeps a question here for reference but removes it from every future guide, including the fuzzy matches made for similarly titled roles."
      >
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
          <div className="relative">
            <Search size={15} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-text-muted" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              aria-label="Search questions"
              placeholder="Search question text, competency or topic tag"
              className="premium-input w-full py-2.5 pl-10 pr-3.5 text-sm"
            />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <select
              value={categoryFilter}
              onChange={(event) => setCategoryFilter(event.target.value)}
              aria-label="Filter by category"
              className="premium-input px-3.5 py-2.5 pr-9 text-sm"
            >
              <option value="">All categories</option>
              {categoryOptions.map((category) => (
                <option key={category} value={category}>{category}</option>
              ))}
            </select>
            <label className="inline-flex cursor-pointer items-center gap-2 text-xs font-medium text-text-secondary">
              <input
                type="checkbox"
                checked={showInactive}
                onChange={(event) => setShowInactive(event.target.checked)}
                className="h-4 w-4 rounded border-border"
              />
              Show inactive
            </label>
          </div>
        </div>

        <p className="mt-4 text-xs text-text-muted">Showing {visibleItems.length} of {items.length}</p>

        <div className="mt-3 space-y-3">
          {visibleItems.length === 0 && (
            <div className="rounded-xl border border-dashed border-border px-4 py-10 text-center">
              <p className="text-sm font-medium text-text-primary">
                {items.length === 0 ? 'No questions in this pool yet' : 'No questions match these filters'}
              </p>
              <p className="mx-auto mt-1 max-w-md text-xs leading-5 text-text-muted">
                {items.length === 0
                  ? 'Add one above. Until then, guides for this role fall back to the shipped question bank.'
                  : 'Clear the search or switch the category filter.'}
              </p>
            </div>
          )}

          {visibleItems.map((item) => {
            const editing = editingId === item.question_id;
            return (
              <div
                key={item.question_id}
                className={`rounded-xl border transition-colors ${
                  editing ? 'border-accent/40' : 'border-border hover:border-border-strong'
                } ${item.active ? 'bg-surface/40' : 'bg-surface/20 opacity-75'}`}
              >
                <div className="flex flex-col gap-4 p-4 md:p-5 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      {item.active ? <Chip tone="accent">Active</Chip> : <Chip tone="warning">Inactive</Chip>}
                      <Chip>{item.category}</Chip>
                      {item.competency && <Chip tone="accent">{item.competency}</Chip>}
                      {item.topic_tag && <Chip>#{item.topic_tag}</Chip>}
                    </div>
                    <p className="mt-3 whitespace-pre-line text-sm leading-6 text-text-primary">{item.question}</p>
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setEditingId(editing ? null : item.question_id);
                        setEditDraft(itemToDraft(item));
                      }}
                      className="btn-secondary px-3 py-2 text-xs"
                    >
                      {editing ? 'Cancel' : 'Edit'}
                    </button>
                    <button
                      type="button"
                      onClick={() => void toggleQuestion(item, !item.active)}
                      disabled={busy === item.question_id}
                      className="btn-secondary inline-flex items-center gap-1.5 px-3 py-2 text-xs disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Trash2 size={14} />
                      {item.active ? 'Deactivate' : 'Reactivate'}
                    </button>
                  </div>
                </div>

                {editing && (
                  <div className="border-t border-border px-4 pb-5 pt-5 md:px-5">
                    <QuestionForm
                      idPrefix={`edit-${item.question_id}`}
                      draft={editDraft}
                      onChange={setEditDraft}
                      categoryOptions={categoryOptions}
                      includeActive
                    />
                    <div className="mt-6 flex flex-wrap items-center justify-end gap-3 border-t border-border pt-5">
                      <button type="button" onClick={() => setEditingId(null)} className="btn-secondary px-4 py-2.5 text-sm">
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={() => void saveQuestion(item.question_id)}
                        disabled={busy === item.question_id || !editDraft.question.trim()}
                        className="btn-primary inline-flex items-center gap-2 px-4 py-2.5 text-sm disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {busy === item.question_id ? <RefreshCw size={16} className="animate-spin" /> : <Save size={16} />}
                        Save question
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Section>
    </div>
  );
}

function QuestionForm({
  idPrefix,
  draft,
  onChange,
  categoryOptions,
  includeActive = false,
}: {
  idPrefix: string;
  draft: QuestionDraft;
  onChange: (draft: QuestionDraft) => void;
  categoryOptions: string[];
  includeActive?: boolean;
}) {
  const update = (patch: Partial<QuestionDraft>) => onChange({ ...draft, ...patch });

  return (
    <div className="grid gap-6">
      <div className="max-w-4xl">
      <Field
        id={`${idPrefix}-question`}
        label="Question"
        required
        counter={`${draft.question.length}/${LIMITS.question}`}
        hint="One question per entry, written the way an interviewer would say it out loud. The model rephrases it for the specific candidate, so keep it general to the role rather than tied to one CV."
      >
        <textarea
          id={`${idPrefix}-question`}
          aria-describedby={`${idPrefix}-question-hint`}
          value={draft.question}
          maxLength={LIMITS.question}
          onChange={(event) => update({ question: event.target.value })}
          rows={4}
          className={TEXTAREA}
          placeholder="e.g. Walk me through a migration you designed where the rollback plan mattered. What would have triggered it?"
        />
      </Field>
      </div>

      <div className="grid gap-x-6 gap-y-5 md:grid-cols-2 xl:grid-cols-3">
        <Field
          id={`${idPrefix}-category`}
          label="Category"
          required
          hint="At most three questions per category reach any one guide, so categories control the mix of an interview. Pick the closest fit rather than inventing a label."
        >
          <select
            id={`${idPrefix}-category`}
            aria-describedby={`${idPrefix}-category-hint`}
            value={draft.category}
            onChange={(event) => update({ category: event.target.value })}
            className={SELECT}
          >
            {categoryOptions.map((category) => (
              <option key={category} value={category}>{category}</option>
            ))}
          </select>
        </Field>
        <Field
          id={`${idPrefix}-competency`}
          label="Competency"
          counter={`${draft.competency.length}/${LIMITS.competency}`}
          hint="The capability this question evidences. It is carried onto the guide as the question's competency label, so it is worth filling in. Ideally one of the competencies set above."
        >
          <input
            id={`${idPrefix}-competency`}
            aria-describedby={`${idPrefix}-competency-hint`}
            value={draft.competency}
            maxLength={LIMITS.competency}
            onChange={(event) => update({ competency: event.target.value })}
            className={INPUT}
            placeholder="e.g. Distributed systems design"
          />
        </Field>
        <Field
          id={`${idPrefix}-topic`}
          label="Topic tag"
          counter={`${draft.topic_tag.length}/${LIMITS.topicTag}`}
          hint="Internal keywords, never shown to a candidate. Words here are matched against the job description to rank this question higher for the right roles — 'Terraform', 'VM migration', 'landing zone'."
        >
          <input
            id={`${idPrefix}-topic`}
            aria-describedby={`${idPrefix}-topic-hint`}
            value={draft.topic_tag}
            maxLength={LIMITS.topicTag}
            onChange={(event) => update({ topic_tag: event.target.value })}
            className={INPUT}
            placeholder="e.g. Terraform, landing zone"
          />
        </Field>
      </div>

      <div className="flex items-start gap-3 rounded-xl border border-info/25 bg-info/10 px-4 py-3.5">
        <Sparkles size={15} className="mt-0.5 shrink-0 text-info" />
        <p className="text-xs leading-5 text-text-secondary">
          <span className="font-semibold text-text-primary">Follow-ups, what to listen for, and red flags are written for you.</span>{' '}
          The model drafts them per candidate each time a guide is generated, which is why there is nothing to fill in
          for them here. Keep this pool as clean reference material — one clear question per entry.
        </p>
      </div>

      {includeActive && (
        <label className="inline-flex cursor-pointer items-center gap-2.5 text-sm font-medium text-text-primary">
          <input
            type="checkbox"
            checked={draft.active}
            onChange={(event) => update({ active: event.target.checked })}
            className="h-4 w-4 rounded border-border"
          />
          Active
          <span className="text-xs font-normal text-text-muted">— inactive questions are never selected for a guide</span>
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
