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

  if (pathname === '/interviews/intelligence/new') {
    return {
      title: 'New interview workspace',
      description: 'Set up the connected interview record before the meeting.',
      breadcrumbs: [{ label: 'Interview Intelligence', href: '/interviews/intelligence' }, { label: 'New workspace' }],
    };
  }

  if (pathname.startsWith('/interviews/intelligence/view')) {
    return {
      title: 'Interview workspace',
      description: 'Prepare, review, approve, and export the interview record.',
      breadcrumbs: [{ label: 'Interview Intelligence', href: '/interviews/intelligence' }, { label: 'Workspace' }],
    };
  }

  if (pathname === '/interviews/intelligence') {
    return {
      title: 'Interview Intelligence',
      description: 'Manage connected interview workspaces and reviews.',
      breadcrumbs: [{ label: 'Interview Intelligence' }],
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

  return { title: 'Workspace', breadcrumbs: [] };
}
