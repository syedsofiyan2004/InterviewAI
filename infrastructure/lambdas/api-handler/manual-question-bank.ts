import { ROLE_QUESTION_BANK, RoleQuestionBankEntry } from './minfy-role-question-bank.js';

export type InterviewLevel = 'junior' | 'mid' | 'senior' | 'lead' | 'architect';

/**
 * A role-bank question as the selector consumes it.
 *
 * Extends the shipped static shape with the richer fields an admin can author in
 * the curated bank. All of them are optional: when absent the selector uses its
 * generic phrasing, so the static entries behave exactly as they always have.
 */
export interface RoleBankEntry extends RoleQuestionBankEntry {
  followUps?: string[];
  strongSignals?: string[];
  redFlags?: string[];
  competency?: string;
}

export interface QuestionBankEntry {
  id: string;
  category: string;
  focusArea: string;
  keywords: string[];
  levels: InterviewLevel[];
  question: string;
  followUps: string[];
  strongSignals: string[];
}

export interface SelectedBankQuestion {
  id: string;
  bankQuestionId: string;
  category: string;
  focusArea: string;
  question: string;
  followUps: string[];
  whatToListenFor: string[];
  /** Present only when the curated bank authored them for this question. */
  redFlags?: string[];
  /** Competency this question evidences, when the curator named one. */
  competency?: string;
}

const ALL_LEVELS: InterviewLevel[] = ['junior', 'mid', 'senior', 'lead', 'architect'];

const QUESTION_BANK: QuestionBankEntry[] = [
  {
    id: 'core-role-ownership',
    category: 'Role alignment',
    focusArea: 'Role ownership',
    keywords: [],
    levels: ALL_LEVELS,
    question: 'Tell me about a responsibility closest to this {role} role that you owned end to end. What outcome were you accountable for?',
    followUps: ['What part did you personally deliver?', 'How did you know the outcome was successful?'],
    strongSignals: ['Clear personal ownership', 'Specific outcome or measurable result', 'Understands the boundary between individual and team contribution'],
  },
  {
    id: 'core-problem-solving',
    category: 'Problem solving',
    focusArea: 'Structured problem solving',
    keywords: [],
    levels: ALL_LEVELS,
    question: 'Describe a difficult problem you solved with incomplete information. How did you decide what to investigate first?',
    followUps: ['Which assumption was most risky?', 'What evidence changed your initial approach?'],
    strongSignals: ['Forms and tests hypotheses', 'Prioritizes high-risk unknowns', 'Adjusts decisions when evidence changes'],
  },
  {
    id: 'core-collaboration',
    category: 'Collaboration',
    focusArea: 'Cross-functional collaboration',
    keywords: [],
    levels: ALL_LEVELS,
    question: 'Give an example of a disagreement with a stakeholder or teammate. How did you reach a workable decision?',
    followUps: ['What trade-off did each side accept?', 'What would the other person say about your approach?'],
    strongSignals: ['Listens before proposing', 'Makes trade-offs explicit', 'Preserves trust while resolving conflict'],
  },
  {
    id: 'core-learning',
    category: 'Growth',
    focusArea: 'Learning and reflection',
    keywords: [],
    levels: ALL_LEVELS,
    question: 'Tell me about a decision or implementation that did not work as expected. What did you change afterward?',
    followUps: ['How did you communicate the issue?', 'What guardrail prevents the same problem today?'],
    strongSignals: ['Owns mistakes without deflection', 'Extracts a concrete lesson', 'Turns learning into a repeatable improvement'],
  },
  {
    id: 'leadership-prioritization',
    category: 'Leadership',
    focusArea: 'Prioritization and delegation',
    keywords: ['lead', 'manager', 'principal', 'architect', 'head', 'mentor'],
    levels: ['senior', 'lead', 'architect'],
    question: 'When several important workstreams compete for attention, how do you choose what the team should do first?',
    followUps: ['What do you deliberately defer?', 'How do you make the decision visible to stakeholders?'],
    strongSignals: ['Uses business impact and risk', 'Explains opportunity cost', 'Creates clear ownership and escalation paths'],
  },
  {
    id: 'leadership-technical-direction',
    category: 'Leadership',
    focusArea: 'Technical direction',
    keywords: ['lead', 'principal', 'architect', 'strategy', 'roadmap', 'governance'],
    levels: ['lead', 'architect'],
    question: 'Describe a technical direction you set for multiple teams. How did you gain adoption without becoming a bottleneck?',
    followUps: ['Which standards were mandatory and which were flexible?', 'How did you measure adoption?'],
    strongSignals: ['Balances standards with team autonomy', 'Uses written decision records or governance', 'Measures adoption and outcomes'],
  },
  {
    id: 'aws-architecture',
    category: 'Cloud architecture',
    focusArea: 'AWS architecture',
    keywords: ['aws', 'cloud', 'vpc', 'ec2', 'lambda', 'serverless', 'landing zone'],
    levels: ['mid', 'senior', 'lead', 'architect'],
    question: 'Walk through an AWS architecture you designed or substantially changed. What requirements and failure modes shaped the design?',
    followUps: ['What was the most important trade-off?', 'How would the design behave during a regional or dependency failure?'],
    strongSignals: ['Connects design choices to requirements', 'Explains availability and recovery behavior', 'Considers security, operability, and cost'],
  },
  {
    id: 'aws-operations',
    category: 'Cloud operations',
    focusArea: 'Production operations',
    keywords: ['aws', 'cloudwatch', 'monitoring', 'observability', 'incident', 'on-call', 'sre'],
    levels: ['junior', 'mid', 'senior', 'lead', 'architect'],
    question: 'Describe a production incident you helped resolve. How did you identify the cause and reduce the chance of recurrence?',
    followUps: ['Which signal was most useful?', 'What permanent corrective action followed?'],
    strongSignals: ['Uses evidence and disciplined triage', 'Communicates impact and recovery clearly', 'Separates immediate mitigation from prevention'],
  },
  {
    id: 'security-access',
    category: 'Security',
    focusArea: 'Identity and access',
    keywords: ['iam', 'security', 'identity', 'access', 'rbac', 'oauth', 'cognito', 'entra'],
    levels: ['mid', 'senior', 'lead', 'architect'],
    question: 'How have you designed or reviewed access controls for a production system? Explain how least privilege was enforced and verified.',
    followUps: ['How were emergency access and credential rotation handled?', 'What evidence would an auditor be able to inspect?'],
    strongSignals: ['Uses least privilege and separation of duties', 'Covers lifecycle and auditability', 'Understands operational access, not only initial policy design'],
  },
  {
    id: 'terraform-design',
    category: 'Infrastructure as code',
    focusArea: 'Terraform design',
    keywords: ['terraform', 'infrastructure as code', 'iac', 'cloudformation', 'cdk'],
    levels: ['junior', 'mid', 'senior', 'lead', 'architect'],
    question: 'Explain how you structure infrastructure-as-code so teams can reuse it safely without losing control of production changes.',
    followUps: ['How do you manage state and versioning?', 'How do you handle an existing resource that is not yet in state?'],
    strongSignals: ['Separates reusable modules from environment configuration', 'Understands state safety and imports', 'Uses review, validation, and controlled promotion'],
  },
  {
    id: 'delivery-pipeline',
    category: 'Delivery engineering',
    focusArea: 'CI/CD',
    keywords: ['ci/cd', 'cicd', 'pipeline', 'github actions', 'jenkins', 'devops', 'deployment'],
    levels: ['junior', 'mid', 'senior', 'lead', 'architect'],
    question: 'Describe a delivery pipeline you improved. Which controls gave the team speed without weakening production safety?',
    followUps: ['What happens when a deployment partially fails?', 'Which checks belong before and after deployment?'],
    strongSignals: ['Uses automated quality and security gates', 'Has rollback or roll-forward strategy', 'Measures deployment outcomes'],
  },
  {
    id: 'kubernetes-operations',
    category: 'Platform engineering',
    focusArea: 'Kubernetes',
    keywords: ['kubernetes', 'eks', 'containers', 'docker', 'helm'],
    levels: ['mid', 'senior', 'lead', 'architect'],
    question: 'Describe a Kubernetes workload you operated in production. How did you handle scaling, reliability, and safe configuration changes?',
    followUps: ['How did you diagnose a failing workload?', 'Which settings protected the cluster from a single service?'],
    strongSignals: ['Understands probes, resources, rollout behavior, and observability', 'Can diagnose beyond basic kubectl commands', 'Explains isolation and failure containment'],
  },
  {
    id: 'software-system-design',
    category: 'Software engineering',
    focusArea: 'System design',
    keywords: ['software', 'backend', 'microservices', 'distributed', 'architecture', 'scalability', 'java', 'node.js', 'python', '.net'],
    levels: ['mid', 'senior', 'lead', 'architect'],
    question: 'Choose a system you designed or evolved. How did you divide responsibilities and manage scale, consistency, and failure?',
    followUps: ['Which boundary was hardest to define?', 'What would force you to redesign it?'],
    strongSignals: ['Explains boundaries and data ownership', 'Makes consistency and reliability trade-offs explicit', 'Uses evidence rather than fashionable patterns'],
  },
  {
    id: 'software-debugging',
    category: 'Software engineering',
    focusArea: 'Debugging',
    keywords: ['software', 'developer', 'engineering', 'java', 'javascript', 'typescript', 'python', '.net', 'node.js'],
    levels: ALL_LEVELS,
    question: 'Tell me about a defect that was difficult to reproduce. How did you narrow it down and prove the fix?',
    followUps: ['What instrumentation did you add?', 'How did you prevent regression?'],
    strongSignals: ['Uses a repeatable diagnostic method', 'Separates correlation from cause', 'Adds an appropriate automated regression check'],
  },
  {
    id: 'api-design',
    category: 'Software engineering',
    focusArea: 'API design',
    keywords: ['api', 'rest', 'graphql', 'microservices', 'integration'],
    levels: ['mid', 'senior', 'lead', 'architect'],
    question: 'Describe an API contract you designed for multiple consumers. How did you handle compatibility, errors, and operational visibility?',
    followUps: ['How were breaking changes introduced?', 'How did consumers diagnose failures?'],
    strongSignals: ['Treats compatibility as a product concern', 'Uses consistent error contracts', 'Includes observability, security, and lifecycle management'],
  },
  {
    id: 'frontend-design',
    category: 'Frontend engineering',
    focusArea: 'Frontend architecture',
    keywords: ['frontend', 'react', 'next.js', 'angular', 'vue', 'javascript', 'typescript', 'ui'],
    levels: ['junior', 'mid', 'senior', 'lead', 'architect'],
    question: 'Describe a frontend feature where state, performance, or accessibility made the implementation non-trivial. How did you approach it?',
    followUps: ['How did you measure the user impact?', 'What automated checks protected the behavior?'],
    strongSignals: ['Connects implementation to user experience', 'Explains state and rendering behavior', 'Treats accessibility and testing as engineering requirements'],
  },
  {
    id: 'data-modeling',
    category: 'Data engineering',
    focusArea: 'Data modeling and SQL',
    keywords: ['sql', 'database', 'data model', 'postgres', 'mysql', 'dynamodb', 'warehouse', 'analytics'],
    levels: ['junior', 'mid', 'senior', 'lead', 'architect'],
    question: 'Describe a data model you designed or corrected. Which access patterns and data-quality risks influenced it?',
    followUps: ['What query or scale exposed the original weakness?', 'How did you migrate existing data safely?'],
    strongSignals: ['Designs from access patterns and integrity needs', 'Understands indexing and migration risk', 'Explains consistency and performance trade-offs'],
  },
  {
    id: 'data-pipeline',
    category: 'Data engineering',
    focusArea: 'Data pipelines',
    keywords: ['etl', 'data pipeline', 'spark', 'glue', 'kafka', 'airflow', 'data engineer'],
    levels: ['mid', 'senior', 'lead', 'architect'],
    question: 'Walk through a data pipeline you owned. How did you make failures, retries, and data-quality issues visible and recoverable?',
    followUps: ['How did you handle duplicate or late-arriving data?', 'What service-level objective mattered most?'],
    strongSignals: ['Designs for idempotency and recovery', 'Uses explicit data-quality controls', 'Connects pipeline behavior to consumer expectations'],
  },
  {
    id: 'quality-strategy',
    category: 'Quality engineering',
    focusArea: 'Test strategy',
    keywords: ['qa', 'quality', 'testing', 'automation', 'selenium', 'playwright'],
    levels: ALL_LEVELS,
    question: 'How would you design a test strategy for a high-risk feature when time is limited?',
    followUps: ['Which tests would you deliberately not automate?', 'How do you know the test suite is giving useful confidence?'],
    strongSignals: ['Prioritizes by risk', 'Balances test layers and feedback speed', 'Measures escaped defects and signal quality'],
  },
  {
    id: 'product-prioritization',
    category: 'Product and delivery',
    focusArea: 'Product prioritization',
    keywords: ['product manager', 'product owner', 'roadmap', 'backlog', 'customer discovery'],
    levels: ['mid', 'senior', 'lead', 'architect'],
    question: 'Describe a product decision where customer value, delivery effort, and business risk pointed in different directions. What did you choose?',
    followUps: ['Which evidence carried the most weight?', 'What did you decide not to build?'],
    strongSignals: ['Uses evidence and explicit trade-offs', 'Can say no with rationale', 'Defines how the decision will be validated'],
  },
  {
    id: 'project-delivery',
    category: 'Product and delivery',
    focusArea: 'Project delivery',
    keywords: ['project manager', 'program manager', 'delivery manager', 'scrum', 'agile', 'stakeholder'],
    levels: ALL_LEVELS,
    question: 'Tell me about a delivery that was at risk. How did you expose the risk, reset the plan, and align stakeholders?',
    followUps: ['What leading indicator showed the plan was slipping?', 'Which decision required escalation?'],
    strongSignals: ['Surfaces risk early', 'Creates an actionable recovery plan', 'Communicates decisions and ownership clearly'],
  },
];

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function normalizedWords(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((word) => word.length >= 3 && !['senior', 'junior', 'lead', 'role'].includes(word));
}

function scoreRoleQuestion(entry: RoleQuestionBankEntry, roleTitle: string, jdText: string): number {
  const normalizedRole = roleTitle.trim().toLowerCase().replace(/\s+/g, ' ');
  const normalizedBankRole = entry.jobTitle.trim().toLowerCase().replace(/\s+/g, ' ');
  if (normalizedRole && normalizedRole === normalizedBankRole) return 100;

  const requestedRoleWords = new Set(normalizedWords(roleTitle));
  const bankRoleWords = normalizedWords(entry.jobTitle);
  const overlappingRoleWords = bankRoleWords.filter((word) => requestedRoleWords.has(word)).length;
  if (overlappingRoleWords < 2) return 0;

  const context = `${roleTitle} ${jdText.slice(0, 12000)}`.toLowerCase();
  const topicHits = normalizedWords(entry.topicTag).filter((word) => context.includes(word)).length;
  return overlappingRoleWords * 18 + Math.min(topicHits, 4) * 5;
}

function roleQuestionToSelected(entry: RoleBankEntry): Omit<SelectedBankQuestion, 'id'> {
  return {
    bankQuestionId: `minfy-${entry.id}`,
    category: entry.category,
    focusArea: entry.topicTag,
    question: entry.question,
    // A curator's own follow-ups and signals beat the generic pair. The generic
    // fallback is what made every question show identical "what to listen for".
    followUps: entry.followUps?.length ? entry.followUps : [
      'Could you walk me through the part you personally owned?',
      'What result did you achieve, and how did you measure it?',
    ],
    whatToListenFor: entry.strongSignals?.length ? entry.strongSignals : [
      `Practical experience relevant to ${entry.topicTag}`,
      'Clear decisions, trade-offs, and personal ownership',
      'Specific outcomes, evidence, or lessons learned',
    ],
    redFlags: entry.redFlags?.length ? entry.redFlags : undefined,
    competency: entry.competency || undefined,
  };
}

function selectRoleSpecificQuestions(input: {
  interviewId: string;
  roleTitle: string;
  jdText: string;
  count: number;
  /** Curated pool. Defaults to the shipped bank when none is supplied. */
  rolePool?: RoleBankEntry[];
}): Array<Omit<SelectedBankQuestion, 'id'>> {
  const seenQuestions = new Set<string>();
  const categoryCounts = new Map<string, number>();

  return (input.rolePool?.length ? input.rolePool : ROLE_QUESTION_BANK)
    .map((entry) => ({
      entry,
      score: scoreRoleQuestion(entry, input.roleTitle, input.jdText),
      tieBreaker: stableHash(`${input.interviewId}:${entry.id}`),
    }))
    .filter((candidate) => candidate.score >= 36)
    .sort((left, right) => right.score - left.score || left.tieBreaker - right.tieBreaker)
    .reduce<Array<Omit<SelectedBankQuestion, 'id'>>>((selected, candidate) => {
      if (selected.length >= input.count) return selected;
      const normalizedQuestion = candidate.entry.question.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      if (seenQuestions.has(normalizedQuestion)) return selected;
      const categoryCount = categoryCounts.get(candidate.entry.category) || 0;
      if (categoryCount >= 3) return selected;

      selected.push(roleQuestionToSelected(candidate.entry));
      seenQuestions.add(normalizedQuestion);
      categoryCounts.set(candidate.entry.category, categoryCount + 1);
      return selected;
    }, []);
}

export function detectInterviewLevel(roleTitle: string, jdText: string): InterviewLevel {
  const context = `${roleTitle} ${jdText.slice(0, 6000)}`.toLowerCase();
  if (/\b(chief|principal|enterprise architect|solution architect|solutions architect|staff engineer)\b/.test(context)) return 'architect';
  if (/\b(lead|manager|head|team lead|tech lead|technical lead)\b/.test(context)) return 'lead';
  if (/\b(senior|sr\.?|advanced|specialist)\b/.test(context)) return 'senior';
  if (/\b(junior|jr\.?|associate|graduate|entry.level|fresher|trainee)\b/.test(context)) return 'junior';
  return 'mid';
}

export function selectQuestionsFromBank(input: {
  interviewId: string;
  roleTitle: string;
  jdText: string;
  count?: number;
  /**
   * Focus areas the interviewer chose to cover. When supplied, the bank is
   * filtered to those areas first so the guide stays on the ground the panel
   * actually intends to cover. Falls back to the full bank if the filter would
   * leave too little to build a guide from.
   */
  focusAreas?: string[];
  /**
   * The admin-curated role pool. Omitted (the default) means use the shipped
   * static bank, so behaviour before seeding is identical to today.
   */
  rolePool?: RoleBankEntry[];
}): { level: InterviewLevel; focusAreas: string[]; questions: SelectedBankQuestion[] } {
  const level = detectInterviewLevel(input.roleTitle, input.jdText);
  const normalizedContext = `${input.roleTitle} ${input.jdText}`.toLowerCase();
  // The interviewer owns this number — they know the slot length. Bounded only
  // to keep the prompt and the session sane.
  const desiredCount = Math.max(3, Math.min(input.count || 8, 20));
  const wantedAreas = (input.focusAreas || [])
    .map((area) => area.trim().toLowerCase())
    .filter(Boolean);
  const matchesWantedArea = (area: string) => !wantedAreas.length
    || wantedAreas.includes(String(area || '').trim().toLowerCase());

  const roleSpecificQuestions = selectRoleSpecificQuestions({
    interviewId: input.interviewId,
    roleTitle: input.roleTitle,
    jdText: input.jdText,
    count: Math.min(6, desiredCount),
    rolePool: input.rolePool,
  }).filter((question) => matchesWantedArea(question.focusArea));
  const genericQuestionCount = Math.max(0, desiredCount - roleSpecificQuestions.length);

  const scored = QUESTION_BANK
    .filter((entry) => matchesWantedArea(entry.focusArea))
    .map((entry) => {
      const keywordMatches = entry.keywords.filter((keyword) => normalizedContext.includes(keyword.toLowerCase()));
      const levelScore = entry.levels.includes(level) ? 4 : -3;
      const generalScore = entry.keywords.length === 0 ? 3 : 0;
      return {
        entry,
        score: keywordMatches.length * 8 + levelScore + generalScore,
        tieBreaker: stableHash(`${input.interviewId}:${entry.id}`),
      };
    }).sort((left, right) => right.score - left.score || left.tieBreaker - right.tieBreaker);

  const selected: QuestionBankEntry[] = [];
  const categoryCounts = new Map<string, number>();
  // Allow more per category when a narrow topic set was requested, otherwise a
  // focused interview cannot reach the requested count.
  const perCategoryCap = wantedAreas.length && wantedAreas.length <= 3 ? 5 : 2;
  for (const candidate of scored) {
    if (selected.length >= genericQuestionCount) break;
    const categoryCount = categoryCounts.get(candidate.entry.category) || 0;
    if (categoryCount >= perCategoryCap) continue;
    if (candidate.score < 0 && selected.length >= 6) continue;
    selected.push(candidate.entry);
    categoryCounts.set(candidate.entry.category, categoryCount + 1);
  }

  const genericQuestions = selected.map((entry) => ({
    bankQuestionId: entry.id,
    category: entry.category,
    focusArea: entry.focusArea,
    question: entry.question.replaceAll('{role}', input.roleTitle || 'target'),
    followUps: entry.followUps,
    whatToListenFor: entry.strongSignals,
  }));
  const questions = [...roleSpecificQuestions, ...genericQuestions]
    .slice(0, desiredCount)
    .map((question, index) => ({
      ...question,
      id: `REC-${String(index + 1).padStart(2, '0')}`,
    }));

  return {
    level,
    focusAreas: Array.from(new Set(questions.map((question) => question.focusArea))),
    questions,
  };
}
