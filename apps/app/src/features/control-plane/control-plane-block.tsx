'use client';

import {
  Card,
  CardContent,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@repo/ui';
import { ShieldAlert } from 'lucide-react';
import { useTranslations } from 'use-intl';

import { PageHeader } from '@/components/page-header';
import { useGlobalPermission } from '@/features/authorization/use-permissions';

import { FeatureFlagsPanel } from './feature-flags-panel';
import { AuditPanel } from './audit-panel';
import { ManagedSecretsPanel } from './managed-secrets-panel';
import { RuntimeSettingsPanel } from './runtime-settings-panel';

export function ControlPlaneBlock() {
  const t = useTranslations('ControlPlane');
  const canRead = useGlobalPermission({ controlPlane: ['read'] });

  if (!canRead) {
    return (
      <div className="space-y-6">
        <PageHeader title={t('title')} description={t('description')} />

        <Card>
          <CardContent className="flex items-center gap-2 py-8 text-sm">
            <ShieldAlert aria-hidden className="size-4 text-destructive" />
            {t('error.forbidden')}
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader title={t('title')} description={t('description')} />

      <Tabs defaultValue="flags">
        <TabsList>
          <TabsTrigger value="flags">{t('flags.tab')}</TabsTrigger>
          <TabsTrigger value="settings">{t('settings.tab')}</TabsTrigger>
          <TabsTrigger value="secrets">{t('secrets.tab')}</TabsTrigger>
          <TabsTrigger value="audit">{t('audit.tab')}</TabsTrigger>
        </TabsList>

        <TabsContent value="flags">
          <FeatureFlagsPanel />
        </TabsContent>

        <TabsContent value="settings">
          <RuntimeSettingsPanel />
        </TabsContent>

        <TabsContent value="secrets">
          <ManagedSecretsPanel />
        </TabsContent>

        <TabsContent value="audit">
          <AuditPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
