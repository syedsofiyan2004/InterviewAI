'use client';

import { useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ShieldCheck, Mail, Lock, Eye, EyeOff, ArrowRight, Loader2, CheckCircle2, AlertCircle, RefreshCw } from 'lucide-react';
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

  const clearMessages = () => {
    setError(null);
    setSuccess(null);
  };

  // ── Sign In ───────────────────────────────────────────────────────────────
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

  // ── Sign Up ───────────────────────────────────────────────────────────────
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

  // ── Verify ────────────────────────────────────────────────────────────────
  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    clearMessages();
    if (!verifyCode || verifyCode.length !== 6) return setError('Please enter the 6-digit code from your email.');
    setLoading(true);
    try {
      await confirmSignUp(email, verifyCode);
      // Auto sign-in after verification
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

  // ── Resend Code ───────────────────────────────────────────────────────────
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
    <div className="w-full max-w-md">
      {/* Logo mark */}
      <div className="flex flex-col items-center mb-8">
        <div className="flex items-center justify-center w-12 h-12 rounded-xl bg-accent text-accent-foreground mb-4 shadow-lg shadow-accent/30">
          <ShieldCheck size={26} />
        </div>
        <h1 className="text-2xl font-bold text-text-primary tracking-tight">InterviewAI</h1>
        <p className="text-sm text-text-secondary mt-1">AI-Powered Interview Evaluation Platform</p>
      </div>

      {/* Card */}
      <div className="card p-8 space-y-6 shadow-xl">

        {/* Mode tabs (only signin / signup) */}
        {mode !== 'verify' && (
          <div className="flex bg-surface rounded-lg p-1 gap-1">
            <button
              type="button"
              onClick={() => { setMode('signin'); clearMessages(); }}
              className={`flex-1 py-2 text-sm font-semibold rounded-md transition-all ${
                mode === 'signin'
                  ? 'bg-surface-elevated text-text-primary shadow-sm'
                  : 'text-text-muted hover:text-text-secondary'
              }`}
            >
              Sign In
            </button>
            <button
              type="button"
              onClick={() => { setMode('signup'); clearMessages(); }}
              className={`flex-1 py-2 text-sm font-semibold rounded-md transition-all ${
                mode === 'signup'
                  ? 'bg-surface-elevated text-text-primary shadow-sm'
                  : 'text-text-muted hover:text-text-secondary'
              }`}
            >
              Create Account
            </button>
          </div>
        )}

        {/* Verify heading */}
        {mode === 'verify' && (
          <div className="text-center space-y-1">
            <h2 className="text-lg font-bold text-text-primary">Check your email</h2>
            <p className="text-sm text-text-secondary">
              We sent a 6-digit code to <span className="font-semibold text-text-primary">{email}</span>
            </p>
          </div>
        )}

        {/* Feedback messages */}
        {error && (
          <div className="flex items-start gap-3 p-3 rounded-lg bg-danger/5 border border-danger/20 text-danger text-sm">
            <AlertCircle size={16} className="shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}
        {success && (
          <div className="flex items-start gap-3 p-3 rounded-lg bg-success/5 border border-success/20 text-success text-sm">
            <CheckCircle2 size={16} className="shrink-0 mt-0.5" />
            <span>{success}</span>
          </div>
        )}

        {/* ── Sign In Form ── */}
        {mode === 'signin' && (
          <form onSubmit={handleSignIn} className="space-y-4">
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
          </form>
        )}

        {/* ── Sign Up Form ── */}
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
              hint="Min 8 chars, 1 uppercase, 1 number"
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
          </form>
        )}

        {/* ── Verify Form ── */}
        {mode === 'verify' && (
          <form onSubmit={handleVerify} className="space-y-4">
            <div>
              <label
                htmlFor="verify-code"
                className="block text-xs font-bold text-text-muted uppercase tracking-wider mb-2"
              >
                Verification Code
              </label>
              <input
                id="verify-code"
                type="text"
                inputMode="numeric"
                maxLength={6}
                value={verifyCode}
                onChange={(e) => setVerifyCode(e.target.value.replace(/\D/g, ''))}
                placeholder="123456"
                className="w-full h-11 bg-surface border border-border rounded-md px-4 text-sm text-center tracking-[0.5em] font-bold focus:ring-2 focus:ring-ring focus:outline-none transition-all"
              />
            </div>
            <SubmitButton loading={loading} label="Verify & Sign In" />
            <button
              type="button"
              onClick={handleResend}
              disabled={loading}
              className="w-full flex items-center justify-center gap-2 py-2 text-xs text-text-muted hover:text-text-primary font-semibold transition-colors"
            >
              <RefreshCw size={14} />
              Resend code
            </button>
            <button
              type="button"
              onClick={() => { setMode('signin'); clearMessages(); }}
              className="w-full text-center text-xs text-text-muted hover:text-text-primary transition-colors"
            >
              ← Back to sign in
            </button>
          </form>
        )}
      </div>

      <p className="text-center text-xs text-text-muted mt-6">
        Secured by AWS Cognito · All data encrypted at rest
      </p>
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────────────────

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
    <div>
      <label htmlFor={id} className="block text-xs font-bold text-text-muted uppercase tracking-wider mb-2">
        {label}
      </label>
      <div className="relative">
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted">{icon}</span>
        <input
          id={id}
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoComplete={autoComplete}
          className="w-full h-11 bg-surface border border-border rounded-md pl-10 pr-4 text-sm focus:ring-2 focus:ring-ring focus:outline-none transition-all"
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
    <div>
      <div className="flex items-center justify-between mb-2">
        <label htmlFor={id} className="block text-xs font-bold text-text-muted uppercase tracking-wider">
          {label}
        </label>
        {hint && <span className="text-[10px] text-text-muted">{hint}</span>}
      </div>
      <div className="relative">
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted">
          <Lock size={16} />
        </span>
        <input
          id={id}
          type={show ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          className="w-full h-11 bg-surface border border-border rounded-md pl-10 pr-10 text-sm focus:ring-2 focus:ring-ring focus:outline-none transition-all"
        />
        <button
          type="button"
          onClick={onToggle}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-secondary transition-colors"
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
      className="w-full h-11 bg-accent text-accent-foreground font-semibold rounded-md hover:opacity-90 transition-all disabled:opacity-50 flex items-center justify-center gap-2 shadow-lg shadow-accent/20"
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
