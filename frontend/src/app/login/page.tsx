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
  BarChart2
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
    <div className="min-h-screen flex flex-row">
      {/* Left Column: Branding & Features */}
      <div className="w-[420px] hidden lg:flex flex-col justify-between p-12 bg-[#050B1A] shrink-0">
        <div>
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-accent text-white">
              <ShieldCheck size={20} />
            </div>
            <span className="font-semibold text-white text-lg">Minfy AI</span>
          </div>
        </div>
        
        <div className="space-y-8">
          <h2 className="text-white text-2xl font-semibold leading-tight">
            Structured AI evaluation for every hire.
          </h2>
          <div className="space-y-4">
            <div className="flex items-center gap-3 text-sm text-slate-300">
              <CheckCircle2 size={18} className="text-accent" />
              <span>Automated transcript analysis</span>
            </div>
            <div className="flex items-center gap-3 text-sm text-slate-300">
              <BarChart2 size={18} className="text-accent" />
              <span>Dimension-based scoring rubric</span>
            </div>
            <div className="flex items-center gap-3 text-sm text-slate-300">
              <ShieldCheck size={18} className="text-accent" />
              <span>AWS-grade security & compliance</span>
            </div>
          </div>
        </div>

        <div className="text-xs text-slate-500 font-medium">
          Secured by AWS Cognito
        </div>
      </div>

      {/* Right Column: Auth Forms */}
      <div className="flex-1 flex items-center justify-center bg-background p-4 overflow-y-auto">
        <div className="card p-8 max-w-sm w-full space-y-8 bg-surface-elevated border-border shadow-sm">
          <div className="text-center space-y-2">
            <h1 className="text-2xl font-semibold text-text-primary tracking-tight">
              {mode === 'signin' ? 'Welcome back' : mode === 'signup' ? 'Create account' : 'Verify email'}
            </h1>
            <p className="text-sm text-text-muted">
              {mode === 'signin' ? 'Enter your details to sign in' : mode === 'signup' ? 'Join Minfy AI today' : 'Enter the code sent to your email'}
            </p>
          </div>

          {/* Feedback messages */}
          {error && (
            <div className="flex items-start gap-3 p-3 rounded-lg bg-danger/10 border border-danger/20 text-danger text-xs font-medium">
              <AlertCircle size={14} className="shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}
          {success && (
            <div className="flex items-start gap-3 p-3 rounded-lg bg-success/10 border border-success/20 text-success text-xs font-medium">
              <CheckCircle2 size={14} className="shrink-0 mt-0.5" />
              <span>{success}</span>
            </div>
          )}

          <div className="space-y-6">
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
                <p className="text-center text-xs text-text-muted">
                  Don't have an account?{' '}
                  <button
                    type="button"
                    onClick={() => { setMode('signup'); clearMessages(); }}
                    className="text-accent font-semibold hover:underline"
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
                <p className="text-center text-xs text-text-muted">
                  Already have an account?{' '}
                  <button
                    type="button"
                    onClick={() => { setMode('signin'); clearMessages(); }}
                    className="text-accent font-semibold hover:underline"
                  >
                    Sign in
                  </button>
                </p>
              </form>
            )}

            {mode === 'verify' && (
              <form onSubmit={handleVerify} className="space-y-6">
                <div className="space-y-2">
                  <label htmlFor="verify-code" className="block text-sm font-medium text-text-secondary text-center">
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
                    className="w-full h-14 bg-surface border border-border rounded-xl px-4 text-2xl text-center tracking-[0.5em] font-bold text-text-primary focus:ring-2 focus:ring-accent/20 focus:border-accent focus:outline-none transition-all"
                  />
                </div>
                <SubmitButton loading={loading} label="Verify Account" />
                <div className="flex flex-col gap-3">
                  <button
                    type="button"
                    onClick={handleResend}
                    disabled={loading}
                    className="text-xs text-text-muted hover:text-text-primary font-medium transition-colors flex items-center justify-center gap-2"
                  >
                    <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
                    Resend code
                  </button>
                  <button
                    type="button"
                    onClick={() => { setMode('signin'); clearMessages(); }}
                    className="text-xs text-text-muted hover:text-text-primary transition-colors text-center"
                  >
                    Back to sign in
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
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
      <label htmlFor={id} className="block text-sm font-medium text-text-secondary">
        {label}
      </label>
      <div className="relative">
        <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-text-muted">{icon}</span>
        <input
          id={id}
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoComplete={autoComplete}
          className="w-full h-11 bg-surface border border-border rounded-lg pl-10 pr-4 text-sm text-text-primary placeholder:text-text-muted/50 focus:ring-2 focus:ring-accent/20 focus:border-accent focus:outline-none transition-all"
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
        <label htmlFor={id} className="block text-sm font-medium text-text-secondary">
          {label}
        </label>
        {hint && <span className="text-[10px] text-text-muted">{hint}</span>}
      </div>
      <div className="relative">
        <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-text-muted">
          <Lock size={16} />
        </span>
        <input
          id={id}
          type={show ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          className="w-full h-11 bg-surface border border-border rounded-lg pl-10 pr-10 text-sm text-text-primary placeholder:text-text-muted/50 focus:ring-2 focus:ring-accent/20 focus:border-accent focus:outline-none transition-all"
        />
        <button
          type="button"
          onClick={onToggle}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary transition-colors"
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
      className="w-full h-11 bg-accent text-white font-semibold rounded-lg hover:opacity-90 transition-all disabled:opacity-50 flex items-center justify-center gap-2 shadow-sm active:scale-[0.98]"
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
