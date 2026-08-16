/**
 * Marks an icon whose meaning is tied to a reading direction.
 *
 * Tailwind's `rtl:` variant resolves to `[dir="rtl"] &`, and the root element
 * carries `dir`, so this needs no JavaScript and no context — it is correct
 * during server rendering and stays correct after a language switch.
 *
 * Apply it only to icons whose *semantics* mirror: arrows, chevrons that mean
 * "forward"/"back", the sign-in and sign-out glyphs. Do not apply it to
 * neutral marks — an envelope, a padlock, a clock, a spinner — where flipping
 * produces a subtly wrong icon and, in the spinner's case, reverses the
 * animation for no reason.
 */
export const MIRRORED_ICON = 'rtl:-scale-x-100';
