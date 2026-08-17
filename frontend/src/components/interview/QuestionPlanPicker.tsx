'use client';

import { useEffect, useMemo, useState } from 'react';
import { Check, Loader2, SlidersHorizontal, Info } from 'lucide-react';
import { api } from '@/lib/api';

interface TopicOption {
  topic: string;
  priority: 'high' | 'medium' | 'low';
}

interface QuestionPlanPickerProps {
  intelligenceId: string;
  /** Called with the interviewer's choices once they confirm. */
  onGenerate: (choices: { focus_areas: string[]; question_count: number }) => void;
  busy?: boolean;
  /** Shown as the confirm button label; differs for first run vs regenerate. */
  submitLabel?: string;
}

const PRIORITY_TONE: Record<TopicOption['priority'], string> = {
  high: 'text-success',
  medium: 'text-accent',
  low: 'text-text-muted',
};

/**
 * Lets the interviewer choose which focus areas to cover and how many questions
 * to prepare before the guide is generated.
 *
 * Panels routinely get through far fewer questions than a default-length guide
 * contains, so generating twelve when only five will be asked makes the report
 * look like uncovered ground. The interviewer knows their slot; this asks them.
 */
export function QuestionPlanPicker({
  intelligenceId,
  onGenerate,
  busy = false,
  submitLabel = 'Generate interview guide',
}: QuestionPlanPickerProps) {
  const [topics, setTopics] = useState<TopicOption[]>([]);
  const [previouslyCovered, setPreviouslyCovered] = useState<Array<{ topic: string; round: string }>>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [questionCount, setQuestionCount] = useState(8);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.getQuestionTopics(intelligenceId)
      .then((data) => {
        if (cancelled) return;
        const options = data.topics || [];
        setTopics(options);
        // Default to everything selected so doing nothing matches the old
        // behaviour; narrowing is a deliberate act.
        setSelected(new Set(options.map((option) => option.topic)));
        setPreviouslyCovered(data.previously_covered || []);
        if (data.suggested_question_count) setQuestionCount(data.suggested_question_count);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load interview topics');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [intelligenceId]);

  const coveredByRound = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const entry of previouslyCovered) {
      const rounds = map.get(entry.topic) || [];
      if (!rounds.includes(entry.round)) rounds.push(entry.round);
      map.set(entry.topic, rounds);
    }
    return map;
  }, [previouslyCovered]);

  const toggle = (topic: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(topic)) next.delete(topic);
      else next.add(topic);
      return next;
    });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 rounded-2xl border border-border bg-surface p-8 text-sm text-text-muted">
        <Loader2 size={16} className="animate-spin text-accent" />
        Loading interview topics...
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-2xl border border-danger/25 bg-danger/10 p-4 text-sm text-danger">{error}</div>
    );
  }

  const selectedList = topics.filter((option) => selected.has(option.topic)).map((option) => option.topic);
  const nothingSelected = selectedList.length === 0;

  return (
    <div className="space-y-5 rounded-2xl border border-border bg-surface p-5">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
          <SlidersHorizontal size={17} />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-text-primary">Plan this round</p>
          <p className="mt-1 text-xs leading-5 text-text-muted">
            Pick the areas you intend to cover and how many questions fit your slot. The report records
            your selection, so competencies you did not schedule are not counted against the candidate.
          </p>
        </div>
      </div>

      {previouslyCovered.length > 0 && (
        <div className="flex items-start gap-2 rounded-xl border border-info/25 bg-info/10 p-3">
          <Info size={14} className="mt-0.5 shrink-0 text-info" />
          <p className="text-xs leading-5 text-text-secondary">
            An earlier round already covered{' '}
            <span className="font-semibold text-text-primary">
              {Array.from(coveredByRound.keys()).slice(0, 6).join(', ')}
            </span>
            . Consider choosing different ground for this panel.
          </p>
        </div>
      )}

      <div>
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">
            Focus areas ({selectedList.length} of {topics.length})
          </p>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setSelected(new Set(topics.map((option) => option.topic)))}
              className="text-xs font-semibold text-accent transition-colors hover:underline"
            >
              Select all
            </button>
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="text-xs font-semibold text-text-muted transition-colors hover:text-text-primary"
            >
              Clear
            </button>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          {topics.map((option) => {
            const isSelected = selected.has(option.topic);
            const alreadyCovered = coveredByRound.get(option.topic);
            return (
              <button
                key={option.topic}
                type="button"
                onClick={() => toggle(option.topic)}
                aria-pressed={isSelected}
                title={alreadyCovered ? `Already covered in: ${alreadyCovered.join(', ')}` : undefined}
                className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${
                  isSelected
                    ? 'border-accent/40 bg-accent/10 text-text-primary'
                    : 'border-border bg-surface-elevated text-text-muted hover:border-accent/25 hover:text-text-secondary'
                }`}
              >
                <span
                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors ${
                    isSelected ? 'border-accent bg-accent text-accent-foreground' : 'border-border bg-surface'
                  }`}
                  aria-hidden="true"
                >
                  {isSelected && <Check size={11} strokeWidth={3} />}
                </span>
                <span className="truncate">{option.topic}</span>
                <span className={`text-[10px] font-bold uppercase tracking-wide ${PRIORITY_TONE[option.priority]}`}>
                  {option.priority}
                </span>
                {alreadyCovered && (
                  <span className="rounded-full bg-info/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-info">
                    covered
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <label htmlFor="question-count" className="text-xs font-semibold uppercase tracking-wide text-text-muted">
            Questions to prepare
          </label>
          <div className="mt-2 flex items-center gap-3">
            <input
              id="question-count"
              type="number"
              min={3}
              max={20}
              value={questionCount}
              onChange={(event) => {
                const next = Number(event.target.value);
                if (Number.isFinite(next)) setQuestionCount(next);
              }}
              onBlur={() => setQuestionCount((current) => Math.max(3, Math.min(Math.round(current) || 8, 20)))}
              className="premium-input w-24 px-3 py-2 text-sm"
            />
            <p className="text-xs leading-5 text-text-muted">
              Roughly {Math.round(questionCount * 5)}-{Math.round(questionCount * 7)} min of discussion.
              <br />
              Plus an opening and resume question.
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={() => onGenerate({ focus_areas: selectedList, question_count: questionCount })}
          disabled={busy || nothingSelected}
          className="btn-primary inline-flex h-11 shrink-0 items-center justify-center gap-2 px-5 text-sm font-semibold disabled:opacity-50"
        >
          {busy ? <Loader2 size={15} className="animate-spin" /> : null}
          {busy ? 'Generating...' : submitLabel}
        </button>
      </div>

      {nothingSelected && (
        <p className="text-xs text-warning">Select at least one focus area to generate a guide.</p>
      )}
    </div>
  );
}
