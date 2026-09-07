'use client';

import {
  Alert,
  AlertDescription,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Label,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from '@repo/ui';
import { Archive, CheckCircle2, Save } from 'lucide-react';
import { useId, useState } from 'react';
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
import {
  formValuesFromProfile,
  useOrganizationBusinessProfile,
  type BusinessProfileFormValues,
} from '../hooks/use-organization-business-profile';
import type { OrganizationBusinessProfileData } from '../route-data';
import { useOrganizationContext } from '../organization-context';

const intl = Intl as typeof Intl & {
  supportedValuesOf(key: 'currency' | 'timeZone'): string[];
};
const TIMEZONES = [...new Set(['UTC', ...intl.supportedValuesOf('timeZone')])];
const CURRENCIES = intl.supportedValuesOf('currency');

export function OrganizationSettingsBlock({
  businessProfile = { profile: null, error: null },
}: {
  businessProfile?: OrganizationBusinessProfileData;
}) {
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
        <>
          <ProfileForm
            organizationId={organization.id}
            initialName={organization.name}
            initialSlug={organization.slug}
          />

          {businessProfile.profile ? (
            <BusinessProfileForm
              key={`${organization.id}:${businessProfile.profile.version}`}
              organizationId={organization.id}
              initial={formValuesFromProfile(businessProfile.profile)}
            />
          ) : (
            <Card>
              <CardContent>
                <OrganizationErrorAlert error={businessProfile.error} />
              </CardContent>
            </Card>
          )}
        </>
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

function BusinessProfileForm({
  organizationId,
  initial,
}: {
  organizationId: string;
  initial: BusinessProfileFormValues;
}) {
  const t = useTranslations('Organization');
  const update = useOrganizationBusinessProfile(organizationId);
  const [values, setValues] = useState(initial);

  const set = <Key extends keyof BusinessProfileFormValues>(
    key: Key,
    value: BusinessProfileFormValues[Key],
  ) => {
    setValues((current) => ({ ...current, [key]: value }));
    update.reset();
  };

  return (
    <Card className="border border-border/60 rounded-lg shadow-2xs bg-card">
      <CardHeader className="p-4 pb-2 space-y-1">
        <CardTitle className="text-sm font-semibold tracking-tight text-foreground">
          {t('settings.business.title')}
        </CardTitle>
        <CardDescription className="text-xs text-muted-foreground">
          {t('settings.business.description')}
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4 p-4">
        <OrganizationErrorAlert error={update.error} />

        {update.isSaved ? (
          <Alert aria-live="polite">
            <CheckCircle2 aria-hidden />
            <AlertDescription>{t('settings.business.saved')}</AlertDescription>
          </Alert>
        ) : null}

        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void update.submit(values);
          }}
        >
          <div className="grid gap-4 sm:grid-cols-3">
            <SelectField
              label={t('settings.business.locale')}
              value={values.locale}
              options={[
                { value: 'ar', label: t('settings.business.locales.ar') },
                { value: 'en', label: t('settings.business.locales.en') },
              ]}
              issue={update.issues.locale}
              onValueChange={(value) => set('locale', value as 'ar' | 'en')}
            />
            <SelectField
              label={t('settings.business.timezone')}
              value={values.timezone}
              options={TIMEZONES.map((value) => ({ value, label: value }))}
              issue={update.issues.timezone}
              onValueChange={(value) => set('timezone', value)}
            />
            <SelectField
              label={t('settings.business.currency')}
              value={values.currency}
              options={CURRENCIES.map((value) => ({ value, label: value }))}
              issue={update.issues.currency}
              onValueChange={(value) => set('currency', value)}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              type="text"
              autoComplete="organization"
              label={t('settings.business.legalName')}
              value={values.legalName}
              issue={update.issues.legalName}
              onChange={(event) => set('legalName', event.target.value)}
            />
            <FormField
              type="text"
              autoComplete="organization-title"
              label={t('settings.business.industry')}
              value={values.industry}
              issue={update.issues.industry}
              onChange={(event) => set('industry', event.target.value)}
            />
          </div>

          <FormField
            type="url"
            inputMode="url"
            autoComplete="url"
            label={t('settings.business.website')}
            hint={t('settings.business.websiteHint')}
            value={values.websiteUrl}
            issue={update.issues.websiteUrl}
            onChange={(event) => set('websiteUrl', event.target.value)}
          />

          <TextareaField
            label={t('settings.business.businessDescription')}
            hint={t('settings.business.businessDescriptionHint')}
            value={values.businessDescription}
            issue={update.issues.businessDescription}
            onChange={(value) => set('businessDescription', value)}
          />

          <SubmitButton
            isPending={update.isPending}
            icon={<Save className="size-3.5" />}
            className="w-full sm:w-auto h-8 text-xs font-semibold"
          >
            {t('settings.business.save')}
          </SubmitButton>
        </form>
      </CardContent>
    </Card>
  );
}

function SelectField({
  label,
  value,
  options,
  issue,
  onValueChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  issue?: string;
  onValueChange: (value: string) => void;
}) {
  const auth = useTranslations('Auth');
  const id = useId();
  const issueId = `${id}-issue`;

  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger
          id={id}
          className="w-full"
          aria-invalid={issue ? true : undefined}
          aria-describedby={issue ? issueId : undefined}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper">
          <SelectGroup>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      {issue ? (
        <p id={issueId} className="text-sm text-destructive">
          {auth(`validation.${issue}`)}
        </p>
      ) : null}
    </div>
  );
}

function TextareaField({
  label,
  hint,
  value,
  issue,
  onChange,
}: {
  label: string;
  hint: string;
  value: string;
  issue?: string;
  onChange: (value: string) => void;
}) {
  const auth = useTranslations('Auth');
  const id = useId();
  const messageId = `${id}-message`;

  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Textarea
        id={id}
        value={value}
        aria-invalid={issue ? true : undefined}
        aria-describedby={messageId}
        onChange={(event) => onChange(event.target.value)}
      />
      <p
        id={messageId}
        className={
          issue ? 'text-sm text-destructive' : 'text-xs text-muted-foreground'
        }
      >
        {issue ? auth(`validation.${issue}`) : hint}
      </p>
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
        <CardTitle className="text-sm font-semibold tracking-tight text-foreground">
          {t('settings.profileTitle')}
        </CardTitle>
        <CardDescription className="text-xs text-muted-foreground">
          {t('settings.profileDescription')}
        </CardDescription>
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
        <CardDescription className="text-xs text-muted-foreground">
          {t('settings.dangerDescription')}
        </CardDescription>
      </CardHeader>

      <CardContent className="p-4 space-y-4">
        <OrganizationErrorAlert error={archive.error} />

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border/40 bg-muted/30 p-3">
          <div className="min-w-0 space-y-0.5">
            <p className="text-xs font-semibold text-foreground">
              {t('settings.archiveTitle')}
            </p>
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
