import { notFound } from 'next/navigation';

/** Routes a valid locale's unknown descendants through the localized 404 UI. */
export default function UnknownLocalizedRoute() {
  notFound();
}
