import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  ArrowRight,
  BarChart3,
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Clock3,
  Command,
  Database,
  FileText,
  FolderKanban,
  History,
  LayoutDashboard,
  LoaderCircle,
  LogOut,
  Menu,
  MoreHorizontal,
  Play,
  Plus,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  Upload,
  FileDown,
  Trash2,
  X,
  Zap,
} from 'lucide-react';
import {
  getListAgentsQueryKey,
  getGetDashboardQueryKey,
  getListActivityQueryKey,
  getListDocumentsQueryKey,
  getListWorkflowsQueryKey,
  getGetWorkspaceSettingsQueryKey,
  useAnalyzeProject,
  useCreateDocument,
  useCreateWorkflow,
  useDeleteDocument,
  useDecideApproval,
  useGetWorkspaceSettings,
  useRunAgent,
  useRunCommandCenter,
  useUpdateWorkflow,
  useUpdateWorkspaceSettings,
  useCreateAgent,
  useGetDashboard,
  useHealthCheck,
  useListActivity,
  useListAgents,
  useListDocuments,
  useListProjects,
  useListWorkflows,
  useRunWorkflow,
  type ActivityEvent,
  type Agent,
  type Dashboard,
  type Document,
  type Project,
  type Workflow,
} from '@workspace/api-client-react';
import { useAuth } from '@workspace/auth-web';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Link, Route, Switch, Router as WouterRouter, useLocation, useParams } from 'wouter';

const queryClient = new QueryClient();

const navGroups = [
  {
    label: 'Workspace',
    links: [
      { href: '/', label: 'Overview', icon: LayoutDashboard },
      { href: '/agents', label: 'AI agents', icon: Bot },
      { href: '/workflows', label: 'Workflows', icon: Zap },
      { href: '/projects', label: 'Projects', icon: FolderKanban },
    ],
  },
  {
    label: 'Knowledge & signals',
    links: [
      { href: '/documents', label: 'Documents', icon: FileText },
      { href: '/analytics', label: 'Analytics', icon: BarChart3 },
      { href: '/activity', label: 'Activity log', icon: History },
    ],
  },
];

function cn(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ');
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : 'The workspace could not be reached.';
}

function Skeleton({ className = '' }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-slate-200/70', className)} />;
}

function EmptyState({ icon: Icon, title, detail, action }: { icon: typeof Bot; title: string; detail: string; action?: ReactNode }) {
  return (
    <div className="flex min-h-64 flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 bg-white/60 p-8 text-center">
      <div className="mb-4 flex size-11 items-center justify-center rounded-full bg-teal-50 text-teal-700"><Icon size={20} /></div>
      <h3 className="font-display text-base font-semibold text-slate-900">{title}</h3>
      <p className="mt-1 max-w-sm text-sm leading-6 text-slate-500">{detail}</p>
      {action}
    </div>
  );
}

function ErrorState({ message, retry }: { message: string; retry: () => void }) {
  return (
    <div className="flex min-h-52 flex-col items-center justify-center rounded-xl border border-rose-200 bg-rose-50/50 p-8 text-center">
      <CircleAlert className="mb-3 text-rose-600" size={22} />
      <h3 className="font-display font-semibold text-slate-900">Something interrupted the workspace</h3>
      <p className="mt-1 text-sm text-slate-500">{message}</p>
      <button data-testid="button-retry" onClick={retry} className="mt-4 inline-flex items-center gap-2 rounded-lg bg-slate-900 px-3 py-2 text-sm font-semibold text-white transition hover:bg-slate-700">Try again <ArrowRight size={14} /></button>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const normalized = status.toLowerCase();
  const tone = normalized.includes('active') || normalized.includes('processed') || normalized.includes('completed') || normalized.includes('on track')
    ? 'status-good'
    : normalized.includes('paused') || normalized.includes('processing') || normalized.includes('waiting') || normalized.includes('draft')
      ? 'status-warn'
      : normalized.includes('failed') || normalized.includes('blocked') || normalized.includes('risk')
        ? 'status-bad' : 'status-neutral';
  return <span data-testid={`status-${normalized.replaceAll(' ', '-')}`} className={cn('status-pill', tone)}><span className="size-1.5 rounded-full bg-current" />{status}</span>;
}

function Avatar({ initials, color, size = 'md' }: { initials: string; color?: string; size?: 'sm' | 'md' | 'lg' }) {
  return <span data-testid={`avatar-${initials}`} className={cn('avatar', size === 'sm' ? 'size-7 text-[10px]' : size === 'lg' ? 'size-12 text-sm' : 'size-9 text-xs')} style={{ background: color || '#d8ede9' }}>{initials}</span>;
}

function PageHeading({ eyebrow, title, detail, children }: { eyebrow: string; title: string; detail: string; children?: ReactNode }) {
  return (
    <div className="mb-7 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1 data-testid={`heading-${title.toLowerCase().replaceAll(' ', '-')}`} className="mt-2 font-display text-3xl font-semibold tracking-[-0.04em] text-slate-950">{title}</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">{detail}</p>
      </div>
      {children}
    </div>
  );
}

function Shell({ children }: { children: ReactNode }) {
  const [location, setLocation] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const { user, logout } = useAuth();
  const queryClient = useQueryClient();
  const { data: workspaceSettings } = useGetWorkspaceSettings();
  const { data: health } = useHealthCheck({ query: { staleTime: 60_000, queryKey: ['/api/healthz'] } });
  const currentLabel = [...navGroups.flatMap((group) => group.links)].find((link) => link.href === location)?.label || (location.startsWith('/agents/') ? 'Agent detail' : location.startsWith('/workflows/') ? 'Workflow detail' : 'Workspace');
  return (
    <div className="min-h-[100dvh] bg-[hsl(var(--background))]">
      <aside className={cn('fixed inset-y-0 left-0 z-40 flex w-[248px] flex-col border-r border-slate-700/40 bg-[hsl(var(--sidebar))] px-4 py-5 text-slate-300 transition-transform duration-300 md:translate-x-0', mobileOpen ? 'translate-x-0' : '-translate-x-full')}>
        <div className="mb-8 flex items-center justify-between px-2">
          <Link href="/" data-testid="link-brand" className="flex items-center gap-3" onClick={() => setMobileOpen(false)}>
            <span className="brand-mark"><span /></span>
            <span className="font-display text-[17px] font-semibold tracking-[-0.04em] text-white">flowmind</span>
          </Link>
          <button data-testid="button-close-mobile-nav" onClick={() => setMobileOpen(false)} className="rounded-md p-1 text-slate-400 hover:bg-white/10 md:hidden"><X size={17} /></button>
        </div>
         <div className="mb-6 rounded-lg border border-white/10 bg-white/[0.06] p-3">
          <div className="flex items-center gap-3"><span className="flex size-8 items-center justify-center rounded-md bg-teal-400/15 text-teal-300"><Command size={16} /></span><div className="min-w-0"><p className="truncate text-xs font-semibold text-white">{workspaceSettings?.name || 'FlowMind workspace'}</p><p className="mt-0.5 text-[10px] text-slate-500">Operations control plane</p></div><ChevronDown size={14} className="ml-auto text-slate-500" /></div>
        </div>
        <nav className="nav-scroll flex-1 space-y-7">
          {navGroups.map((group) => <div key={group.label}><p className="nav-label">{group.label}</p><div className="mt-2 space-y-1">{group.links.map((item) => { const Icon = item.icon; const active = location === item.href; return <Link key={item.href} href={item.href} data-testid={`link-nav-${item.label.toLowerCase().replaceAll(' ', '-')}`} onClick={() => setMobileOpen(false)} className={cn('nav-item', active && 'nav-item-active')}><Icon size={16} strokeWidth={active ? 2.4 : 1.8} /><span>{item.label}</span></Link>; })}</div></div>)}
        </nav>
        <div className="border-t border-white/10 pt-4">
          <Link href="/settings" data-testid="link-nav-settings" onClick={() => setMobileOpen(false)} className={cn('nav-item', location === '/settings' && 'nav-item-active')}><Settings2 size={16} /><span>Workspace settings</span></Link>
           <div className="mt-4 flex items-center gap-3 rounded-lg p-2"><span className="avatar size-8 bg-amber-300 text-[10px] text-slate-900">{`${user?.firstName?.[0] || user?.email?.[0] || 'U'}${user?.lastName?.[0] || ''}`.toUpperCase()}</span><div className="min-w-0 flex-1"><p className="truncate text-xs font-semibold text-white">{user?.firstName ? `${user.firstName}${user.lastName ? ` ${user.lastName}` : ''}` : user?.email || 'Workspace member'}</p><p className="truncate text-[10px] text-slate-500">{workspaceSettings?.name || 'FlowMind workspace'}</p></div><button aria-label="Sign out" data-testid="button-logout" onClick={() => { queryClient.clear(); logout(); }} className="rounded p-1 text-slate-400 hover:bg-white/10 hover:text-white"><LogOut size={15} /></button></div>
        </div>
      </aside>
      {mobileOpen && <button aria-label="Close navigation" data-testid="button-dismiss-nav" onClick={() => setMobileOpen(false)} className="fixed inset-0 z-30 bg-slate-950/30 md:hidden" />}
      <div className="md:pl-[248px]">
        <header className="sticky top-0 z-20 flex h-[68px] items-center justify-between border-b border-slate-200/80 bg-[hsl(var(--background))]/90 px-5 backdrop-blur-md md:px-9">
          <div className="flex items-center gap-3"><button data-testid="button-open-mobile-nav" onClick={() => setMobileOpen(true)} className="rounded-md p-2 text-slate-600 hover:bg-slate-200/70 md:hidden"><Menu size={18} /></button><div className="flex items-center gap-2 text-xs text-slate-400"><span>Workspace</span><span>/</span><span className="font-medium text-slate-700">{currentLabel}</span></div></div>
          <div className="flex items-center gap-3"><div className="hidden items-center gap-2 text-[11px] text-slate-500 sm:flex"><span className={cn('size-1.5 rounded-full', health?.status === 'ok' ? 'bg-teal-500' : 'bg-amber-400')} />{health?.status === 'ok' ? 'Systems nominal' : 'System status unavailable'}</div><button data-testid="button-global-search" title="Open activity search" onClick={() => setLocation('/activity')} className="icon-button"><Search size={17} /></button><button data-testid="button-notifications" title="Open the approval overview" onClick={() => setLocation('/')} className="icon-button"><Activity size={17} /></button></div>
        </header>
        <main className="mx-auto max-w-[1500px] px-5 py-7 md:px-9 md:py-9">{children}</main>
      </div>
    </div>
  );
}

function MetricStrip({ metrics }: { metrics: Array<{ label: string; value: string; change: string; trend: string }> }) {
  const icons = [Zap, CheckCircle2, Activity, FileText];
  return <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">{metrics.map((metric, index) => {
    const Icon = icons[index % icons.length];
    return <div key={metric.label} data-testid={`metric-${index}`} className="metric-card">
      <div className="flex items-start justify-between"><span className="text-xs font-medium text-slate-500">{metric.label}</span><span className="metric-icon"><Icon size={14} /></span></div>
      <div className="mt-4 flex flex-wrap items-end gap-2"><strong className="font-display text-2xl font-semibold tracking-[-0.05em] text-slate-950">{metric.value}</strong><span className={cn('mb-0.5 text-[11px] font-semibold', metric.trend === 'up' ? 'text-teal-700' : 'text-slate-500')}>{metric.change}</span></div>
    </div>;
  })}</div>;
}

function ActivityList({ items, limit }: { items: ActivityEvent[]; limit?: number }) {
  const visible = limit ? items.slice(0, limit) : items;
  if (!visible.length) return <EmptyState icon={Activity} title="No activity yet" detail="Completed runs and human decisions will appear here." />;
  return <div className="divide-y divide-slate-100">{visible.map((event) => <div data-testid={`activity-event-${event.id}`} key={event.id} className="activity-row"><span className="activity-dot" style={{ background: event.color || '#55b8a5' }} /><div className="min-w-0 flex-1"><div className="flex flex-wrap items-baseline gap-x-2 gap-y-1"><p className="text-sm font-semibold text-slate-800">{event.title}</p><span className="text-[11px] text-slate-400">{event.action}</span></div><p className="mt-1 truncate text-xs text-slate-500">{event.detail}</p></div><div className="ml-3 flex shrink-0 flex-col items-end gap-1"><span className="font-mono text-[10px] text-slate-400">{event.time}</span><StatusPill status={event.status} /></div></div>)}</div>;
}

function DashboardPage() {
  const { data, isLoading, isError, error, refetch } = useGetDashboard();
  const { data: workspaceSettings } = useGetWorkspaceSettings();
  const decideApproval = useDecideApproval();
  const queryClient = useQueryClient();
  const [showCommand, setShowCommand] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [draft, setDraft] = useState('');
  const { user } = useAuth();
  const dashboard = data as Dashboard | undefined;
  if (isLoading) return <LoadingDashboard />;
  if (isError) return <ErrorState message={formatError(error)} retry={() => refetch()} />;
  const metrics = dashboard?.metrics || [];
  const activities = dashboard?.activity || [];
  const projects = dashboard?.projects || [];
  const approval = dashboard?.approval;
  const decide = (status: 'Approved' | 'Rejected', proposedDraft = draft) => {
    if (!approval?.id) return;
    decideApproval.mutate({ id: approval.id, data: { status, draft: proposedDraft } }, {
      onSuccess: async () => {
        setReviewing(false);
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: getGetDashboardQueryKey() }),
          queryClient.invalidateQueries({ queryKey: getListActivityQueryKey() }),
        ]);
      },
    });
  };
  return <div className="animate-page-in">
    <PageHeading eyebrow={new Date().toLocaleDateString(undefined, { timeZone: workspaceSettings?.timezone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} title={`Good day${user?.firstName ? `, ${user.firstName}` : ''}.`} detail="A clear view of what your AI teammates handled and what needs your judgment today."><button data-testid="button-command-center" onClick={() => setShowCommand(true)} className="primary-button"><Sparkles size={15} />Ask command center</button></PageHeading>
    <MetricStrip metrics={metrics} />
    <div className="mt-7 grid gap-5 xl:grid-cols-[1.35fr_0.65fr]">
      <section className="panel overflow-hidden"><div className="panel-header"><div><p className="eyebrow">Live pulse</p><h2 className="panel-title">Automation activity</h2></div><Link href="/activity" data-testid="link-view-all-activity" className="text-xs font-semibold text-teal-700 hover:text-teal-900">View all <ArrowRight className="ml-1 inline" size={13} /></Link></div><div className="px-5"><ActivityList items={activities} limit={5} /></div></section>
      <section className="panel"><div className="panel-header"><div><p className="eyebrow">Human in the loop</p><h2 className="panel-title">Approval queue</h2></div><span className="flex size-6 items-center justify-center rounded-full bg-amber-100 text-[11px] font-bold text-amber-800">{approval?.pending ? '1' : '0'}</span></div>{approval?.pending ? <div className="p-5"><div className="rounded-lg border border-amber-200 bg-amber-50/70 p-4"><div className="flex items-center gap-2"><Avatar initials={approval.agent.slice(0, 2).toUpperCase()} color="#f6d48b" size="sm" /><span className="text-xs font-semibold text-amber-900">{approval.agent}</span><span className="ml-auto text-[10px] text-amber-700">Needs review</span></div><h3 className="mt-4 text-sm font-semibold leading-5 text-slate-900">{approval.title}</h3><p className="mt-2 line-clamp-3 text-xs leading-5 text-slate-600">“{approval.excerpt}”</p><div className="mt-4 flex gap-2"><button data-testid="button-approve-item" onClick={() => { setDraft(approval.draft); decide('Approved', approval.draft); }} disabled={decideApproval.isPending} className="secondary-button flex-1"><Check size={14} />Approve</button><button data-testid="button-review-item" onClick={() => { setDraft(approval.draft); setReviewing(true); }} className="dark-button flex-1">Review</button></div>{decideApproval.isError && <p className="mt-2 text-xs text-rose-700">{formatError(decideApproval.error)}</p>}</div></div> : <div className="p-5"><EmptyState icon={ShieldCheck} title="Queue is clear" detail="No decisions are waiting for a human right now." /></div>}</section>
    </div>
    <div className="mt-5 grid gap-5 xl:grid-cols-[0.9fr_1.1fr]">
      <section className="panel"><div className="panel-header"><div><p className="eyebrow">Delivery radar</p><h2 className="panel-title">Projects at a glance</h2></div><Link href="/projects" data-testid="link-view-projects" className="icon-button"><ArrowRight size={16} /></Link></div><div className="divide-y divide-slate-100">{projects.slice(0, 4).map((project) => <Link href="/projects" data-testid={`project-glance-${project.id}`} key={project.id} className="flex items-center gap-3 px-5 py-4 transition hover:bg-slate-50"><span className="size-2 rounded-full" style={{ background: project.color }} /><div className="min-w-0 flex-1"><div className="flex items-center justify-between gap-3"><p className="truncate text-sm font-semibold text-slate-800">{project.name}</p><span className="text-xs font-mono text-slate-500">{project.progress}%</span></div><div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-teal-500" style={{ width: `${project.progress}%` }} /></div></div><StatusPill status={project.health} /></Link>)}</div></section>
       <section className="panel flex flex-col justify-between overflow-hidden bg-slate-900 text-white"><div className="grid-pattern absolute" /><div className="relative p-6 md:p-7"><p className="eyebrow text-teal-300">Workspace insight</p><h2 className="mt-4 max-w-lg font-display text-2xl font-semibold leading-tight tracking-[-0.04em]">{projects.length ? `${projects.length} projects are in your workspace.` : 'Your workspace is ready for its first project.'}</h2><p className="mt-3 max-w-md text-sm leading-6 text-slate-400">Review project health and ask the command center to summarize delivery risks using your saved workspace data.</p><div className="mt-7 flex items-end gap-1.5"><span className="text-3xl font-semibold text-teal-300">{projects.filter((project) => project.health === 'On track').length}</span><span className="mb-1 text-xs text-slate-400">on track</span></div></div><div className="relative border-t border-white/10 px-6 py-4"><Link href="/analytics" data-testid="link-open-insights" className="text-xs font-semibold text-teal-300 hover:text-white">Explore the signal <ArrowRight className="ml-1 inline" size={13} /></Link></div></section>
    </div>
    {showCommand && <CommandCenterModal onClose={() => setShowCommand(false)} />}
    {reviewing && approval?.id && <Modal title="Review AI draft" onClose={() => setReviewing(false)}><p className="mb-3 text-sm text-slate-600">{approval.title}</p><label className="field-label">Proposed response<textarea value={draft} onChange={(event) => setDraft(event.target.value)} className="field-input min-h-36 resize-y" /></label><p className="mt-2 text-xs text-slate-500">Approving records your decision; this prototype does not send external messages.</p><div className="mt-5 flex justify-end gap-2"><button onClick={() => decide('Rejected')} disabled={decideApproval.isPending} className="secondary-button">Reject</button><button onClick={() => decide('Approved')} disabled={decideApproval.isPending || !draft.trim()} className="primary-button">{decideApproval.isPending ? <LoaderCircle size={15} className="animate-spin" /> : <Check size={15} />}Approve draft</button></div>{decideApproval.isError && <p className="mt-3 text-xs text-rose-700">{formatError(decideApproval.error)}</p>}</Modal>}
  </div>;
}

function CommandCenterModal({ onClose }: { onClose: () => void }) {
  const command = useRunCommandCenter();
  const queryClient = useQueryClient();
  const [prompt, setPrompt] = useState('');
  const [answer, setAnswer] = useState('');
  const submit = () => {
    if (!prompt.trim() || command.isPending) return;
    command.mutate({ data: { prompt: prompt.trim() } }, { onSuccess: async (result) => {
      setAnswer(result.answer);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getListActivityQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getGetDashboardQueryKey() }),
      ]);
    } });
  };
  return <Modal title="Ask the command center" onClose={onClose}>
    <p className="mb-4 text-sm leading-6 text-slate-600">Ask about your saved agents, workflows, projects, or approval queue. The answer uses this workspace’s data.</p>
    <label className="field-label">Question<textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) submit(); }} className="field-input min-h-24 resize-y" placeholder="What should I review today?" /></label>
    <div className="mt-4 flex justify-end"><button onClick={submit} disabled={!prompt.trim() || command.isPending} className="primary-button disabled:opacity-50">{command.isPending ? <LoaderCircle className="animate-spin" size={15} /> : <Send size={15} />}Ask Gemini</button></div>
    {command.isError && <p role="alert" className="mt-3 text-sm text-rose-700">{formatError(command.error)}</p>}
    {answer && <div className="mt-5 whitespace-pre-wrap rounded-lg border border-teal-200 bg-teal-50/70 p-4 text-sm leading-6 text-slate-700">{answer}</div>}
  </Modal>;
}

function LoadingDashboard() {
  return <div className="space-y-7"><div className="mb-10"><Skeleton className="h-3 w-36" /><Skeleton className="mt-3 h-10 w-72" /><Skeleton className="mt-3 h-4 w-96" /></div><div className="grid grid-cols-2 gap-3 xl:grid-cols-4">{[1, 2, 3, 4].map((item) => <Skeleton key={item} className="h-32" />)}</div><div className="grid gap-5 xl:grid-cols-2"><Skeleton className="h-96" /><Skeleton className="h-96" /></div></div>;
}

function AgentsPage() {
  const { data, isLoading, isError, error, refetch } = useListAgents();
  const createAgent = useCreateAgent();
  const queryClient = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ name: '', type: 'Operations copilot', description: '' });
  const agents = data || [];
  const submit = () => { if (!form.name.trim() || !form.description.trim()) return; createAgent.mutate({ data: form }, { onSuccess: () => { queryClient.invalidateQueries({ queryKey: getListAgentsQueryKey() }); setShowCreate(false); setForm({ name: '', type: 'Operations copilot', description: '' }); } }); };
  return <div className="animate-page-in">
    <PageHeading eyebrow="AI teammates" title="Agents" detail="Focused operators with clear scopes, visible runs, and a human-friendly handoff when judgment matters."><button data-testid="button-create-agent" onClick={() => setShowCreate(true)} className="primary-button"><Plus size={16} />Create agent</button></PageHeading>
    {isLoading ? <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{[1, 2, 3].map((item) => <Skeleton key={item} className="h-64" />)}</div> : isError ? <ErrorState message={formatError(error)} retry={() => refetch()} /> : !agents.length ? <EmptyState icon={Bot} title="Your first teammate is waiting" detail="Create a focused agent and give repetitive work a safe, reviewable home." action={<button data-testid="button-create-agent-empty" onClick={() => setShowCreate(true)} className="primary-button mt-5">Create an agent</button>} /> : <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{agents.map((agent) => <AgentCard key={agent.id} agent={agent} />)}</div>}
    {showCreate && <Modal title="Create an AI teammate" onClose={() => setShowCreate(false)}><div className="space-y-4"><label className="field-label">Agent name<input data-testid="input-agent-name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="e.g. Invoice reconciler" className="field-input" /></label><label className="field-label">Specialty<select data-testid="select-agent-type" value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value })} className="field-input"><option>Operations copilot</option><option>Customer support</option><option>Data analyst</option><option>Document reviewer</option></select></label><label className="field-label">What should it own?<textarea data-testid="textarea-agent-description" value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} placeholder="Describe the repetitive work and where a person should review." className="field-input min-h-24 resize-none" /></label><div className="flex justify-end gap-2 pt-2"><button data-testid="button-cancel-create-agent" onClick={() => setShowCreate(false)} className="secondary-button">Cancel</button><button data-testid="button-submit-create-agent" onClick={submit} disabled={createAgent.isPending || !form.name || !form.description} className="primary-button disabled:cursor-not-allowed disabled:opacity-50">{createAgent.isPending ? <LoaderCircle className="animate-spin" size={15} /> : <Plus size={15} />}Create teammate</button></div>{createAgent.isError && <p className="text-xs text-rose-600">{formatError(createAgent.error)}</p>}</div></Modal>}
  </div>;
}

function AgentCard({ agent }: { agent: Agent }) {
  return <Link href={`/agents/${agent.id}`} data-testid={`card-agent-${agent.id}`} className="panel group block p-5 transition duration-200 hover:-translate-y-0.5 hover:border-teal-300 hover:shadow-md"><div className="flex items-start justify-between"><div className="flex items-center gap-3"><Avatar initials={agent.initials} color={agent.color} /><div><h2 className="font-display font-semibold tracking-[-0.02em] text-slate-900">{agent.name}</h2><p className="mt-0.5 text-[11px] text-slate-500">{agent.type}</p></div></div><StatusPill status={agent.status} /></div><p className="mt-5 line-clamp-2 min-h-10 text-sm leading-5 text-slate-600">{agent.description}</p><div className="mt-5 flex items-center justify-between border-t border-slate-100 pt-4"><div className="flex items-center gap-2 text-xs text-slate-500"><Activity size={14} className="text-teal-600" /><span><strong className="font-semibold text-slate-800">{agent.runs.toLocaleString()}</strong> runs</span></div><div className="flex -space-x-1">{agent.tools.slice(0, 3).map((tool) => <span key={tool} title={tool} className="flex size-6 items-center justify-center rounded border-2 border-white bg-slate-100 text-[9px] font-semibold text-slate-500">{tool.slice(0, 1)}</span>)}</div></div></Link>;
}

function AgentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading } = useListAgents();
  const runAgent = useRunAgent();
  const queryClient = useQueryClient();
  const agent = (data || []).find((item) => item.id === id) || (data || [])[0];
  const [input, setInput] = useState('');
  const [sent, setSent] = useState<Array<{ key: number; prompt: string; answer: string | null }>>([]);
  if (isLoading) return <Skeleton className="h-96" />;
  if (!agent) return <EmptyState icon={Bot} title="Agent not found" detail="This teammate may have been removed from the workspace." />;
  const submit = () => {
    const prompt = input.trim();
    if (!prompt || runAgent.isPending) return;
    const key = Date.now();
    setSent((current) => [...current, { key, prompt, answer: null }]);
    setInput('');
    runAgent.mutate({ id: agent.id, data: { prompt } }, {
      onSuccess: async (result) => {
        setSent((current) => current.map((item) => item.key === key ? { ...item, answer: result.answer } : item));
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: getListAgentsQueryKey() }),
          queryClient.invalidateQueries({ queryKey: getListActivityQueryKey() }),
          queryClient.invalidateQueries({ queryKey: getGetDashboardQueryKey() }),
        ]);
      },
    });
  };
  return <div className="animate-page-in">
    <Link href="/agents" data-testid="link-back-agents" className="mb-6 inline-flex items-center gap-2 text-xs font-semibold text-slate-500 hover:text-teal-700">← All agents</Link>
    <div className="grid gap-5 xl:grid-cols-[1fr_0.7fr]">
      <section className="panel overflow-hidden">
        <div className="border-b border-slate-100 bg-slate-50/70 p-6 md:p-8"><div className="flex flex-wrap items-start justify-between gap-4"><div className="flex items-center gap-4"><Avatar initials={agent.initials} color={agent.color} size="lg" /><div><p className="eyebrow">AI teammate</p><h1 className="mt-1 font-display text-3xl font-semibold tracking-[-0.05em] text-slate-950">{agent.name}</h1><p className="mt-1 text-sm text-slate-500">{agent.type}</p></div></div><StatusPill status={agent.status} /></div><p className="mt-6 max-w-2xl text-sm leading-6 text-slate-600">{agent.description}</p></div>
        <div className="p-6 md:p-8"><div className="flex items-center justify-between"><div><p className="eyebrow">Test bench</p><h2 className="panel-title mt-1">Ask this teammate</h2></div><span className="text-xs text-slate-400">Gemini · private context follows workspace settings</span></div>
          <div className="mt-5 min-h-44 space-y-4 rounded-lg border border-slate-200 bg-slate-50/70 p-4">
            {!sent.length && <div className="flex h-36 flex-col items-center justify-center text-center"><Sparkles size={20} className="text-teal-600" /><p className="mt-2 text-sm font-medium text-slate-700">Give {agent.name} a task</p><p className="mt-1 text-xs text-slate-500">Try: “What should I review first?”</p></div>}
            {sent.map((item) => <div key={item.key} className="space-y-2"><div className="ml-auto max-w-[88%] rounded-lg bg-slate-900 px-3 py-2 text-sm text-white">{item.prompt}</div><div className="max-w-[92%] whitespace-pre-wrap rounded-lg bg-white px-3 py-2 text-sm leading-6 text-slate-700 shadow-sm">{item.answer || (runAgent.isPending ? <span className="inline-flex items-center gap-2 text-slate-400"><LoaderCircle size={14} className="animate-spin" />Thinking…</span> : 'Run failed. Try again.')}</div></div>)}
          </div>
          <div className="mt-3 flex gap-2"><input data-testid="input-agent-test" value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') submit(); }} placeholder="Ask a question or describe a task…" className="field-input" /><button data-testid="button-send-agent-test" onClick={submit} disabled={!input.trim() || runAgent.isPending} className="primary-button px-3 disabled:opacity-50">{runAgent.isPending ? <LoaderCircle size={15} className="animate-spin" /> : <Send size={15} />}</button></div>
          {runAgent.isError && <p role="alert" className="mt-2 text-xs text-rose-700">{formatError(runAgent.error)}</p>}
        </div>
      </section>
      <aside className="space-y-5"><div className="panel p-6"><p className="eyebrow">Operating record</p><div className="mt-5 grid grid-cols-2 gap-4"><div><p className="text-xs text-slate-500">Total runs</p><p className="mt-1 font-display text-2xl font-semibold text-slate-900">{agent.runs.toLocaleString()}</p></div><div><p className="text-xs text-slate-500">Tool labels</p><p className="mt-1 font-display text-2xl font-semibold text-slate-900">{agent.tools.length}</p></div></div></div><div className="panel p-6"><p className="eyebrow">Configured tool labels</p><p className="mt-1 text-xs leading-5 text-slate-500">These describe agent capabilities; no external services are connected.</p><div className="mt-4 space-y-2">{agent.tools.map((tool) => <div key={tool} className="flex items-center gap-3 rounded-lg border border-slate-100 px-3 py-2.5"><span className="flex size-7 items-center justify-center rounded-md bg-teal-50 text-teal-700"><Database size={14} /></span><span className="text-sm font-medium text-slate-700">{tool}</span><span className="ml-auto text-[10px] text-slate-400">Defined</span></div>)}</div></div></aside>
    </div>
  </div>;
}

function WorkflowsPage() {
  const { data, isLoading, isError, error, refetch } = useListWorkflows();
  const [filter, setFilter] = useState('All statuses');
  const [showCreate, setShowCreate] = useState(false);
  const workflows = data || [];
  const visible = filter === 'All statuses' ? workflows : workflows.filter((workflow) => workflow.status === filter);
  return <div className="animate-page-in"><PageHeading eyebrow="Automation library" title="Workflows" detail="Configure repeatable paths, inspect every step, and run a test against the saved definition."><div className="flex gap-2"><select data-testid="button-filter-workflows" value={filter} onChange={(event) => setFilter(event.target.value)} className="field-input w-auto"><option>All statuses</option><option>Active</option><option>Draft</option><option>Paused</option></select><button data-testid="button-create-workflow" onClick={() => setShowCreate(true)} className="primary-button"><Plus size={15} />Create workflow</button></div></PageHeading>{isLoading ? <div className="space-y-3">{[1, 2, 3].map((item) => <Skeleton key={item} className="h-24" />)}</div> : isError ? <ErrorState message={formatError(error)} retry={() => refetch()} /> : !visible.length ? <EmptyState icon={Zap} title={workflows.length ? "No workflows match this filter" : "No workflows yet"} detail="Create a workflow to define its trigger and reviewable steps." action={!workflows.length ? <button onClick={() => setShowCreate(true)} className="primary-button mt-5"><Plus size={15} />Create workflow</button> : undefined} /> : <div className="space-y-3">{visible.map((workflow) => <WorkflowRow workflow={workflow} key={workflow.id} />)}</div>}{showCreate && <WorkflowComposer onClose={() => setShowCreate(false)} />}</div>;
}

function WorkflowRow({ workflow }: { workflow: Workflow }) {
  return <Link href={`/workflows/${workflow.id}`} data-testid={`row-workflow-${workflow.id}`} className="panel flex flex-col gap-4 p-5 transition hover:border-teal-300 sm:flex-row sm:items-center"><span className="size-2.5 shrink-0 rounded-full" style={{ background: workflow.color }} /><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-3"><h2 className="font-display font-semibold text-slate-900">{workflow.name}</h2><StatusPill status={workflow.status} /></div><p className="mt-1 text-xs text-slate-500">When {workflow.trigger.toLowerCase()}</p></div><div className="grid grid-cols-3 gap-8 text-right sm:mr-5"><div><p className="text-[10px] uppercase tracking-wider text-slate-400">Runs</p><p className="mt-1 font-mono text-sm font-medium text-slate-800">{workflow.runs.toLocaleString()}</p></div><div><p className="text-[10px] uppercase tracking-wider text-slate-400">Success</p><p className="mt-1 font-mono text-sm font-medium text-teal-700">{workflow.success}</p></div><div><p className="text-[10px] uppercase tracking-wider text-slate-400">Last run</p><p className="mt-1 text-xs text-slate-600">{workflow.lastRun}</p></div></div><ArrowRight className="hidden text-slate-400 sm:block" size={17} /></Link>;
}

function WorkflowComposer({ onClose }: { onClose: () => void }) {
  const mutation = useCreateWorkflow();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [trigger, setTrigger] = useState('');
  const [steps, setSteps] = useState('Review the trigger\nPrepare a result\nPause for human approval');
  const submit = () => {
    if (!name.trim() || !trigger.trim()) return;
    mutation.mutate({ data: { name: name.trim(), trigger: trigger.trim(), status: 'Draft', steps: steps.split('\n').map((step) => step.trim()).filter(Boolean) } }, {
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: getListWorkflowsQueryKey() });
        onClose();
      },
    });
  };
  return <Modal title="Create workflow" onClose={onClose}><div className="space-y-4">
    <label className="field-label">Workflow name<input value={name} onChange={(event) => setName(event.target.value)} className="field-input" placeholder="e.g. New lead review" /></label>
    <label className="field-label">Trigger description<input value={trigger} onChange={(event) => setTrigger(event.target.value)} className="field-input" placeholder="e.g. When a new lead is added" /></label>
    <label className="field-label">Steps, one per line<textarea value={steps} onChange={(event) => setSteps(event.target.value)} className="field-input min-h-28 resize-y" /></label>
    <p className="text-xs leading-5 text-slate-500">New workflows start as drafts. “Run test” records the configured path; external actions are not connected.</p>
    {mutation.isError && <p role="alert" className="text-sm text-rose-700">{formatError(mutation.error)}</p>}
    <div className="flex justify-end gap-2"><button onClick={onClose} className="secondary-button">Cancel</button><button onClick={submit} disabled={!name.trim() || !trigger.trim() || mutation.isPending} className="primary-button disabled:opacity-50">{mutation.isPending ? <LoaderCircle className="animate-spin" size={15} /> : <Plus size={15} />}Create draft</button></div>
  </div></Modal>;
}

function WorkflowEditor({ workflow, onClose }: { workflow: Workflow; onClose: () => void }) {
  const mutation = useUpdateWorkflow();
  const queryClient = useQueryClient();
  const [name, setName] = useState(workflow.name);
  const [trigger, setTrigger] = useState(workflow.trigger);
  const [status, setStatus] = useState<Workflow['status']>(workflow.status);
  const [steps, setSteps] = useState(workflow.steps.join('\n'));
  const submit = () => mutation.mutate({
    id: workflow.id,
    data: { name: name.trim(), trigger: trigger.trim(), status, steps: steps.split('\n').map((step) => step.trim()).filter(Boolean) },
  }, { onSuccess: async () => {
    await queryClient.invalidateQueries({ queryKey: getListWorkflowsQueryKey() });
    onClose();
  } });
  return <Modal title="Configure workflow" onClose={onClose}><div className="space-y-4">
    <label className="field-label">Name<input value={name} onChange={(event) => setName(event.target.value)} className="field-input" /></label>
    <label className="field-label">Trigger<input value={trigger} onChange={(event) => setTrigger(event.target.value)} className="field-input" /></label>
    <label className="field-label">Status<select value={status} onChange={(event) => setStatus(event.target.value as Workflow['status'])} className="field-input"><option>Active</option><option>Draft</option><option>Paused</option></select></label>
    <label className="field-label">Steps, one per line<textarea value={steps} onChange={(event) => setSteps(event.target.value)} className="field-input min-h-28 resize-y" /></label>
    {mutation.isError && <p role="alert" className="text-sm text-rose-700">{formatError(mutation.error)}</p>}
    <div className="flex justify-end gap-2"><button onClick={onClose} className="secondary-button">Cancel</button><button onClick={submit} disabled={!name.trim() || !trigger.trim() || mutation.isPending} className="primary-button disabled:opacity-50">{mutation.isPending ? <LoaderCircle className="animate-spin" size={15} /> : <Check size={15} />}Save workflow</button></div>
  </div></Modal>;
}

function WorkflowDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data } = useListWorkflows();
  const runWorkflow = useRunWorkflow();
  const queryClient = useQueryClient();
  const workflow = (data || []).find((item) => item.id === id) || (data || [])[0];
  const [lastRun, setLastRun] = useState<string | null>(null);
  const [configuring, setConfiguring] = useState(false);
  if (!workflow) return <EmptyState icon={Zap} title="Workflow not found" detail="This workflow is no longer available." />;
  const run = () => runWorkflow.mutate({ id: workflow.id }, { onSuccess: async (execution) => {
    setLastRun(`${execution.status} · ${execution.duration}`);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: getListWorkflowsQueryKey() }),
      queryClient.invalidateQueries({ queryKey: getListActivityQueryKey() }),
      queryClient.invalidateQueries({ queryKey: getGetDashboardQueryKey() }),
    ]);
  } });
  return <div className="animate-page-in">
    <Link href="/workflows" data-testid="link-back-workflows" className="mb-6 inline-flex items-center gap-2 text-xs font-semibold text-slate-500 hover:text-teal-700">← All workflows</Link>
    <div className="grid gap-5 xl:grid-cols-[1fr_0.66fr]">
      <section className="panel">
        <div className="border-b border-slate-100 p-6 md:p-8"><div className="flex items-start justify-between gap-4"><div className="flex gap-4"><span className="mt-1 size-3 rounded-full" style={{ background: workflow.color }} /><div><p className="eyebrow">Workflow inspection</p><h1 className="mt-2 font-display text-3xl font-semibold tracking-[-0.05em] text-slate-950">{workflow.name}</h1><p className="mt-2 text-sm text-slate-500">Triggered when {workflow.trigger.toLowerCase()}</p></div></div><StatusPill status={workflow.status} /></div>
          <div className="mt-7 flex flex-wrap gap-2"><button data-testid="button-run-workflow" onClick={run} disabled={runWorkflow.isPending || workflow.status === 'Paused'} className="primary-button disabled:opacity-50">{runWorkflow.isPending ? <LoaderCircle size={15} className="animate-spin" /> : <Play size={15} />}Run test</button><button data-testid="button-workflow-settings" onClick={() => setConfiguring(true)} className="secondary-button"><Settings2 size={15} />Configure</button></div>
          <p className="mt-3 text-xs text-slate-500">Tests record a run of the configured steps. External services are not connected.</p>
          {lastRun && <div className="mt-4 rounded-lg bg-teal-50 px-3 py-2 text-xs font-medium text-teal-800">Latest test: {lastRun}</div>}
          {runWorkflow.isError && <p role="alert" className="mt-3 text-xs text-rose-600">{formatError(runWorkflow.error)}</p>}
        </div>
        <div className="p-6 md:p-8"><p className="eyebrow">Configured steps</p><div className="mt-5 space-y-0">{workflow.steps.map((step, index) => <div key={`${index}-${step}`} className="relative flex gap-4 pb-6 last:pb-0"><div className="relative z-10 flex size-7 shrink-0 items-center justify-center rounded-full border border-teal-200 bg-teal-50 font-mono text-xs font-semibold text-teal-700">{index + 1}</div>{index < workflow.steps.length - 1 && <span className="absolute left-[13px] top-7 h-[calc(100%-10px)] w-px bg-teal-100" />}<div><p className="text-sm font-semibold text-slate-800">{step}</p><p className="mt-1 text-xs text-slate-500">Recorded in the workflow test history.</p></div></div>)}</div></div>
      </section>
      <aside className="space-y-5"><div className="panel p-6"><p className="eyebrow">Performance</p><div className="mt-5 grid grid-cols-2 gap-4"><div><p className="text-xs text-slate-500">Total runs</p><p className="mt-1 font-display text-2xl font-semibold text-slate-900">{workflow.runs.toLocaleString()}</p></div><div><p className="text-xs text-slate-500">Success rate</p><p className="mt-1 font-display text-2xl font-semibold text-teal-700">{workflow.success}</p></div></div><div className="mt-6 flex items-center justify-between border-t border-slate-100 pt-4 text-xs text-slate-500"><span>Last run</span><span className="font-medium text-slate-800">{workflow.lastRun}</span></div></div><div className="rounded-xl border border-amber-200 bg-amber-50 p-6"><div className="flex items-center gap-2 text-amber-800"><ShieldCheck size={17} /><p className="text-sm font-semibold">Safety boundary</p></div><p className="mt-3 text-xs leading-5 text-amber-900/75">A workflow test records configured steps only. No external message is sent, and approval decisions stay in the workspace.</p></div></aside>
    </div>
    {configuring && <WorkflowEditor workflow={workflow} onClose={() => setConfiguring(false)} />}
  </div>;
}

function ProjectsPage() {
  const { data, isLoading, isError, error, refetch } = useListProjects();
  const analyzeProject = useAnalyzeProject();
  const queryClient = useQueryClient();
  const projects = data || [];
  const [selected, setSelected] = useState<Project | null>(null);
  const runAnalysis = () => {
    if (!selected) return;
    analyzeProject.mutate({ id: selected.id }, { onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getListActivityQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getGetDashboardQueryKey() }),
      ]);
    } });
  };
  return <div className="animate-page-in">
    <PageHeading eyebrow="Work orchestration" title="Projects" detail="See where work is moving, where your AI teammates are helping, and where a person may need to unblock the path."><button data-testid="button-analyze-projects" onClick={() => setSelected(projects[0] || null)} disabled={!projects.length} className="primary-button disabled:opacity-50"><Sparkles size={15} />Analyze a project</button></PageHeading>
    {isLoading ? <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{[1, 2, 3].map((item) => <Skeleton key={item} className="h-56" />)}</div> : isError ? <ErrorState message={formatError(error)} retry={() => refetch()} /> : !projects.length ? <EmptyState icon={FolderKanban} title="No projects in view" detail="Projects connected to your workspace will show up here." /> : <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{projects.map((project) => <button data-testid={`card-project-${project.id}`} key={project.id} onClick={() => { setSelected(project); analyzeProject.reset(); }} className="panel text-left transition hover:-translate-y-0.5 hover:border-teal-300 hover:shadow-md"><div className="flex items-start justify-between p-5"><div className="flex gap-3"><span className="flex size-10 items-center justify-center rounded-lg font-mono text-[10px] font-semibold text-white" style={{ background: project.color }}>{project.code}</span><div><h2 className="font-display font-semibold text-slate-900">{project.name}</h2><p className="mt-1 text-xs text-slate-500">{project.tasks} tasks · {project.owner}</p></div></div><MoreHorizontal size={17} className="text-slate-400" /></div><div className="border-t border-slate-100 px-5 py-4"><div className="flex items-center justify-between text-xs"><span className="text-slate-500">Progress</span><span className="font-mono font-medium text-slate-800">{project.progress}%</span></div><div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full" style={{ width: `${project.progress}%`, background: project.color }} /></div><div className="mt-4 flex items-center justify-between"><StatusPill status={project.health} /><span className="text-[11px] text-slate-400">Due {project.due}</span></div></div></button>)}</div>}
    {selected && <Modal title={`Project analysis · ${selected.name}`} onClose={() => setSelected(null)}><div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm leading-6 text-slate-700"><p><strong>Status:</strong> {selected.health} · {selected.progress}% complete</p><p><strong>Tasks:</strong> {selected.tasks} · <strong>Due:</strong> {selected.due}</p></div><div className="mt-4 flex justify-end"><button onClick={runAnalysis} disabled={analyzeProject.isPending} className="primary-button disabled:opacity-50">{analyzeProject.isPending ? <LoaderCircle size={15} className="animate-spin" /> : <Sparkles size={15} />}Analyze with Gemini</button></div>{analyzeProject.isError && <p role="alert" className="mt-3 text-sm text-rose-700">{formatError(analyzeProject.error)}</p>}{analyzeProject.data?.answer && <div className="mt-4 whitespace-pre-wrap rounded-lg border border-teal-200 bg-teal-50/70 p-4 text-sm leading-6 text-slate-700">{analyzeProject.data.answer}</div>}<div className="mt-5 flex justify-end"><button data-testid="button-close-analysis" onClick={() => setSelected(null)} className="secondary-button">Close</button></div></Modal>}
  </div>;
}

function DocumentsPage() {
  const { data, isLoading, isError, error, refetch } = useListDocuments();
  const createDocument = useCreateDocument();
  const deleteDocument = useDeleteDocument();
  const queryClient = useQueryClient();
  const [uploading, setUploading] = useState(false);
  const [uploaded, setUploaded] = useState('');
  const [uploadError, setUploadError] = useState('');
  const documents = data || [];
  const upload = async (file?: File) => {
    if (!file) return;
    setUploadError('');
    setUploaded('');
    const ext = file.name.split('.').pop()?.toLowerCase();
    const mimeByExtension: Record<string, string> = { pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', markdown: 'text/markdown', csv: 'text/csv', json: 'application/json', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
    const supportedMimeTypes = Object.values(mimeByExtension);
    const contentType = supportedMimeTypes.includes(file.type) ? file.type : mimeByExtension[ext || ''];
    if (file.size > 25 * 1024 * 1024) {
      setUploadError('Choose a document smaller than 25 MB.');
      return;
    }
    if (!contentType || !Object.values(mimeByExtension).includes(contentType)) {
      setUploadError('Choose a PDF, DOCX, TXT, Markdown, CSV, or JSON file.');
      return;
    }
    setUploading(true);
    try {
      const request = await fetch('/api/storage/uploads/request-url', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: file.name, size: file.size, contentType }),
      });
      if (!request.ok) {
        const detail = await request.json().catch(() => ({})) as { error?: string };
        throw new Error(detail.error || `Could not prepare upload (${request.status}).`);
      }
      const prepared = await request.json() as { uploadURL: string; objectPath: string };
      const put = await fetch(prepared.uploadURL, { method: 'PUT', headers: { 'Content-Type': contentType }, body: file });
      if (!put.ok) throw new Error(`Object storage rejected the upload (${put.status}).`);
      await createDocument.mutateAsync({ data: { name: file.name, size: file.size, contentType, objectPath: prepared.objectPath } });
      setUploaded(file.name);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getListDocumentsQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getListActivityQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getGetDashboardQueryKey() }),
      ]);
    } catch (uploadFailure) {
      setUploadError(formatError(uploadFailure));
    } finally {
      setUploading(false);
    }
  };
  const remove = (id: string, name: string) => {
    if (!window.confirm(`Delete ${name} from this workspace?`)) return;
    deleteDocument.mutate({ id }, {
      onSuccess: async () => Promise.all([
        queryClient.invalidateQueries({ queryKey: getListDocumentsQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getListActivityQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getGetDashboardQueryKey() }),
      ]),
    });
  };
  const uploadControl = (testId: string) => <label data-testid={testId} className={cn('primary-button cursor-pointer', uploading && 'pointer-events-none opacity-60')}><Upload size={15} />{uploading ? 'Uploading…' : 'Upload document'}<input type="file" accept=".pdf,.docx,.txt,.md,.markdown,.csv,.json" disabled={uploading} className="hidden" onChange={(event) => { void upload(event.target.files?.[0]); event.currentTarget.value = ''; }} /></label>;
  return <div className="animate-page-in">
    <PageHeading eyebrow="Knowledge base" title="Documents" detail="Private files are stored securely, text is extracted for agent context, and each document can be downloaded or removed.">{uploadControl('button-upload-document')}</PageHeading>
    {uploaded && <div role="status" className="mb-4 rounded-lg border border-teal-200 bg-teal-50 px-4 py-3 text-xs text-teal-800"><strong>Processed:</strong> {uploaded}</div>}
    {uploadError && <div role="alert" className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{uploadError}</div>}
    {deleteDocument.isError && <div role="alert" className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{formatError(deleteDocument.error)}</div>}
    {isLoading ? (
      <div className="space-y-3">{[1, 2, 3].map((item) => <Skeleton key={item} className="h-20" />)}</div>
    ) : isError ? (
      <ErrorState message={formatError(error)} retry={() => refetch()} />
    ) : !documents.length ? (
      <EmptyState icon={FileText} title="Your knowledge base is quiet" detail="Upload a source document to give your AI teammates reliable context." action={uploadControl('button-upload-document-empty')} />
    ) : (
      <section className="panel overflow-hidden">
        <div className="hidden grid-cols-[1.6fr_0.5fr_0.6fr_0.65fr_0.7fr] gap-4 border-b border-slate-100 bg-slate-50/70 px-5 py-3 text-[10px] font-semibold uppercase tracking-wider text-slate-400 md:grid">
          <span>Name</span><span>Size</span><span>Added</span><span>Status</span><span className="text-right">Actions</span>
        </div>
        <div className="divide-y divide-slate-100">
          {documents.map((document) => <div data-testid={`document-row-${document.id}`} key={document.id} className="grid gap-2 px-5 py-4 md:grid-cols-[1.6fr_0.5fr_0.6fr_0.65fr_0.7fr] md:items-center md:gap-4">
            <div className="flex items-center gap-3"><span className="flex size-9 items-center justify-center rounded-lg" style={{ color: document.color, background: `${document.color}20` }}><FileText size={17} /></span><div><p className="text-sm font-semibold text-slate-800">{document.name}</p><p className="mt-0.5 text-[11px] text-slate-400">{document.type}</p></div></div>
            <span className="pl-12 text-xs text-slate-500 md:pl-0">{document.size}</span>
            <span className="pl-12 text-xs text-slate-500 md:pl-0">{document.date}</span>
            <span className="pl-12 md:pl-0"><StatusPill status={document.status} /></span>
            <div className="flex gap-2 pl-12 md:justify-end md:pl-0">
              {document.objectPath && <a data-testid={`button-document-download-${document.id}`} className="secondary-button px-2 py-1 text-xs" href={`/api/storage/objects/${document.objectPath.slice('/objects/'.length)}`} target="_blank" rel="noreferrer"><FileDown size={13} />Download</a>}
              <button data-testid={`button-document-delete-${document.id}`} onClick={() => remove(document.id, document.name)} disabled={deleteDocument.isPending} aria-label={`Delete ${document.name}`} className="rounded p-2 text-slate-400 hover:bg-rose-50 hover:text-rose-700"><Trash2 size={15} /></button>
            </div>
          </div>)}
        </div>
      </section>
    )}
  </div>;
}

function AnalyticsPage() {
  const { data: workflows } = useListWorkflows();
  const { data: agents } = useListAgents();
  const savedWorkflows = workflows || [];
  const savedAgents = agents || [];
  const workflowRuns = savedWorkflows.reduce((sum, item) => sum + item.runs, 0);
  const agentRuns = savedAgents.reduce((sum, item) => sum + item.runs, 0);
  const totalRuns = workflowRuns + agentRuns;
  const maxRuns = Math.max(1, ...savedWorkflows.map((item) => item.runs));
  const exportCsv = () => {
    const rows = [
      ['kind', 'name', 'status', 'runs', 'trigger_or_type'],
      ...savedAgents.map((agent) => ['agent', agent.name, agent.status, String(agent.runs), agent.type]),
      ...savedWorkflows.map((workflow) => ['workflow', workflow.name, workflow.status, String(workflow.runs), workflow.trigger]),
    ];
    const csv = rows.map((row) => row.map((value) => `"${value.replaceAll('"', '""')}"`).join(',')).join('\r\n');
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    link.download = 'flowmind-analytics.csv';
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  };
  return <div className="animate-page-in"><PageHeading eyebrow="Signal & performance" title="Analytics" detail="A live summary of persisted agent and workflow counters in this workspace. Export the underlying records as CSV."><button data-testid="button-export-analytics" onClick={exportCsv} className="secondary-button"><FileDown size={15} />Export CSV</button></PageHeading>
    <div className="grid gap-4 md:grid-cols-3"><div className="metric-card"><span className="text-xs text-slate-500">Recorded runs</span><p data-testid="analytics-executions" className="mt-3 font-display text-3xl font-semibold text-slate-950">{totalRuns.toLocaleString()}</p><span className="mt-2 inline-flex text-xs text-slate-500">{workflowRuns.toLocaleString()} workflow · {agentRuns.toLocaleString()} agent</span></div><div className="metric-card"><span className="text-xs text-slate-500">Active AI agents</span><p className="mt-3 font-display text-3xl font-semibold text-slate-950">{savedAgents.filter((agent) => agent.status === 'Active').length}</p><span className="mt-2 inline-flex text-xs text-slate-500">of {savedAgents.length} configured</span></div><div className="metric-card"><span className="text-xs text-slate-500">Active workflows</span><p className="mt-3 font-display text-3xl font-semibold text-slate-950">{savedWorkflows.filter((workflow) => workflow.status === 'Active').length}</p><span className="mt-2 inline-flex text-xs text-slate-500">of {savedWorkflows.length} configured</span></div></div>
    <div className="mt-5 grid gap-5 xl:grid-cols-[1.25fr_0.75fr]"><section className="panel p-6"><div className="flex items-start justify-between"><div><p className="eyebrow">Saved workflow totals</p><h2 className="panel-title mt-1">Runs by workflow</h2></div><span className="font-mono text-[10px] text-slate-400">ALL RECORDED RUNS</span></div><div className="mt-7 space-y-4">{savedWorkflows.map((workflow) => <div key={workflow.id}><div className="mb-1 flex justify-between gap-3 text-xs"><span className="truncate font-medium text-slate-700">{workflow.name}</span><span className="font-mono text-slate-500">{workflow.runs.toLocaleString()}</span></div><div className="h-2 rounded-full bg-slate-100"><div className="h-full rounded-full bg-teal-500" style={{ width: `${Math.max(2, (workflow.runs / maxRuns) * 100)}%` }} /></div></div>)}{!savedWorkflows.length && <EmptyState icon={Zap} title="No workflow data" detail="Run a workflow test to add a saved execution." />}</div></section>
      <section className="panel p-6"><p className="eyebrow">Agent run totals</p><h2 className="panel-title mt-1">Who is carrying the work</h2><div className="mt-6 space-y-5">{savedAgents.slice(0, 6).map((agent) => <div data-testid={`usage-agent-${agent.id}`} key={agent.id}><div className="mb-2 flex items-center justify-between"><div className="flex items-center gap-2"><Avatar initials={agent.initials} color={agent.color} size="sm" /><span className="text-xs font-semibold text-slate-700">{agent.name}</span></div><span className="font-mono text-xs text-slate-500">{agent.runs.toLocaleString()} runs</span></div><div className="h-2 rounded-full bg-slate-100"><div className="h-full rounded-full bg-slate-800" style={{ width: `${Math.max(2, (agent.runs / Math.max(1, ...savedAgents.map((row) => row.runs))) * 100)}%` }} /></div></div>)}{!savedAgents.length && <EmptyState icon={Bot} title="No agent data yet" detail="Agent utilization appears after the first runs." />}</div></section>
    </div>
    <section className="panel mt-5"><div className="panel-header"><div><p className="eyebrow">Workflow status</p><h2 className="panel-title">Configured paths</h2></div></div><div className="divide-y divide-slate-100">{savedWorkflows.map((workflow) => <div key={workflow.id} className="flex flex-wrap items-center gap-4 px-5 py-4"><span className="size-2 rounded-full" style={{ background: workflow.color }} /><span className="min-w-40 flex-1 text-sm font-semibold text-slate-800">{workflow.name}</span><StatusPill status={workflow.status} /><span className="text-xs text-slate-500">{workflow.runs.toLocaleString()} runs</span><span className="w-12 text-right font-mono text-xs text-teal-700">{workflow.success}</span></div>)}</div></section>
  </div>;
}

function ActivityPage() {
  const { data, isLoading, isError, error, refetch } = useListActivity();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('All events');
  const items = useMemo(() => (data || []).filter((event) => { const match = `${event.title} ${event.action} ${event.detail}`.toLowerCase().includes(query.toLowerCase()); return match && (filter === 'All events' || event.status === filter); }), [data, query, filter]);
  return <div className="animate-page-in"><PageHeading eyebrow="System record" title="Activity log" detail="A searchable, chronological record of what ran, what changed, and where a person stepped in." /><div className="mb-5 flex flex-col gap-3 sm:flex-row"><div className="relative flex-1"><Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} /><input data-testid="input-search-activity" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search runs, agents, or details…" className="field-input pl-9" /></div><select data-testid="select-filter-activity" value={filter} onChange={(event) => setFilter(event.target.value)} className="field-input sm:w-40"><option>All events</option>{Array.from(new Set((data || []).map((event) => event.status))).map((status) => <option key={status}>{status}</option>)}</select></div>{isLoading ? <Skeleton className="h-96" /> : isError ? <ErrorState message={formatError(error)} retry={() => refetch()} /> : <section className="panel overflow-hidden"><div className="panel-header"><div><p className="eyebrow">Showing {items.length} events</p><h2 className="panel-title">Recent system activity</h2></div><span className="font-mono text-[10px] text-slate-400">LIVE LOG</span></div><div className="px-5"><ActivityList items={items} /></div></section>}</div>;
}

function SettingsPage() {
  const { data, isLoading, isError, error, refetch } = useGetWorkspaceSettings();
  const update = useUpdateWorkspaceSettings();
  const queryClient = useQueryClient();
  const [saved, setSaved] = useState(false);
  const [form, setForm] = useState({ name: '', timezone: 'Africa/Lagos', pauseBeforeExternalActions: true, showSourceContext: true, dailyDigest: false });
  useEffect(() => {
    if (data) setForm({
      name: data.name, timezone: data.timezone,
      pauseBeforeExternalActions: data.pauseBeforeExternalActions,
      showSourceContext: data.showSourceContext,
      dailyDigest: data.dailyDigest,
    });
  }, [data]);
  const toggles = [
    { key: 'pauseBeforeExternalActions' as const, title: 'Pause before external actions', detail: 'Save a human-review policy for any external integrations connected later.' },
    { key: 'showSourceContext' as const, title: 'Show source context', detail: 'Use extracted text from workspace documents in agent answers.' },
    { key: 'dailyDigest' as const, title: 'Daily digest', detail: 'Save a preference for a compact daily summary of completed work and open decisions.' },
  ];
  const save = () => update.mutate({ data: form }, { onSuccess: async () => {
    setSaved(true);
    window.setTimeout(() => setSaved(false), 2200);
    await queryClient.invalidateQueries({ queryKey: getGetWorkspaceSettingsQueryKey() });
  } });
  if (isLoading) return <div className="max-w-4xl space-y-4"><Skeleton className="h-24" /><Skeleton className="h-72" /></div>;
  if (isError) return <ErrorState message={formatError(error)} retry={() => refetch()} />;
  return <div className="animate-page-in max-w-4xl"><PageHeading eyebrow="Workspace control" title="Settings" detail="Set the persisted defaults that shape how FlowMind works with your team." /><div className="space-y-5">
    <section className="panel"><div className="panel-header"><div><p className="eyebrow">Workspace</p><h2 className="panel-title">Identity & access</h2></div></div><div className="grid gap-4 p-5 md:grid-cols-2"><label className="field-label">Workspace name<input data-testid="input-workspace-name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} className="field-input" /></label><label className="field-label">Timezone<select data-testid="select-workspace-timezone" value={form.timezone} onChange={(event) => setForm({ ...form, timezone: event.target.value })} className="field-input"><option value="Africa/Lagos">Africa/Lagos</option><option value="UTC">UTC</option><option value="America/Los_Angeles">America/Los_Angeles</option><option value="America/New_York">America/New_York</option><option value="Europe/London">Europe/London</option></select></label></div></section>
    <section className="panel"><div className="panel-header"><div><p className="eyebrow">AI defaults</p><h2 className="panel-title">How teammates behave</h2></div><Bot size={18} className="text-teal-600" /></div><div className="divide-y divide-slate-100">{toggles.map((toggle) => <div key={toggle.key} className="flex items-center gap-4 px-5 py-4"><div className="min-w-0 flex-1"><p className="text-sm font-semibold text-slate-800">{toggle.title}</p><p className="mt-1 text-xs leading-5 text-slate-500">{toggle.detail}</p></div><button data-testid={`toggle-${toggle.key}`} aria-pressed={form[toggle.key]} onClick={() => setForm({ ...form, [toggle.key]: !form[toggle.key] })} className={cn('toggle-track', form[toggle.key] && 'toggle-on')}><span /></button></div>)}</div></section>
    {update.isError && <p role="alert" className="text-sm text-rose-700">{formatError(update.error)}</p>}
    <div className="flex items-center justify-end gap-3"><span className={cn('text-xs text-teal-700 transition-opacity', saved ? 'opacity-100' : 'opacity-0')}>Settings saved</span><button data-testid="button-save-settings" onClick={save} disabled={update.isPending || !form.name.trim()} className="primary-button disabled:opacity-50">{update.isPending ? <LoaderCircle className="animate-spin" size={15} /> : <Check size={15} />}Save changes</button></div>
  </div></div>;
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/35 p-4 backdrop-blur-sm"><div className="w-full max-w-lg animate-modal-in rounded-xl border border-slate-200 bg-white p-6 shadow-2xl"><div className="mb-5 flex items-center justify-between"><h2 className="font-display text-lg font-semibold tracking-[-0.03em] text-slate-950">{title}</h2><button data-testid="button-close-modal" onClick={onClose} className="icon-button"><X size={17} /></button></div>{children}</div></div>;
}

function Router() {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}><Shell><Switch><Route path="/" component={DashboardPage} /><Route path="/agents" component={AgentsPage} /><Route path="/agents/:id" component={AgentDetailPage} /><Route path="/workflows" component={WorkflowsPage} /><Route path="/workflows/:id" component={WorkflowDetailPage} /><Route path="/projects" component={ProjectsPage} /><Route path="/documents" component={DocumentsPage} /><Route path="/analytics" component={AnalyticsPage} /><Route path="/activity" component={ActivityPage} /><Route path="/settings" component={SettingsPage} /><Route component={NotFound} /></Switch></Shell></ErrorBoundary>;
}

function AuthGate({ children }: { children: ReactNode }) {
  const { user, isLoading, login } = useAuth();
  if (isLoading) return <div className="flex min-h-screen items-center justify-center bg-slate-50"><LoaderCircle className="animate-spin text-teal-700" size={26} /></div>;
  if (!user) return <main className="flex min-h-screen items-center justify-center bg-[hsl(var(--background))] p-5"><section className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-xl"><span className="brand-mark mx-auto"><span /></span><h1 className="mt-5 font-display text-2xl font-semibold tracking-[-0.04em] text-slate-950">Sign in to FlowMind</h1><p className="mt-2 text-sm leading-6 text-slate-500">Your agents, documents, approvals, and settings are private to your account.</p><button onClick={login} className="primary-button mt-6 w-full justify-center">Sign in</button><p className="mt-4 text-xs text-slate-400">Authentication is handled securely.</p></section></main>;
  return <>{children}</>;
}

function App() {
  return <QueryClientProvider client={queryClient}><AuthGate><TooltipProvider><WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}><Router /></WouterRouter><Toaster /></TooltipProvider></AuthGate></QueryClientProvider>;
}

export default App;