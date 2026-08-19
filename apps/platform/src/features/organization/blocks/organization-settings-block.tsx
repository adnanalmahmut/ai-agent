import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@repo/ui';
import { Archive, CheckCircle2, Save } from 'lucide-react';
import { useState } from 'react';
import { useTranslations } from 'use-intl';

import { ConfirmDialog } from '@/components/confirm-dialog';
import { PageHeader } from '@/components/page-header';
import { FormField } from '@/features/auth/components/form-field';
import { SubmitButton } from '@/features/auth/components/submit-button';
import { useOrganizationRolePermission } from '@/features/authorization/use-permissions';

import { EmptyState } from '@/components/empty-state';
import { OrganizationErrorAlert } from '../components/organization-error-alert';
import {
  useArchiveOrganization,
  useUpdateOrganization,
} from '../hooks/use-organization-settings';
import { useOrganizationContext } from '../organization-context';

/**
 * Organization settings, and the one irreversible-looking action this product
 * has.
 *
 * The two halves are gated by two different permissions on purpose. Updating
 * is `organization:update`, which an organization admin holds; archiving is
 * `organization:archive`, which only an owner does — the backend withholds it
 * from admins because taking an organization offline affects every member, and
 * this page mirrors that rather than inventing its own rule.
 *
 * There is no delete. The backend runs with `disableOrganizationDeletion`, no
 * role is granted `organization:delete`, and no function exists here to call
 * one. Offering a button would be offering a 404.
 */
export function OrganizationSettingsBlock() {
  const t = useTranslations('Organization');
  const { organization, viewer } = useOrganizationContext();

  const canUpdate = useOrganizationRolePermission(viewer.member?.role, {
    organization: ['update'],
  });
  const canArchive = useOrganizationRolePermission(viewer.member?.role, {
    organization: ['archive'],
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('settings.title')}
        description={t('settings.description')}
      />

      {canUpdate ? (
        <ProfileForm
          organizationId={organization.id}
          initialName={organization.name}
          initialSlug={organization.slug}
        />
      ) : (
        <Card>
          <CardContent>
            <EmptyState
              title={t('settings.readOnlyTitle')}
              description={t('settings.readOnlyDescription')}
              className="border-0"
            />
          </CardContent>
        </Card>
      )}

      {canArchive ? (
        <DangerZone
          organizationId={organization.id}
          organizationName={organization.name}
        />
      ) : null}
    </div>
  );
}

function ProfileForm({
  organizationId,
  initialName,
  initialSlug,
}: {
  organizationId: string;
  initialName: string;
  initialSlug: string;
}) {
  const t = useTranslations('Organization');
  const update = useUpdateOrganization(organizationId);

  const [name, setName] = useState(initialName);
  const [slug, setSlug] = useState(initialSlug);

  return (
    <Card className="border border-border/60 rounded-lg shadow-2xs bg-card">
      <CardHeader className="p-4 pb-2 space-y-1">
        <CardTitle className="text-sm font-semibold tracking-tight text-foreground">{t('settings.profileTitle')}</CardTitle>
        <CardDescription className="text-xs text-muted-foreground">{t('settings.profileDescription')}</CardDescription>
      </CardHeader>

      <CardContent className="p-4 space-y-4">
        <OrganizationErrorAlert error={update.error} />

        {update.isSaved ? (
          <div
            className="flex items-start gap-2.5 rounded-md bg-muted/60 border border-border/40 p-3 text-xs"
            aria-live="polite"
          >
            <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-primary" />
            <p className="leading-5 text-muted-foreground">
              {t('settings.saved')}
            </p>
          </div>
        ) : null}

        <form
          noValidate
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void update.submit({ name, slug });
          }}
        >
          <FormField
            type="text"
            autoComplete="organization"
            required
            label={t('fields.name')}
            value={name}
            issue={update.issues.name}
            onChange={(event) => {
              setName(event.target.value);
              update.reset();
            }}
          />

          <FormField
            type="text"
            autoComplete="off"
            inputMode="url"
            required
            label={t('fields.slug')}
            hint={t('fields.slugHint')}
            value={slug}
            issue={update.issues.slug}
            onChange={(event) => {
              setSlug(event.target.value);
              update.reset();
            }}
          />

          <SubmitButton
            isPending={update.isPending}
            icon={<Save className="size-3.5" />}
            className="w-full sm:w-auto h-8 text-xs font-semibold"
          >
            {t('settings.save')}
          </SubmitButton>
        </form>
      </CardContent>
    </Card>
  );
}

/**
 * Archiving.
 */
function DangerZone({
  organizationId,
  organizationName,
}: {
  organizationId: string;
  organizationName: string;
}) {
  const t = useTranslations('Organization');
  const archive = useArchiveOrganization(organizationId);
  const [isOpen, setIsOpen] = useState(false);

  return (
    <Card className="border border-destructive/40 rounded-lg shadow-2xs bg-card">
      <CardHeader className="p-4 pb-2 space-y-1">
        <CardTitle className="text-sm font-semibold tracking-tight text-destructive">
          {t('settings.dangerTitle')}
        </CardTitle>
        <CardDescription className="text-xs text-muted-foreground">{t('settings.dangerDescription')}</CardDescription>
      </CardHeader>

      <CardContent className="p-4 space-y-4">
        <OrganizationErrorAlert error={archive.error} />

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border/40 bg-muted/30 p-3">
          <div className="min-w-0 space-y-0.5">
            <p className="text-xs font-semibold text-foreground">{t('settings.archiveTitle')}</p>
            <p className="text-xs text-muted-foreground text-pretty">
              {t('settings.archiveExplanation')}
            </p>
          </div>

          <Button
            variant="destructive"
            size="sm"
            className="shrink-0 gap-1.5 h-8 text-xs font-semibold"
            onClick={() => setIsOpen(true)}
          >
            <Archive className="size-3.5" />
            {t('settings.archiveAction')}
          </Button>
        </div>
      </CardContent>

      <ConfirmDialog
        open={isOpen}
        onOpenChange={setIsOpen}
        isDestructive
        isPending={archive.isPending}
        title={t('settings.archiveConfirmTitle')}
        description={t('settings.archiveConfirmDescription', {
          organization: organizationName,
        })}
        confirmLabel={t('settings.archiveConfirm')}
        cancelLabel={t('settings.cancel')}
        onConfirm={() => void archive.submit()}
      >
        <ul className="space-y-1.5 rounded-md bg-muted/60 p-3 text-xs text-muted-foreground">
          <li>{t('archived.preservedMembers')}</li>
          <li>{t('archived.preservedResources')}</li>
          <li>{t('archived.canceledInvitations')}</li>
          <li>{t('archived.reversible')}</li>
        </ul>
      </ConfirmDialog>
    </Card>
  );
}
