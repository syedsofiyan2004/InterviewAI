'use client';

import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  BrainCircuit,
  CheckCircle2,
  CloudCog,
  Code2,
  Database,
  Download,
  FileCheck2,
  FileSpreadsheet,
  FolderPlus,
  GitBranch,
  LockKeyhole,
  Network,
  Pencil,
  Play,
  RefreshCw,
  Rocket,
  Route,
  Server,
  ShieldCheck,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { api } from '@/lib/api';
import type { TfGithubApplyResult, TfGithubPullRequest, TfGithubSecretsResult, TfGithubTokenVerification, TfJob, TfProject, TfWorkspace } from '@/lib/api';
import {
  generateTfReviewSummary,
  generateTerraformFiles,
  parseTfWorkbook,
  TfFile,
  TfManifest,
  TfReviewSummary,
  TfValidationMessage,
  validateTfManifest,
} from './terraform-workspace';

export default function TfGeneratorPage() {
  const [deployMode, setDeployMode] = useState<'github' | 'direct' | null>(null);
  const [manifest, setManifest] = useState<TfManifest | null>(null);
  const [messages, setMessages] = useState<TfValidationMessage[]>([]);
  const [files, setFiles] = useState<TfFile[]>([]);
  const [selectedFile, setSelectedFile] = useState('provider.tf');
  const [loading, setLoading] = useState(false);
  const [fileName, setFileName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [roleArn, setRoleArn] = useState('');
  const [tfJob, setTfJob] = useState<TfJob | null>(null);
  const [runnerLoading, setRunnerLoading] = useState(false);
  const [runnerError, setRunnerError] = useState<string | null>(null);
  const [repoUrl, setRepoUrl] = useState('');
  const [targetBranch, setTargetBranch] = useState('terraform-network');
  const [githubToken, setGithubToken] = useState('');
  const [githubLoading, setGithubLoading] = useState(false);
  const [githubVerifyLoading, setGithubVerifyLoading] = useState(false);
  const [githubVerification, setGithubVerification] = useState<TfGithubTokenVerification | null>(null);
  const [githubError, setGithubError] = useState<string | null>(null);
  const [githubResult, setGithubResult] = useState<TfGithubPullRequest | null>(null);
  const [awsAccessKeyId, setAwsAccessKeyId] = useState('');
  const [awsSecretAccessKey, setAwsSecretAccessKey] = useState('');
  const [githubSecretsLoading, setGithubSecretsLoading] = useState(false);
  const [githubSecretsError, setGithubSecretsError] = useState<string | null>(null);
  const [githubSecretsResult, setGithubSecretsResult] = useState<TfGithubSecretsResult | null>(null);
  const [githubApplyLoading, setGithubApplyLoading] = useState(false);
  const [githubApplyError, setGithubApplyError] = useState<string | null>(null);
  const [githubApplyResult, setGithubApplyResult] = useState<TfGithubApplyResult | null>(null);
  const [githubDestroyLoading, setGithubDestroyLoading] = useState(false);
  const [githubDestroyError, setGithubDestroyError] = useState<string | null>(null);
  const [githubDestroyResult, setGithubDestroyResult] = useState<TfGithubApplyResult | null>(null);
  const [destroyDialogOpen, setDestroyDialogOpen] = useState(false);
  const [destroyConfirmation, setDestroyConfirmation] = useState('');
  const [projects, setProjects] = useState<TfProject[]>([]);
  const [activeProject, setActiveProject] = useState<TfProject | null>(null);
  const [projectView, setProjectView] = useState<'workspaces' | 'new' | 'workspace'>('workspaces');
  const [projectName, setProjectName] = useState('');
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectSaving, setProjectSaving] = useState(false);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const [editingProjectName, setEditingProjectName] = useState('');
  const [projectActionLoadingId, setProjectActionLoadingId] = useState<string | null>(null);
  const [savedWorkspace, setSavedWorkspace] = useState<TfWorkspace | null>(null);
  const [workspaces, setWorkspaces] = useState<TfWorkspace[]>([]);
  const [workspacesLoading, setWorkspacesLoading] = useState(false);
  const [workspaceOpeningId, setWorkspaceOpeningId] = useState<string | null>(null);
  const [editingWorkspaceId, setEditingWorkspaceId] = useState<string | null>(null);
  const [editingWorkspaceName, setEditingWorkspaceName] = useState('');
  const [workspaceActionLoadingId, setWorkspaceActionLoadingId] = useState<string | null>(null);
  const [workspaceSaving, setWorkspaceSaving] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<null | { type: 'project' | 'workspace'; id: string; name: string }>(null);

  const selected = files.find((file) => file.filename === selectedFile) || files[0];
  const hasErrors = messages.some((message) => message.severity === 'error');
  const hasWarnings = messages.some((message) => message.severity === 'warning');

  const summary = useMemo(() => {
    const regions = Array.from(new Set((manifest?.vpcs || []).map((vpc) => vpc.region).filter(Boolean)));
    const publicSubnets = manifest?.subnets.filter((subnet) => subnet.route_type === 'public').length || 0;
    const privateSubnets = manifest?.subnets.filter((subnet) => subnet.route_type === 'private').length || 0;
    return {
      accounts: manifest?.accounts.length || 0,
      vpcs: manifest?.vpcs.length || 0,
      subnets: manifest?.subnets.length || 0,
      publicSubnets,
      privateSubnets,
      natEnabled: manifest?.vpcs.filter((vpc) => vpc.nat_gateway).length || 0,
      regions,
    };
  }, [manifest]);

  const intakeState = manifest ? 'Workbook parsed' : loading ? 'Reading workbook' : 'Waiting for workbook';
  const reviewState = files.length ? 'Terraform ready' : hasErrors ? 'Fix validation issues' : 'Not generated yet';
  const deployState = tfJob ? humanTfStatus(tfJob.status) : files.length ? 'Ready to create job' : 'Waiting for Terraform';
  const roleArnValid = /^arn:aws:iam::\d{12}:role\/(TerraformDeployRole|MinfyTerraformDeployRole)$/.test(roleArn.trim());
  const githubReady = !!githubVerification?.valid && !!githubToken.trim() && !!repoUrl.trim() && !!targetBranch.trim();
  const githubSecretsDetected = !!githubVerification?.required_secrets_present;
  const githubSecretsReady = githubSecretsDetected || !!githubSecretsResult;
  const githubPullRequestCreated = !!githubResult;
  const githubPrBlocker = !files.length
    ? 'Generate Terraform files from a workbook first.'
    : !repoUrl.trim()
      ? 'Enter the client GitHub repository.'
      : !targetBranch.trim()
        ? 'Enter a branch name.'
        : githubVerifyLoading
          ? 'Checking GitHub token access.'
          : !githubVerification?.valid
            ? 'Paste a token with valid access to this repository.'
            : !githubSecretsReady
              ? 'Save AWS access key and secret key, or use the existing repository secrets detected by the app.'
              : '';
  const reviewSummary = useMemo(() => (
    manifest ? generateTfReviewSummary(manifest, messages) : null
  ), [manifest, messages]);

  useEffect(() => {
    if (!tfJob || !isTfJobRunning(tfJob.status)) return;
    const timer = window.setInterval(async () => {
      try {
        const refreshed = await api.getTfJob(tfJob.job_id);
        setTfJob(refreshed);
      } catch (err: any) {
        setRunnerError(err.message || 'Unable to refresh Terraform job status');
      }
    }, 8000);

    return () => window.clearInterval(timer);
  }, [tfJob?.job_id, tfJob?.status]);

  useEffect(() => {
    refreshProjects();
  }, []);

  useEffect(() => {
    if (!activeProject) {
      setWorkspaces([]);
      return;
    }
    refreshWorkspaces(activeProject.project_id);
  }, [activeProject?.project_id]);

  useEffect(() => {
    const token = githubToken.trim();
    const repository = repoUrl.trim();
    setGithubVerification(null);
    setGithubError(null);
    setGithubSecretsResult(null);
    if (!repository || token.length < 20) {
      setGithubVerifyLoading(false);
      return;
    }

    let cancelled = false;
    setGithubVerifyLoading(true);
    const timer = window.setTimeout(async () => {
      try {
        const result = await api.verifyTfGithubToken({
          repository_url: repository,
          github_token: token,
        });
        if (!cancelled) setGithubVerification(result);
      } catch (err: any) {
        if (!cancelled) setGithubError(err.message || 'Unable to verify GitHub token');
      } finally {
        if (!cancelled) setGithubVerifyLoading(false);
      }
    }, 850);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [repoUrl, githubToken]);

  useEffect(() => {
    setGithubResult(null);
    setGithubApplyResult(null);
    setGithubApplyError(null);
    setGithubDestroyResult(null);
    setGithubDestroyError(null);
    setGithubError(null);
  }, [repoUrl, targetBranch]);

  const downloadFile = (file: TfFile | undefined) => {
    if (!file) return;
    const blob = new Blob([file.content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = file.filename;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const downloadBundle = () => {
    if (!files.length) return;
    const content = files
      .map((file) => `# ===== ${file.filename} =====\n${file.content.trim()}\n`)
      .join('\n\n');
    downloadFile({ filename: `${slugForDownload(manifest?.deployment_name || 'terraform-review')}.tfbundle.txt`, content });
  };

  const handleUpload = async (file: File | null) => {
    if (!file) return;
    setLoading(true);
    setError(null);
    setFiles([]);
    setMessages([]);
    setManifest(null);
    setRoleArn('');
    setTfJob(null);
    setRunnerError(null);
    setGithubError(null);
    setGithubResult(null);
    setGithubVerification(null);
    setGithubSecretsError(null);
    setGithubSecretsResult(null);
    setGithubApplyError(null);
    setGithubApplyResult(null);
    setGithubDestroyError(null);
    setGithubDestroyResult(null);
    setSavedWorkspace(null);
    setWorkspaceError(null);
    setFileName(file.name);

    try {
      const parsed = await parseTfWorkbook(file);
      const validation = validateTfManifest(parsed);
      setManifest(parsed);
      setRoleArn(parsed.accounts.find((account) => account.role_arn)?.role_arn || '');
      setMessages(validation);
      if (!validation.some((message) => message.severity === 'error')) {
        const generated = generateTerraformFiles(parsed);
        setFiles(generated);
        setSelectedFile(generated[0]?.filename || '');
      }
    } catch (err: any) {
      setError(err.message || 'Failed to parse workbook');
    } finally {
      setLoading(false);
    }
  };

  const saveWorkspaceSnapshot = async (parsed: TfManifest, generated: TfFile[]) => {
    if (!activeProject) {
      setWorkspaceError('Create or open a Terraform project before saving a workspace.');
      return;
    }
    setWorkspaceSaving(true);
    setWorkspaceError(null);
    try {
      const workspace = await api.createTfWorkspace({
        project_id: activeProject.project_id,
        deployment_name: parsed.deployment_name,
        primary_region: parsed.primary_region,
        repository_url: repoUrl.trim(),
        branch: targetBranch.trim(),
        files: generated,
        summary: {
          accounts: parsed.accounts.length,
          vpcs: parsed.vpcs.length,
          subnets: parsed.subnets.length,
          regions: Array.from(new Set(parsed.vpcs.map((vpc) => vpc.region).filter(Boolean))),
        },
        source_manifest: parsed as unknown as Record<string, unknown>,
      });
      setSavedWorkspace(workspace);
      setProjectView('workspace');
      setDeployMode(null);
      setWorkspaces((previous) => [workspace, ...previous.filter((item) => item.workspace_id !== workspace.workspace_id)].slice(0, 8));
      setProjects((previous) => previous.map((project) => (
        project.project_id === activeProject.project_id
          ? { ...project, workspace_count: project.workspace_count + 1, updated_at: workspace.updated_at }
          : project
      )));
    } catch (err: any) {
      setWorkspaceError(err.message || 'Terraform workspace could not be saved.');
    } finally {
      setWorkspaceSaving(false);
    }
  };

  const refreshProjects = async () => {
    setProjectsLoading(true);
    setProjectError(null);
    try {
      const result = await api.getTfProjects();
      setProjects(result.items || []);
    } catch (err: any) {
      setProjects([]);
      setProjectError(err.message || 'Terraform projects could not be loaded.');
    } finally {
      setProjectsLoading(false);
    }
  };

  const createProject = async () => {
    const name = projectName.trim();
    if (!name) {
      setProjectError('Enter a project name before creating it.');
      return;
    }
    setProjectSaving(true);
    setProjectError(null);
    try {
      const project = await api.createTfProject({ project_name: name });
      setProjects((previous) => [project, ...previous.filter((item) => item.project_id !== project.project_id)]);
      setActiveProject(project);
      setProjectView(getRequestedTfView());
      setProjectName('');
      setSavedWorkspace(null);
      setWorkspaceError(null);
    } catch (err: any) {
      setProjectError(err.message || 'Terraform project could not be created.');
    } finally {
      setProjectSaving(false);
    }
  };

  const startEditProject = (project: TfProject) => {
    setEditingProjectId(project.project_id);
    setEditingProjectName(project.project_name);
    setProjectError(null);
  };

  const saveProjectEdit = async (project: TfProject) => {
    const name = editingProjectName.trim();
    if (!name) {
      setProjectError('Project name cannot be empty.');
      return;
    }
    setProjectActionLoadingId(project.project_id);
    setProjectError(null);
    try {
      const updated = await api.updateTfProject(project.project_id, {
        project_name: name,
        description: project.description || '',
      });
      setProjects((previous) => previous.map((item) => item.project_id === updated.project_id ? updated : item));
      setActiveProject((current) => current?.project_id === updated.project_id ? updated : current);
      setEditingProjectId(null);
      setEditingProjectName('');
    } catch (err: any) {
      setProjectError(err.message || 'Project could not be updated.');
    } finally {
      setProjectActionLoadingId(null);
    }
  };

  const refreshWorkspaces = async (projectId = activeProject?.project_id) => {
    if (!projectId) {
      setWorkspaces([]);
      return;
    }
    setWorkspacesLoading(true);
    try {
      const result = await api.getTfProjectWorkspaces(projectId);
      setWorkspaces(result.items || []);
    } catch {
      setWorkspaces([]);
    } finally {
      setWorkspacesLoading(false);
    }
  };

  const startEditWorkspace = (workspace: TfWorkspace) => {
    setEditingWorkspaceId(workspace.workspace_id);
    setEditingWorkspaceName(workspace.deployment_name);
    setWorkspaceError(null);
  };

  const saveWorkspaceEdit = async (workspace: TfWorkspace) => {
    const name = editingWorkspaceName.trim();
    if (!name) {
      setWorkspaceError('Workspace name cannot be empty.');
      return;
    }
    setWorkspaceActionLoadingId(workspace.workspace_id);
    setWorkspaceError(null);
    try {
      const updated = await api.updateTfWorkspace(workspace.workspace_id, {
        deployment_name: name,
        repository_url: workspace.repository_url || '',
        branch: workspace.branch || '',
      });
      setWorkspaces((previous) => previous.map((item) => item.workspace_id === updated.workspace_id ? updated : item));
      setSavedWorkspace((current) => current?.workspace_id === updated.workspace_id ? { ...current, ...updated } : current);
      setEditingWorkspaceId(null);
      setEditingWorkspaceName('');
    } catch (err: any) {
      setWorkspaceError(err.message || 'Workspace could not be updated.');
    } finally {
      setWorkspaceActionLoadingId(null);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    if (deleteTarget.type === 'workspace') {
      setWorkspaceActionLoadingId(deleteTarget.id);
      setWorkspaceError(null);
      try {
        await api.deleteTfWorkspace(deleteTarget.id);
        setWorkspaces((previous) => previous.filter((workspace) => workspace.workspace_id !== deleteTarget.id));
        setSavedWorkspace((current) => current?.workspace_id === deleteTarget.id ? null : current);
        setProjects((previous) => previous.map((project) => (
          project.project_id === activeProject?.project_id
            ? { ...project, workspace_count: Math.max(0, project.workspace_count - 1), updated_at: Date.now() }
            : project
        )));
        setDeleteTarget(null);
      } catch (err: any) {
        setWorkspaceError(err.message || 'Workspace could not be deleted.');
      } finally {
        setWorkspaceActionLoadingId(null);
      }
      return;
    }

    setProjectActionLoadingId(deleteTarget.id);
    setProjectError(null);
    try {
      await api.deleteTfProject(deleteTarget.id);
      setProjects((previous) => previous.filter((project) => project.project_id !== deleteTarget.id));
      if (activeProject?.project_id === deleteTarget.id) {
        setActiveProject(null);
        setWorkspaces([]);
        setSavedWorkspace(null);
      }
      setDeleteTarget(null);
    } catch (err: any) {
      setProjectError(err.message || 'Project could not be deleted.');
    } finally {
      setProjectActionLoadingId(null);
    }
  };

  const saveCurrentWorkspace = () => {
    if (!activeProject) {
      setWorkspaceError('Create or open a Terraform project before saving a workspace.');
      return;
    }
    if (!manifest || !files.length) {
      setWorkspaceError('Upload and validate a workbook before creating a workspace.');
      return;
    }
    saveWorkspaceSnapshot(manifest, files);
  };

  const openWorkspace = async (workspace: TfWorkspace) => {
    setWorkspaceOpeningId(workspace.workspace_id);
    setWorkspaceError(null);
    try {
      const detailed = await api.getTfWorkspace(workspace.workspace_id);
      const loadedFiles = detailed.files || [];
      const sourceManifest = detailed.manifest?.source_manifest as TfManifest | undefined;
      if (sourceManifest?.deployment_name) {
        setManifest(sourceManifest);
        setMessages(validateTfManifest(sourceManifest));
      } else {
        setManifest(null);
        setMessages([]);
      }
      setFiles(loadedFiles);
      setSelectedFile(loadedFiles[0]?.filename || '');
      setSavedWorkspace(detailed);
      setProjectView('workspace');
      setDeployMode(null);
      setFileName(`${detailed.deployment_name} workspace`);
      setRepoUrl(detailed.repository_url || repoUrl);
      setTargetBranch(detailed.branch || targetBranch);
      setTfJob(null);
      setGithubResult(null);
      setGithubApplyResult(null);
      setGithubDestroyResult(null);
      setError(null);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err: any) {
      setWorkspaceError(err.message || 'Unable to open Terraform workspace.');
    } finally {
      setWorkspaceOpeningId(null);
    }
  };

  const createDeploymentJob = async () => {
    if (!manifest || !files.length || !roleArnValid) return;
    setRunnerLoading(true);
    setRunnerError(null);
    try {
      const created = await api.createTfJob({
        deployment_name: manifest.deployment_name,
        primary_region: manifest.primary_region,
        role_arn: roleArn.trim(),
        files,
      });
      setTfJob(created);
    } catch (err: any) {
      setRunnerError(err.message || 'Unable to create Terraform deployment job');
    } finally {
      setRunnerLoading(false);
    }
  };

  const runRunnerAction = async (action: 'plan' | 'approve' | 'apply') => {
    if (!tfJob) return;
    setRunnerLoading(true);
    setRunnerError(null);
    try {
      const next = action === 'plan'
        ? await api.runTfPlan(tfJob.job_id)
        : action === 'approve'
          ? await api.approveTfJob(tfJob.job_id)
          : await api.runTfApply(tfJob.job_id);
      setTfJob(next);
    } catch (err: any) {
      setRunnerError(err.message || `Unable to ${action} Terraform job`);
    } finally {
      setRunnerLoading(false);
    }
  };

  const createGithubPullRequest = async () => {
    if (!manifest || !files.length) return;
    if (githubPullRequestCreated) {
      setGithubError(null);
      return;
    }
    if (!githubReady || !githubSecretsReady) {
      setGithubError('Complete workbook upload, GitHub access, and AWS secrets before creating the pull request.');
      return;
    }
    setGithubLoading(true);
    setGithubError(null);
    setGithubResult(null);
    try {
      const result = await api.createTfGithubPullRequest({
        repository_url: repoUrl.trim(),
        branch: targetBranch.trim(),
        github_token: githubToken.trim(),
        deployment_name: manifest.deployment_name,
        primary_region: manifest.primary_region,
        files,
      });
      setGithubResult(result);
    } catch (err: any) {
      setGithubError(err.message || 'Unable to create GitHub pull request');
    } finally {
      setGithubLoading(false);
    }
  };

  const saveGithubSecrets = async () => {
    if (!githubReady) {
      setGithubSecretsError('Enter a repository and a valid GitHub token first.');
      return;
    }
    setGithubSecretsLoading(true);
    setGithubSecretsError(null);
    setGithubSecretsResult(null);
    try {
      const result = await api.updateTfGithubSecrets({
        repository_url: repoUrl.trim(),
        github_token: githubToken.trim(),
        aws_access_key_id: awsAccessKeyId.trim(),
        aws_secret_access_key: awsSecretAccessKey.trim(),
      });
      setGithubSecretsResult(result);
      setAwsAccessKeyId('');
      setAwsSecretAccessKey('');
    } catch (err: any) {
      setGithubSecretsError(err.message || 'Unable to save AWS secrets to GitHub');
    } finally {
      setGithubSecretsLoading(false);
    }
  };

  const startGithubApply = async () => {
    if (!githubReady) {
      setGithubApplyError('Keep the repository and GitHub token available to trigger apply.');
      return;
    }
    setGithubApplyLoading(true);
    setGithubApplyError(null);
    setGithubApplyResult(null);
    try {
      const result = await api.dispatchTfGithubApply({
        repository_url: repoUrl.trim(),
        github_token: githubToken.trim(),
      });
      setGithubApplyResult(result);
    } catch (err: any) {
      setGithubApplyError(err.message || 'Unable to start Terraform apply workflow');
    } finally {
      setGithubApplyLoading(false);
    }
  };

  const startGithubDestroy = async () => {
    if (!githubReady) {
      setGithubDestroyError('Keep the repository and GitHub token available to trigger destroy.');
      return;
    }
    if (destroyConfirmation !== 'DESTROY') {
      setGithubDestroyError('Type DESTROY exactly to confirm this destructive workflow.');
      return;
    }
    setGithubDestroyLoading(true);
    setGithubDestroyError(null);
    setGithubDestroyResult(null);
    try {
      const result = await api.dispatchTfGithubDestroy({
        repository_url: repoUrl.trim(),
        github_token: githubToken.trim(),
        confirmation: destroyConfirmation,
      });
      setGithubDestroyResult(result);
      setDestroyDialogOpen(false);
      setDestroyConfirmation('');
    } catch (err: any) {
      setGithubDestroyError(err.message || 'Unable to start Terraform destroy workflow');
    } finally {
      setGithubDestroyLoading(false);
    }
  };

  const openProject = (project: TfProject) => {
    setActiveProject(project);
    setDeployMode(null);
    setProjectView(getRequestedTfView());
    setManifest(null);
    setMessages([]);
    setFiles([]);
    setSelectedFile('provider.tf');
    setFileName('');
    setSavedWorkspace(null);
    setWorkspaceError(null);
    setError(null);
  };

  const goBackToProjects = () => {
    setActiveProject(null);
    setDeployMode(null);
    setProjectView('workspaces');
    setManifest(null);
    setMessages([]);
    setFiles([]);
    setSelectedFile('provider.tf');
    setFileName('');
    setSavedWorkspace(null);
    setWorkspaceError(null);
    setError(null);
  };

  const startNewWorkspace = () => {
    setProjectView('new');
    setDeployMode(null);
    setManifest(null);
    setMessages([]);
    setFiles([]);
    setSelectedFile('provider.tf');
    setFileName('');
    setSavedWorkspace(null);
    setTfJob(null);
    setGithubResult(null);
    setGithubApplyResult(null);
    setGithubDestroyResult(null);
    setWorkspaceError(null);
    setError(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const projectDashboard = (
    <section className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Projects</h2>
          <p className="mt-1 text-xs text-text-muted">Create a project workspace first. Deployment options appear only after you open a project.</p>
        </div>
      </div>

      <div className="rounded-2xl border border-border bg-surface-elevated p-5">
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_150px]">
          <input
            value={projectName}
            onChange={(event) => setProjectName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') createProject();
            }}
            placeholder="e.g. Client AWS Network"
            className="w-full rounded-xl border border-border bg-surface px-4 py-3 text-sm text-text-primary outline-none transition-colors focus:border-accent"
          />
          <button
            type="button"
            onClick={createProject}
            disabled={projectSaving || !projectName.trim()}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-4 py-3 text-sm font-semibold text-accent-foreground shadow-sm shadow-accent/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {projectSaving ? <RefreshCw size={16} className="animate-spin" /> : <FolderPlus size={16} />}
            Create
          </button>
        </div>
        {projectError && <Notice tone="error" title="Project issue" detail={projectError} />}
      </div>

      {projectsLoading ? (
        <div className="grid gap-4 md:grid-cols-2">
          {Array.from({ length: 2 }).map((_, index) => (
            <div key={index} className="h-36 animate-pulse rounded-xl border border-border bg-surface-elevated" />
          ))}
        </div>
      ) : projects.length ? (
        <div className="grid gap-4 md:grid-cols-2">
          {projects.map((project) => (
            <div key={project.project_id} className="rounded-xl border border-border bg-surface-elevated p-5 transition-all hover:-translate-y-0.5">
              {editingProjectId === project.project_id ? (
                <div className="space-y-3">
                  <input
                    value={editingProjectName}
                    onChange={(event) => setEditingProjectName(event.target.value)}
                    className="w-full rounded-xl border border-border bg-surface px-4 py-3 text-sm text-text-primary outline-none focus:border-accent"
                  />
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => saveProjectEdit(project)}
                      disabled={projectActionLoadingId === project.project_id}
                      className="rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-accent-foreground disabled:opacity-50"
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setEditingProjectId(null);
                        setEditingProjectName('');
                      }}
                      className="rounded-lg border border-border bg-surface px-4 py-2.5 text-sm font-semibold text-text-primary"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <button type="button" onClick={() => openProject(project)} className="block w-full text-left">
                    <div className="flex items-start gap-3">
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
                        <FolderPlus size={19} />
                      </span>
                      <div className="min-w-0">
                        <h3 className="truncate text-base font-semibold text-text-primary">{project.project_name}</h3>
                        <p className="mt-1 text-xs text-text-muted">{project.workspace_count} saved workspace{project.workspace_count === 1 ? '' : 's'}</p>
                      </div>
                    </div>
                  </button>
                  <div className="mt-5 grid grid-cols-3 gap-2">
                    <button type="button" onClick={() => openProject(project)} className="rounded-lg border border-border bg-surface px-3 py-2 text-xs font-semibold text-text-primary hover:border-accent/50">
                      Open
                    </button>
                    <button type="button" onClick={() => startEditProject(project)} className="inline-flex items-center justify-center gap-1 rounded-lg border border-border bg-surface px-3 py-2 text-xs font-semibold text-text-primary hover:border-accent/50">
                      <Pencil size={12} />
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => setDeleteTarget({ type: 'project', id: project.project_id, name: project.project_name })}
                      disabled={projectActionLoadingId === project.project_id}
                      className="inline-flex items-center justify-center gap-1 rounded-lg border border-danger/25 bg-danger/5 px-3 py-2 text-xs font-semibold text-danger disabled:opacity-50"
                    >
                      <Trash2 size={12} />
                      Delete
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-border bg-surface-elevated px-6 py-16 text-center">
          <FolderPlus size={34} className="mx-auto text-accent" />
          <p className="mt-4 text-sm font-semibold text-text-primary">No projects yet</p>
          <p className="mt-1 text-xs text-text-muted">Create one project workspace to begin.</p>
        </div>
      )}
    </section>
  );

  const savedWorkspacesPanel = (
    <section className="rounded-2xl border border-border bg-surface-elevated p-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-text-primary">Saved workspaces</h2>
          <p className="mt-1 text-xs text-text-muted">Open, rename, or delete saved Terraform packages for this project.</p>
        </div>
        <button
          type="button"
          onClick={() => refreshWorkspaces()}
          className="rounded-lg border border-border bg-surface p-2 text-text-secondary hover:text-text-primary"
          title="Refresh workspaces"
        >
          <RefreshCw size={15} className={workspacesLoading ? 'animate-spin' : ''} />
        </button>
      </div>
      {workspaceError && <Notice tone="error" title="Workspace issue" detail={workspaceError} />}
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        {workspacesLoading ? (
          <div className="rounded-xl border border-border bg-surface p-4 text-sm text-text-muted">Loading workspaces...</div>
        ) : workspaces.length ? (
          workspaces.map((workspace) => (
            <div key={workspace.workspace_id} className="rounded-xl border border-border bg-surface p-4">
              {editingWorkspaceId === workspace.workspace_id ? (
                <div className="space-y-3">
                  <input
                    value={editingWorkspaceName}
                    onChange={(event) => setEditingWorkspaceName(event.target.value)}
                    className="w-full rounded-xl border border-border bg-background px-4 py-3 text-sm text-text-primary outline-none focus:border-accent"
                  />
                  <div className="grid grid-cols-2 gap-2">
                    <button type="button" onClick={() => saveWorkspaceEdit(workspace)} disabled={workspaceActionLoadingId === workspace.workspace_id} className="rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-accent-foreground disabled:opacity-50">
                      Save
                    </button>
                    <button type="button" onClick={() => { setEditingWorkspaceId(null); setEditingWorkspaceName(''); }} className="rounded-lg border border-border bg-background px-4 py-2.5 text-sm font-semibold text-text-primary">
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <button type="button" onClick={() => openWorkspace(workspace)} className="block w-full text-left">
                    <p className="truncate text-sm font-semibold text-text-primary">{workspace.deployment_name}</p>
                    <p className="mt-1 text-xs text-text-muted">{workspace.file_count} files · {workspace.primary_region}</p>
                  </button>
                  <div className="mt-4 grid grid-cols-3 gap-2">
                    <button type="button" onClick={() => openWorkspace(workspace)} disabled={workspaceOpeningId === workspace.workspace_id} className="rounded-lg border border-border bg-background px-3 py-2 text-xs font-semibold text-text-primary hover:border-accent/50 disabled:opacity-50">
                      Open
                    </button>
                    <button type="button" onClick={() => startEditWorkspace(workspace)} className="inline-flex items-center justify-center gap-1 rounded-lg border border-border bg-background px-3 py-2 text-xs font-semibold text-text-primary hover:border-accent/50">
                      <Pencil size={12} />
                      Edit
                    </button>
                    <button type="button" onClick={() => setDeleteTarget({ type: 'workspace', id: workspace.workspace_id, name: workspace.deployment_name })} disabled={workspaceActionLoadingId === workspace.workspace_id} className="inline-flex items-center justify-center gap-1 rounded-lg border border-danger/25 bg-danger/5 px-3 py-2 text-xs font-semibold text-danger disabled:opacity-50">
                      <Trash2 size={12} />
                      Delete
                    </button>
                  </div>
                </>
              )}
            </div>
          ))
        ) : (
          <div className="rounded-xl border border-dashed border-border bg-surface/60 p-5 text-sm text-text-muted md:col-span-2">
            No saved Terraform workspaces yet.
          </div>
        )}
      </div>
    </section>
  );

  const workbookIntake = (
    <section className="rounded-2xl border border-border bg-surface-elevated p-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-accent">Workbook</p>
          <h2 className="mt-1 text-lg font-semibold text-text-primary">{fileName || 'Upload Excel workbook'}</h2>
          <p className="mt-1 text-sm text-text-muted">Terraform is generated only after validation passes.</p>
        </div>
        <label className="inline-flex cursor-pointer items-center justify-center gap-2 rounded-lg bg-accent px-4 py-3 text-sm font-semibold text-accent-foreground shadow-sm shadow-accent/20">
          <Upload size={16} />
          Upload Excel
          <input
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="hidden"
            onChange={(event) => handleUpload(event.target.files?.[0] || null)}
          />
        </label>
      </div>
      {loading && <Notice tone="info" title="Parsing workbook" detail="Building the deployment manifest and Terraform review bundle." />}
      {error && <Notice tone="error" title="Workbook could not be parsed" detail={error} />}
      {workspaceSaving && <Notice tone="info" title="Saving workspace" detail="Storing the generated Terraform files for future review and change requests." />}
      {savedWorkspace && <Notice tone="info" title="Workspace saved" detail={`${savedWorkspace.deployment_name} is stored under ${activeProject?.project_name}.`} />}
      {workspaceError && <Notice tone="error" title="Workspace issue" detail={workspaceError} />}
      {files.length > 0 && (
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface p-4">
          <div>
            <p className="text-sm font-semibold text-text-primary">Terraform package ready</p>
            <p className="mt-1 text-xs text-text-muted">{files.length} files generated from {manifest?.deployment_name || 'workbook'}.</p>
          </div>
          <button
            type="button"
            disabled={!manifest || !files.length || workspaceSaving}
            onClick={saveCurrentWorkspace}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-accent-foreground shadow-sm shadow-accent/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {workspaceSaving ? <RefreshCw size={16} className="animate-spin" /> : <Database size={16} />}
            Save workspace
          </button>
        </div>
      )}
    </section>
  );

  const reviewPanels = files.length > 0 && (
    <>
      <section className="grid gap-5 xl:grid-cols-[390px_minmax(0,1fr)]">
        <div className="grid grid-cols-2 gap-3">
          <Metric title="Accounts" value={summary.accounts} icon={ShieldCheck} caption="Context only" />
          <Metric title="Regions" value={summary.regions.length} icon={Server} caption={summary.regions[0] || 'None'} />
          <Metric title="VPCs" value={summary.vpcs} icon={Network} caption={`${summary.natEnabled} NAT enabled`} />
          <Metric title="Subnets" value={summary.subnets} icon={Route} caption={`${summary.publicSubnets} public / ${summary.privateSubnets} private`} />
        </div>
        <div className="space-y-5">
          {reviewSummary && <ReviewAssistant summary={reviewSummary} />}
          {messages.length > 0 && (
            <div className="card p-5">
              <div className="flex items-center gap-2">
                {hasErrors ? <AlertTriangle size={18} className="text-danger" /> : <CheckCircle2 size={18} className="text-success" />}
                <h2 className="text-base font-semibold text-text-primary">Validation</h2>
              </div>
              <div className="mt-4 grid gap-3 lg:grid-cols-2">
                {messages.map((message, index) => <ValidationCard key={`${message.title}-${index}`} message={message} />)}
              </div>
            </div>
          )}
        </div>
      </section>

      <section className="card overflow-hidden">
        <div className="flex flex-col gap-4 border-b border-border px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <Code2 size={18} className="text-accent" />
              <h2 className="text-base font-semibold text-text-primary">Terraform review</h2>
            </div>
            <p className="mt-1 text-xs text-text-muted">Review generated source before deployment.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => downloadFile(selected)} className="inline-flex items-center justify-center gap-2 rounded-lg border border-border bg-surface px-4 py-2.5 text-sm font-semibold text-text-primary">
              <Download size={16} />
              Download file
            </button>
            <button type="button" onClick={downloadBundle} className="inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-accent-foreground">
              <Download size={16} />
              Download bundle
            </button>
          </div>
        </div>
        <div className="grid min-h-[420px] grid-cols-1 lg:grid-cols-[250px_1fr]">
          <aside className="border-b border-border bg-surface/80 p-3 lg:border-b-0 lg:border-r">
            <div className="space-y-1">
              {files.map((file) => (
                <button key={file.filename} onClick={() => setSelectedFile(file.filename)} className={`flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-medium ${selected?.filename === file.filename ? 'bg-accent/10 text-accent' : 'text-text-secondary hover:bg-surface-elevated hover:text-text-primary'}`}>
                  <span>{file.filename}</span>
                  {selected?.filename === file.filename && <ArrowRight size={14} />}
                </button>
              ))}
            </div>
          </aside>
          <pre className="overflow-auto bg-[#07111f] p-5 text-xs leading-6 text-slate-100">
            <code>{selected?.content || ''}</code>
          </pre>
        </div>
      </section>
    </>
  );

  const deleteDialog = deleteTarget && (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 px-4 py-6 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-2xl border border-danger/25 bg-background p-5 shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-danger">Delete {deleteTarget.type}</p>
            <h2 className="mt-2 text-2xl font-semibold text-text-primary">{deleteTarget.name}</h2>
          </div>
          <button type="button" onClick={() => setDeleteTarget(null)} className="rounded-lg border border-border bg-surface p-2 text-text-secondary hover:text-text-primary" aria-label="Close delete confirmation">
            <X size={18} />
          </button>
        </div>
        <p className="mt-4 text-sm leading-6 text-text-secondary">
          {deleteTarget.type === 'project'
            ? 'This deletes the project and saved Terraform workspaces in the platform. It does not delete deployed AWS resources or client GitHub repositories.'
            : 'This deletes the saved workspace in the platform. It does not delete deployed AWS resources or client GitHub repositories.'}
        </p>
        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <button type="button" onClick={() => setDeleteTarget(null)} className="inline-flex items-center justify-center rounded-lg border border-border bg-surface px-4 py-3 text-sm font-semibold text-text-primary">
            Cancel
          </button>
          <button type="button" onClick={confirmDelete} disabled={projectActionLoadingId === deleteTarget.id || workspaceActionLoadingId === deleteTarget.id} className="inline-flex items-center justify-center gap-2 rounded-lg bg-danger px-4 py-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">
            {(projectActionLoadingId === deleteTarget.id || workspaceActionLoadingId === deleteTarget.id) ? <RefreshCw size={16} className="animate-spin" /> : <Trash2 size={16} />}
            Delete
          </button>
        </div>
      </div>
    </div>
  );

  const destroyDialog = destroyDialogOpen && (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 px-4 py-6 backdrop-blur-sm">
      <div className="w-full max-w-xl rounded-2xl border border-danger/25 bg-background p-5 shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-danger">Destructive workflow</p>
            <h2 className="mt-2 text-2xl font-semibold text-text-primary">Confirm Terraform destroy</h2>
          </div>
          <button type="button" onClick={() => { setDestroyDialogOpen(false); setDestroyConfirmation(''); }} className="rounded-lg border border-border bg-surface p-2 text-text-secondary hover:text-text-primary" aria-label="Close destroy confirmation">
            <X size={18} />
          </button>
        </div>
        <div className="mt-5 rounded-2xl border border-danger/30 bg-danger/10 p-4">
          <p className="text-sm font-semibold text-danger">This can remove AWS resources from the target account.</p>
          <p className="mt-2 text-sm leading-6 text-text-secondary">Use only with explicit approval.</p>
        </div>
        <label className="mt-5 block">
          <span className="text-sm font-semibold text-text-primary">Type DESTROY to continue</span>
          <input value={destroyConfirmation} onChange={(event) => setDestroyConfirmation(event.target.value)} placeholder="DESTROY" className="mt-2 w-full rounded-xl border border-border bg-surface px-4 py-3 text-sm text-text-primary outline-none focus:border-danger" />
        </label>
        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <button type="button" onClick={() => { setDestroyDialogOpen(false); setDestroyConfirmation(''); }} className="inline-flex items-center justify-center rounded-lg border border-border bg-surface px-4 py-3 text-sm font-semibold text-text-primary">
            Cancel
          </button>
          <button type="button" disabled={destroyConfirmation !== 'DESTROY' || githubDestroyLoading} onClick={startGithubDestroy} className="inline-flex items-center justify-center gap-2 rounded-lg bg-danger px-4 py-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">
            {githubDestroyLoading ? <RefreshCw size={16} className="animate-spin" /> : <Trash2 size={16} />}
            Start destroy workflow
          </button>
        </div>
      </div>
    </div>
  );

  if (!activeProject) {
    return (
      <>
        <div className="mx-auto max-w-6xl space-y-8 pb-8">
          <div className="flex flex-col gap-4 pt-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-accent">Minfy AI / TF Generator</p>
              <h1 className="text-2xl font-bold tracking-tight text-text-primary">Terraform Projects</h1>
              <p className="mt-0.5 text-sm text-text-muted">{projects.length} project{projects.length === 1 ? '' : 's'}</p>
            </div>
          </div>
          {projectDashboard}
        </div>
        {deleteDialog}
      </>
    );
  }

  if (!deployMode) {
    return (
      <>
        <div className="mx-auto max-w-6xl space-y-6 pb-8">
          <button type="button" onClick={goBackToProjects} className="inline-flex items-center gap-2 text-sm font-semibold text-text-secondary hover:text-accent">
            <ArrowRight size={16} className="rotate-180" />
            Back to projects
          </button>
          {projectView === 'workspaces' && (
            <>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-accent">Terraform Project</p>
                  <h1 className="mt-1 text-3xl font-bold tracking-tight text-text-primary">{activeProject.project_name}</h1>
                  <p className="mt-1 text-sm text-text-muted">{workspaces.length} saved workspace{workspaces.length === 1 ? '' : 's'}</p>
                </div>
                <button type="button" onClick={startNewWorkspace} className="inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-4 py-3 text-sm font-semibold text-accent-foreground shadow-sm shadow-accent/20">
                  <FolderPlus size={16} />
                  New Workspace
                </button>
              </div>
              {savedWorkspacesPanel}
            </>
          )}

          {projectView === 'new' && (
            <>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-accent">{activeProject.project_name}</p>
                  <h1 className="mt-1 text-3xl font-bold tracking-tight text-text-primary">New Workspace</h1>
                  <p className="mt-1 text-sm text-text-muted">Upload the Excel workbook, review the generated Terraform, then save this workspace.</p>
                </div>
                <button type="button" onClick={() => setProjectView('workspaces')} className="inline-flex items-center justify-center rounded-lg border border-border bg-surface px-4 py-3 text-sm font-semibold text-text-primary">
                  Workspaces
                </button>
              </div>
              {workbookIntake}
              {reviewPanels}
            </>
          )}

          {projectView === 'workspace' && (
            <>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-accent">{activeProject.project_name}</p>
                  <h1 className="mt-1 text-3xl font-bold tracking-tight text-text-primary">{savedWorkspace?.deployment_name || manifest?.deployment_name || 'Terraform Workspace'}</h1>
                  <p className="mt-1 text-sm text-text-muted">Choose exactly one deployment path for this saved workspace.</p>
                </div>
                <div className="flex gap-2">
                  <button type="button" onClick={() => setProjectView('workspaces')} className="inline-flex items-center justify-center rounded-lg border border-border bg-surface px-4 py-3 text-sm font-semibold text-text-primary">
                    Workspaces
                  </button>
                  <button type="button" onClick={startNewWorkspace} className="inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-4 py-3 text-sm font-semibold text-accent-foreground">
                    <FolderPlus size={16} />
                    New
                  </button>
                </div>
              </div>
              <section className="grid gap-4 lg:grid-cols-2">
                <button type="button" disabled={!files.length} onClick={() => setDeployMode('github')} className="rounded-2xl border border-border bg-surface-elevated p-6 text-left transition-all hover:-translate-y-0.5 hover:border-accent/50 disabled:cursor-not-allowed disabled:opacity-50">
                  <GitBranch size={26} className="text-accent" />
                  <p className="mt-4 text-lg font-semibold text-text-primary">GitHub delivery</p>
                  <p className="mt-2 text-sm leading-6 text-text-secondary">Create a client repository PR, then apply after the PR is reviewed and merged.</p>
                </button>
                <button type="button" disabled={!files.length} onClick={() => setDeployMode('direct')} className="rounded-2xl border border-border bg-surface-elevated p-6 text-left transition-all hover:-translate-y-0.5 hover:border-accent/50 disabled:cursor-not-allowed disabled:opacity-50">
                  <Rocket size={26} className="text-success" />
                  <p className="mt-4 text-lg font-semibold text-text-primary">Direct deploy</p>
                  <p className="mt-2 text-sm leading-6 text-text-secondary">Use the controlled runner with an approved cross-account role.</p>
                </button>
              </section>
              {!files.length && <Notice tone="error" title="Workspace files missing" detail="Open another saved workspace or create a new workspace from an Excel workbook." />}
            </>
          )}
        </div>
        {deleteDialog}
      </>
    );
  }

  return (
    <>
      <div className="mx-auto max-w-6xl space-y-6 pb-8">
        <button type="button" onClick={() => setDeployMode(null)} className="inline-flex items-center gap-2 text-sm font-semibold text-text-secondary hover:text-accent">
          <ArrowRight size={16} className="rotate-180" />
          Back to workspace
        </button>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-accent">{activeProject.project_name}</p>
            <h1 className="mt-1 text-3xl font-bold tracking-tight text-text-primary">{deployMode === 'github' ? 'GitHub delivery' : 'Direct deploy'}</h1>
            <p className="mt-1 text-sm text-text-muted">{deployMode === 'github' ? 'Upload workbook, create PR, then apply after merge.' : 'Upload workbook, create runner job, then plan and apply.'}</p>
          </div>
        </div>

        {deployMode === 'github' && files.length > 0 && (
          <section className="rounded-2xl border border-border bg-surface-elevated p-5">
            <div className="space-y-4">
              <div className="grid gap-4 lg:grid-cols-2">
                <label className="block">
                  <span className="text-sm font-semibold text-text-primary">Client repository</span>
                  <input value={repoUrl} onChange={(event) => setRepoUrl(event.target.value)} placeholder="https://github.com/client/network-infra" className="mt-2 w-full rounded-xl border border-border bg-surface px-4 py-3 text-sm text-text-primary outline-none focus:border-accent" />
                </label>
                <label className="block">
                  <span className="text-sm font-semibold text-text-primary">Branch name</span>
                  <input value={targetBranch} onChange={(event) => setTargetBranch(event.target.value)} placeholder="terraform-network" className="mt-2 w-full rounded-xl border border-border bg-surface px-4 py-3 text-sm text-text-primary outline-none focus:border-accent" />
                </label>
              </div>
              <label className="block">
                <span className="text-sm font-semibold text-text-primary">GitHub access token</span>
                <input value={githubToken} onChange={(event) => setGithubToken(event.target.value)} type="password" placeholder="Paste token with repo delivery access" className="mt-2 w-full rounded-xl border border-border bg-surface px-4 py-3 text-sm text-text-primary outline-none focus:border-accent" />
                <span className="mt-2 block text-xs text-text-muted">{githubVerification?.message || 'Required: Contents, Pull requests, Workflows, Secrets, and Actions access.'}</span>
              </label>
              {!githubSecretsDetected && (
                <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_180px] lg:items-end">
                  <label className="block">
                    <span className="text-sm font-semibold text-text-primary">AWS access key ID</span>
                    <input value={awsAccessKeyId} onChange={(event) => setAwsAccessKeyId(event.target.value)} type="password" placeholder="AKIA..." className="mt-2 w-full rounded-xl border border-border bg-surface px-4 py-3 text-sm text-text-primary outline-none focus:border-accent" />
                  </label>
                  <label className="block">
                    <span className="text-sm font-semibold text-text-primary">AWS secret access key</span>
                    <input value={awsSecretAccessKey} onChange={(event) => setAwsSecretAccessKey(event.target.value)} type="password" placeholder="Paste secret key" className="mt-2 w-full rounded-xl border border-border bg-surface px-4 py-3 text-sm text-text-primary outline-none focus:border-accent" />
                  </label>
                  <button type="button" disabled={!githubReady || !awsAccessKeyId.trim() || !awsSecretAccessKey.trim() || githubSecretsLoading} onClick={saveGithubSecrets} className="inline-flex items-center justify-center gap-2 rounded-lg border border-border bg-surface px-4 py-3 text-sm font-semibold text-text-primary disabled:opacity-50">
                    {githubSecretsLoading ? <RefreshCw size={16} className="animate-spin" /> : <LockKeyhole size={16} />}
                    Save
                  </button>
                </div>
              )}
              {githubSecretsDetected && <Notice tone="info" title="AWS secrets detected" detail="This repository already has the required AWS secrets." />}
              {githubError && <Notice tone="error" title="GitHub issue" detail={githubError} />}
              {githubSecretsError && <Notice tone="error" title="Secrets issue" detail={githubSecretsError} />}
              {githubApplyError && <Notice tone="error" title="Apply issue" detail={githubApplyError} />}
              {githubDestroyError && <Notice tone="error" title="Destroy issue" detail={githubDestroyError} />}
              <div className="grid gap-3 md:grid-cols-3">
                <button type="button" disabled={githubPullRequestCreated || !files.length || !githubReady || !githubSecretsReady || githubLoading || githubVerifyLoading} onClick={createGithubPullRequest} className="inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-4 py-3 text-sm font-semibold text-accent-foreground disabled:opacity-50">
                  {githubLoading ? <RefreshCw size={16} className="animate-spin" /> : <GitBranch size={16} />}
                  {githubPullRequestCreated ? 'PR created' : 'Create PR'}
                </button>
                <button type="button" disabled={!githubPullRequestCreated || !githubReady || githubApplyLoading} onClick={startGithubApply} className="inline-flex items-center justify-center gap-2 rounded-lg bg-success px-4 py-3 text-sm font-semibold text-white disabled:opacity-50">
                  {githubApplyLoading ? <RefreshCw size={16} className="animate-spin" /> : <Rocket size={16} />}
                  Start apply
                </button>
                <button type="button" disabled={!githubPullRequestCreated || !githubReady || githubDestroyLoading} onClick={() => { setGithubDestroyError(null); setDestroyDialogOpen(true); }} className="inline-flex items-center justify-center gap-2 rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-sm font-semibold text-danger disabled:opacity-50">
                  <Trash2 size={16} />
                  Destroy
                </button>
              </div>
              {githubResult?.pull_request_url && <a href={githubResult.pull_request_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 text-sm font-semibold text-accent hover:underline">Open pull request <ArrowRight size={14} /></a>}
              {githubApplyResult?.actions_url && <a href={githubApplyResult.actions_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 text-sm font-semibold text-accent hover:underline">Open apply workflow <ArrowRight size={14} /></a>}
            </div>
          </section>
        )}

        {deployMode === 'direct' && files.length > 0 && (
          <section className="rounded-2xl border border-border bg-surface-elevated p-5">
            <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
              <div className="space-y-4">
                <label className="block">
                  <span className="text-sm font-semibold text-text-primary">Cross-account deploy role</span>
                  <input value={roleArn} onChange={(event) => { setRoleArn(event.target.value); setTfJob(null); }} placeholder="arn:aws:iam::123456789012:role/TerraformDeployRole" className="mt-2 w-full rounded-xl border border-border bg-surface px-4 py-3 font-mono text-sm text-text-primary outline-none focus:border-accent" />
                </label>
                {runnerError && <Notice tone="error" title="Terraform runner error" detail={runnerError} />}
                {tfJob?.plan_output && <RunnerOutput title="Latest plan output" content={tfJob.plan_output} />}
                {tfJob?.apply_output && <RunnerOutput title="Latest apply output" content={tfJob.apply_output} />}
              </div>
              <div className="grid gap-2 self-start rounded-2xl border border-border bg-surface p-4">
                {!tfJob ? (
                  <button type="button" disabled={!roleArnValid || runnerLoading} onClick={createDeploymentJob} className="inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-4 py-3 text-sm font-semibold text-accent-foreground disabled:opacity-50">
                    {runnerLoading ? <RefreshCw size={16} className="animate-spin" /> : <CloudCog size={16} />}
                    Create job
                  </button>
                ) : (
                  <>
                    <button type="button" disabled={runnerLoading || isTfJobRunning(tfJob.status)} onClick={() => runRunnerAction('plan')} className="inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-4 py-3 text-sm font-semibold text-accent-foreground disabled:opacity-50">
                      <Play size={16} />
                      Run plan
                    </button>
                    <button type="button" disabled={runnerLoading || tfJob.status !== 'PLAN_SUCCEEDED'} onClick={() => runRunnerAction('approve')} className="inline-flex items-center justify-center gap-2 rounded-lg border border-border bg-background px-4 py-3 text-sm font-semibold text-text-primary disabled:opacity-50">
                      <ShieldCheck size={16} />
                      Approve
                    </button>
                    <button type="button" disabled={runnerLoading || !tfJob.approved_at || !['APPROVED', 'APPLY_FAILED'].includes(tfJob.status)} onClick={() => runRunnerAction('apply')} className="inline-flex items-center justify-center gap-2 rounded-lg bg-success px-4 py-3 text-sm font-semibold text-white disabled:opacity-50">
                      <Rocket size={16} />
                      Apply
                    </button>
                  </>
                )}
              </div>
            </div>
          </section>
        )}

      </div>
      {deleteDialog}
      {destroyDialog}
    </>
  );

  /*
  Legacy all-at-once layout kept only as reference while the TF Generator is
  moved to the project-first flow above.
  if (!activeProject) return null;

  return (
    <>
    <div className="mx-auto max-w-7xl space-y-6 pb-8">
      <section className="relative overflow-hidden rounded-2xl border border-border bg-surface-elevated/80 px-6 py-6 shadow-[0_24px_80px_rgba(15,23,42,0.08)] backdrop-blur-xl">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_16%_18%,rgba(16,185,129,0.16),transparent_28rem),radial-gradient(circle_at_92%_4%,rgba(79,70,229,0.14),transparent_26rem)]" />
        <div className="relative z-10 grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div>
            <div className="flex flex-wrap items-center gap-3">
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent text-accent-foreground shadow-lg shadow-accent/20">
                <CloudCog size={23} />
              </span>
              <div>
                <p className="text-sm font-semibold text-text-primary">Minfy AI TF Generator</p>
                <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-accent">AWS network deployment console</p>
              </div>
            </div>

            <h1 className="mt-7 max-w-4xl text-[clamp(34px,5vw,64px)] font-semibold leading-[0.98] tracking-tight text-text-primary">
              Prepare Terraform for client GitHub delivery.
            </h1>
            <p className="mt-5 max-w-3xl text-base leading-7 text-text-secondary">
              Convert prerequisite workbooks into reviewed Terraform, then move it through a client-owned repository, GitHub Actions, AWS authentication, plan review, and approved apply.
            </p>
          </div>

          <div className="rounded-2xl border border-border bg-background/70 p-4 backdrop-blur">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-text-muted">Control state</p>
                <p className="mt-2 text-xl font-semibold text-text-primary">{reviewState}</p>
              </div>
              <span className={`rounded-full px-3 py-1 text-xs font-semibold ${hasErrors ? 'bg-danger/10 text-danger' : files.length ? 'bg-success/10 text-success' : 'bg-warning/10 text-warning'}`}>
                Production review
              </span>
            </div>
            <div className="mt-5 grid gap-2">
              <FlowItem active={!!manifest} label="Workbook" value={intakeState} />
              <FlowItem active={!!messages.length && !hasErrors} warning={hasWarnings} label="Validation" value={messages.length ? `${messages.length} checks returned` : 'Awaiting manifest'} />
              <FlowItem active={!!files.length} label="Repo package" value={files.length ? `${files.length} Terraform files ready` : 'Locked until valid'} />
              <FlowItem active={!!tfJob?.status && !isTfJobFailed(tfJob?.status)} warning={isTfJobFailed(tfJob?.status)} locked={!files.length} label="Plan / apply" value={deployState} />
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <button
          type="button"
          onClick={() => setDeployMode('github')}
          className={`rounded-2xl border p-5 text-left transition-colors ${deployMode === 'github' ? 'border-accent/60 bg-accent/10 shadow-sm shadow-accent/10' : 'border-border bg-surface hover:border-accent/40 hover:bg-surface-elevated'}`}
        >
          <div className="flex items-start gap-4">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
              <GitBranch size={22} />
            </span>
            <div>
              <p className="text-base font-semibold text-text-primary">GitHub delivery</p>
              <p className="mt-1 text-sm leading-6 text-text-secondary">
                Generate Terraform, create a PR in the client repository, then apply from GitHub Actions after review.
              </p>
            </div>
          </div>
        </button>
        <button
          type="button"
          onClick={() => setDeployMode('direct')}
          className={`rounded-2xl border p-5 text-left transition-colors ${deployMode === 'direct' ? 'border-accent/60 bg-accent/10 shadow-sm shadow-accent/10' : 'border-border bg-surface hover:border-accent/40 hover:bg-surface-elevated'}`}
        >
          <div className="flex items-start gap-4">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-success/10 text-success">
              <Rocket size={22} />
            </span>
            <div>
              <p className="text-base font-semibold text-text-primary">Direct deploy</p>
              <p className="mt-1 text-sm leading-6 text-text-secondary">
                Use the controlled runner with a cross-account role for internal deployments that do not need a client PR.
              </p>
            </div>
          </div>
        </button>
      </section>

      <section className="grid gap-5 xl:grid-cols-[minmax(0,1.08fr)_minmax(360px,0.92fr)]">
        <div className="card overflow-hidden">
          <div className="border-b border-border px-5 py-4">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <GitBranch size={18} className="text-accent" />
                  <h2 className="text-base font-semibold text-text-primary">{deployMode === 'github' ? 'Client GitHub delivery' : deployMode === 'direct' ? 'Direct deployment intake' : 'Workspace intake'}</h2>
                </div>
                <p className="mt-1 max-w-2xl text-xs leading-5 text-text-muted">
                  {deployMode === 'github'
                    ? 'Use this path when the Terraform code must be committed to a client-owned repository before any AWS deployment.'
                    : deployMode === 'direct'
                      ? 'Upload and save the Terraform workspace, then use the direct runner section below.'
                      : 'Create or open a project, then choose how this Terraform package should be deployed.'}
                </p>
              </div>
              <span className="w-fit rounded-full bg-accent/10 px-3 py-1 text-xs font-semibold text-accent">
                {deployMode === 'github' ? 'Recommended' : deployMode === 'direct' ? 'Internal' : 'Choose mode'}
              </span>
            </div>
          </div>

          <div className="space-y-3 p-5">
            <DeliveryStep index="01" title="Project workbook" status={!activeProject ? 'Project first' : manifest ? 'Parsed' : loading ? 'Reading' : 'Required'} open={!manifest}>
              {!activeProject && (
                <Notice tone="info" title="Create a project first" detail="A project keeps related Terraform workspaces together, so future changes are easier to find and reopen." />
              )}
              <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_180px] lg:items-end">
                <div className="rounded-xl border border-border bg-surface p-4">
                  <p className="truncate text-sm font-semibold text-text-primary">{fileName || 'No workbook selected'}</p>
                  <p className="mt-1 text-xs text-text-muted">
                    {activeProject?.project_name ? `Saving under ${activeProject?.project_name}.` : 'Select or create a project before uploading the Excel workbook.'}
                  </p>
                </div>
                <label className={`inline-flex items-center justify-center gap-2 rounded-lg px-4 py-3 text-sm font-semibold shadow-sm shadow-accent/20 ${activeProject ? 'cursor-pointer bg-accent text-accent-foreground' : 'cursor-not-allowed bg-text-muted/20 text-text-muted'}`}>
                  <Upload size={16} />
                  Upload Excel
                  <input
                    type="file"
                    accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                    className="hidden"
                    disabled={!activeProject}
                    onChange={(event) => handleUpload(event.target.files?.[0] || null)}
                  />
                </label>
              </div>
              {loading && (
                <Notice tone="info" title="Parsing workbook" detail="Building the deployment manifest and Terraform review bundle." />
              )}
              {workspaceSaving && (
                <Notice tone="info" title="Saving workspace" detail="Storing the generated Terraform files for future review and change requests." />
              )}
              {savedWorkspace && (
                <div className="mt-4 rounded-2xl border border-success/25 bg-success/5 px-4 py-3">
                  <div className="flex items-start gap-3">
                    <Database size={18} className="mt-0.5 text-success" />
                    <div>
                      <p className="text-sm font-semibold text-text-primary">Workspace saved</p>
                      <p className="mt-1 text-xs leading-5 text-text-secondary">
                        {savedWorkspace?.deployment_name} is stored with {savedWorkspace?.file_count} Terraform files. This gives the app a saved baseline for future change requests.
                      </p>
                    </div>
                  </div>
                </div>
              )}
              {workspaceError && (
                <Notice tone="error" title="Workspace could not be saved" detail={workspaceError} />
              )}
              {error && (
                <Notice tone="error" title="Workbook could not be parsed" detail={error} />
              )}
            </DeliveryStep>

            {!deployMode && (
              <Notice tone="info" title="Choose deployment mode" detail="Select GitHub delivery or Direct deploy above. The app will show only the controls needed for that path." />
            )}

            {deployMode === 'github' && (
            <>
            <DeliveryStep index="02" title="Repository" status={repoUrl.trim() ? 'Ready' : 'Required'} open={!!manifest && !repoUrl.trim()}>
              <div className="grid gap-4 lg:grid-cols-2">
                <label className="block">
                  <span className="text-sm font-semibold text-text-primary">Client repository</span>
                  <input
                    value={repoUrl}
                    onChange={(event) => setRepoUrl(event.target.value)}
                    placeholder="https://github.com/client/network-infra"
                    className="mt-2 w-full rounded-xl border border-border bg-surface px-4 py-3 text-sm text-text-primary outline-none transition-colors focus:border-accent"
                  />
                  <span className="mt-2 block text-xs text-text-muted">Use a client-owned repository with Actions enabled. If the repo is empty, the app initializes a small README before opening the PR.</span>
                </label>

                <label className="block">
                  <span className="text-sm font-semibold text-text-primary">Branch name</span>
                  <input
                    value={targetBranch}
                    onChange={(event) => setTargetBranch(event.target.value)}
                    placeholder="terraform-network"
                    className="mt-2 w-full rounded-xl border border-border bg-surface px-4 py-3 text-sm text-text-primary outline-none transition-colors focus:border-accent"
                  />
                  <span className="mt-2 block text-xs text-text-muted">Use a branch different from the repo default branch.</span>
                </label>
              </div>
            </DeliveryStep>

            <DeliveryStep
              index="03"
              title="GitHub access"
              status={githubVerifyLoading ? 'Checking' : githubVerification?.valid ? 'Verified' : githubToken.trim() ? 'Needs review' : 'Required'}
              open={!!repoUrl.trim() && !githubVerification?.valid}
            >
              <label className="block">
                <span className="text-sm font-semibold text-text-primary">GitHub access token</span>
                <input
                  value={githubToken}
                  onChange={(event) => setGithubToken(event.target.value)}
                  type="password"
                  placeholder="Paste token with repo delivery access"
                  className="mt-2 w-full rounded-xl border border-border bg-surface px-4 py-3 text-sm text-text-primary outline-none transition-colors focus:border-accent"
                />
                <span className="mt-2 block text-xs text-text-muted">Create a fine-grained PAT for this repo with Contents, Pull requests, Workflows, Secrets, and Actions access. The token is used in this browser session and is not stored.</span>
              </label>

              <div className="mt-4 rounded-2xl border border-border bg-surface/60 p-4">
                <div className="flex items-start gap-3">
                  <span className={`mt-0.5 ${githubVerification?.valid ? 'text-success' : githubVerification ? 'text-warning' : 'text-text-muted'}`}>
                    {githubVerifyLoading ? <RefreshCw size={18} className="animate-spin" /> : githubVerification?.valid ? <CheckCircle2 size={18} /> : <ShieldCheck size={18} />}
                  </span>
                  <div>
                    <p className="text-sm font-semibold text-text-primary">
                      {githubVerifyLoading ? 'Checking token access' : githubVerification?.valid ? 'Token can create the PR' : 'Waiting for valid repository access'}
                    </p>
                    <p className="mt-1 text-xs leading-5 text-text-secondary">
                      {githubVerification?.message || 'Required permissions: Contents, Pull requests, Workflows, Secrets, and Actions set to Read and write.'}
                    </p>
                    {!!githubVerification?.missing_permissions.length && (
                      <div className="mt-3 flex flex-wrap gap-2">
                        {(githubVerification?.missing_permissions || []).map((permission) => (
                          <span key={permission} className="rounded-full bg-background/80 px-3 py-1 text-xs font-semibold text-text-primary">
                            {permission}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </DeliveryStep>

            <DeliveryStep index="04" title="AWS pipeline secrets" status={githubSecretsDetected ? 'Detected' : githubSecretsResult ? 'Saved' : '2 secrets'} open={githubReady && !githubSecretsReady}>
              {githubSecretsDetected && (
                <Notice tone="info" title="AWS secrets detected" detail="This repository already has AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY. The app will use them for the GitHub Actions plan. If those are not the credentials you want, enter new values below to replace them." />
              )}
              {!githubSecretsDetected && (
                <>
                  <div className="grid gap-4 lg:grid-cols-2">
                    <label className="block">
                      <span className="text-sm font-semibold text-text-primary">AWS access key ID</span>
                      <input
                        value={awsAccessKeyId}
                        onChange={(event) => setAwsAccessKeyId(event.target.value)}
                        type="password"
                        placeholder="AKIA..."
                        className="mt-2 w-full rounded-xl border border-border bg-surface px-4 py-3 text-sm text-text-primary outline-none transition-colors focus:border-accent"
                      />
                    </label>
                    <label className="block">
                      <span className="text-sm font-semibold text-text-primary">AWS secret access key</span>
                      <input
                        value={awsSecretAccessKey}
                        onChange={(event) => setAwsSecretAccessKey(event.target.value)}
                        type="password"
                        placeholder="Paste secret key"
                        className="mt-2 w-full rounded-xl border border-border bg-surface px-4 py-3 text-sm text-text-primary outline-none transition-colors focus:border-accent"
                      />
                    </label>
                  </div>
                  <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_220px] sm:items-center">
                    <p className="text-xs leading-5 text-text-secondary">
                      The backend encrypts these with GitHub's repository public key and updates only `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`. Region comes from the workbook.
                    </p>
                    <button
                      type="button"
                      disabled={!githubReady || !awsAccessKeyId.trim() || !awsSecretAccessKey.trim() || githubSecretsLoading}
                      onClick={saveGithubSecrets}
                      className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-border bg-surface px-4 py-3 text-sm font-semibold text-text-primary shadow-sm disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {githubSecretsLoading ? <RefreshCw size={16} className="animate-spin" /> : <LockKeyhole size={16} />}
                      Save secrets
                    </button>
                  </div>
                </>
              )}
              {githubSecretsError && (
                <Notice tone="error" title="AWS secrets could not be saved" detail={githubSecretsError} />
              )}
              {githubSecretsResult && (
                <Notice tone="info" title="AWS secrets saved" detail="AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY were updated in GitHub Actions secrets." />
              )}
            </DeliveryStep>

            <DeliveryStep index="05" title="Create pull request" status={githubPullRequestCreated ? 'Created' : (githubReady && githubSecretsReady) ? 'Ready' : 'Locked'} open={(githubReady && githubSecretsReady) || githubPullRequestCreated}>
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_220px] sm:items-center">
                <div>
                  <p className="text-sm leading-6 text-text-secondary">
                    Generate the branch, commit the Terraform package, and open a PR in the selected repository. After it is created, review and merge that PR before applying.
                  </p>
                  {githubPrBlocker && (
                    <p className="mt-2 text-xs font-semibold text-warning">{githubPrBlocker}</p>
                  )}
                </div>
                <button
                  type="button"
                  disabled={githubPullRequestCreated || !files.length || !githubReady || !githubSecretsReady || githubLoading || githubVerifyLoading}
                  onClick={createGithubPullRequest}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-3 text-sm font-semibold text-accent-foreground shadow-sm shadow-accent/20 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {githubLoading ? <RefreshCw size={16} className="animate-spin" /> : <GitBranch size={16} />}
                  {githubPullRequestCreated ? 'PR created' : 'Create PR'}
                </button>
              </div>
              {githubError && (
                <Notice tone="error" title="GitHub PR could not be created" detail={githubError} />
              )}
              {githubResult && (
                <div className="mt-4 rounded-2xl border border-success/25 bg-success/5 px-4 py-3">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="text-sm font-semibold text-text-primary">Pull request ready</p>
                      <p className="mt-1 text-xs leading-5 text-text-secondary">
                        Branch <span className="font-mono">{githubResult?.branch}</span> was updated. Open the PR, review the plan, then merge it before starting apply.
                      </p>
                    </div>
                    {githubResult?.pull_request_url && (
                      <a
                        href={githubResult?.pull_request_url || undefined}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg border border-success/30 bg-background px-4 py-2 text-sm font-semibold text-success hover:bg-success/10"
                      >
                        Open pull request <ArrowRight size={14} />
                      </a>
                    )}
                  </div>
                </div>
              )}
            </DeliveryStep>

            <DeliveryStep index="06" title="Deploy after merge" status={githubApplyResult ? 'Started' : githubPullRequestCreated ? 'Ready after merge' : 'Locked'} open={githubPullRequestCreated}>
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_220px] sm:items-center">
                <div>
                  <p className="text-sm leading-6 text-text-secondary">
                    After the PR is reviewed and merged, start the Terraform Apply workflow from here. The workflow bootstraps an encrypted S3 backend and DynamoDB lock table in the target AWS account before applying.
                  </p>
                  <p className="mt-2 text-xs leading-5 text-text-muted">
                    If GitHub says the apply workflow is not found, merge the PR first and try again.
                  </p>
                </div>
                <button
                  type="button"
                  disabled={!githubPullRequestCreated || !githubReady || githubApplyLoading}
                  onClick={startGithubApply}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-success px-4 py-3 text-sm font-semibold text-white shadow-sm shadow-success/20 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {githubApplyLoading ? <RefreshCw size={16} className="animate-spin" /> : <Rocket size={16} />}
                  Start apply
                </button>
              </div>
              {githubApplyError && (
                <Notice tone="error" title="Terraform apply could not start" detail={githubApplyError} />
              )}
              {githubApplyResult && (
                <div className="mt-4 rounded-2xl border border-success/25 bg-success/5 px-4 py-3">
                  <p className="text-sm font-semibold text-text-primary">Terraform apply workflow started</p>
                  <p className="mt-1 text-xs leading-5 text-text-secondary">GitHub Actions is running apply from <span className="font-mono">{githubApplyResult?.ref}</span>.</p>
                  <a
                    href={githubApplyResult?.actions_url}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-3 inline-flex items-center gap-2 text-sm font-semibold text-accent hover:underline"
                  >
                    Open apply workflow <ArrowRight size={14} />
                  </a>
                </div>
              )}
            </DeliveryStep>

            <DeliveryStep index="07" title="Destroy controls" status={githubDestroyResult ? 'Started' : githubPullRequestCreated ? 'Protected' : 'Locked'} open={!!githubApplyResult || !!githubDestroyError || !!githubDestroyResult}>
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_220px] sm:items-center">
                <div>
                  <p className="text-sm leading-6 text-text-secondary">
                    Destroy is available only as a separate emergency workflow. It is not recommended for client deployments unless the client has explicitly approved resource removal.
                  </p>
                  <p className="mt-2 text-xs leading-5 text-text-muted">
                    The generated Terraform and normal apply workflow block update, delete, and replacement actions. Destroy requires a typed confirmation before the app will start GitHub Actions.
                  </p>
                </div>
                <button
                  type="button"
                  disabled={!githubPullRequestCreated || !githubReady || githubDestroyLoading}
                  onClick={() => {
                    setGithubDestroyError(null);
                    setDestroyDialogOpen(true);
                  }}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-sm font-semibold text-danger shadow-sm disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {githubDestroyLoading ? <RefreshCw size={16} className="animate-spin" /> : <Trash2 size={16} />}
                  Destroy
                </button>
              </div>
              {githubDestroyError && (
                <Notice tone="error" title="Terraform destroy could not start" detail={githubDestroyError} />
              )}
              {githubDestroyResult && (
                <div className="mt-4 rounded-2xl border border-warning/30 bg-warning/10 px-4 py-3">
                  <p className="text-sm font-semibold text-text-primary">Terraform destroy workflow started</p>
                  <p className="mt-1 text-xs leading-5 text-text-secondary">GitHub Actions is running destroy from <span className="font-mono">{githubDestroyResult.ref}</span>.</p>
                  <a
                    href={githubDestroyResult.actions_url}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-3 inline-flex items-center gap-2 text-sm font-semibold text-accent hover:underline"
                  >
                    Open destroy workflow <ArrowRight size={14} />
                  </a>
                </div>
              )}
            </DeliveryStep>
            </>
            )}
          </div>

          <div className="border-t border-border bg-surface/50 px-5 py-4">
            <div className="grid gap-3 lg:grid-cols-3">
              <DeliveryCheck title="Repository package" detail="Terraform code, variables, and CI workflow generated from the uploaded workbook." active={!!files.length} />
              <DeliveryCheck title="Workspace" detail="Projects keep saved Terraform packages grouped for later review, edit, or deletion." active={!!activeProject} />
              {deployMode === 'github' ? (
                <DeliveryCheck title="Pull request" detail="The app creates the branch, commits files, and opens the PR." active={!!githubResult?.pull_request_url} />
              ) : (
                <DeliveryCheck title="Direct runner" detail="The controlled runner appears after a valid workbook is generated." active={deployMode === 'direct' && !!files.length} />
              )}
            </div>
          </div>
        </div>

        <div className="card p-5">
          <div className="flex items-center gap-2">
            <GitBranch size={18} className="text-accent" />
            <h2 className="text-base font-semibold text-text-primary">Production path</h2>
          </div>
          <div className="mt-5 space-y-3">
            <PathStep index="01" title="Upload Excel" detail="Parse accounts, VPCs, subnet names, CIDRs, NAT flags, and route intent." active={!!manifest} />
            <PathStep index="02" title="Generate repo code" detail="Create Terraform files that preserve workbook resource names." active={!!files.length} />
            {deployMode === 'direct' ? (
              <>
                <PathStep index="03" title="Create runner job" detail="Use the approved cross-account role to create a controlled Terraform job." active={!!tfJob} />
                <PathStep index="04" title="Plan and approve" detail="Run plan first, then approve the latest successful output." active={!!tfJob?.approved_at} />
                <PathStep index="05" title="Apply" detail="Apply only after approval from the app." active={tfJob?.status === 'APPLY_SUCCEEDED'} />
              </>
            ) : (
              <>
                <PathStep index="03" title="Open GitHub PR" detail="The app pushes to the client repo branch and opens a PR." active={!!githubResult?.pull_request_url} />
                <PathStep index="04" title="Plan in GitHub Actions" detail="The workflow uses two AWS secrets, workbook region, and S3 backend state to produce plan output." active={false} />
                <PathStep index="05" title="Merge PR" detail="Merge only after the plan output and Terraform code are reviewed." active={false} />
                <PathStep index="06" title="Apply from app" detail="The app starts the manual Terraform Apply workflow after merge." active={!!githubApplyResult} />
              </>
            )}
          </div>
        </div>

        <div className="card p-5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <FolderPlus size={18} className="text-accent" />
              <h2 className="text-base font-semibold text-text-primary">Terraform projects</h2>
            </div>
            <button
              type="button"
              onClick={refreshProjects}
              className="rounded-lg border border-border bg-surface p-2 text-text-secondary hover:text-text-primary"
              title="Refresh projects"
            >
              <RefreshCw size={15} className={projectsLoading ? 'animate-spin' : ''} />
            </button>
          </div>
          <p className="mt-2 text-xs leading-5 text-text-muted">
            Create one project per client or environment, then keep every generated Terraform workspace inside it.
          </p>
          <div className="mt-4 grid gap-2 sm:grid-cols-[minmax(0,1fr)_120px]">
            <input
              value={projectName}
              onChange={(event) => setProjectName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') createProject();
              }}
              placeholder="e.g. Verbal AWS network"
              className="w-full rounded-xl border border-border bg-surface px-3 py-2.5 text-sm text-text-primary outline-none transition-colors focus:border-accent"
            />
            <button
              type="button"
              onClick={createProject}
              disabled={projectSaving || !projectName.trim()}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2.5 text-sm font-semibold text-accent-foreground shadow-sm shadow-accent/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {projectSaving ? <RefreshCw size={15} className="animate-spin" /> : <FolderPlus size={15} />}
              Create
            </button>
          </div>
          {projectError && (
            <Notice tone="error" title="Project issue" detail={projectError} />
          )}

          <div className="mt-4 space-y-2">
            {projectsLoading ? (
              <div className="rounded-xl border border-border bg-surface p-4 text-sm text-text-muted">Loading projects...</div>
            ) : projects.length ? (
              projects.slice(0, 6).map((project) => {
                const selectedProject = activeProject?.project_id === project.project_id;
                return (
                  <div
                    key={project.project_id}
                    className={`rounded-xl border p-3 transition-colors ${selectedProject ? 'border-accent/50 bg-accent/10' : 'border-border bg-surface'}`}
                  >
                    {editingProjectId === project.project_id ? (
                      <div className="space-y-2">
                        <input
                          value={editingProjectName}
                          onChange={(event) => setEditingProjectName(event.target.value)}
                          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-text-primary outline-none focus:border-accent"
                        />
                        <div className="grid grid-cols-2 gap-2">
                          <button
                            type="button"
                            onClick={() => saveProjectEdit(project)}
                            disabled={projectActionLoadingId === project.project_id}
                            className="rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-accent-foreground disabled:opacity-50"
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setEditingProjectId(null);
                              setEditingProjectName('');
                            }}
                            className="rounded-lg border border-border bg-background px-3 py-2 text-xs font-semibold text-text-primary"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-semibold text-text-primary">{project.project_name}</p>
                            <p className="mt-1 text-xs text-text-muted">
                              {project.workspace_count} workspace{project.workspace_count === 1 ? '' : 's'}
                            </p>
                          </div>
                          <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold ${selectedProject ? 'bg-accent text-accent-foreground' : 'bg-background text-text-muted'}`}>
                            {selectedProject ? 'Open' : 'Select'}
                          </span>
                        </div>
                        <div className="mt-3 grid grid-cols-3 gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              setActiveProject(project);
                              setSavedWorkspace(null);
                              setWorkspaceError(null);
                            }}
                            className="rounded-lg border border-border bg-background px-3 py-2 text-xs font-semibold text-text-primary hover:border-accent/50"
                          >
                            Open
                          </button>
                          <button
                            type="button"
                            onClick={() => startEditProject(project)}
                            className="inline-flex items-center justify-center gap-1 rounded-lg border border-border bg-background px-3 py-2 text-xs font-semibold text-text-primary hover:border-accent/50"
                          >
                            <Pencil size={12} />
                            Edit
                          </button>
                          <button
                            type="button"
                            onClick={() => setDeleteTarget({ type: 'project', id: project.project_id, name: project.project_name })}
                            disabled={projectActionLoadingId === project.project_id}
                            className="inline-flex items-center justify-center gap-1 rounded-lg border border-danger/25 bg-danger/5 px-3 py-2 text-xs font-semibold text-danger disabled:opacity-50"
                          >
                            <Trash2 size={12} />
                            Delete
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                );
              })
            ) : (
              <div className="rounded-xl border border-dashed border-border bg-surface/60 p-4 text-sm text-text-muted">
                No Terraform projects yet. Create a project first, then upload the workbook for that project.
              </div>
            )}
          </div>

          <div className="mt-5 border-t border-border pt-5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-text-primary">Project workspaces</h3>
                <p className="mt-1 text-xs text-text-muted">
                  {activeProject?.project_name ? `Inside ${activeProject?.project_name}` : 'Select a project to view saved workspaces.'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => refreshWorkspaces()}
                disabled={!activeProject}
                className="rounded-lg border border-border bg-surface p-2 text-text-secondary hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
                title="Refresh workspaces"
              >
                <RefreshCw size={15} className={workspacesLoading ? 'animate-spin' : ''} />
              </button>
            </div>
            {editingWorkspaceId && (
              <div className="mt-4 rounded-xl border border-accent/30 bg-accent/5 p-3">
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-accent">Edit workspace</p>
                <input
                  value={editingWorkspaceName}
                  onChange={(event) => setEditingWorkspaceName(event.target.value)}
                  className="mt-2 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-text-primary outline-none focus:border-accent"
                />
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      const workspace = workspaces.find((item) => item.workspace_id === editingWorkspaceId);
                      if (workspace) saveWorkspaceEdit(workspace);
                    }}
                    disabled={workspaceActionLoadingId === editingWorkspaceId}
                    className="rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-accent-foreground disabled:opacity-50"
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setEditingWorkspaceId(null);
                      setEditingWorkspaceName('');
                    }}
                    className="rounded-lg border border-border bg-background px-3 py-2 text-xs font-semibold text-text-primary"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
            <div className="mt-4 space-y-2">
            {workspacesLoading ? (
              <div className="rounded-xl border border-border bg-surface p-4 text-sm text-text-muted">Loading workspaces...</div>
            ) : workspaces.length ? (
              workspaces.slice(0, 5).map((workspace) => (
                <div
                  key={workspace.workspace_id}
                  className="rounded-xl border border-border bg-surface p-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-text-primary">{workspace.deployment_name}</p>
                      <p className="mt-1 text-xs text-text-muted">
                        {workspace.file_count} files · {workspace.primary_region}
                      </p>
                    </div>
                    <span className="shrink-0 rounded-full bg-success/10 px-2.5 py-1 text-[11px] font-semibold text-success">
                      {workspaceOpeningId === workspace.workspace_id ? 'Opening' : 'Saved'}
                    </span>
                  </div>
                  <div className="mt-3 grid grid-cols-3 gap-2">
                    <button
                      type="button"
                      onClick={() => openWorkspace(workspace)}
                      disabled={workspaceOpeningId === workspace.workspace_id}
                      className="rounded-lg border border-border bg-background px-3 py-2 text-xs font-semibold text-text-primary hover:border-accent/50 disabled:opacity-50"
                    >
                      Open
                    </button>
                    <button
                      type="button"
                      onClick={() => startEditWorkspace(workspace)}
                      className="inline-flex items-center justify-center gap-1 rounded-lg border border-border bg-background px-3 py-2 text-xs font-semibold text-text-primary hover:border-accent/50"
                    >
                      <Pencil size={12} />
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => setDeleteTarget({ type: 'workspace', id: workspace.workspace_id, name: workspace.deployment_name })}
                      disabled={workspaceActionLoadingId === workspace.workspace_id}
                      className="inline-flex items-center justify-center gap-1 rounded-lg border border-danger/25 bg-danger/5 px-3 py-2 text-xs font-semibold text-danger disabled:opacity-50"
                    >
                      <Trash2 size={12} />
                      Delete
                    </button>
                  </div>
                </div>
              ))
            ) : (
              <div className="rounded-xl border border-dashed border-border bg-surface/60 p-4 text-sm text-text-muted">
                {activeProject ? 'No saved workspaces in this project yet. Upload a workbook, then click Save workspace.' : 'Open a project to see its saved workspaces.'}
              </div>
            )}
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-5 xl:grid-cols-[390px_minmax(0,1fr)]">
        <div className="space-y-5">
          <div className="card p-5">
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent/10 text-accent">
                <FileSpreadsheet size={20} />
              </span>
              <div>
                <h2 className="text-base font-semibold text-text-primary">Workbook status</h2>
                <p className="text-xs text-text-muted">Parsed locally before Terraform review.</p>
              </div>
            </div>

            <div className="mt-5 rounded-xl border border-border bg-surface p-4">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-text-primary">{fileName || 'No workbook selected'}</p>
                <p className="mt-1 text-xs text-text-muted">{manifest ? `${summary.vpcs} VPCs and ${summary.subnets} subnets detected` : 'Use step 01 above to upload the Excel workbook.'}</p>
              </div>
            </div>

            {loading && (
              <Notice tone="info" title="Parsing workbook" detail="Building the deployment manifest and Terraform review bundle." />
            )}
            {error && (
              <Notice tone="error" title="Workbook could not be parsed" detail={error} />
            )}

            <div className="mt-5 rounded-xl border border-border bg-surface/80 p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-semibold text-text-primary">Workspace creation</p>
                  <p className="mt-1 text-xs leading-5 text-text-muted">
                    {activeProject?.project_name ? `Save this package inside ${activeProject?.project_name}.` : 'Create or select a Terraform project before saving.'}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={!activeProject || !manifest || !files.length || workspaceSaving}
                  onClick={saveCurrentWorkspace}
                  className="inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-accent-foreground shadow-sm shadow-accent/20 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {workspaceSaving ? <RefreshCw size={16} className="animate-spin" /> : <Database size={16} />}
                  Save workspace
                </button>
              </div>
            </div>

            <div className="mt-5 rounded-xl border border-warning/25 bg-warning/5 p-4">
              <div className="flex gap-3">
                <LockKeyhole size={18} className="mt-0.5 text-warning" />
                <div>
                  <p className="text-sm font-semibold text-text-primary">Deployment guardrail</p>
                <p className="mt-1 text-xs leading-5 text-text-secondary">
                    The GitHub PR path only needs access key and secret key in the client repo. Apply remains blocked until the reviewed plan is approved.
                  </p>
                </div>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Metric title="Accounts" value={summary.accounts} icon={ShieldCheck} caption="Context only" />
            <Metric title="Regions" value={summary.regions.length} icon={Server} caption={summary.regions[0] || 'None'} />
            <Metric title="VPCs" value={summary.vpcs} icon={Network} caption={`${summary.natEnabled} NAT enabled`} />
            <Metric title="Subnets" value={summary.subnets} icon={Route} caption={`${summary.publicSubnets} public / ${summary.privateSubnets} private`} />
          </div>
        </div>

        <div className="space-y-5">
          {reviewSummary && (
            <ReviewAssistant summary={reviewSummary} />
          )}

          <div className="card overflow-hidden">
            <div className="flex flex-col gap-3 border-b border-border px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <h2 className="text-base font-semibold text-text-primary">Network manifest</h2>
                <p className="mt-1 text-xs text-text-muted">Only VPC networking is generated. Non-network workbook tabs stay outside Terraform scope.</p>
              </div>
              <span className="inline-flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1.5 text-xs font-semibold text-text-secondary">
                <FileCheck2 size={14} />
                {manifest ? manifest.deployment_name : 'Awaiting workbook'}
              </span>
            </div>

            {manifest ? (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] text-left">
                  <thead>
                    <tr className="border-b border-border bg-surface/80">
                      <th className="px-5 py-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-text-muted">Type</th>
                      <th className="px-5 py-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-text-muted">Name</th>
                      <th className="px-5 py-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-text-muted">CIDR</th>
                      <th className="px-5 py-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-text-muted">Placement</th>
                    </tr>
                  </thead>
                  <tbody>
                    {manifest.vpcs.map((vpc) => (
                      <tr key={`vpc-${vpc.logical_name}`} className="border-b border-border/80">
                        <td className="px-5 py-3 text-sm font-semibold text-text-primary">VPC</td>
                        <td className="px-5 py-3 text-sm text-text-secondary">{vpc.logical_name}</td>
                        <td className="px-5 py-3 font-mono text-xs text-text-secondary">{vpc.cidr}</td>
                        <td className="px-5 py-3 text-sm text-text-secondary">{vpc.region}</td>
                      </tr>
                    ))}
                    {manifest.subnets.map((subnet) => (
                      <tr key={`subnet-${subnet.logical_name}`} className="border-b border-border/80">
                        <td className="px-5 py-3 text-sm font-semibold text-text-primary">Subnet</td>
                        <td className="px-5 py-3 text-sm text-text-secondary">{subnet.logical_name}</td>
                        <td className="px-5 py-3 font-mono text-xs text-text-secondary">{subnet.cidr}</td>
                        <td className="px-5 py-3 text-sm text-text-secondary">
                          <span className="capitalize">{subnet.route_type}</span> / AZ {subnet.az_label.toUpperCase()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="flex min-h-[280px] items-center justify-center px-6 py-10">
                <div className="max-w-md text-center">
                  <Network className="mx-auto text-accent" size={32} />
                  <p className="mt-4 text-base font-semibold text-text-primary">Upload a workbook to review the deployment manifest</p>
                  <p className="mt-2 text-sm leading-6 text-text-secondary">
                    The review will show accounts as context, then the VPCs and subnets that Terraform can generate.
                  </p>
                </div>
              </div>
            )}
          </div>

          {messages.length > 0 && (
            <div className="card p-5">
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-2">
                  {hasErrors ? <AlertTriangle size={18} className="text-danger" /> : <CheckCircle2 size={18} className="text-success" />}
                  <h2 className="text-base font-semibold text-text-primary">Validation</h2>
                </div>
                <span className="text-xs font-medium text-text-muted">{hasErrors ? 'Action needed' : 'Ready for code review'}</span>
              </div>
              <div className="mt-4 grid gap-3 lg:grid-cols-2">
                {messages.map((message, index) => (
                  <ValidationCard key={`${message.title}-${index}`} message={message} />
                ))}
              </div>
            </div>
          )}
        </div>
      </section>

      {deployMode === 'direct' && files.length > 0 && (
        <section className="card overflow-hidden">
          <div className="flex flex-col gap-3 border-b border-border px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <div className="flex items-center gap-2">
                <Rocket size={18} className="text-accent" />
                <h2 className="text-base font-semibold text-text-primary">Direct deployment runner</h2>
              </div>
              <p className="mt-1 text-xs text-text-muted">Use this only when the target account has the approved cross-account Terraform role.</p>
            </div>
            <span className={`w-fit rounded-full px-3 py-1 text-xs font-semibold ${tfJob ? tfStatusClass(tfJob.status) : 'bg-surface text-text-secondary'}`}>
              {deployState}
            </span>
          </div>

          <div className="grid gap-5 p-5 xl:grid-cols-[minmax(0,1fr)_360px]">
            <div className="space-y-4">
              <label className="block">
                <span className="text-sm font-semibold text-text-primary">Cross-account deploy role</span>
                <input
                  value={roleArn}
                  onChange={(event) => {
                    setRoleArn(event.target.value);
                    setTfJob(null);
                  }}
                  placeholder="arn:aws:iam::123456789012:role/TerraformDeployRole"
                  className="mt-2 w-full rounded-xl border border-border bg-surface px-4 py-3 font-mono text-sm text-text-primary outline-none transition-colors focus:border-accent"
                />
                <span className={`mt-2 block text-xs ${roleArn && !roleArnValid ? 'text-danger' : 'text-text-muted'}`}>
                  Internal runner only. The GitHub PR path above uses the client's access key and secret key instead.
                </span>
              </label>

              {runnerError && (
                <Notice tone="error" title="Terraform runner error" detail={runnerError} />
              )}

              {tfJob?.plan_output && (
                <RunnerOutput title="Latest plan output" content={tfJob.plan_output} />
              )}
              {tfJob?.apply_output && (
                <RunnerOutput title="Latest apply output" content={tfJob.apply_output} />
              )}
            </div>

            <div className="rounded-2xl border border-border bg-surface/70 p-4">
              <div className="space-y-3">
                <RunnerStep index="01" title="Create job" active={!!tfJob} />
                <RunnerStep index="02" title="Run plan" active={!!(tfJob?.plan_output || tfJob?.status === 'PLAN_SUCCEEDED' || tfJob?.status === 'APPROVED' || tfJob?.status.startsWith('APPLY_'))} />
                <RunnerStep index="03" title="Approve plan" active={!!(tfJob?.approved_at || tfJob?.status === 'APPROVED' || tfJob?.status.startsWith('APPLY_'))} />
                <RunnerStep index="04" title="Apply" active={tfJob?.status === 'APPLY_SUCCEEDED'} />
              </div>

              <div className="mt-5 grid gap-2">
                {!tfJob ? (
                  <button
                    type="button"
                    disabled={!roleArnValid || runnerLoading}
                    onClick={createDeploymentJob}
                    className="inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-4 py-3 text-sm font-semibold text-accent-foreground shadow-sm shadow-accent/20 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {runnerLoading ? <RefreshCw size={16} className="animate-spin" /> : <CloudCog size={16} />}
                    Create deployment job
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      disabled={runnerLoading || isTfJobRunning(tfJob.status)}
                      onClick={() => runRunnerAction('plan')}
                      className="inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-4 py-3 text-sm font-semibold text-accent-foreground shadow-sm shadow-accent/20 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {isTfJobRunning(tfJob.status) ? <RefreshCw size={16} className="animate-spin" /> : <Play size={16} />}
                      Run Terraform plan
                    </button>
                    <button
                      type="button"
                      disabled={runnerLoading || tfJob.status !== 'PLAN_SUCCEEDED'}
                      onClick={() => runRunnerAction('approve')}
                      className="inline-flex items-center justify-center gap-2 rounded-lg border border-border bg-background px-4 py-3 text-sm font-semibold text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <ShieldCheck size={16} />
                      Approve latest plan
                    </button>
                    <button
                      type="button"
                      disabled={runnerLoading || !tfJob.approved_at || !['APPROVED', 'APPLY_FAILED'].includes(tfJob.status)}
                      onClick={() => runRunnerAction('apply')}
                      className="inline-flex items-center justify-center gap-2 rounded-lg bg-success px-4 py-3 text-sm font-semibold text-white shadow-sm shadow-success/20 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Rocket size={16} />
                      Apply to AWS
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        </section>
      )}

      {files.length > 0 && (
        <section className="card overflow-hidden">
          <div className="flex flex-col gap-4 border-b border-border px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <div className="flex items-center gap-2">
                <Code2 size={18} className="text-accent" />
                <h2 className="text-base font-semibold text-text-primary">Terraform review</h2>
              </div>
              <p className="mt-1 text-xs text-text-muted">Generated for source review. AWS changes require a controlled plan and approval workflow.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => downloadFile(selected)}
                className="inline-flex items-center justify-center gap-2 rounded-lg border border-border bg-surface px-4 py-2.5 text-sm font-semibold text-text-primary transition-colors hover:bg-surface-elevated"
              >
                <Download size={16} />
                Download file
              </button>
              <button
                type="button"
                onClick={downloadBundle}
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-accent-foreground shadow-sm shadow-accent/20"
              >
                <Download size={16} />
                Download bundle
              </button>
            </div>
          </div>
          <div className="grid min-h-[500px] grid-cols-1 lg:grid-cols-[250px_1fr]">
            <aside className="border-b border-border bg-surface/80 p-3 lg:border-b-0 lg:border-r">
              <div className="space-y-1">
                {files.map((file) => (
                  <button
                    key={file.filename}
                    onClick={() => setSelectedFile(file.filename)}
                    className={`flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-medium transition-colors ${selected?.filename === file.filename ? 'bg-accent/10 text-accent' : 'text-text-secondary hover:bg-surface-elevated hover:text-text-primary'}`}
                  >
                    <span>{file.filename}</span>
                    {selected?.filename === file.filename && <ArrowRight size={14} />}
                  </button>
                ))}
              </div>
            </aside>
            <pre className="overflow-auto bg-[#07111f] p-5 text-xs leading-6 text-slate-100">
              <code>{selected?.content || ''}</code>
            </pre>
          </div>
        </section>
      )}
    </div>
    {destroyDialogOpen && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 px-4 py-6 backdrop-blur-sm">
        <div className="w-full max-w-xl rounded-2xl border border-danger/25 bg-background p-5 shadow-2xl">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.18em] text-danger">Destructive workflow</p>
              <h2 className="mt-2 text-2xl font-semibold text-text-primary">Confirm Terraform destroy</h2>
            </div>
            <button
              type="button"
              onClick={() => {
                setDestroyDialogOpen(false);
                setDestroyConfirmation('');
              }}
              className="rounded-lg border border-border bg-surface p-2 text-text-secondary hover:text-text-primary"
              aria-label="Close destroy confirmation"
            >
              <X size={18} />
            </button>
          </div>

          <div className="mt-5 rounded-2xl border border-danger/30 bg-danger/10 p-4">
            <p className="text-sm font-semibold text-danger">This can remove AWS resources from the target account.</p>
            <p className="mt-2 text-sm leading-6 text-text-secondary">
              For client deployments this is not recommended unless the client has explicitly approved teardown. Review the GitHub workflow and AWS account before continuing.
            </p>
          </div>

          <label className="mt-5 block">
            <span className="text-sm font-semibold text-text-primary">Type DESTROY to continue</span>
            <input
              value={destroyConfirmation}
              onChange={(event) => setDestroyConfirmation(event.target.value)}
              placeholder="DESTROY"
              className="mt-2 w-full rounded-xl border border-border bg-surface px-4 py-3 text-sm text-text-primary outline-none transition-colors focus:border-danger"
            />
          </label>

          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => {
                setDestroyDialogOpen(false);
                setDestroyConfirmation('');
              }}
              className="inline-flex items-center justify-center rounded-lg border border-border bg-surface px-4 py-3 text-sm font-semibold text-text-primary"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={destroyConfirmation !== 'DESTROY' || githubDestroyLoading}
              onClick={startGithubDestroy}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-danger px-4 py-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              {githubDestroyLoading ? <RefreshCw size={16} className="animate-spin" /> : <Trash2 size={16} />}
              Start destroy workflow
            </button>
          </div>
        </div>
      </div>
    )}
    {deleteTarget && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 px-4 py-6 backdrop-blur-sm">
        <div className="w-full max-w-lg rounded-2xl border border-danger/25 bg-background p-5 shadow-2xl">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.18em] text-danger">Delete {deleteTarget.type}</p>
              <h2 className="mt-2 text-2xl font-semibold text-text-primary">{deleteTarget.name}</h2>
            </div>
            <button
              type="button"
              onClick={() => setDeleteTarget(null)}
              className="rounded-lg border border-border bg-surface p-2 text-text-secondary hover:text-text-primary"
              aria-label="Close delete confirmation"
            >
              <X size={18} />
            </button>
          </div>
          <p className="mt-4 text-sm leading-6 text-text-secondary">
            {deleteTarget.type === 'project'
              ? 'This will delete the project and all saved Terraform workspaces inside it. Generated client GitHub repositories and deployed AWS resources are not deleted.'
              : 'This will delete the saved workspace files from the platform. Client GitHub repositories and deployed AWS resources are not deleted.'}
          </p>
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => setDeleteTarget(null)}
              className="inline-flex items-center justify-center rounded-lg border border-border bg-surface px-4 py-3 text-sm font-semibold text-text-primary"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={confirmDelete}
              disabled={projectActionLoadingId === deleteTarget.id || workspaceActionLoadingId === deleteTarget.id}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-danger px-4 py-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              {(projectActionLoadingId === deleteTarget.id || workspaceActionLoadingId === deleteTarget.id) ? <RefreshCw size={16} className="animate-spin" /> : <Trash2 size={16} />}
              Delete
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  );
  */
}

function ReviewAssistant({ summary }: { summary: TfReviewSummary }) {
  const toneClass = summary.readiness === 'Blocked'
    ? 'bg-danger/10 text-danger'
    : summary.readiness === 'Review needed'
      ? 'bg-warning/10 text-warning'
      : 'bg-success/10 text-success';

  const visibleFindings = summary.findings.slice(0, 4);

  return (
    <div className="card overflow-hidden">
      <div className="border-b border-border px-5 py-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
              <BrainCircuit size={20} />
            </span>
            <div>
              <h2 className="text-base font-semibold text-text-primary">Deployment review assistant</h2>
              <p className="mt-1 text-xs leading-5 text-text-muted">{summary.headline}</p>
            </div>
          </div>
          <span className={`w-fit rounded-full px-3 py-1 text-xs font-semibold ${toneClass}`}>
            {summary.readiness}
          </span>
        </div>
      </div>

      <div className="grid gap-0 lg:grid-cols-[0.9fr_1.1fr]">
        <div className="border-b border-border p-5 lg:border-b-0 lg:border-r">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-text-muted">Resource plan</p>
          <div className="mt-4 grid gap-2">
            {summary.resource_plan.map((item) => (
              <div key={item.label} className="rounded-xl border border-border bg-surface/70 px-3 py-3">
                <div className="flex items-center justify-between gap-4">
                  <p className="text-sm font-semibold text-text-primary">{item.label}</p>
                  <p className="font-mono text-lg font-semibold text-accent">{item.count}</p>
                </div>
                <p className="mt-1 text-xs leading-5 text-text-muted">{item.detail}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="p-5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-text-muted">Recommendations</p>
          <div className="mt-4 space-y-3">
            {visibleFindings.map((finding, index) => (
              <div key={`${finding.title}-${index}`} className="rounded-xl border border-border bg-surface/60 px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-semibold text-text-primary">{finding.title}</p>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${finding.severity === 'error' ? 'bg-danger/10 text-danger' : finding.severity === 'warning' ? 'bg-warning/10 text-warning' : 'bg-success/10 text-success'}`}>
                    {finding.severity}
                  </span>
                </div>
                <p className="mt-1 text-xs leading-5 text-text-secondary">{finding.recommendation}</p>
              </div>
            ))}
          </div>
          <div className="mt-4 rounded-xl border border-border bg-background/60 px-4 py-3">
            <p className="text-xs font-semibold text-text-primary">Next checkpoint</p>
            <p className="mt-1 text-xs leading-5 text-text-secondary">{summary.next_steps[0]}</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function FlowItem({ active, warning, locked, label, value }: { active: boolean; warning?: boolean; locked?: boolean; label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-surface/70 px-3 py-2.5">
      <div>
        <p className="text-xs font-semibold text-text-primary">{label}</p>
        <p className="mt-0.5 text-[11px] text-text-muted">{value}</p>
      </div>
      <span className={`h-2.5 w-2.5 rounded-full ${locked ? 'bg-text-muted' : warning ? 'bg-warning' : active ? 'bg-success' : 'bg-border'}`} />
    </div>
  );
}

function Metric({ title, value, icon: Icon, caption }: { title: string; value: number; icon: LucideIcon; caption: string }) {
  return (
    <div className="card p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent/10 text-accent">
          <Icon size={18} />
        </span>
        <p className="text-2xl font-semibold text-text-primary">{value}</p>
      </div>
      <p className="mt-4 text-sm font-semibold text-text-primary">{title}</p>
      <p className="mt-1 truncate text-xs text-text-muted">{caption}</p>
    </div>
  );
}

function Notice({ tone, title, detail }: { tone: 'info' | 'error'; title: string; detail: ReactNode }) {
  const toneClass = tone === 'error'
    ? 'border-danger/30 bg-danger/5 text-danger'
    : 'border-accent/25 bg-accent/5 text-accent';

  return (
    <div className={`mt-4 rounded-lg border px-4 py-3 ${toneClass}`}>
      <p className="text-sm font-semibold">{title}</p>
      <p className="mt-1 text-xs leading-5 text-text-secondary">{detail}</p>
    </div>
  );
}

function ValidationCard({ message }: { message: TfValidationMessage }) {
  const toneClass = message.severity === 'error'
    ? 'border-danger/30 bg-danger/5'
    : message.severity === 'warning'
      ? 'border-warning/30 bg-warning/5'
      : 'border-success/25 bg-success/5';

  return (
    <div className={`rounded-xl border px-4 py-3 ${toneClass}`}>
      <p className="text-sm font-semibold text-text-primary">{message.title}</p>
      <p className="mt-1 text-xs leading-5 text-text-secondary">{message.detail}</p>
    </div>
  );
}

function DeliveryCheck({ title, detail, active }: { title: string; detail: string; active: boolean }) {
  return (
    <div className={`rounded-xl border px-4 py-3 ${active ? 'border-success/25 bg-success/5' : 'border-border bg-background/70'}`}>
      <div className="flex items-center gap-2">
        <span className={`h-2.5 w-2.5 rounded-full ${active ? 'bg-success' : 'bg-border'}`} />
        <p className="text-sm font-semibold text-text-primary">{title}</p>
      </div>
      <p className="mt-2 text-xs leading-5 text-text-secondary">{detail}</p>
    </div>
  );
}

function DeliveryStep({ index, title, status, children }: { index: string; title: string; status: string; open?: boolean; children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-border bg-background/70 px-4 py-3">
      <div className="flex items-center justify-between gap-4">
        <span className="flex items-center gap-3">
          <span className="font-mono text-xs font-semibold text-accent">{index}</span>
          <span className="text-sm font-semibold text-text-primary">{title}</span>
        </span>
        <span className="rounded-full bg-surface px-3 py-1 text-xs font-semibold text-text-muted">{status}</span>
      </div>
      <div className="mt-4 border-t border-border pt-4">
        {children}
      </div>
    </div>
  );
}

function PathStep({ index, title, detail, active }: { index: string; title: string; detail: string; active: boolean }) {
  return (
    <div className={`rounded-2xl border px-4 py-3 ${active ? 'border-accent/30 bg-accent/10' : 'border-border bg-surface/60'}`}>
      <div className="flex items-start gap-3">
        <span className={`mt-0.5 font-mono text-xs font-semibold ${active ? 'text-accent' : 'text-text-muted'}`}>{index}</span>
        <div>
          <p className="text-sm font-semibold text-text-primary">{title}</p>
          <p className="mt-1 text-xs leading-5 text-text-secondary">{detail}</p>
        </div>
      </div>
    </div>
  );
}

function RunnerStep({ index, title, active }: { index: string; title: string; active: boolean }) {
  return (
    <div className={`flex items-center justify-between gap-3 rounded-xl border px-3 py-3 ${active ? 'border-accent/25 bg-accent/10' : 'border-border bg-background/70'}`}>
      <div className="flex items-center gap-3">
        <span className={`font-mono text-xs font-semibold ${active ? 'text-accent' : 'text-text-muted'}`}>{index}</span>
        <span className="text-sm font-semibold text-text-primary">{title}</span>
      </div>
      <span className={`h-2.5 w-2.5 rounded-full ${active ? 'bg-success' : 'bg-border'}`} />
    </div>
  );
}

function RunnerOutput({ title, content }: { title: string; content: string }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-[#07111f]">
      <div className="border-b border-white/10 px-4 py-3">
        <p className="text-sm font-semibold text-white">{title}</p>
      </div>
      <pre className="max-h-80 overflow-auto p-4 text-xs leading-6 text-slate-100">
        <code>{content}</code>
      </pre>
    </div>
  );
}

function isTfJobRunning(status?: string): boolean {
  return ['PLAN_QUEUED', 'PLAN_RUNNING', 'APPLY_QUEUED', 'APPLY_RUNNING'].includes(status || '');
}

function getRequestedTfView(): 'workspaces' | 'new' {
  if (typeof window === 'undefined') return 'workspaces';
  return new URLSearchParams(window.location.search).get('view') === 'new' ? 'new' : 'workspaces';
}

function isTfJobFailed(status?: string): boolean {
  return ['PLAN_FAILED', 'APPLY_FAILED'].includes(status || '');
}

function humanTfStatus(status: string): string {
  const labels: Record<string, string> = {
    CREATED: 'Job created',
    PLAN_QUEUED: 'Plan queued',
    PLAN_RUNNING: 'Plan running',
    PLAN_SUCCEEDED: 'Plan ready',
    PLAN_FAILED: 'Plan failed',
    APPROVED: 'Approved',
    APPLY_QUEUED: 'Apply queued',
    APPLY_RUNNING: 'Apply running',
    APPLY_SUCCEEDED: 'Applied',
    APPLY_FAILED: 'Apply failed',
  };
  return labels[status] || status;
}

function tfStatusClass(status: string): string {
  if (isTfJobFailed(status)) return 'bg-danger/10 text-danger';
  if (isTfJobRunning(status)) return 'bg-warning/10 text-warning';
  if (status === 'APPLY_SUCCEEDED' || status === 'PLAN_SUCCEEDED' || status === 'APPROVED') return 'bg-success/10 text-success';
  return 'bg-surface text-text-secondary';
}

function slugForDownload(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'terraform-review';
}
