'use client';

import { useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  ShieldCheck,
  Mail,
  Lock,
  Eye,
  EyeOff,
  ArrowRight,
  Loader2,
  CheckCircle2,
  AlertCircle,
  RefreshCw,
  ClipboardList,
  FileText,
} from 'lucide-react';
import { signIn, signUp, confirmSignUp, resendCode } from '@/lib/auth';
import { useAuth } from '@/contexts/AuthContext';

type AuthMode = 'signin' | 'signup' | 'verify';

function LoginContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextPath = searchParams.get('next') || '/';
  const { refreshSession } = useAuth();

  const [mode, setMode] = useState<AuthMode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [verifyCode, setVerifyCode] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [activeStory, setActiveStory] = useState(0);
  const [pointer, setPointer] = useState({ x: 50, y: 50 });

  const stories = [
    {
      label: 'Interviews',
      title: 'Evaluate candidates with confidence.',
      body: 'Scores, evidence, and clear recommendations from interview conversations.',
      icon: <ClipboardList size={17} />,
    },
    {
      label: 'Meetings',
      title: 'Understand meetings without replaying them.',
      body: 'Summaries, decisions, risks, next steps, and owner-wise action items.',
      icon: <FileText size={17} />,
    },
  ];

  const clearMessages = () => {
    setError(null);
    setSuccess(null);
  };

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    clearMessages();
    if (!email || !password) return setError('Please enter your email and password.');
    setLoading(true);
    try {
      await signIn(email, password);
      await refreshSession();
      router.push(nextPath);
    } catch (err: any) {
      if (err.code === 'UserNotConfirmedException') {
        setMode('verify');
        setError('Please verify your email before signing in. Enter the code we sent you.');
      } else if (err.code === 'NotAuthorizedException') {
        setError('Incorrect email or password.');
      } else if (err.code === 'UserNotFoundException') {
        setError('No account found with this email. Please sign up.');
      } else {
        setError(err.message || 'Sign in failed. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    clearMessages();
    if (!email || !password || !confirmPassword) return setError('Please fill in all fields.');
    if (password !== confirmPassword) return setError('Passwords do not match.');
    if (password.length < 8) return setError('Password must be at least 8 characters.');
    if (!/[A-Z]/.test(password)) return setError('Password must contain at least one uppercase letter.');
    if (!/[0-9]/.test(password)) return setError('Password must contain at least one number.');
    setLoading(true);
    try {
      await signUp(email, password);
      setMode('verify');
      setSuccess('Account created! Check your email for the verification code.');
    } catch (err: any) {
      if (err.code === 'UsernameExistsException') {
        setError('An account with this email already exists. Please sign in.');
      } else if (err.code === 'InvalidPasswordException') {
        setError(err.message);
      } else {
        setError(err.message || 'Sign up failed. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    clearMessages();
    if (!verifyCode || verifyCode.length !== 6) return setError('Please enter the 6-digit code from your email.');
    setLoading(true);
    try {
      await confirmSignUp(email, verifyCode);
      await signIn(email, password);
      await refreshSession();
      router.push(nextPath);
    } catch (err: any) {
      if (err.code === 'CodeMismatchException') {
        setError('Incorrect verification code. Please try again.');
      } else if (err.code === 'ExpiredCodeException') {
        setError('The code has expired. Please request a new one.');
      } else {
        setError(err.message || 'Verification failed.');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    clearMessages();
    if (!email) return setError('Enter your email address first.');
    setLoading(true);
    try {
      await resendCode(email);
      setSuccess('A new verification code has been sent to your email.');
    } catch (err: any) {
      setError(err.message || 'Failed to resend code.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="login-stage h-screen w-full overflow-hidden"
      onMouseMove={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        setPointer({
          x: ((event.clientX - rect.left) / rect.width) * 100,
          y: ((event.clientY - rect.top) / rect.height) * 100,
        });
      }}
      style={{ '--mx': `${pointer.x}%`, '--my': `${pointer.y}%` } as React.CSSProperties}
    >
      <div className="login-grid" />
      <div className="login-scanline" />
      <div className="login-pointer-field" />
      <div className="login-orbit login-orbit-one" />
      <div className="login-orbit login-orbit-two" />

      <div className="relative z-10 grid h-full grid-cols-1 gap-9 px-[clamp(24px,3.8vw,58px)] py-[clamp(24px,4.5vh,48px)] lg:grid-cols-[minmax(0,1fr)_minmax(430px,540px)]">
        <section className="hidden min-h-0 flex-col justify-between lg:flex">
          <div className="flex items-center justify-between">
            <div className="relative flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-md bg-[#6EE7B7] text-[#071018]">
                <ShieldCheck size={20} />
              </div>
              <span className="text-lg font-semibold tracking-tight text-white">Minfy AI</span>
            </div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#6EE7B7]">
              Interview intelligence / Meeting clarity
            </div>
          </div>

          <div className="grid grid-cols-[minmax(0,1fr)_clamp(76px,10vw,148px)] items-end gap-7">
            <div className="max-w-[720px] space-y-6">
              <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[#93C5FD]">Work clarity suite</p>
              <div>
                <h2 className="text-[clamp(46px,5vw,82px)] font-semibold leading-[0.94] tracking-tight text-white">
                  Conversations,
                  <span className="block text-[#6EE7B7]">understood.</span>
                </h2>
                <div className="mt-5 h-[34px] overflow-hidden text-[28px] font-semibold tracking-tight text-white/80">
                  <div className="login-kinetic-stack">
                    <span>Evaluate candidates</span>
                    <span>Summarize meetings</span>
                    <span>Share reports</span>
                  </div>
                </div>
              </div>
              <p className="max-w-[500px] text-[15px] leading-7 text-slate-300">
                A focused workspace that turns long discussions into useful reports your team can read, trust, and share.
              </p>
            </div>

            <div className="login-index-mark" aria-hidden="true">
              <span>01</span>
              <span>02</span>
              <span>03</span>
            </div>
          </div>

          <div className="space-y-5">
            <div className="grid gap-0 border-y border-white/10">
              {stories.map((story, index) => (
                <button
                  key={story.label}
                  type="button"
                  onMouseEnter={() => setActiveStory(index)}
                  onFocus={() => setActiveStory(index)}
                  className={`login-capability text-left ${activeStory === index ? 'is-active' : ''}`}
                >
                  <div className="flex items-center gap-4">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#6EE7B7]">
                      0{index + 1}
                    </span>
                    <div className="flex h-8 w-8 items-center justify-center rounded-md bg-white/[0.06] text-[#6EE7B7]">
                      {story.icon}
                    </div>
                  </div>
                  <div className="min-w-0">
                    <p className="text-[15px] font-semibold text-white">{story.label}</p>
                    <p className="mt-1 max-w-[620px] text-xs leading-5 text-slate-400">{story.body}</p>
                  </div>
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center justify-between text-xs font-medium text-slate-500">
            <span>{stories[activeStory].title}</span>
            <span>Reports ready to review and download</span>
          </div>
        </section>

        <section className="flex items-center justify-center lg:justify-end">
          <div className="login-auth-card w-full max-w-[520px] space-y-7 p-10">
            <div className="text-center space-y-2.5">
              <h1 className="text-3xl font-semibold text-white tracking-tight">
                {mode === 'signin' ? 'Welcome back' : mode === 'signup' ? 'Create account' : 'Verify email'}
              </h1>
              <p className="text-base text-slate-300">
                {mode === 'signin' ? 'Enter your details to sign in' : mode === 'signup' ? 'Join Minfy AI today' : 'Enter the code sent to your email'}
              </p>
            </div>

            {error && (
              <div className="flex items-start gap-3 rounded-lg border border-red-400/25 bg-red-400/10 p-3 text-xs font-medium text-red-200">
                <AlertCircle size={14} className="shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}
            {success && (
              <div className="flex items-start gap-3 rounded-lg border border-emerald-300/25 bg-emerald-300/10 p-3 text-xs font-medium text-emerald-100">
                <CheckCircle2 size={14} className="shrink-0 mt-0.5" />
                <span>{success}</span>
              </div>
            )}

            <div className="space-y-5">
              {mode === 'signin' && (
                <form onSubmit={handleSignIn} className="space-y-5">
                  <InputField
                    id="email"
                    label="Email Address"
                    type="email"
                    icon={<Mail size={16} />}
                    value={email}
                    onChange={setEmail}
                    placeholder="you@company.com"
                    autoComplete="email"
                  />
                  <PasswordField
                    id="password"
                    label="Password"
                    value={password}
                    onChange={setPassword}
                    show={showPassword}
                    onToggle={() => setShowPassword(!showPassword)}
                    autoComplete="current-password"
                  />
                  <SubmitButton loading={loading} label="Sign In" />
                  <p className="text-center text-xs text-slate-400">
                    Don't have an account?{' '}
                    <button
                      type="button"
                      onClick={() => { setMode('signup'); clearMessages(); }}
                      className="font-semibold text-[#6EE7B7] hover:underline"
                    >
                      Sign up
                    </button>
                  </p>
                </form>
              )}

              {mode === 'signup' && (
                <form onSubmit={handleSignUp} className="space-y-4">
                  <InputField
                    id="email-signup"
                    label="Email Address"
                    type="email"
                    icon={<Mail size={16} />}
                    value={email}
                    onChange={setEmail}
                    placeholder="you@company.com"
                    autoComplete="email"
                  />
                  <PasswordField
                    id="password-signup"
                    label="Password"
                    value={password}
                    onChange={setPassword}
                    show={showPassword}
                    onToggle={() => setShowPassword(!showPassword)}
                    autoComplete="new-password"
                    hint="Min. 8 chars"
                  />
                  <PasswordField
                    id="confirm-password"
                    label="Confirm Password"
                    value={confirmPassword}
                    onChange={setConfirmPassword}
                    show={showPassword}
                    onToggle={() => setShowPassword(!showPassword)}
                    autoComplete="new-password"
                  />
                  <SubmitButton loading={loading} label="Create Account" />
                  <p className="text-center text-xs text-slate-400">
                    Already have an account?{' '}
                    <button
                      type="button"
                      onClick={() => { setMode('signin'); clearMessages(); }}
                      className="font-semibold text-[#6EE7B7] hover:underline"
                    >
                      Sign in
                    </button>
                  </p>
                </form>
              )}

              {mode === 'verify' && (
                <form onSubmit={handleVerify} className="space-y-6">
                  <div className="space-y-2">
                    <label htmlFor="verify-code" className="block text-center text-sm font-medium text-slate-300">
                      Verification Code
                    </label>
                    <input
                      id="verify-code"
                      type="text"
                      inputMode="numeric"
                      maxLength={6}
                      value={verifyCode}
                      onChange={(e) => setVerifyCode(e.target.value.replace(/\D/g, ''))}
                      placeholder="000000"
                      className="w-full h-14 rounded-xl border border-white/10 bg-white/[0.08] px-4 text-center text-2xl font-bold tracking-[0.5em] text-white outline-none transition-all placeholder:text-slate-500 focus:border-[#6EE7B7] focus:ring-2 focus:ring-[#6EE7B7]/20"
                    />
                  </div>
                  <SubmitButton loading={loading} label="Verify Account" />
                  <div className="flex flex-col gap-3">
                    <button
                      type="button"
                      onClick={handleResend}
                      disabled={loading}
                      className="flex items-center justify-center gap-2 text-xs font-medium text-slate-400 transition-colors hover:text-white"
                    >
                      <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
                      Resend code
                    </button>
                    <button
                      type="button"
                      onClick={() => { setMode('signin'); clearMessages(); }}
                      className="text-center text-xs text-slate-400 transition-colors hover:text-white"
                    >
                      Back to sign in
                    </button>
                  </div>
                </form>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function InputField({
  id, label, type, icon, value, onChange, placeholder, autoComplete,
}: {
  id: string;
  label: string;
  type: string;
  icon: React.ReactNode;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoComplete?: string;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-slate-300">
        {label}
      </label>
      <div className="relative">
        <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400">{icon}</span>
        <input
          id={id}
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoComplete={autoComplete}
          className="w-full h-12 rounded-lg border border-white/10 bg-white/[0.08] pl-10 pr-4 text-base text-white outline-none transition-all placeholder:text-slate-500 focus:border-[#6EE7B7] focus:ring-2 focus:ring-[#6EE7B7]/20"
        />
      </div>
    </div>
  );
}

function PasswordField({
  id, label, value, onChange, show, onToggle, autoComplete, hint,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  show: boolean;
  onToggle: () => void;
  autoComplete?: string;
  hint?: string;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <label htmlFor={id} className="block text-sm font-medium text-slate-300">
          {label}
        </label>
        {hint && <span className="text-[10px] text-slate-500">{hint}</span>}
      </div>
      <div className="relative">
        <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400">
          <Lock size={16} />
        </span>
        <input
          id={id}
          type={show ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          className="w-full h-12 rounded-lg border border-white/10 bg-white/[0.08] pl-10 pr-10 text-base text-white outline-none transition-all placeholder:text-slate-500 focus:border-[#6EE7B7] focus:ring-2 focus:ring-[#6EE7B7]/20"
        />
        <button
          type="button"
          onClick={onToggle}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 transition-colors hover:text-white"
          tabIndex={-1}
        >
          {show ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </div>
    </div>
  );
}

function SubmitButton({ loading, label }: { loading: boolean; label: string }) {
  return (
    <button
      type="submit"
      disabled={loading}
      className="w-full h-12 rounded-lg bg-[#6EE7B7] text-base font-semibold text-[#071018] shadow-[0_16px_44px_rgba(110,231,183,0.22)] transition-all hover:bg-[#8CF3CB] disabled:opacity-50 active:scale-[0.98] flex items-center justify-center gap-2"
    >
      {loading ? (
        <Loader2 className="animate-spin" size={18} />
      ) : (
        <>
          {label}
          <ArrowRight size={16} />
        </>
      )}
    </button>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="animate-spin text-accent" size={32} />
      </div>
    }>
      <LoginContent />
    </Suspense>
  );
}
