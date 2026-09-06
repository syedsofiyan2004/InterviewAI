export interface BreadcrumbItem {
  label: string;
  href?: string;
}

export interface PageMetadata {
  title: string;
  description?: string;
  breadcrumbs: BreadcrumbItem[];
}

export function getPageMetadata(pathname: string): PageMetadata {
  if (pathname === '/') {
    return { title: 'Home', breadcrumbs: [] };
  }

  if (pathname === '/interviews/new') {
    return {
      title: 'HireRite',
      description: 'Scheduled interviews and completed hiring reviews.',
      breadcrumbs: [{ label: 'HireRite', href: '/my-interviews' }],
    };
  }

  if (pathname.startsWith('/interviews/view')) {
    return {
      title: 'HireRite details',
      description: 'Review source material, analysis, and the final report.',
      breadcrumbs: [{ label: 'HireRite', href: '/my-interviews' }, { label: 'Details' }],
    };
  }

  if (pathname === '/interviews') {
    return {
      title: 'HireRite',
      description: 'Scheduled interviews and completed hiring reviews.',
      breadcrumbs: [{ label: 'HireRite', href: '/my-interviews' }],
    };
  }

  if (pathname === '/my-interviews') {
    return {
      title: 'HireRite',
      description: 'Scheduled interviews and completed hiring reviews.',
      breadcrumbs: [{ label: 'HireRite' }],
    };
  }

  if (pathname === '/interviews/intelligence/new') {
    return {
      title: 'New connected workspace',
      description: 'Set up the connected interview record before the meeting.',
      breadcrumbs: [{ label: 'HireRite', href: '/my-interviews' }, { label: 'New workspace' }],
    };
  }

  if (pathname.startsWith('/interviews/intelligence/view')) {
    return {
      title: 'Interview workspace',
      description: 'Prepare, review, approve, and export the interview record.',
      breadcrumbs: [{ label: 'HireRite', href: '/my-interviews' }, { label: 'Workspace' }],
    };
  }

  if (pathname === '/interviews/intelligence') {
    return {
      title: 'HireRite workspaces',
      description: 'Manage connected interview workspaces and reviews.',
      breadcrumbs: [{ label: 'HireRite', href: '/my-interviews' }, { label: 'Workspaces' }],
    };
  }

  if (pathname === '/mom/new') {
    return {
      title: 'New MOM project',
      description: 'Create a project for related meeting reports.',
      breadcrumbs: [{ label: 'MOM projects', href: '/mom' }, { label: 'New project' }],
    };
  }

  if (pathname.startsWith('/mom/project')) {
    return {
      title: 'MOM project',
      description: 'Add, monitor, and review meetings for this project.',
      breadcrumbs: [{ label: 'MOM projects', href: '/mom' }, { label: 'Project' }],
    };
  }

  if (pathname.startsWith('/mom/view')) {
    return {
      title: 'MOM details',
      description: 'Review the meeting analysis and download the report.',
      breadcrumbs: [{ label: 'MOM projects', href: '/mom' }, { label: 'Meeting report' }],
    };
  }

  if (pathname === '/mom') {
    return {
      title: 'MOM projects',
      description: 'Keep meeting reports organized by project.',
      breadcrumbs: [{ label: 'MOM projects' }],
    };
  }

  // --- AWS Cost Calculator --------------------------------------------------
  // Longest-prefix first, like the admin branches below: a bare /calculator test
  // placed above these would swallow /calculator/new and /calculator/view.

  if (pathname === '/calculator/new') {
    return {
      title: 'New estimate',
      description: 'Describe a workload and get a shareable AWS Pricing Calculator estimate.',
      breadcrumbs: [{ label: 'Projects', href: '/calculator' }, { label: 'New estimate' }],
    };
  }

  if (pathname.startsWith('/calculator/view')) {
    return {
      title: 'Estimate details',
      description: 'Cost breakdown, assumptions, and the shareable calculator link.',
      breadcrumbs: [{ label: 'Projects', href: '/calculator' }, { label: 'Estimate' }],
    };
  }

  // Above the bare /calculator/project test, for the same reason the comment at the
  // top of this block gives: the shorter prefix would otherwise swallow this one.
  if (pathname === '/calculator/project/new') {
    return {
      title: 'New project',
      description: 'Group every estimate for one engagement under a single project.',
      breadcrumbs: [{ label: 'Projects', href: '/calculator' }, { label: 'New project' }],
    };
  }

  if (pathname.startsWith('/calculator/project')) {
    return {
      title: 'Project estimates',
      description: 'Every AWS cost estimate built for this project, including revisions.',
      breadcrumbs: [{ label: 'Projects', href: '/calculator' }, { label: 'Project' }],
    };
  }

  if (pathname === '/calculator') {
    return {
      title: 'Projects',
      description: 'AWS cost estimates, grouped by the engagement they were built for.',
      breadcrumbs: [{ label: 'Projects' }],
    };
  }

  // --- Admin portal ---------------------------------------------------------
  // Ordered longest-prefix first so /admin/candidates/view does not fall into
  // the /admin/candidates branch.

  if (pathname.startsWith('/admin/candidates/view')) {
    return {
      title: 'Review workspace',
      description: 'Linked interview rounds, reports, comments, reviewers, and decision history.',
      breadcrumbs: [{ label: 'HireRite', href: '/my-interviews' }, { label: 'Admin', href: '/admin' }, { label: 'All Candidates', href: '/admin/candidates' }, { label: 'Candidate' }],
    };
  }

  if (pathname === '/admin/candidates') {
    return {
      title: 'All Candidates',
      description: 'Every candidate review workspace across the organization.',
      breadcrumbs: [{ label: 'HireRite', href: '/my-interviews' }, { label: 'Admin', href: '/admin' }, { label: 'Review workspaces' }],
    };
  }

  if (pathname === '/admin/search') {
    return {
      title: 'Org-wide search',
      description: 'Search evaluations, meetings, and review workspaces across all owners.',
      breadcrumbs: [{ label: 'Admin', href: '/admin' }, { label: 'Search' }],
    };
  }

  if (pathname === '/admin/interviews') {
    return {
      title: 'Interview reports',
      description: 'Every interview evaluation and downloadable report in the organisation.',
      breadcrumbs: [{ label: 'HireRite', href: '/my-interviews' }, { label: 'Admin', href: '/admin' }, { label: 'Interview reports' }],
    };
  }

  if (pathname === '/admin/moms') {
    return {
      title: 'MOM reports',
      description: 'Every meeting analysis and downloadable PDF report in the organisation.',
      breadcrumbs: [{ label: 'MOM Analyzer', href: '/mom' }, { label: 'Admin', href: '/admin' }, { label: 'MOM reports' }],
    };
  }

  if (pathname === '/admin/calculator') {
    return {
      title: 'Cost estimates',
      description: 'Every AWS cost estimate in the organisation, with its owner and monthly total.',
      breadcrumbs: [{ label: 'Cost Calculator', href: '/calculator' }, { label: 'Admin', href: '/admin' }, { label: 'Cost estimates' }],
    };
  }

  if (pathname === '/admin/approvals') {
    return {
      title: 'Approval Queue',
      description: 'Candidates awaiting a final approve or reject decision.',
      breadcrumbs: [{ label: 'HireRite', href: '/my-interviews' }, { label: 'Admin', href: '/admin' }, { label: 'Decision queue' }],
    };
  }

  if (pathname === '/admin/access') {
    return {
      title: 'Access control',
      description: 'Manage members, admin roles, and access tiers.',
      breadcrumbs: [{ label: 'Admin', href: '/admin' }, { label: 'Access control' }],
    };
  }

  if (pathname.startsWith('/admin/question-bank/view')) {
    return {
      title: 'Question Bank',
      description: 'Edit role competencies and interview questions.',
      breadcrumbs: [{ label: 'HireRite', href: '/my-interviews' }, { label: 'Admin', href: '/admin' }, { label: 'Question Bank', href: '/admin/question-bank' }, { label: 'Role' }],
    };
  }

  if (pathname === '/admin/question-bank') {
    return {
      title: 'Question Bank',
      description: 'Manage role-specific competency overrides and questions.',
      breadcrumbs: [{ label: 'HireRite', href: '/my-interviews' }, { label: 'Admin', href: '/admin' }, { label: 'Question Bank' }],
    };
  }

  if (pathname.startsWith('/admin/conversations/view')) {
    return {
      title: 'Conversation',
      description: 'Every turn of one conversation with the assistant, as it was written.',
      breadcrumbs: [{ label: 'Admin', href: '/admin' }, { label: 'Conversations', href: '/admin/conversations' }, { label: 'Conversation' }],
    };
  }

  if (pathname === '/admin/conversations') {
    return {
      title: 'Conversations',
      description: 'What people asked the assistant about their records, and what it answered.',
      breadcrumbs: [{ label: 'Admin', href: '/admin' }, { label: 'Conversations' }],
    };
  }

  if (pathname === '/admin/audit-log') {
    return {
      title: 'Audit log',
      description: 'Every admin read, download, and decision, newest first.',
      breadcrumbs: [{ label: 'Admin', href: '/admin' }, { label: 'Audit log' }],
    };
  }

  if (pathname === '/admin') {
    return {
      title: 'Admin',
      description: 'Organisation-wide activity at a glance.',
      breadcrumbs: [{ label: 'Admin' }],
    };
  }

  // --- Collaboration --------------------------------------------------------

  if (pathname.startsWith('/candidates/view')) {
    return {
      title: 'Review workspace',
      description: 'Linked interview records, comments, internal reviewers, and decisions.',
      breadcrumbs: [{ label: 'HireRite', href: '/my-interviews' }, { label: 'My Candidates', href: '/candidates' }, { label: 'Workspace' }],
    };
  }

  if (pathname === '/candidates/new') {
    return {
      title: 'Create from interview',
      description: 'Start from HireRite interview records.',
      breadcrumbs: [{ label: 'HireRite', href: '/my-interviews' }, { label: 'My Candidates', href: '/candidates' }, { label: 'Create from interview' }],
    };
  }

  if (pathname === '/candidates') {
    return {
      title: 'My Candidates',
      description: 'Candidate review workspaces you own, with linked interviews and decisions.',
      breadcrumbs: [{ label: 'HireRite', href: '/my-interviews' }, { label: 'My Candidates' }],
    };
  }

  if (pathname === '/shared') {
    return {
      title: 'Shared with me',
      description: 'Interview review workspaces colleagues have shared with you.',
      breadcrumbs: [{ label: 'HireRite', href: '/my-interviews' }, { label: 'Shared with Me' }],
    };
  }

  return { title: 'Workspace', breadcrumbs: [] };
}
