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
    return { title: 'Dashboard', breadcrumbs: [] };
  }

  if (pathname === '/interviews/new') {
    return {
      title: 'New evaluation',
      description: 'Create an interview evaluation from source material.',
      breadcrumbs: [{ label: 'Evaluations', href: '/interviews' }, { label: 'New evaluation' }],
    };
  }

  if (pathname.startsWith('/interviews/view')) {
    return {
      title: 'Evaluation details',
      description: 'Review source material, analysis, and the final report.',
      breadcrumbs: [{ label: 'Evaluations', href: '/interviews' }, { label: 'Evaluation details' }],
    };
  }

  if (pathname === '/interviews') {
    return {
      title: 'Evaluations',
      description: 'Review candidate evaluations and reports.',
      breadcrumbs: [{ label: 'Evaluations' }],
    };
  }

  if (pathname === '/my-interviews') {
    return {
      title: 'My Interviews',
      description: 'Scheduled Keka rounds assigned to your panel email.',
      breadcrumbs: [{ label: 'My Interviews' }],
    };
  }

  if (pathname === '/interviews/intelligence/new') {
    return {
      title: 'New connected workspace',
      description: 'Set up the connected interview record before the meeting.',
      breadcrumbs: [{ label: 'Evaluations', href: '/interviews' }, { label: 'Connected workspaces', href: '/interviews/intelligence' }, { label: 'New workspace' }],
    };
  }

  if (pathname.startsWith('/interviews/intelligence/view')) {
    return {
      title: 'Interview workspace',
      description: 'Prepare, review, approve, and export the interview record.',
      breadcrumbs: [{ label: 'Evaluations', href: '/interviews' }, { label: 'Connected workspaces', href: '/interviews/intelligence' }, { label: 'Workspace' }],
    };
  }

  if (pathname === '/interviews/intelligence') {
    return {
      title: 'Connected workspaces',
      description: 'Manage connected interview workspaces and reviews.',
      breadcrumbs: [{ label: 'Evaluations', href: '/interviews' }, { label: 'Connected workspaces' }],
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
      breadcrumbs: [{ label: 'Estimates', href: '/calculator' }, { label: 'New estimate' }],
    };
  }

  if (pathname.startsWith('/calculator/view')) {
    return {
      title: 'Estimate details',
      description: 'Cost breakdown, assumptions, and the shareable calculator link.',
      breadcrumbs: [{ label: 'Estimates', href: '/calculator' }, { label: 'Estimate' }],
    };
  }

  if (pathname === '/calculator') {
    return {
      title: 'Estimates',
      description: 'AWS cost estimates built from plain-English workload descriptions.',
      breadcrumbs: [{ label: 'Estimates' }],
    };
  }

  // --- Admin portal ---------------------------------------------------------
  // Ordered longest-prefix first so /admin/candidates/view does not fall into
  // the /admin/candidates branch.

  if (pathname.startsWith('/admin/candidates/view')) {
    return {
      title: 'Review workspace',
      description: 'Linked interview rounds, reports, comments, reviewers, and decision history.',
      breadcrumbs: [{ label: 'Admin', href: '/admin' }, { label: 'All Candidates', href: '/admin/candidates' }, { label: 'Candidate' }],
    };
  }

  if (pathname === '/admin/candidates') {
    return {
      title: 'All Candidates',
      description: 'Every candidate review workspace across the organization.',
      breadcrumbs: [{ label: 'Admin', href: '/admin' }, { label: 'Review workspaces' }],
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
      breadcrumbs: [{ label: 'Admin', href: '/admin' }, { label: 'Interview reports' }],
    };
  }

  if (pathname === '/admin/moms') {
    return {
      title: 'MOM reports',
      description: 'Every meeting analysis and downloadable PDF report in the organisation.',
      breadcrumbs: [{ label: 'Admin', href: '/admin' }, { label: 'MOM reports' }],
    };
  }

  if (pathname === '/admin/calculator') {
    return {
      title: 'Cost estimates',
      description: 'Every AWS cost estimate in the organisation, with its owner and monthly total.',
      breadcrumbs: [{ label: 'Admin', href: '/admin' }, { label: 'Cost estimates' }],
    };
  }

  if (pathname === '/admin/approvals') {
    return {
      title: 'Approval Queue',
      description: 'Candidates awaiting a final approve or reject decision.',
      breadcrumbs: [{ label: 'Admin', href: '/admin' }, { label: 'Decision queue' }],
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
      breadcrumbs: [{ label: 'Admin', href: '/admin' }, { label: 'Question Bank', href: '/admin/question-bank' }, { label: 'Role' }],
    };
  }

  if (pathname === '/admin/question-bank') {
    return {
      title: 'Question Bank',
      description: 'Manage role-specific competency overrides and questions.',
      breadcrumbs: [{ label: 'Admin', href: '/admin' }, { label: 'Question Bank' }],
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
      breadcrumbs: [{ label: 'Review workspaces', href: '/candidates' }, { label: 'Workspace' }],
    };
  }

  if (pathname === '/candidates/new') {
    return {
      title: 'Create from interview',
      description: 'Start a review workspace from manual evaluation or Interview Intelligence.',
      breadcrumbs: [{ label: 'Review workspaces', href: '/candidates' }, { label: 'Create from interview' }],
    };
  }

  if (pathname === '/candidates') {
    return {
      title: 'Review workspaces',
      description: 'Multi-round interview reviews you own or that colleagues shared with you.',
      breadcrumbs: [{ label: 'Review workspaces' }],
    };
  }

  if (pathname === '/shared') {
    return {
      title: 'Shared with me',
      description: 'Interview review workspaces colleagues have shared with you.',
      breadcrumbs: [{ label: 'Shared with me' }],
    };
  }

  return { title: 'Workspace', breadcrumbs: [] };
}
