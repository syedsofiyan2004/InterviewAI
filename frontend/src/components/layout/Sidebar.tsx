'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LayoutDashboard, PlusCircle, ShieldCheck } from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const navItems = [
  { name: 'Dashboard', href: '/', icon: LayoutDashboard },
  { name: 'New Interview', href: '/interviews/new', icon: PlusCircle },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <div className="flex flex-col w-64 h-screen border-r border-border bg-surface text-foreground">
      <div className="flex items-center gap-3 px-6 h-16 border-b border-border">
        <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-accent text-accent-foreground">
          <ShieldCheck size={20} />
        </div>
        <span className="font-semibold text-text-primary tracking-tight">InterviewAI</span>
      </div>
      
      <nav className="flex-1 px-4 py-6 space-y-1">
        {navItems.map((item) => {
          const isActive = pathname === item.href;
          const Icon = item.icon;
          
          return (
            <Link
              key={item.name}
              href={item.href}
              className={cn(
                "flex items-center gap-3 px-3 py-2 rounded-md transition-all duration-200 group text-sm font-medium",
                isActive 
                  ? "bg-accent text-accent-foreground" 
                  : "text-text-secondary hover:bg-surface-elevated hover:text-text-primary"
              )}
            >
              <Icon size={18} className={cn(isActive ? "text-accent-foreground" : "text-text-muted group-hover:text-text-primary")} />
              {item.name}
            </Link>
          );
        })}
      </nav>
      
      <div className="p-4 border-t border-border">
        <div className="p-3 rounded-lg bg-surface-elevated border border-border">
          <p className="text-xs font-semibold text-text-muted uppercase tracking-wider">Plan</p>
          <p className="text-sm font-medium text-text-primary mt-1">Enterprise Internal</p>
        </div>
      </div>
    </div>
  );
}
