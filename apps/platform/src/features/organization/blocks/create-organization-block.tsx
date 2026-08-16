import { Card, CardContent, CardHeader, CardTitle, buttonVariants } from '@repo/ui';
import { Check, Plus, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslations } from 'use-intl';

import { PageHeader } from '@/components/page-header';
import { FormField } from '@/features/auth/components/form-field';
import { SubmitButton } from '@/features/auth/components/submit-button';
import { PLATFORM_ROUTES } from '@/features/auth/routes';
import { Link } from '@/i18n/navigation';

import { OrganizationErrorAlert } from '../components/organization-error-alert';
import {
  useCreateOrganization,
  useSlugAvailability,
} from '../hooks/use-create-organization';
import { suggestSlug } from '../organization-validation';

/**
 * Creating an organization.
 *
 * A page rather than a dialog, and for a reason beyond taste: this is the
 * screen a brand-new user with no organizations is sent to from an empty
 * state, so it has to be linkable, refreshable and reachable with the Back
 * button. A modal over an empty list would be all three of those things badly.
 *
 * The slug is suggested from the name until the reader touches it, then left
 * alone. Continuing to overwrite an edited slug on every keystroke of the name
 * is the classic version of this form that people fight with.
 */
export function CreateOrganizationBlock() {
  const t = useTranslations('Organization');

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [isSlugEdited, setIsSlugEdited] = useState(false);

  const create = useCreateOrganization();
  const availability = useSlugAvailability(slug, !create.issues.slug);

  return (
    <div className="mx-auto w-full max-w-xl space-y-8">
      <PageHeader
        title={t('create.title')}
        description={t('create.description')}
      />

      <Card>
        <CardHeader>
          <CardTitle>{t('create.formTitle')}</CardTitle>
        </CardHeader>

        <CardContent className="space-y-5">
          <OrganizationErrorAlert error={create.error} />

          <form
            noValidate
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void create.submit({ name, slug });
            }}
          >
            <FormField
              type="text"
              autoComplete="organization"
              autoFocus
              required
              label={t('fields.name')}
              placeholder={t('fields.namePlaceholder')}
              value={name}
              issue={create.issues.name}
              onChange={(event) => {
                const next = event.target.value;
                setName(next);
                if (!isSlugEdited) setSlug(suggestSlug(next));
                create.reset();
              }}
            />

            <FormField
              type="text"
              autoComplete="off"
              required
              inputMode="url"
              label={t('fields.slug')}
              placeholder={t('fields.slugPlaceholder')}
              value={slug}
              issue={create.issues.slug}
              hint={<SlugHint availability={availability} />}
              onChange={(event) => {
                setIsSlugEdited(true);
                setSlug(event.target.value);
                create.reset();
              }}
            />

            <div className="flex flex-col gap-2 sm:flex-row-reverse">
              <SubmitButton
                isPending={create.isPending}
                icon={<Plus />}
                className="flex-1"
              >
                {t('create.submit')}
              </SubmitButton>

              <Link
                href={PLATFORM_ROUTES.organizations}
                className={buttonVariants({
                  variant: 'outline',
                  className: 'flex-1',
                })}
              >
                {t('create.cancel')}
              </Link>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * What the slug field says underneath itself.
 *
 * Deliberately advisory. "Available" means the server said so a moment ago,
 * not that the name is reserved — uniqueness is decided on write, and a
 * collision in between is answered with a translated error rather than
 * prevented here.
 */
function SlugHint({
  availability,
}: {
  availability: 'unknown' | 'checking' | 'available' | 'taken';
}) {
  const t = useTranslations('Organization');

  if (availability === 'checking') {
    return <span>{t('fields.slugChecking')}</span>;
  }

  if (availability === 'available') {
    return (
      <span className="inline-flex items-center gap-1.5">
        <Check className="size-3.5" aria-hidden />
        {t('fields.slugAvailable')}
      </span>
    );
  }

  if (availability === 'taken') {
    return (
      <span className="inline-flex items-center gap-1.5 text-destructive">
        <X className="size-3.5" aria-hidden />
        {t('fields.slugTaken')}
      </span>
    );
  }

  return <span>{t('fields.slugHint')}</span>;
}
