'use client';

import { DEFAULT_LOCALE, LOCALE_META, isAppLocale } from '@repo/i18n-core';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Input,
} from '@repo/ui';
import { Globe, Heart, Mail, Settings, Trash2, Zap } from 'lucide-react';
import { useFormatter, useLocale, useTranslations } from 'use-intl';
import type { ReactNode } from 'react';

const SAMPLE_DATE = new Date('2026-08-15T10:30:00.000Z');
const SAMPLE_AMOUNT = 1234567.89;

const COLOR_TOKENS = [
  {
    nameKey: 'background',
    token: '--background',
    className: 'bg-background text-foreground',
  },
  {
    nameKey: 'foreground',
    token: '--foreground',
    className: 'bg-foreground text-background',
  },
  {
    nameKey: 'card',
    token: '--card',
    className: 'bg-card text-card-foreground',
  },
  {
    nameKey: 'primary',
    token: '--primary',
    className: 'bg-primary text-primary-foreground',
  },
  {
    nameKey: 'secondary',
    token: '--secondary',
    className: 'bg-secondary text-secondary-foreground',
  },
  {
    nameKey: 'muted',
    token: '--muted',
    className: 'bg-muted text-muted-foreground',
  },
  {
    nameKey: 'accent',
    token: '--accent',
    className: 'bg-accent text-accent-foreground',
  },
  {
    nameKey: 'destructive',
    token: '--destructive',
    className: 'bg-destructive text-destructive-foreground',
  },
] as const;

const TYPE_SCALE = [
  {
    labelKey: 'display.label',
    sampleKey: 'display.sample',
    className: 'text-4xl font-bold tracking-tight md:text-5xl',
  },
  {
    labelKey: 'heading1.label',
    sampleKey: 'heading1.sample',
    className: 'text-3xl font-bold tracking-tight',
  },
  {
    labelKey: 'heading2.label',
    sampleKey: 'heading2.sample',
    className: 'text-2xl font-semibold tracking-tight',
  },
  {
    labelKey: 'heading3.label',
    sampleKey: 'heading3.sample',
    className: 'text-xl font-semibold',
  },
  {
    labelKey: 'body.label',
    sampleKey: 'body.sample',
    className: 'text-base',
  },
  {
    labelKey: 'small.label',
    sampleKey: 'small.sample',
    className: 'text-sm',
  },
  {
    labelKey: 'muted.label',
    sampleKey: 'muted.sample',
    className: 'text-sm text-muted-foreground',
  },
  {
    labelKey: 'caption.label',
    sampleKey: 'caption.sample',
    className: 'text-xs text-muted-foreground',
  },
] as const;

const NAVIGATION = [
  { href: '#foundations', labelKey: 'foundations' },
  { href: '#colors', labelKey: 'colors' },
  { href: '#typography', labelKey: 'typography' },
  { href: '#surfaces', labelKey: 'surfaces' },
  { href: '#buttons', labelKey: 'buttons' },
  { href: '#inputs', labelKey: 'inputs' },
  { href: '#cards', labelKey: 'cards' },
  { href: '#dialogs', labelKey: 'dialogs' },
  { href: '#internationalization', labelKey: 'internationalization' },
  { href: '#formatting', labelKey: 'formatting' },
] as const;

const SPACING_SCALE = [2, 3, 4, 6, 8, 12] as const;

function SectionHeader({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <div className="space-y-1.5">
      <h2 className="text-2xl font-semibold tracking-tight text-foreground">
        {title}
      </h2>

      {description ? (
        <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
          {description}
        </p>
      ) : null}
    </div>
  );
}

function DemoFrame({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <div className="border-b px-5 py-4">
        <div className="font-medium text-card-foreground">{title}</div>

        {description ? (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>

      <div className="p-5 md:p-6">{children}</div>
    </div>
  );
}

/**
 * The design-system showcase.
 *
 * Carried over from before the migration with its markup untouched — it is a
 * reference for what the tokens and primitives look like, and rewriting it
 * would have meant rewriting the reference. Only the i18n calls changed, from
 * next-intl's asynchronous server helpers to `use-intl`'s hooks, which is the
 * same library underneath.
 *
 * It lives inside the protected tree because the platform is private, and it
 * is lazily loaded because it is the largest and least-visited page here.
 */
export function DesignSystemPage() {
  const requestLocale = useLocale();
  const locale = isAppLocale(requestLocale) ? requestLocale : DEFAULT_LOCALE;
  const meta = LOCALE_META[locale];

  const tCommon = useTranslations('Common');
  const tNavigation = useTranslations('Navigation');
  const tShowcase = useTranslations('Showcase');
  const tFoundations = useTranslations('Foundations');
  const tColors = useTranslations('Colors');
  const tTypography = useTranslations('Typography');
  const tSurfaces = useTranslations('Surfaces');
  const tButtons = useTranslations('Buttons');
  const tDialogs = useTranslations('Dialogs');
  const tInputs = useTranslations('Inputs');
  const tCards = useTranslations('Cards');
  const tInternationalization = useTranslations('Internationalization');
  const tFormatting = useTranslations('Formatting');
  const tSamples = useTranslations('Samples');

  const format = useFormatter();

  return (
    <div className="text-foreground">
      {/*
        The page's own top bar is gone: the dashboard shell already provides a
        header, a brand mark, the language switcher and the theme toggle, and
        two of each stacked on one screen is how a page announces that it was
        pasted in from somewhere else.
      */}
      <div>
        {/* Hero */}
        <div className="border-b pb-10">
          <div className="max-w-3xl">
            <h1 className="text-4xl font-bold tracking-tight md:text-5xl">
              {tShowcase('title')}
            </h1>

            <p className="mt-4 max-w-2xl text-base leading-7 text-muted-foreground md:text-lg">
              {tShowcase('description')}
            </p>
          </div>
        </div>

        <div className="grid items-start gap-12 py-10 lg:grid-cols-[200px_minmax(0,1fr)] lg:gap-16">
          {/* Navigation */}
          <aside className="hidden lg:block">
            <nav className="sticky top-20 space-y-1">
              <div className="mb-3 px-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                {tNavigation('onThisPage')}
              </div>

              {NAVIGATION.map((item) => (
                <a
                  key={item.href}
                  href={item.href}
                  className="block rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  {tNavigation(item.labelKey)}
                </a>
              ))}
            </nav>
          </aside>

          {/* Main content */}
          <main className="min-w-0 space-y-20 pb-24">
            {/* Foundations */}
            <section id="foundations" className="scroll-mt-24 space-y-8">
              <SectionHeader
                title={tFoundations('title')}
                description={tFoundations('description')}
              />

              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <div className="rounded-xl border bg-card p-5">
                  <div className="text-xs font-medium text-muted-foreground">
                    {tFoundations('direction.title')}
                  </div>
                  <div className="mt-3 text-xl font-semibold">
                    {meta.direction.toUpperCase()}
                  </div>
                  <div className="mt-1 text-sm text-muted-foreground">
                    {tFoundations('direction.description')}
                  </div>
                </div>

                <div className="rounded-xl border bg-card p-5">
                  <div className="text-xs font-medium text-muted-foreground">
                    {tFoundations('locale.title')}
                  </div>
                  <div className="mt-3 text-xl font-semibold">
                    {meta.nativeName}
                  </div>
                  <div className="mt-1 text-sm text-muted-foreground">
                    {locale}
                  </div>
                </div>

                <div className="rounded-xl border bg-card p-5">
                  <div className="text-xs font-medium text-muted-foreground">
                    {tFoundations('radius.title')}
                  </div>
                  <div className="mt-3 text-xl font-semibold">
                    {tFoundations('radius.value')}
                  </div>
                  <div className="mt-1 text-sm text-muted-foreground">
                    {tFoundations('radius.description')}
                  </div>
                </div>

                <div className="rounded-xl border bg-card p-5">
                  <div className="text-xs font-medium text-muted-foreground">
                    {tFoundations('theme.title')}
                  </div>
                  <div className="mt-3 text-xl font-semibold">
                    {tFoundations('theme.value')}
                  </div>
                  <div className="mt-1 text-sm text-muted-foreground">
                    {tFoundations('theme.description')}
                  </div>
                </div>
              </div>
            </section>

            {/* Colors */}
            <section id="colors" className="scroll-mt-24 space-y-8">
              <SectionHeader
                title={tColors('title')}
                description={tColors('description')}
              />

              <DemoFrame title={tColors('paletteTitle')}>
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                  {COLOR_TOKENS.map((color) => (
                    <div
                      key={color.token}
                      className="overflow-hidden rounded-lg border"
                    >
                      <div
                        className={`flex h-28 items-end p-4 ${color.className}`}
                      >
                        <span className="text-sm font-medium">
                          {tColors(color.nameKey)}
                        </span>
                      </div>

                      <div className="bg-background px-4 py-3">
                        <code className="text-xs text-muted-foreground">
                          {color.token}
                        </code>
                      </div>
                    </div>
                  ))}
                </div>
              </DemoFrame>

              <DemoFrame
                title={tColors('borders.title')}
                description={tColors('borders.description')}
              >
                <div className="grid gap-4 md:grid-cols-3">
                  <div className="rounded-lg border p-5">
                    <div className="font-medium">
                      {tColors('borders.default.title')}
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {tColors('borders.default.description')}
                    </p>
                  </div>

                  <div className="rounded-lg border border-primary/40 p-5">
                    <div className="font-medium">
                      {tColors('borders.accent.title')}
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {tColors('borders.accent.description')}
                    </p>
                  </div>

                  <div className="rounded-lg border border-destructive/40 p-5">
                    <div className="font-medium">
                      {tColors('borders.destructive.title')}
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {tColors('borders.destructive.description')}
                    </p>
                  </div>
                </div>
              </DemoFrame>
            </section>

            {/* Typography */}
            <section id="typography" className="scroll-mt-24 space-y-8">
              <SectionHeader
                title={tTypography('title')}
                description={tTypography('description')}
              />

              <DemoFrame title={tTypography('scaleTitle')}>
                <div className="divide-y">
                  {TYPE_SCALE.map((type) => (
                    <div
                      key={type.labelKey}
                      className="grid gap-4 py-6 first:pt-0 last:pb-0 md:grid-cols-[140px_1fr]"
                    >
                      <div>
                        <span className="font-mono text-xs text-muted-foreground">
                          {tTypography(type.labelKey)}
                        </span>
                      </div>

                      <div className={type.className}>
                        {tTypography(type.sampleKey)}
                      </div>
                    </div>
                  ))}
                </div>
              </DemoFrame>
            </section>

            {/* Surfaces */}
            <section id="surfaces" className="scroll-mt-24 space-y-8">
              <SectionHeader
                title={tSurfaces('title')}
                description={tSurfaces('description')}
              />

              <DemoFrame title={tSurfaces('hierarchyTitle')}>
                <div className="grid gap-5 md:grid-cols-3">
                  <div className="rounded-md border bg-card p-5">
                    <div className="text-sm font-semibold">
                      {tSurfaces('mediumRadius')}
                    </div>
                    <code className="mt-2 block text-xs text-muted-foreground">
                      rounded-md
                    </code>
                  </div>

                  <div className="rounded-lg border bg-card p-5">
                    <div className="text-sm font-semibold">
                      {tSurfaces('largeRadius')}
                    </div>
                    <code className="mt-2 block text-xs text-muted-foreground">
                      rounded-lg
                    </code>
                  </div>

                  <div className="rounded-xl border bg-card p-5">
                    <div className="text-sm font-semibold">
                      {tSurfaces('extraLargeRadius')}
                    </div>
                    <code className="mt-2 block text-xs text-muted-foreground">
                      rounded-xl
                    </code>
                  </div>
                </div>

                <div className="mt-5 rounded-xl bg-muted p-6">
                  <div className="font-medium">
                    {tSurfaces('mutedSurface.title')}
                  </div>
                  <p className="mt-1 text-sm leading-6 text-muted-foreground">
                    {tSurfaces('mutedSurface.description')}
                  </p>
                </div>
              </DemoFrame>

              <DemoFrame
                title={tSurfaces('spacing.title')}
                description={tSurfaces('spacing.description')}
              >
                <div className="space-y-6">
                  {SPACING_SCALE.map((space) => (
                    <div
                      key={space}
                      className="grid grid-cols-[64px_1fr] items-center gap-4"
                    >
                      <code className="text-xs text-muted-foreground">
                        {space}
                      </code>

                      <div className="h-2 rounded-full bg-muted">
                        <div
                          className="h-2 rounded-full bg-foreground"
                          style={{
                            width: `${Math.min(space * 8, 100)}%`,
                          }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </DemoFrame>
            </section>

            {/* Buttons */}
            <section id="buttons" className="scroll-mt-24 space-y-8">
              <SectionHeader
                title={tButtons('title')}
                description={tButtons('variantsDesc')}
              />

              <DemoFrame title={tButtons('variantsTitle')}>
                <div className="flex flex-wrap items-center gap-3">
                  <Button variant="default">
                    <Zap className="size-4" />
                    {tButtons('default')}
                  </Button>

                  <Button variant="secondary">
                    <Settings className="size-4" />
                    {tButtons('secondary')}
                  </Button>

                  <Button variant="destructive">
                    <Trash2 className="size-4" />
                    {tButtons('destructive')}
                  </Button>

                  <Button variant="outline">
                    <Mail className="size-4" />
                    {tButtons('outline')}
                  </Button>

                  <Button variant="ghost">
                    <Heart className="size-4" />
                    {tButtons('ghost')}
                  </Button>

                  <Button variant="link">{tButtons('link')}</Button>
                </div>
              </DemoFrame>

              <DemoFrame
                title={tButtons('sizes.title')}
                description={tButtons('sizes.description')}
              >
                <div className="flex flex-wrap items-center gap-3">
                  <Button size="sm">{tButtons('sizes.small')}</Button>
                  <Button>{tButtons('sizes.default')}</Button>
                  <Button size="lg">{tButtons('sizes.large')}</Button>

                  <Button
                    size="icon"
                    variant="outline"
                    aria-label={tButtons('settingsLabel')}
                  >
                    <Settings className="size-4" />
                  </Button>
                </div>
              </DemoFrame>

              <DemoFrame title={tButtons('states.title')}>
                <div className="flex flex-wrap items-center gap-3">
                  <Button>{tButtons('states.enabled')}</Button>
                  <Button disabled>{tButtons('states.disabled')}</Button>

                  <Button variant="outline">
                    {tButtons('states.enabled')}
                  </Button>
                  <Button variant="outline" disabled>
                    {tButtons('states.disabled')}
                  </Button>

                  <Button variant="destructive">
                    {tButtons('states.danger')}
                  </Button>
                  <Button variant="destructive" disabled>
                    {tButtons('states.disabled')}
                  </Button>
                </div>
              </DemoFrame>
            </section>

            {/* Inputs */}
            <section id="inputs" className="scroll-mt-24 space-y-8">
              <SectionHeader
                title={tInputs('title')}
                description={tInputs('description')}
              />

              <DemoFrame title={tInputs('textFieldsTitle')}>
                <div className="grid gap-6 md:grid-cols-2">
                  <div className="space-y-2">
                    <label
                      htmlFor="showcase-name"
                      className="text-sm font-medium"
                    >
                      {tInputs('name.label')}
                    </label>

                    <Input
                      id="showcase-name"
                      placeholder={tInputs('placeholder')}
                    />

                    <p className="text-xs text-muted-foreground">
                      {tInputs('name.helper')}
                    </p>
                  </div>

                  <div className="space-y-2">
                    <label
                      htmlFor="showcase-email"
                      className="text-sm font-medium"
                    >
                      {tInputs('email.label')}
                    </label>

                    <Input
                      id="showcase-email"
                      type="email"
                      placeholder={tInputs('emailPlaceholder')}
                    />

                    <p className="text-xs text-muted-foreground">
                      {tInputs('email.helper')}
                    </p>
                  </div>

                  <div className="space-y-2">
                    <label
                      htmlFor="showcase-value"
                      className="text-sm font-medium"
                    >
                      {tInputs('withValue.label')}
                    </label>

                    <Input
                      id="showcase-value"
                      defaultValue={tSamples('name')}
                    />
                  </div>

                  <div className="space-y-2">
                    <label
                      htmlFor="showcase-disabled"
                      className="text-sm font-medium text-muted-foreground"
                    >
                      {tInputs('disabled.label')}
                    </label>

                    <Input
                      id="showcase-disabled"
                      defaultValue={tInputs('disabled.value')}
                      disabled
                    />
                  </div>
                </div>
              </DemoFrame>

              <DemoFrame title={tInputs('composition.title')}>
                <div className="max-w-md space-y-2">
                  <label
                    htmlFor="showcase-account-email"
                    className="text-sm font-medium"
                  >
                    {tInputs('composition.label')}
                  </label>

                  <Input
                    id="showcase-account-email"
                    type="email"
                    defaultValue={tSamples('email')}
                  />

                  <p className="text-xs leading-5 text-muted-foreground">
                    {tInputs('composition.helper')}
                  </p>
                </div>
              </DemoFrame>
            </section>

            {/* Cards */}
            <section id="cards" className="scroll-mt-24 space-y-8">
              <SectionHeader
                title={tCards('title')}
                description={tCards('description')}
              />

              <div className="grid gap-5 md:grid-cols-2">
                <Card>
                  <CardHeader>
                    <CardTitle>{tCards('standard.title')}</CardTitle>
                    <CardDescription>
                      {tCards('standard.description')}
                    </CardDescription>
                  </CardHeader>

                  <CardContent>
                    <p className="text-sm leading-6 text-muted-foreground">
                      {tCards('standard.content')}
                    </p>
                  </CardContent>
                </Card>

                <Card className="bg-muted/40 shadow-none">
                  <CardHeader>
                    <CardTitle>{tCards('secondary.title')}</CardTitle>
                    <CardDescription>
                      {tCards('secondary.description')}
                    </CardDescription>
                  </CardHeader>

                  <CardContent>
                    <Button variant="outline">
                      {tCards('secondary.action')}
                    </Button>
                  </CardContent>
                </Card>
              </div>
            </section>

            {/* Dialog */}
            <section id="dialogs" className="scroll-mt-24 space-y-8">
              <SectionHeader
                title={tDialogs('title')}
                description={tDialogs('headerDesc')}
              />

              <DemoFrame
                title={tDialogs('headerTitle')}
                description={tDialogs('showcaseDescription')}
              >
                <Dialog>
                  <DialogTrigger asChild>
                    <Button variant="outline">{tDialogs('trigger')}</Button>
                  </DialogTrigger>

                  {/* @repo/ui owns no copy — the label arrives translated. */}
                  <DialogContent closeLabel={tCommon('close')}>
                    <DialogHeader>
                      <DialogTitle>{tDialogs('headerTitle')}</DialogTitle>

                      <DialogDescription>
                        {tDialogs('headerDesc')}
                      </DialogDescription>
                    </DialogHeader>

                    <div className="grid gap-5 py-4">
                      <div className="grid gap-2">
                        <label
                          htmlFor="dialog-name"
                          className="text-sm font-medium"
                        >
                          {tDialogs('nameLabel')}
                        </label>

                        <Input
                          id="dialog-name"
                          defaultValue={tSamples('name')}
                        />
                      </div>

                      <div className="grid gap-2">
                        <label
                          htmlFor="dialog-username"
                          className="text-sm font-medium"
                        >
                          {tDialogs('usernameLabel')}
                        </label>

                        <Input
                          id="dialog-username"
                          defaultValue={tSamples('username')}
                        />
                      </div>
                    </div>

                    <DialogFooter>
                      <DialogClose asChild>
                        <Button variant="outline">{tCommon('cancel')}</Button>
                      </DialogClose>

                      <Button type="submit">{tDialogs('saveChanges')}</Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              </DemoFrame>
            </section>

            {/* Internationalization */}
            <section
              id="internationalization"
              className="scroll-mt-24 space-y-8"
            >
              <SectionHeader
                title={tInternationalization('title')}
                description={tInternationalization('description')}
              />

              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Globe className="size-5 text-primary" />

                    <span>
                      {tShowcase('localeInfo', {
                        locale: meta.nativeName,
                        dir: meta.direction.toUpperCase(),
                      })}
                    </span>
                  </CardTitle>

                  <CardDescription>
                    {tShowcase('mixedContentTest')}
                  </CardDescription>
                </CardHeader>

                <CardContent>
                  <div className="divide-y rounded-lg border">
                    <div className="grid gap-2 p-4 sm:grid-cols-[160px_1fr] sm:items-center">
                      <span className="text-sm text-muted-foreground">
                        {tShowcase('emailSample')}
                      </span>

                      <div>
                        <bdi className="inline-flex rounded-md bg-muted px-2.5 py-1 font-mono text-xs">
                          {tSamples('email')}
                        </bdi>
                      </div>
                    </div>

                    <div className="grid gap-2 p-4 sm:grid-cols-[160px_1fr] sm:items-center">
                      <span className="text-sm text-muted-foreground">
                        {tShowcase('orderSample')}
                      </span>

                      <div>
                        <bdi className="inline-flex rounded-md bg-muted px-2.5 py-1 font-mono text-xs">
                          {tSamples('orderNumber')}
                        </bdi>
                      </div>
                    </div>

                    <div className="grid gap-2 p-4 sm:grid-cols-[160px_1fr] sm:items-center">
                      <span className="text-sm text-muted-foreground">
                        {tShowcase('urlSample')}
                      </span>

                      <div className="min-w-0">
                        <bdi className="inline-block max-w-full break-all rounded-md bg-muted px-2.5 py-1 font-mono text-xs">
                          {tSamples('url')}
                        </bdi>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </section>

            {/* Formatting */}
            <section id="formatting" className="scroll-mt-24 space-y-8">
              <SectionHeader
                title={tFormatting('title')}
                description={tFormatting('description')}
              />

              <DemoFrame title={tFormatting('valuesTitle')}>
                <div className="divide-y rounded-lg border">
                  <div className="grid gap-1 p-4 sm:grid-cols-[180px_1fr] sm:items-center">
                    <span className="text-sm text-muted-foreground">
                      {tFormatting('dateLabel')}
                    </span>

                    <span className="text-sm font-medium">
                      {format.dateTime(SAMPLE_DATE, {
                        dateStyle: 'long',
                        timeStyle: 'short',
                      })}
                    </span>
                  </div>

                  <div className="grid gap-1 p-4 sm:grid-cols-[180px_1fr] sm:items-center">
                    <span className="text-sm text-muted-foreground">
                      {tFormatting('currencyLabel')}
                    </span>

                    <span className="text-sm font-medium">
                      {format.number(SAMPLE_AMOUNT, {
                        style: 'currency',
                        currency: 'USD',
                      })}
                    </span>
                  </div>

                  <div className="grid gap-1 p-4 sm:grid-cols-[180px_1fr] sm:items-center">
                    <span className="text-sm text-muted-foreground">
                      {tFormatting('numberLabel')}
                    </span>

                    <span className="text-sm font-medium">
                      {tFormatting('notificationsCount', { count: 3 })}
                    </span>
                  </div>
                </div>
              </DemoFrame>
            </section>

            {/* Footer */}
            <footer className="border-t pt-8">
              <div className="flex flex-col justify-between gap-2 text-sm text-muted-foreground sm:flex-row">
                <span>{tShowcase('footerTitle')}</span>
                <span>
                  {meta.nativeName} · {meta.direction.toUpperCase()}
                </span>
              </div>
            </footer>
          </main>
        </div>
      </div>
    </div>
  );
}