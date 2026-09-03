'use client';

import { cn } from '@repo/ui';
import { Laptop, Lock, ShieldAlert, User } from 'lucide-react';
import { useState } from 'react';
import { useTranslations } from 'use-intl';

import { PageHeader } from '@/components/page-header';

import {
  EmailSection,
  LifecycleSection,
  ProfileSection,
  SecuritySection,
  SessionsSection,
} from './components/user-settings-sections';

type SettingsTab = 'profile' | 'security' | 'sessions' | 'danger';

export function UserSettingsBlock() {
  const t = useTranslations('UserSettings');
  const [activeTab, setActiveTab] = useState<SettingsTab>('profile');

  const tabs: { id: SettingsTab; label: string; Icon: typeof User }[] = [
    { id: 'profile', label: t('tabs.profile'), Icon: User },
    { id: 'security', label: t('tabs.security'), Icon: Lock },
    { id: 'sessions', label: t('tabs.sessions'), Icon: Laptop },
    { id: 'danger', label: t('tabs.danger'), Icon: ShieldAlert },
  ];

  return (
    <div className="space-y-6">
      <PageHeader title={t('title')} description={t('description')} />

      {/* Segmented Tab Control */}
      <nav aria-label={t('tabs.label')} className="overflow-x-auto py-1">
        <div className="inline-flex items-center gap-1 rounded-lg bg-secondary/70 p-1 border border-border/40 shadow-2xs">
          {tabs.map(({ id, label, Icon }) => {
            const isActive = activeTab === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => setActiveTab(id)}
                className={cn(
                  'flex items-center gap-2 rounded-md px-3 py-1.5 text-xs font-semibold whitespace-nowrap transition-all outline-none',
                  'focus-visible:ring-1 focus-visible:ring-ring cursor-pointer',
                  isActive
                    ? 'bg-background text-foreground shadow-2xs border border-border/60'
                    : 'text-muted-foreground hover:text-foreground hover:bg-background/40',
                )}
              >
                <Icon
                  className={cn('size-3.5', isActive ? 'text-primary' : 'text-muted-foreground')}
                  aria-hidden
                />
                {label}
              </button>
            );
          })}
        </div>
      </nav>

      {activeTab === 'profile' && (
        <div className="space-y-6">
          <ProfileSection />
          <EmailSection />
        </div>
      )}
      {activeTab === 'security' && <SecuritySection />}
      {activeTab === 'sessions' && <SessionsSection />}
      {activeTab === 'danger' && <LifecycleSection />}
    </div>
  );
}