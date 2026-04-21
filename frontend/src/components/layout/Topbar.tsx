'use client';

import { Bell, Search, User, Sun, Moon } from 'lucide-react';
import { useState, useEffect } from 'react';

export function Topbar() {
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    // Sync with initial theme if needed
    if (document.documentElement.classList.contains('dark')) {
      setIsDark(true);
    }
  }, []);

  const toggleTheme = () => {
    const root = document.documentElement;
    if (root.classList.contains('dark')) {
      root.classList.remove('dark');
      setIsDark(false);
    } else {
      root.classList.add('dark');
      setIsDark(true);
    }
  };

  return (
    <header className="h-16 border-b border-border bg-surface-elevated flex items-center justify-between px-8 sticky top-0 z-10">
      <div className="flex items-center gap-4 w-1/3">
        <div className="relative w-full max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" size={16} />
          <input 
            type="text" 
            placeholder="Search interviews..." 
            className="w-full h-9 pl-10 pr-4 rounded-md bg-surface border border-border text-sm focus:outline-none focus:ring-2 focus:ring-ring transition-all"
          />
        </div>
      </div>
      
      <div className="flex items-center gap-4">
        <button 
          onClick={toggleTheme}
          className="p-2 rounded-md hover:bg-surface text-text-secondary transition-colors"
          title="Toggle theme"
        >
          {isDark ? <Sun size={20} /> : <Moon size={20} />}
        </button>
        
        <button className="p-2 rounded-md hover:bg-surface text-text-secondary transition-colors">
          <Bell size={20} />
        </button>
        
        <div className="h-8 w-px bg-border mx-2" />
        
        <div className="flex items-center gap-3 pl-2 cursor-pointer hover:opacity-80 transition-opacity">
          <div className="text-right flex flex-col hidden sm:flex">
            <span className="text-sm font-semibold text-text-primary leading-tight">Internal User</span>
            <span className="text-xs text-text-muted">Administrator</span>
          </div>
          <div className="w-9 h-9 rounded-full bg-accent flex items-center justify-center text-accent-foreground">
            <User size={18} />
          </div>
        </div>
      </div>
    </header>
  );
}
