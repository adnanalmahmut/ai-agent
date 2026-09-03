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

/**
 * The operator's view of the control plane.
 *
 * Four resources on one page because they are one job: an operator turning a
 * feature on usually has to set a limit and store a credential in the same
 * sitting, and splitting them across three routes would make that three
 * navigations. Tabs rather than three stacked tables so each panel loads only
 * when it is looked at — the secrets list in particular is a request an
 * operator reading about flags has no reason to make.
 *
 * The gate here is UX, not security. It hides a page the reader cannot use;
 * the backend re-derives every one of these permissions from the database on
 * the request itself, and a reader who reached this component anyway would see
 * the panels refuse.
 */
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